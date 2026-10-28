import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackendApiRouter } from '../../src/backend/app.ts';
import { sanitizeCsvCell } from '../../src/backend/utils/csv.ts';
import { SupabasePostgresHarness } from '../helpers/pgliteSupabaseHarness.ts';

describe('Stage 4 & 5: Administrative Analytics, CSV Formula Sanitization, and End-to-End HTTP API', () => {
  let harness: SupabasePostgresHarness;
  let app: express.Express;
  let adminToken: string;
  let student1Token: string;
  let student1Id: string;
  let student2Token: string;
  let student2Id: string;
  let student3Id: string;

  beforeAll(async () => {
    harness = await SupabasePostgresHarness.create();

    const admin = await harness.createAuthUser({
      email: 'director@quizpocket.edu',
      password: 'AdminPassword#2026',
    });
    await harness.asServiceRole(
      `SELECT * FROM public.bootstrap_initial_admin($1::uuid, 'Director Lin')`,
      [admin.id]
    );
    adminToken = admin.token;

    // Student 1 has a malicious formula-injection name & identifier to test CSV export protection!
    const s1 = await harness.createAuthUser({
      email: 'formula.student@quizpocket.edu',
      password: 'StudentPassword#1',
    });
    student1Token = s1.token;
    student1Id = s1.id;

    const s2 = await harness.createAuthUser({
      email: 'regular.student@quizpocket.edu',
      password: 'StudentPassword#2',
    });
    student2Token = s2.token;
    student2Id = s2.id;

    const s3 = await harness.createAuthUser({
      email: 'notstarted.student@quizpocket.edu',
      password: 'StudentPassword#3',
    });
    student3Id = s3.id;

    await harness.asUser(
      admin.id,
      `SELECT * FROM public.admin_configure_student_profile($1::uuid, '=CMD|'' /C calc''!A0', '+STU-INJECT-1', 'active')`,
      [student1Id]
    );
    await harness.asUser(
      admin.id,
      `SELECT * FROM public.admin_configure_student_profile($1::uuid, 'Regular Student', 'STU-200', 'active')`,
      [student2Id]
    );
    await harness.asUser(
      admin.id,
      `SELECT * FROM public.admin_configure_student_profile($1::uuid, 'Unstarted Student', 'STU-300', 'active')`,
      [student3Id]
    );

    app = express();
    app.use(
      '/api',
      createBackendApiRouter({
        gateway: harness.createGateway(),
        cronSecret: 'test-cron-secret-999',
        authRateLimitMax: 6,
      })
    );
  });

  afterAll(async () => {
    await harness.close();
  });

  it('neutralizes all spreadsheet formula prefixes in sanitizeCsvCell', () => {
    expect(sanitizeCsvCell('=SUM(A1:A10)')).toBe("'=SUM(A1:A10)");
    expect(sanitizeCsvCell('+1+1')).toBe("'+1+1");
    expect(sanitizeCsvCell('-2+3')).toBe("'-2+3");
    expect(sanitizeCsvCell('@SUM(1,2)')).toBe(`"'@SUM(1,2)"`);
    expect(sanitizeCsvCell('   =HYPERLINK("http://evil.example")')).toBe(
      `"'   =HYPERLINK(""http://evil.example"")"`
    );
    expect(sanitizeCsvCell('\t=1+1')).toBe("'\t=1+1");
    expect(sanitizeCsvCell('Safe Name')).toBe('Safe Name');
  });

  it('executes full exam lifecycle over HTTP API, computes accurate analytics, and exports sanitized CSV', async () => {
    // 1. Unauthenticated request is rejected with 401
    const unauthRes = await request(app).get('/api/admin/students');
    expect(unauthRes.status).toBe(401);

    // 2. Student calling admin endpoint is rejected with 403
    const studentAdminAttempt = await request(app)
      .get('/api/admin/students')
      .set('Authorization', `Bearer ${student1Token}`);
    expect(studentAdminAttempt.status).toBe(403);

    // 3. Student attempting to smuggle role="admin" on PATCH /api/me is rejected with 403
    const roleSmuggle = await request(app)
      .patch('/api/me')
      .set('Authorization', `Bearer ${student1Token}`)
      .send({ full_name: 'Innocent', role: 'admin' });
    expect(roleSmuggle.status).toBe(403);

    // 4. Admin creates class, enrolls all 3 students, creates exam, adds 2 questions, publishes, and assigns to class
    const classRes = await request(app)
      .post('/api/admin/classes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Biology 101', description: 'Cell Biology' });
    expect(classRes.status).toBe(201);
    const classId = classRes.body.data.id;

    for (const sid of [student1Id, student2Id, student3Id]) {
      const mem = await request(app)
        .put(`/api/admin/classes/${classId}/members/${sid}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ membership_status: 'active' });
      expect(mem.status).toBe(200);
    }

    const examRes = await request(app)
      .post('/api/admin/exams')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: '@Biology Midterm Assessment',
        duration_minutes: 30,
        passing_percentage: 50,
        result_release_policy: 'immediate',
        allow_review: true,
        max_attempts: 1,
      });
    expect(examRes.status).toBe(201);
    const examId = examRes.body.data.id;

    const q1Res = await request(app)
      .post(`/api/admin/exams/${examId}/questions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        question_text: 'Mitochondria generate ATP via cellular respiration.',
        question_type: 'true_false',
        marks: 5,
        explanation: 'Mitochondria are the primary site of oxidative phosphorylation.',
        options: [
          { option_text: 'True', is_correct: true },
          { option_text: 'False', is_correct: false },
        ],
      });
    expect(q1Res.status).toBe(201);

    const q2Res = await request(app)
      .post(`/api/admin/exams/${examId}/questions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        question_text: 'Which organelle performs photosynthesis?',
        question_type: 'multiple_choice',
        marks: 5,
        explanation: 'Chloroplasts capture light energy in plant cells.',
        options: [
          { option_text: 'Ribosome', is_correct: false },
          { option_text: 'Chloroplast', is_correct: true },
          { option_text: 'Golgi apparatus', is_correct: false },
        ],
      });
    expect(q2Res.status).toBe(201);

    const pubRes = await request(app)
      .post(`/api/admin/exams/${examId}/publish`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(pubRes.status).toBe(200);

    const assignRes = await request(app)
      .post(`/api/admin/exams/${examId}/assignments`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ class_id: classId });
    expect(assignRes.status).toBe(200);

    // 5. Student 1 takes exam and gets 10/10 (100% PASS)
    const s1Start = await request(app)
      .post(`/api/student/exams/${examId}/attempts`)
      .set('Authorization', `Bearer ${student1Token}`);
    expect(s1Start.status).toBe(200);
    const s1AttemptId = s1Start.body.data.attempt_id;

    const s1Questions = await request(app)
      .get(`/api/student/attempts/${s1AttemptId}/questions`)
      .set('Authorization', `Bearer ${student1Token}`);
    expect(s1Questions.status).toBe(200);
    expect(JSON.stringify(s1Questions.body)).not.toContain('is_correct');

    await request(app)
      .put(`/api/student/attempts/${s1AttemptId}/answers`)
      .set('Authorization', `Bearer ${student1Token}`)
      .send({
        question_id: q1Res.body.data.question_id,
        selected_option_id: q1Res.body.data.options[0].id, // True
      })
      .expect(200);

    await request(app)
      .put(`/api/student/attempts/${s1AttemptId}/answers`)
      .set('Authorization', `Bearer ${student1Token}`)
      .send({
        question_id: q2Res.body.data.question_id,
        selected_option_id: q2Res.body.data.options[1].id, // Chloroplast
      })
      .expect(200);

    const s1Sub = await request(app)
      .post(`/api/student/attempts/${s1AttemptId}/submit`)
      .set('Authorization', `Bearer ${student1Token}`)
      .expect(200);
    expect(Number(s1Sub.body.data.result.percentage)).toBe(100);
    expect(s1Sub.body.data.result.passed).toBe(true);

    // 6. Student 2 starts attempt, answers Q1 wrong, and lets timer expire -> cron sweeps it!
    const s2Start = await request(app)
      .post(`/api/student/exams/${examId}/attempts`)
      .set('Authorization', `Bearer ${student2Token}`)
      .expect(200);
    const s2AttemptId = s2Start.body.data.attempt_id;

    await request(app)
      .put(`/api/student/attempts/${s2AttemptId}/answers`)
      .set('Authorization', `Bearer ${student2Token}`)
      .send({
        question_id: q1Res.body.data.question_id,
        selected_option_id: q1Res.body.data.options[1].id, // False (wrong)
      })
      .expect(200);

    await harness.asSuperuser(
      `UPDATE public.exam_attempts
       SET started_at = public.utc_now() - interval '35 minutes',
           deadline_at = public.utc_now() - interval '5 minutes'
       WHERE id = $1::uuid`,
      [s2AttemptId]
    );

    // Unauthorized cron request is rejected
    await request(app)
      .post('/api/internal/cron/finalize-expired-attempts')
      .set('x-cron-secret', 'wrong-secret')
      .expect(401);

    // Authorized cron sweep finalizes Student 2's expired attempt as auto_submitted (0/10 FAIL)
    const cronRes = await request(app)
      .post('/api/internal/cron/finalize-expired-attempts')
      .set('x-cron-secret', 'test-cron-secret-999')
      .expect(200);
    expect(cronRes.body.data.finalized_count).toBe(1);

    // 7. Verify Admin Examination Statistics (3 assigned, 2 started, 1 submitted, 1 auto_submitted, 1 not attempted)
    const statsRes = await request(app)
      .get(`/api/admin/exams/${examId}/statistics`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const stats = statsRes.body.data;
    expect(stats.assigned_students_count).toBe(3);
    expect(stats.started_students_count).toBe(2);
    expect(stats.not_attempted_students_count).toBe(1);
    expect(stats.submitted_count).toBe(1);
    expect(stats.auto_submitted_count).toBe(1);
    expect(Number(stats.highest_score)).toBe(10);
    expect(Number(stats.lowest_score)).toBe(0);
    expect(Number(stats.average_score)).toBe(5);
    expect(Number(stats.pass_rate)).toBe(50);
    expect(Number(stats.failure_rate)).toBe(50);
    expect(Number(stats.completion_rate)).toBeCloseTo(66.67, 1);

    // 8. Verify admins can see each student attempt and its marks
    const attemptsRes = await request(app)
      .get(`/api/admin/exams/${examId}/attempts`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(attemptsRes.body.data).toHaveLength(2);
    const submittedAttempt = attemptsRes.body.data.find(
      (attempt: { attempt_id: string }) => attempt.attempt_id === s1AttemptId
    );
    expect(submittedAttempt).toMatchObject({
      status: 'submitted',
      marks_obtained: 10,
      total_marks: 10,
      percentage: 100,
      passed: true,
    });

    const autoSubmittedAttempt = attemptsRes.body.data.find(
      (attempt: { attempt_id: string }) => attempt.attempt_id === s2AttemptId
    );
    expect(autoSubmittedAttempt).toMatchObject({
      status: 'auto_submitted',
      marks_obtained: 0,
      total_marks: 10,
      percentage: 0,
      passed: false,
    });

    const attemptDetailRes = await request(app)
      .get(`/api/admin/attempts/${s1AttemptId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(attemptDetailRes.body.data.result.marks_obtained).toBe(10);
    expect(attemptDetailRes.body.data.questions).toHaveLength(2);

    // 9. Verify Question-Level Analytics
    const qAnalyticsRes = await request(app)
      .get(`/api/admin/exams/${examId}/question-analytics`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(qAnalyticsRes.body.data).toHaveLength(2);
    expect(qAnalyticsRes.body.data[0].correct_count).toBe(1);
    expect(qAnalyticsRes.body.data[0].incorrect_count).toBe(1);
    expect(qAnalyticsRes.body.data[1].correct_count).toBe(1);
    expect(qAnalyticsRes.body.data[1].unanswered_count).toBe(1);

    // 10. Verify Class Performance Summary
    const classSummaryRes = await request(app)
      .get(`/api/admin/exams/${examId}/class-summary`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(classSummaryRes.body.data[0].enrolled_students).toBe(3);
    expect(classSummaryRes.body.data[0].completed_attempts).toBe(2);

    // 11. Verify CSV Export & Formula-Injection Protection
    // Student cannot export CSV
    await request(app)
      .get(`/api/admin/exams/${examId}/export.csv`)
      .set('Authorization', `Bearer ${student1Token}`)
      .expect(403);

    const csvRes = await request(app)
      .get(`/api/admin/exams/${examId}/export.csv`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(csvRes.headers['content-type']).toContain('text/csv');
    const csvText = csvRes.text;
    // Malicious "=CMD|..." student name, "+STU-INJECT-1" identifier, and "@Biology..." title
    // MUST be prefixed with a leading single quote, never raw unquoted formula starters!
    expect(csvText).toContain("'=CMD|");
    expect(csvText).toContain("'+STU-INJECT-1");
    expect(csvText).toContain("'@Biology Midterm Assessment");
    expect(csvText).not.toMatch(/(?:^|,|\n)=CMD/m);
  });

  it('prevents email enumeration on password reset and enforces rate limiting on auth routes', async () => {
    const existingEmailRes = await request(app)
      .post('/api/auth/password-reset')
      .send({ email: 'director@quizpocket.edu' })
      .expect(200);

    const unknownEmailRes = await request(app)
      .post('/api/auth/password-reset')
      .send({ email: 'nobody.unknown@quizpocket.edu' })
      .expect(200);

    // Exact same status and message for registered vs unregistered emails
    expect(existingEmailRes.body).toEqual(unknownEmailRes.body);

    // Exceed configured authRateLimitMax (6 requests/min) -> returns 429 Too Many Requests
    let hit429 = false;
    for (let i = 0; i < 8; i++) {
      const r = await request(app)
        .post('/api/auth/login')
        .send({ email: 'director@quizpocket.edu', password: 'wrong' });
      if (r.status === 429) {
        hit429 = true;
        break;
      }
    }
    expect(hit429).toBe(true);
  });
});
