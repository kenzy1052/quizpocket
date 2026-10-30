import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { LocalPostgresBackendGateway } from '../../src/backend/db/localPostgresGateway.ts';
import { createBackendApiRouter } from '../../src/backend/app.ts';

describe('05 — Username+Password Auth, kenzy Admin, HIM 105 Lecture 1 Seed, Open/Close & 3-Hour Cooldown Override', () => {
  let gateway: LocalPostgresBackendGateway;
  let app: express.Express;

  beforeAll(async () => {
    gateway = await LocalPostgresBackendGateway.create({ seedDemoData: true });
    app = express();
    app.use(
      '/api',
      createBackendApiRouter({
        gateway,
        cronSecret: 'test-cron-secret',
        authRateLimitMax: 100,
        attemptRateLimitMax: 100,
      })
    );
  });

  afterAll(async () => {
    if (gateway) {
      await gateway.close();
    }
  });

  it('authenticates administrator kenzy (kenzy1052) and seeds HIM 105 Lecture 1 (30 min, 20 questions) with zero draft quizzes', async () => {
    const adminLogin = await request(app)
      .post('/api/auth/login')
      .send({ username: 'kenzy', password: 'kenzy1052' })
      .expect(200);

    expect(adminLogin.body.data.profile.role).toBe('admin');
    expect(adminLogin.body.data.profile.username).toBe('kenzy');

    const examsRes = await request(app)
      .get('/api/admin/exams')
      .set('Authorization', `Bearer ${adminLogin.body.data.access_token}`)
      .expect(200);

    expect(examsRes.body.data).toHaveLength(3);
    const himExam = examsRes.body.data.find(
      (e: { title: string }) => e.title === 'HIM 105 Lecture 1'
    );
    const ch1Exam = examsRes.body.data.find(
      (e: { title: string }) => e.title === 'HIM 103 Chapter 1'
    );
    const swExam = examsRes.body.data.find(
      (e: { title: string }) => e.title === 'HIM 101: Software System'
    );
    expect(swExam.status).toBe('published');
    expect(swExam.is_open).toBe(true);
    expect(Number(swExam.duration_minutes)).toBe(60);
    expect(Number(swExam.question_count)).toBe(40);
    expect(Number(swExam.total_marks)).toBe(50);

    expect(ch1Exam.status).toBe('published');
    expect(ch1Exam.is_open).toBe(true);
    expect(Number(ch1Exam.duration_minutes)).toBe(40);
    expect(Number(ch1Exam.question_count)).toBe(40);
    expect(Number(ch1Exam.total_marks)).toBe(40);
    expect(himExam.title).toBe('HIM 105 Lecture 1');
    expect(himExam.status).toBe('published');
    expect(himExam.is_open).toBe(true);
    expect(Number(himExam.duration_minutes)).toBe(30);
    expect(Number(himExam.question_count)).toBe(20);
    expect(Number(himExam.total_marks)).toBe(20);
  });

  it('enforces >= 8 character password on Create Account, signs up with Name + Password only, and exposes HIM 105 Lecture 1 as available', async () => {
    await request(app)
      .post('/api/auth/signup')
      .send({ username: 'kwame', password: 'short77' })
      .expect(422);

    await request(app)
      .post('/api/auth/signup')
      .send({ username: 'kenzy', password: 'anotherpass12' })
      .expect(409);

    const signupRes = await request(app)
      .post('/api/auth/signup')
      .send({ username: 'Kwame Boateng', password: 'kwame1234' })
      .expect(201);

    expect(signupRes.body.data.profile.role).toBe('student');
    expect(signupRes.body.data.profile.username).toBe('Kwame Boateng');
    expect(signupRes.body.data.access_token).toBeTruthy();

    const eligibleRes = await request(app)
      .get('/api/student/exams')
      .set('Authorization', `Bearer ${signupRes.body.data.access_token}`)
      .expect(200);

    expect(eligibleRes.body.data).toHaveLength(3);
    const ch1 = eligibleRes.body.data.find(
      (e: { title: string }) => e.title === 'HIM 103 Chapter 1'
    );
    expect(ch1).toBeTruthy();
    expect(Number(ch1.duration_minutes)).toBe(40);
    const lecture1 = eligibleRes.body.data.find(
      (e: { title: string }) => e.title === 'HIM 105 Lecture 1'
    );
    expect(Number(lecture1.duration_minutes)).toBe(30);
    expect(lecture1.availability_state).toBe('available');
    expect(lecture1.is_open).toBe(true);

    const sw = eligibleRes.body.data.find(
      (e: { title: string }) => e.title === 'HIM 101: Software System'
    );
    expect(sw).toBeTruthy();
    expect(Number(sw.duration_minutes)).toBe(60);
    expect(sw.availability_state).toBe('available');
    expect(sw.is_open).toBe(true);

    const reloginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'kwame boateng', password: 'kwame1234' })
      .expect(200);

    expect(reloginRes.body.data.profile.id).toBe(signupRes.body.data.profile.id);
  });

  it('delivers 20 HIM 105 Lecture 1 questions (12 MCQ, 3 T/F, 5 Fill-in-the-Blank), returns immediate score & explanations on submit, and supports 3-hour cooldown & overrides', async () => {
    const aminaLogin = await request(app)
      .post('/api/auth/login')
      .send({ username: 'Amina Okafor', password: 'QuizPocket#Student1' })
      .expect(200);
    const aminaToken = aminaLogin.body.data.access_token as string;
    const aminaId = aminaLogin.body.data.profile.id as string;

    const eligibleRes = await request(app)
      .get('/api/student/exams')
      .set('Authorization', `Bearer ${aminaToken}`)
      .expect(200);

    expect(eligibleRes.body.data).toHaveLength(3);
    const lecture1Exam = eligibleRes.body.data.find(
      (e: { title: string }) => e.title === 'HIM 105 Lecture 1'
    );
    expect(lecture1Exam.availability_state).toBe('available');
    const examId = lecture1Exam.id as string;

    const startRes = await request(app)
      .post(`/api/student/exams/${examId}/attempts`)
      .set('Authorization', `Bearer ${aminaToken}`)
      .expect(200);

    const attemptId = startRes.body.data.attempt_id as string;

    const qRes = await request(app)
      .get(`/api/student/attempts/${attemptId}/questions`)
      .set('Authorization', `Bearer ${aminaToken}`)
      .expect(200);

    expect(Number(qRes.body.data.duration_minutes)).toBe(30);

    const questions = qRes.body.data.questions as Array<{
      id: string;
      display_order: number;
      question_type: string;
      options: Array<{ id: string; option_text: string }>;
    }>;
    expect(questions).toHaveLength(20);
    expect(questions.filter((q) => q.question_type === 'multiple_choice')).toHaveLength(12);
    expect(questions.filter((q) => q.question_type === 'true_false')).toHaveLength(3);
    expect(questions.filter((q) => q.question_type === 'fill_in_blank')).toHaveLength(5);

    const serialized = JSON.stringify(questions);
    expect(serialized).not.toContain('is_correct');
    expect(serialized).not.toContain('accepted_answers');
    expect(serialized).not.toContain('rubric_keywords');
    expect(serialized).not.toContain('explanation');

    const q1 = questions.find((q) => q.display_order === 1)!;
    const q14 = questions.find((q) => q.display_order === 14)!;
    const q16 = questions.find((q) => q.display_order === 16)!;
    const q17 = questions.find((q) => q.display_order === 17)!;
    const q18 = questions.find((q) => q.display_order === 18)!;
    const q19 = questions.find((q) => q.display_order === 19)!;
    const q20 = questions.find((q) => q.display_order === 20)!;

    const q1CorrectOpt = q1.options.find((o) =>
      o.option_text.includes('professional practice of collecting')
    )!;
    const q14CorrectOpt = q14.options.find((o) => o.option_text === 'False')!;

    await request(app)
      .put(`/api/student/attempts/${attemptId}/answers`)
      .set('Authorization', `Bearer ${aminaToken}`)
      .send({ question_id: q1.id, selected_option_id: q1CorrectOpt.id })
      .expect(200);

    await request(app)
      .put(`/api/student/attempts/${attemptId}/answers`)
      .set('Authorization', `Bearer ${aminaToken}`)
      .send({ question_id: q14.id, selected_option_id: q14CorrectOpt.id })
      .expect(200);

    await request(app)
      .put(`/api/student/attempts/${attemptId}/answers`)
      .set('Authorization', `Bearer ${aminaToken}`)
      .send({ question_id: q16.id, answer_value: 'icd 10' })
      .expect(200);

    await request(app)
      .put(`/api/student/attempts/${attemptId}/answers`)
      .set('Authorization', `Bearer ${aminaToken}`)
      .send({ question_id: q17.id, answer_value: 'association' })
      .expect(200);

    await request(app)
      .put(`/api/student/attempts/${attemptId}/answers`)
      .set('Authorization', `Bearer ${aminaToken}`)
      .send({ question_id: q18.id, answer_value: 'Coding' })
      .expect(200);

    await request(app)
      .put(`/api/student/attempts/${attemptId}/answers`)
      .set('Authorization', `Bearer ${aminaToken}`)
      .send({ question_id: q19.id, answer_value: 'PATHOLOGY' })
      .expect(200);

    await request(app)
      .put(`/api/student/attempts/${attemptId}/answers`)
      .set('Authorization', `Bearer ${aminaToken}`)
      .send({ question_id: q20.id, answer_value: 'radiology' })
      .expect(200);

    const submitRes = await request(app)
      .post(`/api/student/attempts/${attemptId}/submit`)
      .set('Authorization', `Bearer ${aminaToken}`)
      .expect(200);

    expect(submitRes.body.data.result_released).toBe(true);
    expect(submitRes.body.data.allow_review).toBe(true);
    expect(Number(submitRes.body.data.result.marks_obtained)).toBe(7);
    expect(Number(submitRes.body.data.result.total_marks)).toBe(20);

    // Student immediately views full review with answers and explanations
    const reviewRes = await request(app)
      .get(`/api/student/attempts/${attemptId}/review`)
      .set('Authorization', `Bearer ${aminaToken}`)
      .expect(200);

    expect(reviewRes.body.data.exam_title).toBe('HIM 105 Lecture 1');
    expect(Number(reviewRes.body.data.marks_obtained)).toBe(7);
    expect(reviewRes.body.data.questions).toHaveLength(20);
    expect(
      reviewRes.body.data.questions.every(
        (item: { explanation: string | null }) =>
          typeof item.explanation === 'string' && item.explanation.length > 0
      )
    ).toBe(true);

    // Immediately after submitting, student is locked in 3-hour cooldown
    const postSubmitExams = await request(app)
      .get('/api/student/exams')
      .set('Authorization', `Bearer ${aminaToken}`)
      .expect(200);
    const submittedExam = postSubmitExams.body.data.find((e: { id: string }) => e.id === examId);
    expect(submittedExam.availability_state).toBe('cooldown');
    expect(submittedExam.next_eligible_attempt_at).toBeTruthy();

    const blockedRetake = await request(app)
      .post(`/api/student/exams/${examId}/attempts`)
      .set('Authorization', `Bearer ${aminaToken}`)
      .expect(409);
    expect(blockedRetake.body.error.code).toBe('RETAKE_COOLDOWN_ACTIVE');

    // Administrator kenzy tests Close/Open quiz and overrides Amina's 3-hour cooldown
    const adminLogin = await request(app)
      .post('/api/auth/login')
      .send({ username: 'kenzy', password: 'kenzy1052' })
      .expect(200);
    const adminToken = adminLogin.body.data.access_token as string;

    await request(app)
      .patch(`/api/admin/exams/${examId}/access`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ is_open: false })
      .expect(200);

    const closedCheck = await request(app)
      .get('/api/student/exams')
      .set('Authorization', `Bearer ${aminaToken}`)
      .expect(200);
    const closedRow = closedCheck.body.data.find((e: { id: string }) => e.id === examId);
    expect(closedRow.availability_state).toBe('closed');
    expect(closedRow.is_open).toBe(false);

    const closedStart = await request(app)
      .post(`/api/student/exams/${examId}/attempts`)
      .set('Authorization', `Bearer ${aminaToken}`)
      .expect(409);
    expect(closedStart.body.error.code).toBe('EXAM_CLOSED_BY_ADMIN');

    await request(app)
      .patch(`/api/admin/exams/${examId}/access`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ is_open: true })
      .expect(200);

    await request(app)
      .post(`/api/admin/exams/${examId}/unlock-retake`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ student_id: aminaId, reason: 'Instructor approved immediate retake' })
      .expect(200);

    const unlockedCheck = await request(app)
      .get('/api/student/exams')
      .set('Authorization', `Bearer ${aminaToken}`)
      .expect(200);
    const unlockedRow = unlockedCheck.body.data.find((e: { id: string }) => e.id === examId);
    expect(unlockedRow.availability_state).toBe('available');

    const retakeStart = await request(app)
      .post(`/api/student/exams/${examId}/attempts`)
      .set('Authorization', `Bearer ${aminaToken}`)
      .expect(200);
    expect(retakeStart.body.data.attempt_number).toBe(2);
  });
  it('delivers HIM 103 Chapter 1 as a 40-question, 40-minute MCQ quiz whose correct answers are hidden until review', async () => {
    const login = await request(app)
      .post('/api/auth/login')
      .send({ username: 'Marcus Rivera', password: 'QuizPocket#Student2' })
      .expect(200);
    const token = login.body.data.access_token as string;

    const eligible = await request(app)
      .get('/api/student/exams')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const ch1 = eligible.body.data.find((e: { title: string }) => e.title === 'HIM 103 Chapter 1');
    expect(ch1).toBeTruthy();
    expect(ch1.availability_state).toBe('available');

    const start = await request(app)
      .post(`/api/student/exams/${ch1.id}/attempts`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const attemptId = start.body.data.attempt_id as string;

    const qRes = await request(app)
      .get(`/api/student/attempts/${attemptId}/questions`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(Number(qRes.body.data.duration_minutes)).toBe(40);
    const questions = qRes.body.data.questions as Array<{
      question_type: string;
      options: Array<{ is_correct?: boolean }>;
    }>;
    expect(questions).toHaveLength(40);
    expect(questions.every((q) => q.question_type === 'multiple_choice')).toBe(true);
    expect(questions.every((q) => q.options.every((o) => o.is_correct === undefined))).toBe(true);

    const submit = await request(app)
      .post(`/api/student/attempts/${attemptId}/submit`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(submit.body.data.result_released).toBe(true);
    expect(Number(submit.body.data.result.total_marks)).toBe(40);
  });

  it('delivers HIM 101: Software System (40 questions, 60 min, 50 marks) with 35 MCQs and 5 Short Answer questions, supporting instructor partial grading', async () => {
    const studentLogin = await request(app)
      .post('/api/auth/login')
      .send({ username: 'Marcus Rivera', password: 'QuizPocket#Student2' })
      .expect(200);
    const studentToken = studentLogin.body.data.access_token as string;

    const adminLogin = await request(app)
      .post('/api/auth/login')
      .send({ username: 'kenzy', password: 'kenzy1052' })
      .expect(200);
    const adminToken = adminLogin.body.data.access_token as string;

    const eligible = await request(app)
      .get('/api/student/exams')
      .set('Authorization', `Bearer ${studentToken}`)
      .expect(200);
    const swExam = eligible.body.data.find(
      (e: { title: string }) => e.title === 'HIM 101: Software System'
    );
    expect(swExam).toBeTruthy();
    expect(Number(swExam.duration_minutes)).toBe(60);
    expect(Number(swExam.total_marks)).toBe(50);

    const start = await request(app)
      .post(`/api/student/exams/${swExam.id}/attempts`)
      .set('Authorization', `Bearer ${studentToken}`)
      .expect(200);
    const attemptId = start.body.data.attempt_id as string;

    const qRes = await request(app)
      .get(`/api/student/attempts/${attemptId}/questions`)
      .set('Authorization', `Bearer ${studentToken}`)
      .expect(200);
    const questions = qRes.body.data.questions as Array<{
      id: string;
      display_order: number;
      question_type: string;
      marks: number;
    }>;
    expect(questions).toHaveLength(40);

    const mcqs = questions.filter((q) => q.question_type === 'multiple_choice');
    const shortAnswers = questions.filter((q) => q.question_type === 'short_answer');
    expect(mcqs).toHaveLength(35);
    expect(shortAnswers).toHaveLength(5);
    expect(shortAnswers.every((q) => Number(q.marks) === 3)).toBe(true);

    // Student types a written answer for question 36
    const q36 = shortAnswers[0];
    await request(app)
      .put(`/api/student/attempts/${attemptId}/answers`)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({
        question_id: q36.id,
        answer_value:
          'Cold boot is turning on a computer from completely off. Warm boot restarts without turning power off. POST checks hardware components.',
      })
      .expect(200);

    // Submit attempt
    const submitRes = await request(app)
      .post(`/api/student/attempts/${attemptId}/submit`)
      .set('Authorization', `Bearer ${studentToken}`)
      .expect(200);
    expect(submitRes.body.data.result_released).toBe(true);
    expect(Number(submitRes.body.data.result.total_marks)).toBe(50);
    const resultId = submitRes.body.data.result_id as string;

    // Admin views attempt detail
    const attemptDetail = await request(app)
      .get(`/api/admin/attempts/${attemptId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(attemptDetail.body.data.exam.title).toBe('HIM 101: Software System');
    expect(attemptDetail.body.data.questions).toHaveLength(40);

    // Admin grades Q36 with 2 marks out of 3 marks (partial credit)
    const gradeRes = await request(app)
      .post(`/api/admin/results/${resultId}/items/${q36.id}/grade`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        marks_awarded: 2,
        reason: 'Good explanation of cold vs warm boot; POST description was brief.',
      })
      .expect(200);

    expect(Number(gradeRes.body.data.marks_obtained)).toBe(2);

    // Student reviews their attempt
    const studentReview = await request(app)
      .get(`/api/student/attempts/${attemptId}/review`)
      .set('Authorization', `Bearer ${studentToken}`)
      .expect(200);

    const reviewedQ36 = studentReview.body.data.questions.find(
      (q: { question_id: string }) => q.question_id === q36.id
    );
    expect(Number(reviewedQ36.marks_awarded)).toBe(2);
    expect(reviewedQ36.outcome).toBe('partial');
  });
});
