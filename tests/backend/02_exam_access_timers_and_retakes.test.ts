import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SupabasePostgresHarness } from '../helpers/pgliteSupabaseHarness.ts';

describe('Stage 3: Examination Access, Availability Windows, Server Timers, Cooldowns, and Concurrency', () => {
  let harness: SupabasePostgresHarness;
  let admin: { id: string };
  let assignedStudent: { id: string };
  let classStudent: { id: string };
  let unassignedStudent: { id: string };
  let classId: string;

  beforeAll(async () => {
    harness = await SupabasePostgresHarness.create();
    admin = await harness.createAuthUser({ email: 'teacher@quizpocket.edu' });
    assignedStudent = await harness.createAuthUser({ email: 'assigned@quizpocket.edu' });
    classStudent = await harness.createAuthUser({ email: 'class.member@quizpocket.edu' });
    unassignedStudent = await harness.createAuthUser({ email: 'unassigned@quizpocket.edu' });

    await harness.asServiceRole(
      `SELECT * FROM public.bootstrap_initial_admin($1::uuid, 'Lead Teacher')`,
      [admin.id]
    );

    const cls = await harness.asUser<{ id: string }>(
      admin.id,
      `SELECT * FROM public.admin_create_class('Physics 201', 'Mechanics Cohort')`
    );
    classId = cls[0].id;

    await harness.asUser(
      admin.id,
      `SELECT * FROM public.admin_set_class_membership($1::uuid, $2::uuid, 'active')`,
      [classId, classStudent.id]
    );
  });

  afterAll(async () => {
    await harness.close();
  });

  async function createReadyExam(opts: {
    title: string;
    durationMinutes?: number;
    maxAttempts?: number;
    cooldownMinutes?: number;
    scheduledStartOffsetMins?: number | null;
    scheduledEndOffsetMins?: number | null;
    publish?: boolean;
  }): Promise<{ examId: string; questionId: string; correctOptionId: string }> {
    const startRows =
      opts.scheduledStartOffsetMins !== undefined && opts.scheduledStartOffsetMins !== null
        ? await harness.asSuperuser<{ ts: string }>(
            `SELECT (public.utc_now() + make_interval(mins => $1::int))::text AS ts`,
            [opts.scheduledStartOffsetMins]
          )
        : null;
    const endRows =
      opts.scheduledEndOffsetMins !== undefined && opts.scheduledEndOffsetMins !== null
        ? await harness.asSuperuser<{ ts: string }>(
            `SELECT (public.utc_now() + make_interval(mins => $1::int))::text AS ts`,
            [opts.scheduledEndOffsetMins]
          )
        : null;

    const created = await harness.asUser<{ id: string }>(
      admin.id,
      `SELECT * FROM public.admin_create_exam(
        $1::text, 'Desc', 'Instructions', $2::integer, 50.0,
        $3::timestamptz, $4::timestamptz, 'immediate', true, false, false, $5::integer, $6::integer
      )`,
      [
        opts.title,
        opts.durationMinutes ?? 30,
        startRows?.[0]?.ts ?? null,
        endRows?.[0]?.ts ?? null,
        opts.maxAttempts ?? 2,
        opts.cooldownMinutes ?? 180,
      ]
    );

    const examId = created[0].id;

    const qRes = await harness.asUser<{
      q: { question_id: string; options: Array<{ id: string; is_correct: boolean }> };
    }>(
      admin.id,
      `SELECT public.admin_upsert_question_with_options(
        $1::uuid,
        'What is Newtons second law?',
        'multiple_choice',
        10.0,
        $2::jsonb
      ) AS q`,
      [
        examId,
        JSON.stringify([
          { option_text: 'F = ma', is_correct: true },
          { option_text: 'F = mv', is_correct: false },
          { option_text: 'E = mc^2', is_correct: false },
        ]),
      ]
    );

    if (opts.publish !== false) {
      await harness.asUser(admin.id, `SELECT * FROM public.admin_publish_exam($1::uuid)`, [examId]);
    }

    const correctOpt = qRes[0].q.options.find((o) => o.is_correct)!;
    return {
      examId,
      questionId: qRes[0].q.question_id,
      correctOptionId: correctOpt.id,
    };
  }

  it('blocks draft exams, archived exams, and unassigned students from starting attempts', async () => {
    const draft = await createReadyExam({ title: 'Draft Exam', publish: false });
    await harness.asUser(
      admin.id,
      `SELECT * FROM public.admin_assign_exam($1::uuid, $2::uuid, NULL, 'active')`,
      [draft.examId, assignedStudent.id]
    );

    // Draft exam cannot be seen or started by assigned student
    const draftVisible = await harness.asUser(
      assignedStudent.id,
      `SELECT * FROM public.exams WHERE id = $1::uuid`,
      [draft.examId]
    );
    expect(draftVisible).toHaveLength(0);

    await expect(
      harness.asUser(
        assignedStudent.id,
        `SELECT public.student_start_or_resume_attempt($1::uuid)`,
        [draft.examId]
      )
    ).rejects.toThrow(/EXAM_NOT_AVAILABLE/);

    // Published exam assigned only to assignedStudent cannot be started by unassignedStudent
    const published = await createReadyExam({ title: 'Restricted Exam', publish: true });
    await harness.asUser(
      admin.id,
      `SELECT * FROM public.admin_assign_exam($1::uuid, $2::uuid, NULL, 'active')`,
      [published.examId, assignedStudent.id]
    );

    await expect(
      harness.asUser(
        unassignedStudent.id,
        `SELECT public.student_start_or_resume_attempt($1::uuid)`,
        [published.examId]
      )
    ).rejects.toThrow(/EXAM_NOT_ASSIGNED/);

    // Archiving blocks starts
    await harness.asUser(admin.id, `SELECT * FROM public.admin_archive_exam($1::uuid)`, [
      published.examId,
    ]);
    await expect(
      harness.asUser(
        assignedStudent.id,
        `SELECT public.student_start_or_resume_attempt($1::uuid)`,
        [published.examId]
      )
    ).rejects.toThrow(/EXAM_NOT_AVAILABLE/);
  });

  it('enforces availability windows before scheduled_start_at and after scheduled_end_at', async () => {
    const futureExam = await createReadyExam({
      title: 'Future Window Exam',
      scheduledStartOffsetMins: 60,
      scheduledEndOffsetMins: 180,
    });
    await harness.asUser(
      admin.id,
      `SELECT * FROM public.admin_assign_exam($1::uuid, $2::uuid, NULL, 'active')`,
      [futureExam.examId, assignedStudent.id]
    );

    await expect(
      harness.asUser(
        assignedStudent.id,
        `SELECT public.student_start_or_resume_attempt($1::uuid)`,
        [futureExam.examId]
      )
    ).rejects.toThrow(/EXAM_NOT_YET_OPEN/);

    const closedExam = await createReadyExam({
      title: 'Closed Window Exam',
      scheduledStartOffsetMins: -180,
      scheduledEndOffsetMins: -30,
    });
    await harness.asUser(
      admin.id,
      `SELECT * FROM public.admin_assign_exam($1::uuid, $2::uuid, NULL, 'active')`,
      [closedExam.examId, assignedStudent.id]
    );

    await expect(
      harness.asUser(
        assignedStudent.id,
        `SELECT public.student_start_or_resume_attempt($1::uuid)`,
        [closedExam.examId]
      )
    ).rejects.toThrow(/EXAM_WINDOW_CLOSED/);
  });

  it('grants eligibility via active class membership and revokes immediately upon deactivation', async () => {
    const classExam = await createReadyExam({ title: 'Class Assigned Exam', durationMinutes: 25 });
    await harness.asUser(
      admin.id,
      `SELECT * FROM public.admin_assign_exam($1::uuid, NULL, $2::uuid, 'active')`,
      [classExam.examId, classId]
    );

    // Deactivate membership -> cannot start
    await harness.asUser(
      admin.id,
      `SELECT * FROM public.admin_set_class_membership($1::uuid, $2::uuid, 'inactive')`,
      [classId, classStudent.id]
    );
    await expect(
      harness.asUser(
        classStudent.id,
        `SELECT public.student_start_or_resume_attempt($1::uuid)`,
        [classExam.examId]
      )
    ).rejects.toThrow(/EXAM_NOT_ASSIGNED/);

    // Re-activate membership -> can start, and deadline_at = started_at + 25 minutes
    await harness.asUser(
      admin.id,
      `SELECT * FROM public.admin_set_class_membership($1::uuid, $2::uuid, 'active')`,
      [classId, classStudent.id]
    );
    const startRes = await harness.asUser<{
      res: {
        attempt_id: string;
        started_at: string;
        deadline_at: string;
        resumed: boolean;
      };
    }>(classStudent.id, `SELECT public.student_start_or_resume_attempt($1::uuid) AS res`, [
      classExam.examId,
    ]);

    expect(startRes[0].res.resumed).toBe(false);
    const diffMs =
      new Date(startRes[0].res.deadline_at).getTime() -
      new Date(startRes[0].res.started_at).getTime();
    expect(Math.round(diffMs / 60_000)).toBe(25);
  });

  it('resumes valid active attempts instead of duplicating, and prevents concurrent duplicate creation', async () => {
    const exam = await createReadyExam({
      title: 'Concurrency & Resume Exam',
      durationMinutes: 30,
      maxAttempts: 3,
    });
    await harness.asUser(
      admin.id,
      `SELECT * FROM public.admin_assign_exam($1::uuid, $2::uuid, NULL, 'active')`,
      [exam.examId, assignedStudent.id]
    );

    // Fire 5 simultaneous start requests -> must yield the exact same single attempt_id!
    const concurrentCalls = await Promise.all(
      Array.from({ length: 5 }, () =>
        harness.asUser<{ res: { attempt_id: string; attempt_number: number } }>(
          assignedStudent.id,
          `SELECT public.student_start_or_resume_attempt($1::uuid) AS res`,
          [exam.examId]
        )
      )
    );

    const uniqueAttemptIds = new Set(concurrentCalls.map((r) => r[0].res.attempt_id));
    expect(uniqueAttemptIds.size).toBe(1);
    expect(concurrentCalls[0][0].res.attempt_number).toBe(1);

    // Students cannot directly UPDATE exam_attempts to extend their own deadline
    const attemptId = concurrentCalls[0][0].res.attempt_id;
    await expect(
      harness.asUser(
        assignedStudent.id,
        `UPDATE public.exam_attempts SET deadline_at = deadline_at + interval '5 hours' WHERE id = $1::uuid`,
        [attemptId]
      )
    ).rejects.toThrow();
  });

  it('rejects late answer saves on expired attempts, auto-finalizes idempotently, and enforces retake cooldowns + attempt limits', async () => {
    const exam = await createReadyExam({
      title: 'Cooldown & Expiry Exam',
      durationMinutes: 30,
      maxAttempts: 2,
      cooldownMinutes: 180, // Default 3-hour cooldown
    });
    await harness.asUser(
      admin.id,
      `SELECT * FROM public.admin_assign_exam($1::uuid, $2::uuid, NULL, 'active')`,
      [exam.examId, assignedStudent.id]
    );

    const started = await harness.asUser<{ res: { attempt_id: string } }>(
      assignedStudent.id,
      `SELECT public.student_start_or_resume_attempt($1::uuid) AS res`,
      [exam.examId]
    );
    const attempt1Id = started[0].res.attempt_id;

    // Simulate 35 minutes passing on the server (attempt expired 5 minutes ago)
    await harness.asSuperuser(
      `UPDATE public.exam_attempts
       SET started_at = public.utc_now() - interval '35 minutes',
           deadline_at = public.utc_now() - interval '5 minutes'
       WHERE id = $1::uuid`,
      [attempt1Id]
    );

    // Student tries to save an answer after deadline -> rejected & attempt auto-submitted!
    const lateSave = await harness.asUser<{
      res: { ok: boolean; code: string; attempt_status: string };
    }>(
      assignedStudent.id,
      `SELECT public.student_save_answer($1::uuid, $2::uuid, $3::uuid) AS res`,
      [attempt1Id, exam.questionId, exam.correctOptionId]
    );
    expect(lateSave[0].res.ok).toBe(false);
    expect(lateSave[0].res.code).toBe('ATTEMPT_DEADLINE_EXPIRED');
    expect(lateSave[0].res.attempt_status).toBe('auto_submitted');

    // Running scheduled expiry sweep multiple times is 100% idempotent (0 duplicate results)
    await harness.asServiceRole(`SELECT public.finalize_expired_attempts(100)`);
    await harness.asServiceRole(`SELECT public.finalize_expired_attempts(100)`);
    const resultCount = await harness.asSuperuser<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM public.results WHERE attempt_id = $1::uuid`,
      [attempt1Id]
    );
    expect(Number(resultCount[0].cnt)).toBe(1);

    // Retake during 180-minute cooldown MUST be rejected!
    await expect(
      harness.asUser(
        assignedStudent.id,
        `SELECT public.student_start_or_resume_attempt($1::uuid)`,
        [exam.examId]
      )
    ).rejects.toThrow(/RETAKE_COOLDOWN_ACTIVE/);

    // Simulate 181 minutes elapsed since attempt 1 submission -> Attempt 2 now succeeds!
    await harness.asSuperuser(
      `UPDATE public.exam_attempts
       SET started_at = public.utc_now() - interval '211 minutes',
           deadline_at = public.utc_now() - interval '181 minutes',
           submitted_at = public.utc_now() - interval '181 minutes'
       WHERE id = $1::uuid`,
      [attempt1Id]
    );

    const attempt2 = await harness.asUser<{
      res: { attempt_id: string; attempt_number: number; resumed: boolean };
    }>(assignedStudent.id, `SELECT public.student_start_or_resume_attempt($1::uuid) AS res`, [
      exam.examId,
    ]);
    expect(attempt2[0].res.attempt_number).toBe(2);
    expect(attempt2[0].res.resumed).toBe(false);

    // Submit attempt 2 manually
    await harness.asUser(
      assignedStudent.id,
      `SELECT public.student_submit_attempt($1::uuid)`,
      [attempt2[0].res.attempt_id]
    );

    // Simulate another 200 minutes passing (cooldown elapsed), but max_attempts = 2 is reached -> DENIED!
    await harness.asSuperuser(
      `UPDATE public.exam_attempts
       SET started_at = public.utc_now() - interval '230 minutes',
           deadline_at = public.utc_now() - interval '200 minutes',
           submitted_at = public.utc_now() - interval '200 minutes'
       WHERE id = $1::uuid`,
      [attempt2[0].res.attempt_id]
    );

    await expect(
      harness.asUser(
        assignedStudent.id,
        `SELECT public.student_start_or_resume_attempt($1::uuid)`,
        [exam.examId]
      )
    ).rejects.toThrow(/MAX_ATTEMPTS_REACHED/);
  });
});
