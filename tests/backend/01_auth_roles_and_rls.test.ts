import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SupabasePostgresHarness } from '../helpers/pgliteSupabaseHarness.ts';

describe('Stage 2 & 5: Authentication, Role Security, Profile Protection, and RLS Isolation', () => {
  let harness: SupabasePostgresHarness;
  let adminUser: { id: string; email: string; token: string };
  let studentA: { id: string; email: string; token: string };
  let studentB: { id: string; email: string; token: string };
  let suspendedStudent: { id: string; email: string; token: string };

  beforeAll(async () => {
    harness = await SupabasePostgresHarness.create();

    adminUser = await harness.createAuthUser({
      email: 'admin@quizpocket.edu',
      rawUserMetaData: { full_name: 'Prof. Claire Bennett' },
    });

    // Even if a malicious signup payload includes { role: "admin" } in raw_user_meta_data,
    // handle_new_auth_user MUST ignore it and assign only "student".
    studentA = await harness.createAuthUser({
      email: 'student.a@quizpocket.edu',
      rawUserMetaData: { full_name: 'Student Alpha', role: 'admin', is_admin: true },
    });

    studentB = await harness.createAuthUser({
      email: 'student.b@quizpocket.edu',
      rawUserMetaData: { full_name: 'Student Beta' },
    });

    suspendedStudent = await harness.createAuthUser({
      email: 'suspended@quizpocket.edu',
      rawUserMetaData: { full_name: 'Suspended Student' },
    });

    // Promote adminUser ONLY via service_role bootstrap_initial_admin
    await harness.asServiceRole(
      `SELECT * FROM public.bootstrap_initial_admin($1::uuid, $2::text)`,
      [adminUser.id, 'Prof. Claire Bennett']
    );

    // Admin configures student identifiers and suspends suspendedStudent
    await harness.asUser(
      adminUser.id,
      `SELECT * FROM public.admin_configure_student_profile($1::uuid, 'Student Alpha', 'STU-001', 'active')`,
      [studentA.id]
    );
    await harness.asUser(
      adminUser.id,
      `SELECT * FROM public.admin_configure_student_profile($1::uuid, 'Student Beta', 'STU-002', 'active')`,
      [studentB.id]
    );
    await harness.asUser(
      adminUser.id,
      `SELECT * FROM public.admin_configure_student_profile($1::uuid, 'Suspended Student', 'STU-999', 'suspended')`,
      [suspendedStudent.id]
    );
  });

  afterAll(async () => {
    await harness.close();
  });

  it('enforces RLS on every application table in the public schema', async () => {
    const tables = await harness.asSuperuser<{ tablename: string; rowsecurity: boolean }>(
      `SELECT tablename, rowsecurity
       FROM pg_tables
       WHERE schemaname = 'public'`
    );
    expect(tables.length).toBeGreaterThanOrEqual(13);
    for (const tbl of tables) {
      expect(tbl.rowsecurity, `Expected RLS enabled on public.${tbl.tablename}`).toBe(true);
    }
  });

  it('rejects unauthenticated (anon) access to profiles, exams, questions, results, and RPCs', async () => {
    await expect(harness.asAnon(`SELECT * FROM public.profiles`)).rejects.toThrow();
    await expect(harness.asAnon(`SELECT * FROM public.exams`)).rejects.toThrow();
    await expect(harness.asAnon(`SELECT * FROM public.question_options`)).rejects.toThrow();
    await expect(harness.asAnon(`SELECT * FROM public.results`)).rejects.toThrow();
    await expect(
      harness.asAnon(`SELECT public.student_list_eligible_exams()`)
    ).rejects.toThrow();
  });

  it('prevents self-assigned admin role during signup and blocks student self-promotion', async () => {
    const profileRows = await harness.asUser<{ role: string; student_identifier: string }>(
      studentA.id,
      `SELECT role, student_identifier FROM public.profiles WHERE id = $1`,
      [studentA.id]
    );
    expect(profileRows[0]?.role).toBe('student');

    // Attempt direct SQL column update to promote self -> rejected by column grant & trigger
    await expect(
      harness.asUser(
        studentA.id,
        `UPDATE public.profiles SET role = 'admin' WHERE id = $1`,
        [studentA.id]
      )
    ).rejects.toThrow();

    // Attempt calling bootstrap_initial_admin as authenticated student -> rejected
    await expect(
      harness.asUser(
        studentA.id,
        `SELECT * FROM public.bootstrap_initial_admin($1::uuid, 'Hacked Admin')`,
        [studentA.id]
      )
    ).rejects.toThrow();

    // Student CAN update their own full_name
    const updated = await harness.asUser<{ full_name: string; role: string }>(
      studentA.id,
      `UPDATE public.profiles SET full_name = 'Student Alpha Updated' WHERE id = $1 RETURNING full_name, role`,
      [studentA.id]
    );
    expect(updated[0]?.full_name).toBe('Student Alpha Updated');
    expect(updated[0]?.role).toBe('student');
  });

  it('prevents Student A from reading Student B private profile or calling administrative RPCs', async () => {
    const visibleProfiles = await harness.asUser<{ id: string }>(
      studentA.id,
      `SELECT id FROM public.profiles`
    );
    expect(visibleProfiles).toHaveLength(1);
    expect(visibleProfiles[0]?.id).toBe(studentA.id);

    // Student cannot create an exam, class, or configure profiles
    await expect(
      harness.asUser(
        studentA.id,
        `SELECT * FROM public.admin_create_exam('Unauthorized Exam', NULL, NULL, 30)`
      )
    ).rejects.toThrow(/FORBIDDEN_ADMIN_ONLY/);

    await expect(
      harness.asUser(
        studentA.id,
        `SELECT * FROM public.admin_create_class('Unauthorized Class', NULL)`
      )
    ).rejects.toThrow(/FORBIDDEN_ADMIN_ONLY/);

    await expect(
      harness.asUser(
        studentA.id,
        `SELECT * FROM public.admin_configure_student_profile($1::uuid, 'Tampered', 'STU-002', 'suspended')`,
        [studentB.id]
      )
    ).rejects.toThrow(/FORBIDDEN_ADMIN_ONLY/);
  });

  it('blocks suspended/disabled accounts from accessing profiles or student operations', async () => {
    const ownProfile = await harness.asUser(
      suspendedStudent.id,
      `SELECT * FROM public.profiles WHERE id = $1`,
      [suspendedStudent.id]
    );
    expect(ownProfile).toHaveLength(0);

    await expect(
      harness.asUser(suspendedStudent.id, `SELECT public.student_list_eligible_exams()`)
    ).rejects.toThrow(/FORBIDDEN_STUDENT_ONLY/);
  });

  it('scopes student_identifier uniqueness per institution rather than globally', async () => {
    // Duplicate student_identifier in the SAME institution is rejected
    await expect(
      harness.asUser(
        adminUser.id,
        `SELECT * FROM public.admin_configure_student_profile($1::uuid, 'Student Beta', 'stu-001', 'active')`,
        [studentB.id]
      )
    ).rejects.toThrow();

    // Same student_identifier in a SECOND institution is permitted
    const secondInstId = '00000000-0000-0000-0000-000000000002';
    await harness.asSuperuser(
      `INSERT INTO public.institutions (id, name, slug) VALUES ($1, 'Second Academy', 'second-academy')`,
      [secondInstId]
    );
    const otherSchoolStudent = await harness.createAuthUser({
      email: 'student.other@secondacademy.edu',
    });
    await harness.asSuperuser(
      `UPDATE public.profiles SET institution_id = $1, student_identifier = 'STU-001' WHERE id = $2`,
      [secondInstId, otherSchoolStudent.id]
    );

    const check = await harness.asSuperuser<{ student_identifier: string }>(
      `SELECT student_identifier FROM public.profiles WHERE id = $1`,
      [otherSchoolStudent.id]
    );
    expect(check[0]?.student_identifier).toBe('STU-001');
  });

  it('protects audit_logs from student reads and blocks all modifications/deletions even by admins', async () => {
    const studentAuditView = await harness.asUser(
      studentA.id,
      `SELECT * FROM public.audit_logs`
    );
    expect(studentAuditView).toHaveLength(0);

    const adminAuditView = await harness.asUser<{ id: string }>(
      adminUser.id,
      `SELECT id FROM public.audit_logs`
    );
    expect(adminAuditView.length).toBeGreaterThan(0);

    // Even superuser/admin cannot UPDATE or DELETE audit_logs due to immutability trigger
    await expect(
      harness.asSuperuser(`DELETE FROM public.audit_logs WHERE id = $1`, [adminAuditView[0].id])
    ).rejects.toThrow(/AUDIT_LOG_IMMUTABLE/);
  });
});
