import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SupabasePostgresHarness } from '../helpers/pgliteSupabaseHarness.ts';

describe('Stage 3 & 4: Answer-Key Non-Leakage, Objective Marking, Negative Marking, Release Policies, and Edit Locking', () => {
  let harness: SupabasePostgresHarness;
  let admin: { id: string };
  let student1: { id: string };
  let student2: { id: string };

  beforeAll(async () => {
    harness = await SupabasePostgresHarness.create();
    admin = await harness.createAuthUser({ email: 'examiner@quizpocket.edu' });
    student1 = await harness.createAuthUser({ email: 'candidate1@quizpocket.edu' });
    student2 = await harness.createAuthUser({ email: 'candidate2@quizpocket.edu' });

    await harness.asServiceRole(
      `SELECT * FROM public.bootstrap_initial_admin($1::uuid, 'Chief Examiner')`,
      [admin.id]
    );
  });

  afterAll(async () => {
    await harness.close();
  });

  it('prevents answer-key and explanation leakage across direct table queries and active exam RPCs', async () => {
    const examRows = await harness.asUser<{ id: string }>(
      admin.id,
      `SELECT * FROM public.admin_create_exam(
        'Chemistry Security Exam', 'Desc', 'Instructions', 45, 60.0,
        NULL, NULL, 'manual', true, false, false, 1, 180
      )`
    );
    const examId = examRows[0].id;

    const q1 = await harness.asUser<{
      q: {
        question_id: string;
        options: Array<{ id: string; option_text: string; is_correct: boolean }>;
      };
    }>(
      admin.id,
      `SELECT public.admin_upsert_question_with_options(
        $1::uuid,
        'What is the atomic number of Carbon?',
        'multiple_choice',
        5.0,
        $2::jsonb,
        NULL,
        1.0,
        'SECRET EXPLANATION: Carbon has 6 protons in its nucleus.'
      ) AS q`,
      [
        examId,
        JSON.stringify([
          { option_text: '4', is_correct: false },
          { option_text: '6', is_correct: true },
          { option_text: '12', is_correct: false },
        ]),
      ]
    );

    const q2 = await harness.asUser<{
      q: {
        question_id: string;
        options: Array<{ id: string; option_text: string; is_correct: boolean }>;
      };
    }>(
      admin.id,
      `SELECT public.admin_upsert_question_with_options(
        $1::uuid,
        'Helium is a noble gas.',
        'true_false',
        5.0,
        $2::jsonb,
        NULL,
        0.0,
        'SECRET EXPLANATION: Helium is in Group 18.'
      ) AS q`,
      [
        examId,
        JSON.stringify([
          { option_text: 'True', is_correct: true },
          { option_text: 'False', is_correct: false },
        ]),
      ]
    );

    await harness.asUser(admin.id, `SELECT * FROM public.admin_publish_exam($1::uuid)`, [examId]);
    await harness.asUser(
      admin.id,
      `SELECT * FROM public.admin_assign_exam($1::uuid, $2::uuid, NULL, 'active')`,
      [examId, student1.id]
    );
    await harness.asUser(
      admin.id,
      `SELECT * FROM public.admin_assign_exam($1::uuid, $2::uuid, NULL, 'active')`,
      [examId, student2.id]
    );

    // 1. Direct SELECT on exam_questions and question_options as student returns ZERO rows!
    const directQuestions = await harness.asUser(
      student1.id,
      `SELECT * FROM public.exam_questions WHERE exam_id = $1::uuid`,
      [examId]
    );
    const directOptions = await harness.asUser(
      student1.id,
      `SELECT * FROM public.question_options`
    );
    expect(directQuestions).toHaveLength(0);
    expect(directOptions).toHaveLength(0);

    // 2. Start attempt and inspect active question payload -> NO is_correct, NO explanation!
    const attemptStart = await harness.asUser<{ res: { attempt_id: string } }>(
      student1.id,
      `SELECT public.student_start_or_resume_attempt($1::uuid) AS res`,
      [examId]
    );
    const attempt1Id = attemptStart[0].res.attempt_id;

    const activePayload = await harness.asUser<{ res: Record<string, unknown> }>(
      student1.id,
      `SELECT public.student_get_attempt_questions($1::uuid) AS res`,
      [attempt1Id]
    );
    const serialized = JSON.stringify(activePayload[0].res);
    expect(serialized).not.toContain('is_correct');
    expect(serialized).not.toContain('SECRET EXPLANATION');

    // 3. Cross-student attack: Student 2 cannot read or save answers to Student 1's attempt
    await expect(
      harness.asUser(
        student2.id,
        `SELECT public.student_get_attempt_questions($1::uuid)`,
        [attempt1Id]
      )
    ).rejects.toThrow(/FORBIDDEN_ATTEMPT_ACCESS/);

    await expect(
      harness.asUser(
        student2.id,
        `SELECT public.student_save_answer($1::uuid, $2::uuid, $3::uuid)`,
        [attempt1Id, q1[0].q.question_id, q1[0].q.options[0].id]
      )
    ).rejects.toThrow(/FORBIDDEN_ATTEMPT_ACCESS/);

    // 4. Cross-question option attack: selecting Q2's option for Q1 is rejected!
    await expect(
      harness.asUser(
        student1.id,
        `SELECT public.student_save_answer($1::uuid, $2::uuid, $3::uuid)`,
        [attempt1Id, q1[0].q.question_id, q2[0].q.options[0].id]
      )
    ).rejects.toThrow(/OPTION_QUESTION_MISMATCH/);

    // 5. Repeated saves update revision in-place without creating duplicate rows
    const wrongQ1Opt = q1[0].q.options.find((o) => !o.is_correct)!;
    const rightQ1Opt = q1[0].q.options.find((o) => o.is_correct)!;

    const save1 = await harness.asUser<{ res: { revision: number } }>(
      student1.id,
      `SELECT public.student_save_answer($1::uuid, $2::uuid, $3::uuid) AS res`,
      [attempt1Id, q1[0].q.question_id, wrongQ1Opt.id]
    );
    const save2 = await harness.asUser<{ res: { revision: number } }>(
      student1.id,
      `SELECT public.student_save_answer($1::uuid, $2::uuid, $3::uuid) AS res`,
      [attempt1Id, q1[0].q.question_id, rightQ1Opt.id]
    );
    expect(save1[0].res.revision).toBe(1);
    expect(save2[0].res.revision).toBe(2);

    const savedRows = await harness.asUser(
      student1.id,
      `SELECT * FROM public.student_answers WHERE attempt_id = $1::uuid`,
      [attempt1Id]
    );
    expect(savedRows).toHaveLength(1);

    // Leave Q2 unanswered and submit attempt (exam has 'manual' release policy!)
    const submit1 = await harness.asUser<{
      res: { result_released: boolean; already_finalized: boolean; result?: unknown };
    }>(student1.id, `SELECT public.student_submit_attempt($1::uuid) AS res`, [attempt1Id]);

    expect(submit1[0].res.already_finalized).toBe(false);
    expect(submit1[0].res.result_released).toBe(false);
    expect(submit1[0].res.result).toBeUndefined();

    // Duplicate submission retry is idempotent and creates NO second result
    const submitRetry = await harness.asUser<{ res: { already_finalized: boolean } }>(
      student1.id,
      `SELECT public.student_submit_attempt($1::uuid) AS res`,
      [attempt1Id]
    );
    expect(submitRetry[0].res.already_finalized).toBe(true);

    // Post-submission answer modification MUST be rejected
    await expect(
      harness.asUser(
        student1.id,
        `SELECT public.student_save_answer($1::uuid, $2::uuid, $3::uuid)`,
        [attempt1Id, q2[0].q.question_id, q2[0].q.options[0].id]
      )
    ).rejects.toThrow(/ATTEMPT_NOT_ACTIVE/);

    // Before manual release: student CANNOT read results directly or call review RPC!
    const preReleaseResults = await harness.asUser(
      student1.id,
      `SELECT * FROM public.results WHERE attempt_id = $1::uuid`,
      [attempt1Id]
    );
    expect(preReleaseResults).toHaveLength(0);

    await expect(
      harness.asUser(
        student1.id,
        `SELECT public.student_get_attempt_review($1::uuid)`,
        [attempt1Id]
      )
    ).rejects.toThrow(/RESULT_NOT_RELEASED/);

    // Admin releases results manually, BUT disables allow_review first:
    // Student can see summary score (5/10 = 50%, FAIL since pass=60%), NOT answer keys/explanations!
    await harness.asUser(
      admin.id,
      `SELECT * FROM public.admin_set_exam_release_settings($1::uuid, 'manual', true, false)`,
      [examId]
    );

    const releasedSummary = await harness.asUser<{
      res: Array<{ marks_obtained: number; total_marks: number; percentage: number; passed: boolean }>;
    }>(student1.id, `SELECT public.student_get_released_results() AS res`);
    expect(releasedSummary[0].res).toHaveLength(1);
    expect(Number(releasedSummary[0].res[0].marks_obtained)).toBe(5);
    expect(Number(releasedSummary[0].res[0].total_marks)).toBe(10);
    expect(Number(releasedSummary[0].res[0].percentage)).toBe(50);
    expect(releasedSummary[0].res[0].passed).toBe(false);

    await expect(
      harness.asUser(
        student1.id,
        `SELECT public.student_get_attempt_review($1::uuid)`,
        [attempt1Id]
      )
    ).rejects.toThrow(/REVIEW_NOT_PERMITTED/);

    // Admin enables allow_review = true -> Student 1 can now review explanations, while Student 2 still CANNOT!
    await harness.asUser(
      admin.id,
      `SELECT * FROM public.admin_set_exam_release_settings($1::uuid, 'manual', true, true)`,
      [examId]
    );

    const review = await harness.asUser<{
      res: { questions: Array<{ explanation: string; outcome: string }> };
    }>(student1.id, `SELECT public.student_get_attempt_review($1::uuid) AS res`, [attempt1Id]);
    expect(review[0].res.questions[0].outcome).toBe('correct');
    expect(review[0].res.questions[1].outcome).toBe('unanswered');
    expect(review[0].res.questions[0].explanation).toContain('Carbon has 6 protons');

    await expect(
      harness.asUser(
        student2.id,
        `SELECT public.student_get_attempt_review($1::uuid)`,
        [attempt1Id]
      )
    ).rejects.toThrow(/FORBIDDEN_ATTEMPT_ACCESS/);

    // Controlled editing policy: exam now has attempts, so modifying questions or marks is LOCKED!
    await expect(
      harness.asUser(
        admin.id,
        `SELECT public.admin_upsert_question_with_options(
          $1::uuid, 'Injected New Question', 'true_false', 5.0,
          '[{"option_text":"True","is_correct":true},{"option_text":"False","is_correct":false}]'::jsonb
        )`,
        [examId]
      )
    ).rejects.toThrow(/EXAM_LOCKED_BY_ATTEMPTS/);
  });

  it('calculates negative marking accurately, clamps minimum score at 0, enforces after_window policy, and audits admin corrections', async () => {
    const windowEnd = await harness.asSuperuser<{ ts: string }>(
      `SELECT (public.utc_now() + interval '60 minutes')::text AS ts`
    );

    const examRows = await harness.asUser<{ id: string }>(
      admin.id,
      `SELECT * FROM public.admin_create_exam(
        'Negative Marking Exam', NULL, NULL, 20, 60.0,
        NULL, $1::timestamptz, 'after_window', true, false, false, 1, 180
      )`,
      [windowEnd[0].ts]
    );
    const examId = examRows[0].id;

    // Q1: 4 marks, -1 penalty; Q2: 6 marks, -2 penalty -> Total = 10 marks
    const q1 = await harness.asUser<{
      q: { question_id: string; options: Array<{ id: string; is_correct: boolean }> };
    }>(
      admin.id,
      `SELECT public.admin_upsert_question_with_options(
        $1::uuid, 'Question 1', 'multiple_choice', 4.0,
        '[{"option_text":"A","is_correct":true},{"option_text":"B","is_correct":false}]'::jsonb,
        NULL, 1.0
      ) AS q`,
      [examId]
    );

    const q2 = await harness.asUser<{
      q: { question_id: string; options: Array<{ id: string; is_correct: boolean }> };
    }>(
      admin.id,
      `SELECT public.admin_upsert_question_with_options(
        $1::uuid, 'Question 2', 'multiple_choice', 6.0,
        '[{"option_text":"X","is_correct":false},{"option_text":"Y","is_correct":true}]'::jsonb,
        NULL, 2.0
      ) AS q`,
      [examId]
    );

    await harness.asUser(admin.id, `SELECT * FROM public.admin_publish_exam($1::uuid)`, [examId]);
    await harness.asUser(
      admin.id,
      `SELECT * FROM public.admin_assign_exam($1::uuid, $2::uuid, NULL, 'active')`,
      [examId, student1.id]
    );
    await harness.asUser(
      admin.id,
      `SELECT * FROM public.admin_assign_exam($1::uuid, $2::uuid, NULL, 'active')`,
      [examId, student2.id]
    );

    // Student 1 answers Q1 wrong (-1) and Q2 right (+6) => 5.00 / 10.00 = 50% (FAIL)
    const s1Start = await harness.asUser<{ res: { attempt_id: string } }>(
      student1.id,
      `SELECT public.student_start_or_resume_attempt($1::uuid) AS res`,
      [examId]
    );
    await harness.asUser(
      student1.id,
      `SELECT public.student_save_answer($1::uuid, $2::uuid, $3::uuid)`,
      [
        s1Start[0].res.attempt_id,
        q1[0].q.question_id,
        q1[0].q.options.find((o) => !o.is_correct)!.id,
      ]
    );
    await harness.asUser(
      student1.id,
      `SELECT public.student_save_answer($1::uuid, $2::uuid, $3::uuid)`,
      [
        s1Start[0].res.attempt_id,
        q2[0].q.question_id,
        q2[0].q.options.find((o) => o.is_correct)!.id,
      ]
    );
    const s1Submit = await harness.asUser<{ res: { result_released: boolean } }>(
      student1.id,
      `SELECT public.student_submit_attempt($1::uuid) AS res`,
      [s1Start[0].res.attempt_id]
    );
    // Window still open -> after_window policy withholds result!
    expect(s1Submit[0].res.result_released).toBe(false);

    // Student 2 answers BOTH wrong (-1 + -2 = -3 raw) -> clamped to 0.00 / 10.00 = 0%
    const s2Start = await harness.asUser<{ res: { attempt_id: string } }>(
      student2.id,
      `SELECT public.student_start_or_resume_attempt($1::uuid) AS res`,
      [examId]
    );
    await harness.asUser(
      student2.id,
      `SELECT public.student_save_answer($1::uuid, $2::uuid, $3::uuid)`,
      [
        s2Start[0].res.attempt_id,
        q1[0].q.question_id,
        q1[0].q.options.find((o) => !o.is_correct)!.id,
      ]
    );
    await harness.asUser(
      student2.id,
      `SELECT public.student_save_answer($1::uuid, $2::uuid, $3::uuid)`,
      [
        s2Start[0].res.attempt_id,
        q2[0].q.question_id,
        q2[0].q.options.find((o) => !o.is_correct)!.id,
      ]
    );
    await harness.asUser(
      student2.id,
      `SELECT public.student_submit_attempt($1::uuid)`,
      [s2Start[0].res.attempt_id]
    );

    // Simulate exam availability window closing -> after_window automatically releases results!
    await harness.asSuperuser(
      `UPDATE public.exams SET scheduled_end_at = public.utc_now() - interval '1 minute' WHERE id = $1::uuid`,
      [examId]
    );

    const s1Results = await harness.asUser<{
      res: Array<{ result_id: string; marks_obtained: number; percentage: number; passed: boolean }>;
    }>(student1.id, `SELECT public.student_get_released_results() AS res`);
    const s1Target = s1Results[0].res[0];
    expect(Number(s1Target.marks_obtained)).toBe(5);
    expect(Number(s1Target.percentage)).toBe(50);
    expect(s1Target.passed).toBe(false);

    const s2Results = await harness.asUser<{
      res: Array<{ marks_obtained: number; percentage: number }>;
    }>(student2.id, `SELECT public.student_get_released_results() AS res`);
    expect(Number(s2Results[0].res[0].marks_obtained)).toBe(0);
    expect(Number(s2Results[0].res[0].percentage)).toBe(0);

    // Audited Admin Result Correction: requires explicit reason and increments marking_version
    await expect(
      harness.asUser(
        admin.id,
        `SELECT * FROM public.admin_correct_result($1::uuid, 7.0, '')`,
        [s1Target.result_id]
      )
    ).rejects.toThrow(/REASON_REQUIRED/);

    const corrected = await harness.asUser<{
      marks_obtained: string;
      percentage: string;
      passed: boolean;
      marking_version: number;
    }>(
      admin.id,
      `SELECT * FROM public.admin_correct_result($1::uuid, 7.0, 'Ambiguous wording in Question 1 granted credit.')`,
      [s1Target.result_id]
    );
    expect(Number(corrected[0].marks_obtained)).toBe(7);
    expect(Number(corrected[0].percentage)).toBe(70);
    expect(corrected[0].passed).toBe(true);
    expect(corrected[0].marking_version).toBe(2);
  });
});
