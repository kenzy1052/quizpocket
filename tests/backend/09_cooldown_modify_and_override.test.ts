import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { LocalPostgresBackendGateway } from '../../src/backend/db/localPostgresGateway.ts';
import { createBackendApiRouter } from '../../src/backend/app.ts';

describe('09 — Admin can modify the retake cooldown and override it (all students)', () => {
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
    if (gateway) await gateway.close();
  });

  it('changes cooldown to a custom value, rejects invalid values, and unlocks everyone', async () => {
    const student = await request(app)
      .post('/api/auth/login')
      .send({ username: 'Amina Okafor', password: 'QuizPocket#Student1' })
      .expect(200);
    const studentToken = student.body.data.access_token as string;

    const admin = await request(app)
      .post('/api/auth/login')
      .send({ username: 'kenzy', password: 'kenzy1052' })
      .expect(200);
    const adminToken = admin.body.data.access_token as string;

    const exams = await request(app)
      .get('/api/student/exams')
      .set('Authorization', `Bearer ${studentToken}`)
      .expect(200);
    const examId = exams.body.data[0].id as string;

    // Custom cooldown (137 minutes is not one of the presets) is saved and listed back
    await request(app)
      .patch(`/api/admin/exams/${examId}/access`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ retake_cooldown_minutes: 137 })
      .expect(200);

    const listed = await request(app)
      .get('/api/admin/exams')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const row = (listed.body.data as Array<{ id: string; retake_cooldown_minutes: number }>).find(
      (e) => e.id === examId
    );
    expect(row?.retake_cooldown_minutes).toBe(137);

    // Invalid values are rejected with a clear 422 instead of a generic server error
    for (const bad of [-5, 99999, 1.5, '60']) {
      const res = await request(app)
        .patch(`/api/admin/exams/${examId}/access`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ retake_cooldown_minutes: bad })
        .expect(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }

    // Student attempts and submits, then is locked by the 137-minute cooldown
    const start = await request(app)
      .post(`/api/student/exams/${examId}/attempts`)
      .set('Authorization', `Bearer ${studentToken}`)
      .expect(200);
    await request(app)
      .post(`/api/student/attempts/${start.body.data.attempt_id}/submit`)
      .set('Authorization', `Bearer ${studentToken}`)
      .expect(200);

    const locked = await request(app)
      .get('/api/student/exams')
      .set('Authorization', `Bearer ${studentToken}`)
      .expect(200);
    expect(locked.body.data[0].availability_state).toBe('cooldown');

    // Quiz-wide override ("Unlock All Retakes") frees the student immediately
    await request(app)
      .post(`/api/admin/exams/${examId}/unlock-retake`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ student_id: null, reason: 'Unlock all' })
      .expect(200);

    const freed = await request(app)
      .get('/api/student/exams')
      .set('Authorization', `Bearer ${studentToken}`)
      .expect(200);
    expect(freed.body.data[0].availability_state).toBe('available');
  });
});
