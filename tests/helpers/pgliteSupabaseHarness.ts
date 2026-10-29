import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PGlite } from '@electric-sql/pglite';
import { BackendGateway, SignInResult } from '../../src/backend/db/gateway.ts';
import { AppError, translateDatabaseError } from '../../src/backend/utils/errors.ts';
import {
  MIN_PASSWORD_LENGTH,
  normalizeUsername,
  usernameToSyntheticEmail,
} from '../../src/backend/utils/authIdentifier.ts';
import {
  AccountStatus,
  AssignmentStatus,
  AuthenticatedActor,
  CreateExamInput,
  ExamAccessSettingsInput,
  ExportResultRow,
  MembershipStatus,
  Profile,
  ResultReleasePolicy,
  UpsertQuestionInput,
} from '../../src/backend/types/domain.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.resolve(__dirname, '../../supabase/migrations');

/**
 * Bootstraps standard Supabase pre-existing auth schema and PostgreSQL roles
 * in an isolated in-memory PostgreSQL 16 (PGlite) database, then runs all
 * version-controlled SQL migrations from /supabase/migrations in order.
 */
const SUPABASE_PRELUDE_SQL = `
  DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

  CREATE SCHEMA IF NOT EXISTS auth;
  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

  CREATE TABLE IF NOT EXISTS auth.users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text UNIQUE NOT NULL,
    encrypted_password text NULL,
    raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT timezone('utc', now())
  );

  GRANT SELECT ON auth.users TO service_role;

  CREATE OR REPLACE FUNCTION auth.jwt()
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  AS $fn$
    SELECT COALESCE(
      NULLIF(current_setting('request.jwt.claims', true), ''),
      '{}'
    )::jsonb;
  $fn$;

  CREATE OR REPLACE FUNCTION auth.uid()
  RETURNS uuid
  LANGUAGE sql
  STABLE
  AS $fn$
    SELECT NULLIF(
      COALESCE(
        NULLIF(current_setting('request.jwt.claim.sub', true), ''),
        (auth.jwt() ->> 'sub')
      ),
      ''
    )::uuid;
  $fn$;

  CREATE OR REPLACE FUNCTION auth.role()
  RETURNS text
  LANGUAGE sql
  STABLE
  AS $fn$
    SELECT COALESCE(
      NULLIF(current_setting('request.jwt.claim.role', true), ''),
      NULLIF(auth.jwt() ->> 'role', ''),
      current_user::text
    );
  $fn$;

  GRANT EXECUTE ON FUNCTION auth.jwt() TO anon, authenticated, service_role;
  GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
  GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, service_role;
`;

export class SupabasePostgresHarness {
  public readonly db: PGlite;
  private readonly passwords = new Map<string, string>();
  private readonly tokens = new Map<string, string>();

  private constructor(db: PGlite) {
    this.db = db;
  }

  static async create(): Promise<SupabasePostgresHarness> {
    const db = new PGlite();
    await db.exec(SUPABASE_PRELUDE_SQL);

    const migrationFiles = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of migrationFiles) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await db.exec(sql);
    }

    return new SupabasePostgresHarness(db);
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  /**
   * Simulates Supabase Auth account creation (fires on_auth_user_created trigger).
   */
  async createAuthUser(params: {
    id?: string;
    email: string;
    password?: string;
    rawUserMetaData?: Record<string, unknown>;
  }): Promise<{ id: string; email: string; token: string }> {
    const email = params.email.trim().toLowerCase();
    const password = params.password ?? 'ValidPass#2026!';
    const meta = JSON.stringify(params.rawUserMetaData ?? {});

    const res = params.id
      ? await this.db.query<{ id: string; email: string }>(
          `INSERT INTO auth.users (id, email, encrypted_password, raw_user_meta_data)
           VALUES ($1, $2, $3, $4::jsonb)
           RETURNING id, email`,
          [params.id, email, password, meta]
        )
      : await this.db.query<{ id: string; email: string }>(
          `INSERT INTO auth.users (email, encrypted_password, raw_user_meta_data)
           VALUES ($1, $2, $3::jsonb)
           RETURNING id, email`,
          [email, password, meta]
        );

    const user = res.rows[0];
    const token = `test-jwt-${user.id}`;
    this.passwords.set(email, password);
    this.tokens.set(token, user.id);

    return { id: user.id, email: user.email, token };
  }

  /**
   * Executes a query as an unauthenticated `anon` PostgreSQL role.
   */
  async asAnon<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.transaction(async (tx) => {
      await tx.exec(`SET LOCAL ROLE anon;`);
      await tx.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ role: 'anon' }),
      ]);
      const res = await tx.query<T>(sql, params);
      return res.rows;
    });
  }

  /**
   * Executes a query as an authenticated Supabase user (`ROLE authenticated`)
   * with `auth.uid()` bound to `userId`, enforcing all RLS policies and grants.
   */
  async asUser<T = Record<string, unknown>>(
    userId: string,
    sql: string,
    params: unknown[] = []
  ): Promise<T[]> {
    return this.db.transaction(async (tx) => {
      await tx.exec(`SET LOCAL ROLE authenticated;`);
      await tx.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: userId, role: 'authenticated' }),
      ]);
      const res = await tx.query<T>(sql, params);
      return res.rows;
    });
  }

  /**
   * Executes a query as trusted server-side `service_role`.
   */
  async asServiceRole<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = []
  ): Promise<T[]> {
    return this.db.transaction(async (tx) => {
      await tx.exec(`SET LOCAL ROLE service_role;`);
      await tx.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ role: 'service_role' }),
      ]);
      const res = await tx.query<T>(sql, params);
      return res.rows;
    });
  }

  /**
   * Superuser test-only helper for inspecting raw DB state or simulating elapsed server time
   * without adding any backdoors to production RPCs.
   */
  async asSuperuser<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = []
  ): Promise<T[]> {
    const res = await this.db.query<T>(sql, params);
    return res.rows;
  }

  createGateway(): BackendGateway {
    const harness = this;

    return {
      async verifyBearerToken(token: string): Promise<AuthenticatedActor> {
        const userId = harness.tokens.get(token);
        if (!userId) {
          throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired authentication session.');
        }

        const rows = await harness.asUser<Profile>(
          userId,
          `SELECT * FROM public.profiles WHERE id = $1`,
          [userId]
        );
        const profile = rows[0];
        if (!profile || profile.account_status !== 'active') {
          throw new AppError(403, 'ACCOUNT_INACTIVE', 'Your account is not currently active.');
        }

        return {
          uid: userId,
          email: profile.email,
          accessToken: token,
          profile,
        };
      },

      async signUpWithUsername(username: string, password: string): Promise<SignInResult> {
        const normalizedUsername = normalizeUsername(username);
        if (!normalizedUsername || password.length < MIN_PASSWORD_LENGTH) {
          throw new AppError(
            422,
            'VALIDATION_ERROR',
            `Name and a password of at least ${MIN_PASSWORD_LENGTH} characters are required.`
          );
        }
        const syntheticEmail = usernameToSyntheticEmail(normalizedUsername);
        if (harness.passwords.has(syntheticEmail)) {
          throw new AppError(
            409,
            'ACCOUNT_ALREADY_EXISTS',
            'That name is already registered. Please sign in or choose another name.'
          );
        }
        await harness.createAuthUser({
          email: syntheticEmail,
          password,
          rawUserMetaData: { username: normalizedUsername, full_name: normalizedUsername },
        });
        return this.signInWithPassword(normalizedUsername, password);
      },

      async signInWithPassword(identifier: string, password: string): Promise<SignInResult> {
        const trimmed = normalizeUsername(identifier);
        const resolvedRows = await harness.asServiceRole<{ email: string | null }>(
          `SELECT public.service_resolve_login_email($1::text) AS email`,
          [trimmed]
        );
        const normalized = (
          resolvedRows[0]?.email ||
          (trimmed.includes('@') ? trimmed.toLowerCase() : usernameToSyntheticEmail(trimmed))
        ).toLowerCase();

        const expected = harness.passwords.get(normalized);
        if (!expected || expected !== password) {
          throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid name or password.');
        }

        const userRows = await harness.asSuperuser<{ id: string }>(
          `SELECT id FROM auth.users WHERE lower(email) = $1`,
          [normalized]
        );
        if (!userRows[0]) {
          throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid name or password.');
        }

        const token = `test-jwt-${userRows[0].id}`;
        harness.tokens.set(token, userRows[0].id);
        const actor = await this.verifyBearerToken(token);

        return {
          access_token: token,
          refresh_token: `refresh-${userRows[0].id}`,
          profile: actor.profile,
        };
      },

      async requestPasswordReset(_email: string): Promise<void> {
        // No-op in test harness; route verifies non-enumerating response behavior
      },

      async updateOwnFullName(actor: AuthenticatedActor, fullName: string): Promise<Profile> {
        try {
          const rows = await harness.asUser<Profile>(
            actor.uid,
            `UPDATE public.profiles SET full_name = $1 WHERE id = $2 RETURNING *`,
            [fullName.trim(), actor.uid]
          );
          return rows[0];
        } catch (err) {
          throw translateDatabaseError(err);
        }
      },

      async adminCreateStudentAccount(actor, params): Promise<Profile> {
        if (actor.profile.role !== 'admin') {
          throw new AppError(403, 'FORBIDDEN_ADMIN_ONLY', 'Administrator privileges required.');
        }
        try {
          const normalizedName = normalizeUsername(params.username || params.full_name);
          const targetEmail =
            params.email && params.email.trim().includes('@')
              ? params.email.trim().toLowerCase()
              : usernameToSyntheticEmail(normalizedName);

          const created = await harness.createAuthUser({
            email: targetEmail,
            password: params.password,
            rawUserMetaData: { username: normalizedName, full_name: params.full_name },
          });
          return await this.adminUpdateStudentProfile(actor, {
            student_id: created.id,
            full_name: params.full_name,
            student_identifier: params.student_identifier ?? null,
            account_status: params.account_status ?? 'active',
          });
        } catch (err) {
          throw translateDatabaseError(err);
        }
      },

      async adminUpdateStudentProfile(actor, params): Promise<Profile> {
        try {
          const rows = await harness.asUser<Profile>(
            actor.uid,
            `SELECT * FROM public.admin_configure_student_profile($1::uuid, $2::text, $3::text, $4::public.account_status)`,
            [
              params.student_id,
              params.full_name,
              params.student_identifier ?? null,
              params.account_status,
            ]
          );
          return rows[0];
        } catch (err) {
          throw translateDatabaseError(err);
        }
      },

      async adminListStudents(actor): Promise<Profile[]> {
        try {
          return await harness.asUser<Profile>(
            actor.uid,
            `SELECT * FROM public.profiles WHERE role = 'student' ORDER BY full_name ASC`
          );
        } catch (err) {
          throw translateDatabaseError(err);
        }
      },

      async adminListClasses(actor): Promise<unknown> {
        try {
          const rows = await harness.asUser<{ res: unknown }>(
            actor.uid,
            `SELECT public.admin_list_classes() AS res`
          );
          return rows[0]?.res ?? [];
        } catch (err) {
          throw translateDatabaseError(err);
        }
      },

      async adminCreateClass(actor, name, description): Promise<unknown> {
        try {
          const rows = await harness.asUser(
            actor.uid,
            `SELECT * FROM public.admin_create_class($1::text, $2::text)`,
            [name, description ?? null]
          );
          return rows[0];
        } catch (err) {
          throw translateDatabaseError(err);
        }
      },

      async adminSetClassMembership(
        actor,
        classId: string,
        studentId: string,
        status: MembershipStatus
      ): Promise<unknown> {
        try {
          const rows = await harness.asUser(
            actor.uid,
            `SELECT * FROM public.admin_set_class_membership($1::uuid, $2::uuid, $3::public.membership_status)`,
            [classId, studentId, status]
          );
          return rows[0];
        } catch (err) {
          throw translateDatabaseError(err);
        }
      },

      async adminListExams(actor): Promise<unknown> {
        try {
          const rows = await harness.asUser<{ res: unknown }>(
            actor.uid,
            `SELECT public.admin_list_exams() AS res`
          );
          return rows[0]?.res ?? [];
        } catch (err) {
          throw translateDatabaseError(err);
        }
      },

      async adminGetExamQuestions(actor, examId: string): Promise<unknown> {
        try {
          const rows = await harness.asUser<{ res: unknown }>(
            actor.uid,
            `SELECT public.admin_get_exam_questions($1::uuid) AS res`,
            [examId]
          );
          return rows[0]?.res ?? [];
        } catch (err) {
          throw translateDatabaseError(err);
        }
      },

      async adminCreateExam(actor, input: CreateExamInput): Promise<unknown> {
        try {
          const rows = await harness.asUser(
            actor.uid,
            `SELECT * FROM public.admin_create_exam(
              $1::text, $2::text, $3::text, $4::integer, $5::numeric,
              $6::timestamptz, $7::timestamptz, $8::public.result_release_policy,
              $9::boolean, $10::boolean, $11::boolean, $12::integer, $13::integer,
              $14::boolean, $15::boolean
            )`,
            [
              input.title,
              input.description ?? null,
              input.instructions ?? null,
              input.duration_minutes,
              input.passing_percentage ?? 50,
              input.scheduled_start_at ?? null,
              input.scheduled_end_at ?? null,
              input.result_release_policy ?? 'immediate',
              input.allow_review ?? true,
              input.shuffle_questions ?? false,
              input.shuffle_options ?? false,
              input.max_attempts ?? 1,
              input.retake_cooldown_minutes ?? 180,
              input.open_to_all ?? false,
              input.is_open ?? true,
            ]
          );
          return rows[0];
        } catch (err) {
          throw translateDatabaseError(err);
        }
      },

      async adminUpsertQuestion(
        actor,
        examId: string,
        input: UpsertQuestionInput
      ): Promise<unknown> {
        try {
          const rows = await harness.asUser<{ res: unknown }>(
            actor.uid,
            `SELECT public.admin_upsert_question_with_options(
              $1::uuid, $2::text, $3::public.question_type, $4::numeric, $5::jsonb,
              $6::uuid, $7::numeric, $8::text, $9::integer, $10::boolean, $11::jsonb, $12::jsonb
            ) AS res`,
            [
              examId,
              input.question_text,
              input.question_type,
              input.marks,
              JSON.stringify(input.options ?? []),
              input.question_id ?? null,
              input.negative_marks ?? 0,
              input.explanation ?? null,
              input.display_order ?? null,
              input.is_required ?? true,
              JSON.stringify(input.accepted_answers ?? []),
              JSON.stringify(input.rubric_keywords ?? []),
            ]
          );
          return rows[0]?.res;
        } catch (err) {
          throw translateDatabaseError(err);
        }
      },

      async adminPublishExam(actor, examId: string): Promise<unknown> {
        try {
          const rows = await harness.asUser(
            actor.uid,
            `SELECT * FROM public.admin_publish_exam($1::uuid)`,
            [examId]
          );
          return rows[0];
        } catch (err) {
          throw translateDatabaseError(err);
        }
      },

      async adminArchiveExam(actor, examId: string): Promise<unknown> {
        try {
          const rows = await harness.asUser(
            actor.uid,
            `SELECT * FROM public.admin_archive_exam($1::uuid)`,
            [examId]
          );
          return rows[0];
        } catch (err) {
          throw translateDatabaseError(err);
        }
      },

      async adminUpdateReleaseSettings(
        actor,
        examId: string,
        settings: {
          result_release_policy?: ResultReleasePolicy;
          results_released_manually?: boolean;
          allow_review?: boolean;
        }
      ): Promise<unknown> {
        try {
          const rows = await harness.asUser(
            actor.uid,
            `SELECT * FROM public.admin_set_exam_release_settings(
              $1::uuid, $2::public.result_release_policy, $3::boolean, $4::boolean
            )`,
            [
              examId,
              settings.result_release_policy ?? null,
              settings.results_released_manually ?? null,
              settings.allow_review ?? null,
            ]
          );
          return rows[0];
        } catch (err) {
          throw translateDatabaseError(err);
        }
      },

      async adminUpdateExamAccess(
        actor,
        examId: string,
        settings: ExamAccessSettingsInput
      ): Promise<unknown> {
        try {
          const rows = await harness.asUser(
            actor.uid,
            `SELECT * FROM public.admin_set_exam_access(
              $1::uuid, $2::boolean, $3::boolean, $4::text, $5::integer, $6::integer
            )`,
            [
              examId,
              settings.is_open ?? null,
              settings.open_to_all ?? null,
              settings.title ?? null,
              settings.retake_cooldown_minutes ?? null,
              settings.max_attempts ?? null,
            ]
          );
          return rows[0];
        } catch (err) {
          throw translateDatabaseError(err);
        }
      },

      async adminOverrideExamCooldown(
        actor,
        examId: string,
        options?: { student_id?: string | null; reason?: string | null }
      ): Promise<unknown> {
        try {
          const rows = await harness.asUser<{ res: unknown }>(
            actor.uid,
            `SELECT public.admin_override_exam_cooldown($1::uuid, $2::uuid, $3::text) AS res`,
            [examId, options?.student_id ?? null, options?.reason ?? null]
          );
          return rows[0]?.res;
        } catch (err) {
          throw translateDatabaseError(err);
        }
      },

      async adminAssignExam(
        actor,
        examId: string,
        target: { student_id?: string | null; class_id?: string | null; status?: AssignmentStatus }
      ): Promise<unknown> {
        try {
          const rows = await harness.asUser(
            actor.uid,
            `SELECT * FROM public.admin_assign_exam(
              $1::uuid, $2::uuid, $3::uuid, $4::public.assignment_status
            )`,
            [examId, target.student_id ?? null, target.class_id ?? null, target.status ?? 'active']
          );
          return rows[0];
        } catch (err) {
          throw translateDatabaseError(err);
        }
      },

      async adminCorrectResult(
        actor,
        resultId: string,
        correctedMarks: number,
        reason: string
      ): Promise<unknown> {
        try {
          const rows = await harness.asUser(
            actor.uid,
            `SELECT * FROM public.admin_correct_result($1::uuid, $2::numeric, $3::text)`,
            [resultId, correctedMarks, reason]
          );
          return rows[0];
        } catch (err) {
          throw translateDatabaseError(err);
        }
      },

      async adminGradeResultItem(
        actor,
        resultId: string,
        questionId: string,
        marksAwarded: number,
        reason: string
      ): Promise<unknown> {
        try {
          const rows = await harness.asUser(
            actor.uid,
            `SELECT * FROM public.admin_grade_result_item($1::uuid, $2::uuid, $3::numeric, $4::text)`,
            [resultId, questionId, marksAwarded, reason]
          );
          return rows[0];
        } catch (err) {
          throw translateDatabaseError(err);
        }
      },

      async studentListEligibleExams(actor): Promise<unknown> {
        try {
          const rows = await harness.asUser<{ res: unknown }>(
            actor.uid,
            `SELECT public.student_list_eligible_exams() AS res`
          );
          return rows[0]?.res;
        } catch (err) {
          throw translateDatabaseError(err);
        }
      },

      async studentStartOrResumeAttempt(actor, examId: string): Promise<unknown> {
        try {
          const rows = await harness.asUser<{ res: unknown }>(
            actor.uid,
            `SELECT public.student_start_or_resume_attempt($1::uuid) AS res`,
            [examId]
          );
          return rows[0]?.res;
        } catch (err) {
          throw translateDatabaseError(err);
        }
      },

      async studentGetAttemptQuestions(actor, attemptId: string): Promise<unknown> {
        try {
          const rows = await harness.asUser<{ res: unknown }>(
            actor.uid,
            `SELECT public.student_get_attempt_questions($1::uuid) AS res`,
            [attemptId]
          );
          return rows[0]?.res;
        } catch (err) {
          throw translateDatabaseError(err);
        }
      },

      async studentSaveAnswer(
        actor,
        attemptId: string,
        questionId: string,
        selectedOptionId: string | null,
        answerValue: string | null = null
      ): Promise<unknown> {
        try {
          const rows = await harness.asUser<{ res: unknown }>(
            actor.uid,
            `SELECT public.student_save_answer($1::uuid, $2::uuid, $3::uuid, $4::text) AS res`,
            [attemptId, questionId, selectedOptionId, answerValue]
          );
          return rows[0]?.res;
        } catch (err) {
          throw translateDatabaseError(err);
        }
      },

      async studentSubmitAttempt(actor, attemptId: string): Promise<unknown> {
        try {
          const rows = await harness.asUser<{ res: unknown }>(
            actor.uid,
            `SELECT public.student_submit_attempt($1::uuid) AS res`,
            [attemptId]
          );
          return rows[0]?.res;
        } catch (err) {
          throw translateDatabaseError(err);
        }
      },

      async studentGetReleasedResults(actor): Promise<unknown> {
        try {
          const rows = await harness.asUser<{ res: unknown }>(
            actor.uid,
            `SELECT public.student_get_released_results() AS res`
          );
          return rows[0]?.res;
        } catch (err) {
          throw translateDatabaseError(err);
        }
      },

      async studentGetAttemptReview(actor, attemptId: string): Promise<unknown> {
        try {
          const rows = await harness.asUser<{ res: unknown }>(
            actor.uid,
            `SELECT public.student_get_attempt_review($1::uuid) AS res`,
            [attemptId]
          );
          return rows[0]?.res;
        } catch (err) {
          throw translateDatabaseError(err);
        }
      },

      async adminGetExamStatistics(actor, examId: string): Promise<unknown> {
        try {
          const rows = await harness.asUser<{ res: unknown }>(
            actor.uid,
            `SELECT public.admin_get_exam_statistics($1::uuid) AS res`,
            [examId]
          );
          return rows[0]?.res;
        } catch (err) {
          throw translateDatabaseError(err);
        }
      },

      async adminListExamAttempts(actor, examId: string): Promise<unknown> {
        try {
          const rows = await harness.asUser<{ res: unknown }>(
            actor.uid,
            `SELECT public.admin_list_exam_attempts($1::uuid) AS res`,
            [examId]
          );
          return rows[0]?.res;
        } catch (err) {
          throw translateDatabaseError(err);
        }
      },

      async adminGetAttemptDetail(actor, attemptId: string): Promise<unknown> {
        try {
          const rows = await harness.asUser<{ res: unknown }>(
            actor.uid,
            `SELECT public.admin_get_attempt_detail($1::uuid) AS res`,
            [attemptId]
          );
          return rows[0]?.res;
        } catch (err) {
          throw translateDatabaseError(err);
        }
      },

      async adminGetQuestionAnalytics(actor, examId: string): Promise<unknown> {
        try {
          const rows = await harness.asUser<{ res: unknown }>(
            actor.uid,
            `SELECT public.admin_get_question_analytics($1::uuid) AS res`,
            [examId]
          );
          return rows[0]?.res;
        } catch (err) {
          throw translateDatabaseError(err);
        }
      },

      async adminGetClassPerformanceSummary(actor, examId: string): Promise<unknown> {
        try {
          const rows = await harness.asUser<{ res: unknown }>(
            actor.uid,
            `SELECT public.admin_get_class_performance_summary($1::uuid) AS res`,
            [examId]
          );
          return rows[0]?.res;
        } catch (err) {
          throw translateDatabaseError(err);
        }
      },

      async adminExportExamResultsRows(actor, examId: string): Promise<ExportResultRow[]> {
        try {
          return await harness.asUser<ExportResultRow>(
            actor.uid,
            `SELECT * FROM public.admin_export_exam_results_rows($1::uuid)`,
            [examId]
          );
        } catch (err) {
          throw translateDatabaseError(err);
        }
      },

      async adminListAuditLogs(actor, limit = 100): Promise<unknown> {
        try {
          return await harness.asUser(
            actor.uid,
            `SELECT * FROM public.audit_logs ORDER BY created_at DESC LIMIT $1`,
            [Math.min(Math.max(1, limit), 500)]
          );
        } catch (err) {
          throw translateDatabaseError(err);
        }
      },

      async finalizeExpiredAttemptsSweep(batchLimit = 200): Promise<unknown> {
        try {
          const rows = await harness.asServiceRole<{ res: unknown }>(
            `SELECT public.finalize_expired_attempts($1::integer) AS res`,
            [batchLimit]
          );
          return rows[0]?.res;
        } catch (err) {
          throw translateDatabaseError(err);
        }
      },

      async studentRecordQuestionPosition(actor, attemptId: string, questionIndex: number): Promise<void> {
        try {
          await harness.asUser(
            actor.uid,
            `SELECT public.student_record_question_position($1::uuid, $2::integer)`,
            [attemptId, questionIndex]
          );
        } catch (err) {
          throw translateDatabaseError(err);
        }
      },

      async adminListLiveMonitoring(actor, examId?: string): Promise<unknown> {
        try {
          const rows = await harness.asUser<{ res: unknown }>(
            actor.uid,
            `SELECT public.admin_list_live_monitoring($1::uuid) AS res`,
            [examId ?? null]
          );
          return rows[0]?.res ?? [];
        } catch (err) {
          throw translateDatabaseError(err);
        }
      },

      async adminGetAttemptLiveStatus(actor, attemptId: string): Promise<unknown> {
        try {
          const rows = await harness.asUser<{ res: unknown }>(
            actor.uid,
            `SELECT public.admin_get_attempt_live_status($1::uuid) AS res`,
            [attemptId]
          );
          return rows[0]?.res ?? null;
        } catch (err) {
          throw translateDatabaseError(err);
        }
      },
    };
  }
}
