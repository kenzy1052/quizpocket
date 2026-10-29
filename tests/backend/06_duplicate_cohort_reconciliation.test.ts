import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SupabasePostgresHarness } from '../helpers/pgliteSupabaseHarness.ts';

const reconciliationSql = readFileSync(
  new URL(
    '../../supabase/migrations/20261025001000_reconcile_duplicate_aim105_cohorts.sql',
    import.meta.url
  ),
  'utf8'
);

describe('duplicate cohort reconciliation migration', () => {
  it('merges duplicate cohort memberships and quiz assignments without losing active access', async () => {
    const harness = await SupabasePostgresHarness.create();

    try {
      const admin = await harness.createAuthUser({
        email: 'migration.admin@quizpocket.edu',
        password: 'AdminPassword#2026',
      });
      await harness.asServiceRole(
        `SELECT * FROM public.bootstrap_initial_admin($1::uuid, 'Migration Admin')`,
        [admin.id]
      );

      const studentOne = await harness.createAuthUser({
        email: 'migration.student1@quizpocket.edu',
        password: 'StudentPassword#2026',
      });
      const studentTwo = await harness.createAuthUser({
        email: 'migration.student2@quizpocket.edu',
        password: 'StudentPassword#2026',
      });

      const legacyClassId = randomUUID();
      const canonicalClassId = randomUUID();
      await harness.asServiceRole(
        `INSERT INTO public.classes (
           id, institution_id, name, description, created_by
         )
         VALUES
           ($1::uuid, '00000000-0000-0000-0000-000000000001',
            'HIM-101 Health Information Management Cohort', 'Legacy cohort details', $3::uuid),
           ($2::uuid, '00000000-0000-0000-0000-000000000001',
            'AIM 105 Health Information Management Cohort', 'Canonical cohort details', $3::uuid)`,
        [legacyClassId, canonicalClassId, admin.id]
      );

      await harness.asServiceRole(
        `INSERT INTO public.class_memberships (class_id, student_id, membership_status)
         VALUES
           ($1::uuid, $3::uuid, 'active'),
           ($2::uuid, $3::uuid, 'inactive'),
           ($1::uuid, $4::uuid, 'active')`,
        [legacyClassId, canonicalClassId, studentOne.id, studentTwo.id]
      );

      const examRows = await harness.asUser<{ id: string }>(
        admin.id,
        `SELECT (public.admin_create_exam($1)).id::text AS id`,
        ['Cohort migration test quiz']
      );
      const examId = examRows[0].id;

      await harness.asServiceRole(
        `INSERT INTO public.exam_assignments (
           exam_id, class_id, assigned_by, assignment_status
         )
         VALUES
           ($1::uuid, $2::uuid, $4::uuid, 'active'),
           ($1::uuid, $3::uuid, $4::uuid, 'revoked')`,
        [examId, legacyClassId, canonicalClassId, admin.id]
      );

      await harness.db.exec(reconciliationSql);
      await harness.db.exec(reconciliationSql);

      const classes = await harness.asSuperuser<{ id: string; name: string; auto_enroll_new_students: boolean }>(
        `SELECT id::text, name, auto_enroll_new_students
         FROM public.classes
         WHERE institution_id = '00000000-0000-0000-0000-000000000001'
           AND lower(btrim(name)) IN (
             lower('HIM-101 Health Information Management Cohort'),
             lower('AIM 105 Health Information Management Cohort')
           )`
      );
      expect(classes).toEqual([
        {
          id: canonicalClassId,
          name: 'AIM 105 Health Information Management Cohort',
          auto_enroll_new_students: true,
        },
      ]);

      const memberships = await harness.asSuperuser<{
        student_id: string;
        membership_status: string;
      }>(
        `SELECT student_id::text, membership_status::text
         FROM public.class_memberships
         WHERE class_id = $1::uuid
         ORDER BY student_id`,
        [canonicalClassId]
      );
      expect(memberships).toHaveLength(2);
      expect(memberships.every((membership) => membership.membership_status === 'active')).toBe(
        true
      );

      const assignments = await harness.asSuperuser<{
        class_id: string;
        assignment_status: string;
      }>(
        `SELECT class_id::text, assignment_status::text
         FROM public.exam_assignments
         WHERE exam_id = $1::uuid
           AND class_id IS NOT NULL`,
        [examId]
      );
      expect(assignments).toEqual([
        { class_id: canonicalClassId, assignment_status: 'active' },
      ]);
    } finally {
      await harness.close();
    }
  }, 25_000);
});
