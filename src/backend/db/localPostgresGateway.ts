import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PGlite } from '@electric-sql/pglite';
import { BackendGateway, SignInResult } from './gateway.ts';
import { AppError, translateDatabaseError } from '../utils/errors.ts';
import {
  MIN_PASSWORD_LENGTH,
  normalizeUsername,
  usernameToSyntheticEmail,
} from '../utils/authIdentifier.ts';
import {
  AccountStatus,
  AssignmentStatus,
  AuthenticatedActor,
  CreateExamInput,
  DemoAccountSummary,
  ExamAccessSettingsInput,
  ExportResultRow,
  MembershipStatus,
  Profile,
  ResultReleasePolicy,
  UpsertQuestionInput,
} from '../types/domain.ts';
import {
  HIM_20_QUESTIONS,
  HIM_DEMO_ACCOUNTS,
  HIM_EXAM_METADATA,
} from '../seed/himExamData.ts';
import { HIM103_CH1_METADATA, HIM103_CH1_QUESTIONS } from '../seed/him103Chapter1Data.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../supabase/migrations');

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

  CREATE SCHEMA IF NOT EXISTS quizpocket_internal;
  CREATE TABLE IF NOT EXISTS quizpocket_internal.applied_migrations (
    filename text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT timezone('utc', now())
  );
`;

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password: string, storedHash: string | null): boolean {
  if (!storedHash || !storedHash.startsWith('scrypt$')) return false;
  const parts = storedHash.split('$');
  if (parts.length !== 3) return false;
  const [, salt, expectedHex] = parts;
  const actualBuf = crypto.scryptSync(password, salt, 64);
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  if (actualBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

interface TokenClaims {
  sub: string;
  email: string;
  exp: number;
}

export interface LocalPostgresGatewayOptions {
  dataDir?: string;
  seedDemoData?: boolean;
  predefinedAdminId?: string;
}

/**
 * Embedded PostgreSQL 16 gateway executing the exact QuizPocket Supabase SQL migrations,
 * Row-Level Security policies, triggers, and RPCs when external VITE_SUPABASE_URL is unset.
 */
export class LocalPostgresBackendGateway implements BackendGateway {
  public readonly db: PGlite;
  private readonly jwtSecret: Buffer;
  private readonly demoAccountsEnabled: boolean;

  private constructor(db: PGlite, jwtSecret: Buffer, demoAccountsEnabled: boolean) {
    this.db = db;
    this.jwtSecret = jwtSecret;
    this.demoAccountsEnabled = demoAccountsEnabled;
  }

  static async create(options: LocalPostgresGatewayOptions = {}): Promise<LocalPostgresBackendGateway> {
    const dataDir = options.dataDir;
    let secretHex: string | null = null;

    if (dataDir) {
      fs.mkdirSync(path.dirname(dataDir), { recursive: true });
      const secretFile = `${dataDir}.secret`;
      if (fs.existsSync(secretFile)) {
        secretHex = fs.readFileSync(secretFile, 'utf8').trim();
      } else {
        secretHex = crypto.randomBytes(32).toString('hex');
        fs.writeFileSync(secretFile, secretHex, { mode: 0o600 });
      }
    }

    const jwtSecret = Buffer.from(secretHex || crypto.randomBytes(32).toString('hex'), 'hex');
    const db = dataDir ? new PGlite(dataDir) : new PGlite();

    await db.exec(SUPABASE_PRELUDE_SQL);

    const appliedRows = await db.query<{ filename: string }>(
      `SELECT filename FROM quizpocket_internal.applied_migrations`
    );
    const appliedSet = new Set(appliedRows.rows.map((r) => r.filename));

    const migrationFiles = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of migrationFiles) {
      if (!appliedSet.has(file)) {
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
        await db.exec(sql);
        await db.query(
          `INSERT INTO quizpocket_internal.applied_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`,
          [file]
        );
      }
    }

    const seedDemoData = options.seedDemoData ?? true;
    const gateway = new LocalPostgresBackendGateway(db, jwtSecret, seedDemoData);

    if (seedDemoData) {
      await gateway.ensureSeeded(options.predefinedAdminId);
      await gateway.ensureAdminAndCohortDefaults(options.predefinedAdminId);
      await gateway.ensureHim103Chapter1();
    }

    return gateway;
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  private signToken(claims: TokenClaims): string {
    const payloadB64 = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    const sigB64 = crypto
      .createHmac('sha256', this.jwtSecret)
      .update(payloadB64)
      .digest('base64url');
    return `qp.${payloadB64}.${sigB64}`;
  }

  private verifySignedToken(token: string): TokenClaims {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'qp') {
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired authentication session.');
    }
    const [, payloadB64, providedSig] = parts;
    const expectedSig = crypto
      .createHmac('sha256', this.jwtSecret)
      .update(payloadB64)
      .digest('base64url');

    const bufA = Buffer.from(providedSig, 'utf8');
    const bufB = Buffer.from(expectedSig, 'utf8');
    if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired authentication session.');
    }

    let claims: TokenClaims;
    try {
      claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as TokenClaims;
    } catch {
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired authentication session.');
    }

    if (!claims.sub || typeof claims.exp !== 'number' || Date.now() / 1000 > claims.exp) {
      throw new AppError(401, 'UNAUTHORIZED', 'Your authentication session has expired.');
    }

    return claims;
  }

  private async asUser<T = Record<string, unknown>>(
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

  private async asServiceRole<T = Record<string, unknown>>(
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

  private async insertAuthUser(params: {
    id?: string;
    email: string;
    password: string;
    fullName: string;
    username?: string;
  }): Promise<{ id: string; email: string }> {
    const normalizedEmail = params.email.trim().toLowerCase();
    const encrypted = hashPassword(params.password);
    const cleanFullName = params.fullName.trim();
    const cleanUsername = normalizeUsername(params.username ?? cleanFullName);
    const meta = JSON.stringify({ username: cleanUsername, full_name: cleanFullName });

    if (params.id) {
      const res = await this.db.query<{ id: string; email: string }>(
        `INSERT INTO auth.users (id, email, encrypted_password, raw_user_meta_data)
         VALUES ($1::uuid, $2, $3, $4::jsonb)
         ON CONFLICT (id) DO UPDATE
           SET email = EXCLUDED.email,
               encrypted_password = EXCLUDED.encrypted_password,
               raw_user_meta_data = EXCLUDED.raw_user_meta_data
         RETURNING id, email`,
        [params.id, normalizedEmail, encrypted, meta]
      );
      return res.rows[0];
    }

    const res = await this.db.query<{ id: string; email: string }>(
      `INSERT INTO auth.users (email, encrypted_password, raw_user_meta_data)
       VALUES ($1, $2, $3::jsonb)
       RETURNING id, email`,
      [normalizedEmail, encrypted, meta]
    );
    return res.rows[0];
  }

  /**
   * Mirrors an externally authenticated Supabase Auth user (preserving exact UUID)
   * into the embedded PostgreSQL instance so RLS and `auth.uid()` match 1:1.
   */
  async ensureMirroredAuthUser(params: {
    id: string;
    email: string;
    username: string;
    fullName: string;
    password?: string;
    isAdmin?: boolean;
  }): Promise<Profile> {
    const normalizedEmail = params.email.trim().toLowerCase();
    const cleanUsername = normalizeUsername(params.username || params.fullName);
    const cleanFullName = params.fullName.trim() || cleanUsername;

    const existingById = await this.db.query<{ id: string }>(
      `SELECT id FROM auth.users WHERE id = $1::uuid`,
      [params.id]
    );

    if (!existingById.rows[0]) {
      // Remove any stale local-only user row with the same email/username if UUID differed
      await this.db.query(
        `DELETE FROM auth.users
         WHERE lower(email) = $1
           AND id <> $2::uuid
           AND NOT EXISTS (SELECT 1 FROM public.exams e WHERE e.created_by = auth.users.id)
           AND NOT EXISTS (SELECT 1 FROM public.exam_attempts a WHERE a.student_id = auth.users.id)`,
        [normalizedEmail, params.id]
      );

      await this.insertAuthUser({
        id: params.id,
        email: normalizedEmail,
        password: params.password ?? crypto.randomBytes(16).toString('hex'),
        fullName: cleanFullName,
        username: cleanUsername,
      });
    } else if (params.password) {
      await this.db.query(`UPDATE auth.users SET encrypted_password = $1 WHERE id = $2::uuid`, [
        hashPassword(params.password),
        params.id,
      ]);
    }

    if (params.isAdmin) {
      await this.db.query(`SELECT * FROM public.bootstrap_initial_admin($1::uuid, $2::text)`, [
        params.id,
        cleanUsername,
      ]);
    }

    const rows = await this.asUser<Profile>(
      params.id,
      `SELECT * FROM public.profiles WHERE id = $1::uuid`,
      [params.id]
    );
    return rows[0];
  }

  async resolveLocalLoginEmail(identifier: string): Promise<string | null> {
    const trimmed = normalizeUsername(identifier);
    const rows = await this.asServiceRole<{ email: string | null }>(
      `SELECT public.service_resolve_login_email($1::text) AS email`,
      [trimmed]
    );
    return rows[0]?.email ?? null;
  }

  async loadActiveActorById(userId: string, accessToken: string): Promise<AuthenticatedActor> {
    const rows = await this.asUser<Profile>(
      userId,
      `SELECT * FROM public.profiles WHERE id = $1::uuid`,
      [userId]
    );
    const profile = rows[0];
    if (!profile || profile.account_status !== 'active') {
      throw new AppError(403, 'ACCOUNT_INACTIVE', 'Your account is not currently active.');
    }
    return {
      uid: userId,
      email: profile.email,
      accessToken,
      profile,
    };
  }

  /**
   * Idempotently guarantees that the `kenzy` (password `kenzy1052`) administrator account
   * and HIM-101 auto-enrollment flag exist on both fresh and pre-existing databases.
   */
  private async ensureAdminAndCohortDefaults(predefinedAdminId?: string): Promise<void> {
    const kenzyEmail = usernameToSyntheticEmail('kenzy');
    const existingRows = await this.db.query<{
      id: string;
      encrypted_password: string | null;
    }>(
      `SELECT u.id, u.encrypted_password
       FROM auth.users u
       LEFT JOIN public.profiles p ON p.id = u.id
       WHERE lower(u.email) = $1 OR lower(btrim(COALESCE(p.username, ''))) = 'kenzy'
       LIMIT 1`,
      [kenzyEmail]
    );

    let kenzyId: string;
    if (!existingRows.rows[0]) {
      const created = await this.insertAuthUser({
        id: predefinedAdminId,
        email: kenzyEmail,
        password: 'kenzy1052',
        fullName: 'kenzy',
        username: 'kenzy',
      });
      kenzyId = created.id;
    } else {
      kenzyId = existingRows.rows[0].id;
      if (!verifyPassword('kenzy1052', existingRows.rows[0].encrypted_password)) {
        await this.db.query(`UPDATE auth.users SET encrypted_password = $1 WHERE id = $2`, [
          hashPassword('kenzy1052'),
          kenzyId,
        ]);
      }
    }

    await this.db.query(`SELECT * FROM public.bootstrap_initial_admin($1::uuid, $2::text)`, [
      kenzyId,
      'kenzy',
    ]);

    await this.db.query(
      `DELETE FROM public.exams e
       WHERE e.status = 'draft'
         AND e.title ILIKE 'HIS 202%'
         AND NOT EXISTS (SELECT 1 FROM public.exam_attempts a WHERE a.exam_id = e.id)`
    );

    await this.db.query(
      `UPDATE public.exams
       SET title = 'HIM 105 Lecture 1',
           duration_minutes = 30,
           passing_percentage = 50,
           result_release_policy = 'immediate',
           allow_review = true,
           is_open = true,
           open_to_all = true,
           max_attempts = GREATEST(max_attempts, 100),
           retake_cooldown_minutes = 180
       WHERE title ILIKE 'HIM 101%' OR title ILIKE 'AIM 105%' OR title ILIKE 'HIM 105%'`
    );

    await this.db.query(
      `UPDATE public.classes
       SET name = 'HIM 105 Health Information Management Cohort',
           auto_enroll_new_students = true
       WHERE lower(btrim(name)) IN (
         lower('HIM-101 Health Information Management Cohort'),
         lower('AIM 105 Health Information Management Cohort'),
         lower('HIM 105 Health Information Management Cohort')
       )`
    );

    await this.db.query(
      `INSERT INTO public.class_memberships (class_id, student_id, membership_status)
       SELECT c.id, p.id, 'active'
       FROM public.classes c
       CROSS JOIN public.profiles p
       WHERE c.auto_enroll_new_students = true
         AND p.institution_id = c.institution_id
         AND p.role = 'student'
       ON CONFLICT (class_id, student_id) DO UPDATE SET membership_status = 'active'`
    );
  }

  /**
   * Idempotently provisions "HIM 103 Chapter 1" (40 MCQs, 40 minutes) and assigns it to every
   * auto-enrolling cohort so all students see it, including on databases seeded before it existed.
   */
  private async ensureHim103Chapter1(): Promise<void> {
    const existing = await this.db.query<{ id: string }>(
      `SELECT id FROM public.exams WHERE title = $1 AND status <> 'archived' LIMIT 1`,
      [HIM103_CH1_METADATA.title]
    );
    if (existing.rows.length > 0) return;

    const adminAccount = HIM_DEMO_ACCOUNTS.find((a) => a.role === 'admin')!;
    const adminSession = await this.signInWithPassword(
      adminAccount.username ?? 'kenzy',
      adminAccount.password
    );
    const adminActor = await this.verifyBearerToken(adminSession.access_token);

    const exam = (await this.adminCreateExam(adminActor, HIM103_CH1_METADATA)) as { id: string };
    for (const q of HIM103_CH1_QUESTIONS) {
      await this.adminUpsertQuestion(adminActor, exam.id, q);
    }
    await this.adminPublishExam(adminActor, exam.id);

    const cohorts = await this.db.query<{ id: string }>(
      `SELECT id FROM public.classes WHERE auto_enroll_new_students = true`
    );
    for (const c of cohorts.rows) {
      await this.adminAssignExam(adminActor, exam.id, { class_id: c.id, status: 'active' });
    }
  }

  private async ensureSeeded(predefinedAdminId?: string): Promise<void> {
    const countRes = await this.db.query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt FROM public.exams`
    );
    if ((countRes.rows[0]?.cnt ?? 0) > 0) {
      return;
    }

    // 1. Seed initial Administrator account (`kenzy` / `kenzy1052`) via bootstrap_initial_admin
    const adminAccount = HIM_DEMO_ACCOUNTS.find((a) => a.role === 'admin')!;
    const adminName = adminAccount.username ?? 'kenzy';
    const adminUser = await this.insertAuthUser({
      id: predefinedAdminId,
      email: adminAccount.email,
      password: adminAccount.password,
      fullName: adminName,
      username: adminName,
    });

    await this.db.query(`SELECT * FROM public.bootstrap_initial_admin($1::uuid, $2::text)`, [
      adminUser.id,
      adminName,
    ]);

    const adminSession = await this.signInWithPassword(adminName, adminAccount.password);
    const adminActor = await this.verifyBearerToken(adminSession.access_token);

    // 2. Create Student 1 (Amina Okafor — clean slate for taking HIM 105 Lecture 1)
    const aminaSpec = HIM_DEMO_ACCOUNTS[0];
    const aminaProfile = await this.adminCreateStudentAccount(adminActor, {
      email: aminaSpec.email,
      username: aminaSpec.username ?? 'Amina Okafor',
      password: aminaSpec.password,
      full_name: 'Amina Okafor',
      student_identifier: 'HIM-2026-014',
      account_status: 'active',
    });

    // 3. Create Student 2 (Marcus Rivera — completes Attempt 1 for live analytics & grading)
    const marcusSpec = HIM_DEMO_ACCOUNTS[2];
    const marcusProfile = await this.adminCreateStudentAccount(adminActor, {
      email: marcusSpec.email,
      username: marcusSpec.username ?? 'Marcus Rivera',
      password: marcusSpec.password,
      full_name: 'Marcus Rivera',
      student_identifier: 'HIM-2026-008',
      account_status: 'active',
    });

    // 4. Create HIM 105 Cohort Class & enable auto-enrollment for newly created student accounts
    const himClass = (await this.adminCreateClass(
      adminActor,
      'HIM 105 Health Information Management Cohort',
      'Undergraduate Health Information Management & Hospital Administration Cohort'
    )) as { id: string };

    await this.db.query(`UPDATE public.classes SET auto_enroll_new_students = true WHERE id = $1`, [
      himClass.id,
    ]);

    await this.adminSetClassMembership(adminActor, himClass.id, aminaProfile.id, 'active');
    await this.adminSetClassMembership(adminActor, himClass.id, marcusProfile.id, 'active');

    // 5. Create HIM 105 Lecture 1 Examination & load all 20 questions
    const himExam = (await this.adminCreateExam(adminActor, HIM_EXAM_METADATA)) as { id: string };

    for (const q of HIM_20_QUESTIONS) {
      await this.adminUpsertQuestion(adminActor, himExam.id, q);
    }

    await this.adminPublishExam(adminActor, himExam.id);
    await this.adminAssignExam(adminActor, himExam.id, {
      class_id: himClass.id,
      status: 'active',
    });

    // 6. Record an authentic completed attempt by Marcus Rivera on HIM 105 Lecture 1
    const marcusSession = await this.signInWithPassword(marcusSpec.email, marcusSpec.password);
    const marcusActor = await this.verifyBearerToken(marcusSession.access_token);

    const started = (await this.studentStartOrResumeAttempt(marcusActor, himExam.id)) as {
      attempt_id: string;
    };
    const qPayload = (await this.studentGetAttemptQuestions(
      marcusActor,
      started.attempt_id
    )) as {
      questions: Array<{
        id: string;
        display_order: number;
        question_type: string;
        options: Array<{ id: string; option_text: string }>;
      }>;
    };

    const marcusTextResponses: Record<number, string> = {
      16: 'ICD-10',
      17: 'Association',
      18: 'coding',
      19: 'Pathology',
      20: 'Radiology',
    };

    const marcusOptionPicks: Record<number, string> = {
      1: 'The professional practice of collecting, organizing, storing, protecting, and using patients’ health information to support healthcare delivery, decision-making, research, and legal/administrative processes.',
      2: 'Professionalization of medical record management (Mid–Late 20th Century)',
      3: 'Health Information Technician',
      4: 'Coding and Classification',
      5: 'Interoperability',
      6: 'CIS (Clinical Information System)',
      7: 'Community-Wide Scheduling (CWS)', // realistic single missed MCQ
      8: 'Reception Community and Medical Accounting Community',
      9: 'It is an important cost factor that influences hospital operating costs.',
      10: 'RHIA',
      11: 'To maintain accurate and complete medical records including notes, orders, test results, and care plans to prevent errors and denied claims',
      12: 'Protecting patient information, ensuring HIPAA compliance, and managing data breaches',
      13: 'True',
      14: 'False',
      15: 'True',
    };

    for (const q of qPayload.questions) {
      if (q.question_type === 'multiple_choice' || q.question_type === 'true_false') {
        const wantedText = marcusOptionPicks[q.display_order];
        const chosen = q.options.find((o) => o.option_text === wantedText) ?? q.options[0];
        if (chosen) {
          await this.studentSaveAnswer(marcusActor, started.attempt_id, q.id, chosen.id, null);
        }
      } else {
        const textVal = marcusTextResponses[q.display_order] ?? '';
        await this.studentSaveAnswer(marcusActor, started.attempt_id, q.id, null, textVal);
      }
    }

    await this.studentSubmitAttempt(marcusActor, started.attempt_id);
  }

  async getDemoAccounts(): Promise<DemoAccountSummary[]> {
    return this.demoAccountsEnabled ? HIM_DEMO_ACCOUNTS : [];
  }

  async verifyBearerToken(token: string): Promise<AuthenticatedActor> {
    const claims = this.verifySignedToken(token);
    const rows = await this.asUser<Profile>(
      claims.sub,
      `SELECT * FROM public.profiles WHERE id = $1`,
      [claims.sub]
    );
    const profile = rows[0];
    if (!profile || profile.account_status !== 'active') {
      throw new AppError(403, 'ACCOUNT_INACTIVE', 'Your account is not currently active.');
    }

    return {
      uid: claims.sub,
      email: profile.email,
      accessToken: token,
      profile,
    };
  }

  async signUpWithUsername(username: string, password: string): Promise<SignInResult> {
    const normalizedUsername = normalizeUsername(username);
    if (normalizedUsername.length < 1 || normalizedUsername.length > 80) {
      throw new AppError(422, 'VALIDATION_ERROR', 'Name must be between 1 and 80 characters.');
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new AppError(
        422,
        'VALIDATION_ERROR',
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
      );
    }

    const syntheticEmail = usernameToSyntheticEmail(normalizedUsername);

    const existing = await this.asServiceRole<{ email: string | null }>(
      `SELECT public.service_resolve_login_email($1::text) AS email`,
      [normalizedUsername]
    );
    if (existing[0]?.email) {
      throw new AppError(
        409,
        'ACCOUNT_ALREADY_EXISTS',
        'That name is already registered. Please sign in or choose another name.'
      );
    }

    try {
      await this.insertAuthUser({
        email: syntheticEmail,
        password,
        fullName: normalizedUsername,
        username: normalizedUsername,
      });
    } catch (err) {
      const appErr = translateDatabaseError(err);
      if (appErr.statusCode === 409) {
        throw new AppError(
          409,
          'ACCOUNT_ALREADY_EXISTS',
          'That name is already registered. Please sign in or choose another name.'
        );
      }
      throw appErr;
    }

    return this.signInWithPassword(normalizedUsername, password);
  }

  async signInWithPassword(identifier: string, password: string): Promise<SignInResult> {
    const trimmed = normalizeUsername(identifier);
    const resolvedRows = await this.asServiceRole<{ email: string | null }>(
      `SELECT public.service_resolve_login_email($1::text) AS email`,
      [trimmed]
    );
    const lookupEmail =
      resolvedRows[0]?.email ||
      (trimmed.includes('@') ? trimmed.toLowerCase() : usernameToSyntheticEmail(trimmed));

    const res = await this.db.query<{
      id: string;
      email: string;
      encrypted_password: string | null;
    }>(`SELECT id, email, encrypted_password FROM auth.users WHERE lower(email) = $1`, [
      lookupEmail.toLowerCase(),
    ]);

    const user = res.rows[0];
    if (!user || !verifyPassword(password, user.encrypted_password)) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid name or password.');
    }

    const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60 * 12;
    const accessToken = this.signToken({
      sub: user.id,
      email: user.email,
      exp: expiresAt,
    });

    const actor = await this.verifyBearerToken(accessToken);

    return {
      access_token: accessToken,
      refresh_token: `refresh-${crypto.randomBytes(16).toString('hex')}`,
      expires_at: expiresAt,
      profile: actor.profile,
    };
  }

  async requestPasswordReset(_email: string): Promise<void> {
    // Non-enumerating local handler
  }

  async updateOwnFullName(actor: AuthenticatedActor, fullName: string): Promise<Profile> {
    try {
      const rows = await this.asUser<Profile>(
        actor.uid,
        `UPDATE public.profiles SET full_name = $1 WHERE id = $2 RETURNING *`,
        [fullName.trim(), actor.uid]
      );
      return rows[0];
    } catch (err) {
      throw translateDatabaseError(err);
    }
  }

  async adminCreateStudentAccount(
    actor: AuthenticatedActor,
    params: {
      email?: string;
      username?: string;
      password: string;
      full_name: string;
      student_identifier?: string | null;
      account_status?: AccountStatus;
    }
  ): Promise<Profile> {
    if (actor.profile.role !== 'admin') {
      throw new AppError(403, 'FORBIDDEN_ADMIN_ONLY', 'Administrator privileges required.');
    }

    const normalizedName = normalizeUsername(params.username || params.full_name);
    const targetEmail =
      params.email && params.email.trim().includes('@')
        ? params.email.trim().toLowerCase()
        : usernameToSyntheticEmail(normalizedName);

    let createdUserId: string | null = null;
    try {
      const created = await this.insertAuthUser({
        email: targetEmail,
        password: params.password,
        fullName: params.full_name,
        username: normalizedName,
      });
      createdUserId = created.id;

      return await this.adminUpdateStudentProfile(actor, {
        student_id: created.id,
        full_name: params.full_name,
        student_identifier: params.student_identifier ?? null,
        account_status: params.account_status ?? 'active',
      });
    } catch (err) {
      if (createdUserId) {
        await this.db.query(`DELETE FROM auth.users WHERE id = $1`, [createdUserId]);
      }
      throw translateDatabaseError(err);
    }
  }

  async adminUpdateStudentProfile(
    actor: AuthenticatedActor,
    params: {
      student_id: string;
      full_name: string;
      student_identifier?: string | null;
      account_status: AccountStatus;
    }
  ): Promise<Profile> {
    try {
      const rows = await this.asUser<Profile>(
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
  }

  async adminListStudents(actor: AuthenticatedActor): Promise<Profile[]> {
    try {
      return await this.asUser<Profile>(
        actor.uid,
        `SELECT * FROM public.profiles WHERE role = 'student' ORDER BY full_name ASC`
      );
    } catch (err) {
      throw translateDatabaseError(err);
    }
  }

  async adminListClasses(actor: AuthenticatedActor): Promise<unknown> {
    try {
      const rows = await this.asUser<{ res: unknown }>(
        actor.uid,
        `SELECT public.admin_list_classes() AS res`
      );
      return rows[0]?.res ?? [];
    } catch (err) {
      throw translateDatabaseError(err);
    }
  }

  async adminCreateClass(
    actor: AuthenticatedActor,
    name: string,
    description?: string | null
  ): Promise<unknown> {
    try {
      const rows = await this.asUser(
        actor.uid,
        `SELECT * FROM public.admin_create_class($1::text, $2::text)`,
        [name, description ?? null]
      );
      return rows[0];
    } catch (err) {
      throw translateDatabaseError(err);
    }
  }

  async adminSetClassMembership(
    actor: AuthenticatedActor,
    classId: string,
    studentId: string,
    status: MembershipStatus
  ): Promise<unknown> {
    try {
      const rows = await this.asUser(
        actor.uid,
        `SELECT * FROM public.admin_set_class_membership($1::uuid, $2::uuid, $3::public.membership_status)`,
        [classId, studentId, status]
      );
      return rows[0];
    } catch (err) {
      throw translateDatabaseError(err);
    }
  }

  async adminListExams(actor: AuthenticatedActor): Promise<unknown> {
    try {
      const rows = await this.asUser<{ res: unknown }>(
        actor.uid,
        `SELECT public.admin_list_exams() AS res`
      );
      return rows[0]?.res ?? [];
    } catch (err) {
      throw translateDatabaseError(err);
    }
  }

  async adminGetExamQuestions(actor: AuthenticatedActor, examId: string): Promise<unknown> {
    try {
      const rows = await this.asUser<{ res: unknown }>(
        actor.uid,
        `SELECT public.admin_get_exam_questions($1::uuid) AS res`,
        [examId]
      );
      return rows[0]?.res ?? [];
    } catch (err) {
      throw translateDatabaseError(err);
    }
  }

  async adminCreateExam(actor: AuthenticatedActor, input: CreateExamInput): Promise<unknown> {
    try {
      const rows = await this.asUser(
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
  }

  async adminUpsertQuestion(
    actor: AuthenticatedActor,
    examId: string,
    input: UpsertQuestionInput
  ): Promise<unknown> {
    try {
      const rows = await this.asUser<{ res: unknown }>(
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
  }

  async adminPublishExam(actor: AuthenticatedActor, examId: string): Promise<unknown> {
    try {
      const rows = await this.asUser(
        actor.uid,
        `SELECT * FROM public.admin_publish_exam($1::uuid)`,
        [examId]
      );
      return rows[0];
    } catch (err) {
      throw translateDatabaseError(err);
    }
  }

  async adminArchiveExam(actor: AuthenticatedActor, examId: string): Promise<unknown> {
    try {
      const rows = await this.asUser(
        actor.uid,
        `SELECT * FROM public.admin_archive_exam($1::uuid)`,
        [examId]
      );
      return rows[0];
    } catch (err) {
      throw translateDatabaseError(err);
    }
  }

  async adminUpdateReleaseSettings(
    actor: AuthenticatedActor,
    examId: string,
    settings: {
      result_release_policy?: ResultReleasePolicy;
      results_released_manually?: boolean;
      allow_review?: boolean;
    }
  ): Promise<unknown> {
    try {
      const rows = await this.asUser(
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
  }

  async adminUpdateExamAccess(
    actor: AuthenticatedActor,
    examId: string,
    settings: ExamAccessSettingsInput
  ): Promise<unknown> {
    try {
      const rows = await this.asUser(
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
  }

  async adminOverrideExamCooldown(
    actor: AuthenticatedActor,
    examId: string,
    options?: { student_id?: string | null; reason?: string | null }
  ): Promise<unknown> {
    try {
      const rows = await this.asUser<{ res: unknown }>(
        actor.uid,
        `SELECT public.admin_override_exam_cooldown($1::uuid, $2::uuid, $3::text) AS res`,
        [examId, options?.student_id ?? null, options?.reason ?? null]
      );
      return rows[0]?.res;
    } catch (err) {
      throw translateDatabaseError(err);
    }
  }

  async adminAssignExam(
    actor: AuthenticatedActor,
    examId: string,
    target: { student_id?: string | null; class_id?: string | null; status?: AssignmentStatus }
  ): Promise<unknown> {
    try {
      const rows = await this.asUser(
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
  }

  async adminCorrectResult(
    actor: AuthenticatedActor,
    resultId: string,
    correctedMarks: number,
    reason: string
  ): Promise<unknown> {
    try {
      const rows = await this.asUser(
        actor.uid,
        `SELECT * FROM public.admin_correct_result($1::uuid, $2::numeric, $3::text)`,
        [resultId, correctedMarks, reason]
      );
      return rows[0];
    } catch (err) {
      throw translateDatabaseError(err);
    }
  }

  async adminGradeResultItem(
    actor: AuthenticatedActor,
    resultId: string,
    questionId: string,
    marksAwarded: number,
    reason: string
  ): Promise<unknown> {
    try {
      const rows = await this.asUser(
        actor.uid,
        `SELECT * FROM public.admin_grade_result_item($1::uuid, $2::uuid, $3::numeric, $4::text)`,
        [resultId, questionId, marksAwarded, reason]
      );
      return rows[0];
    } catch (err) {
      throw translateDatabaseError(err);
    }
  }

  async studentListEligibleExams(actor: AuthenticatedActor): Promise<unknown> {
    try {
      const rows = await this.asUser<{ res: unknown }>(
        actor.uid,
        `SELECT public.student_list_eligible_exams() AS res`
      );
      return rows[0]?.res ?? [];
    } catch (err) {
      throw translateDatabaseError(err);
    }
  }

  async studentStartOrResumeAttempt(
    actor: AuthenticatedActor,
    examId: string
  ): Promise<unknown> {
    try {
      const rows = await this.asUser<{ res: unknown }>(
        actor.uid,
        `SELECT public.student_start_or_resume_attempt($1::uuid) AS res`,
        [examId]
      );
      return rows[0]?.res;
    } catch (err) {
      throw translateDatabaseError(err);
    }
  }

  async studentGetAttemptQuestions(
    actor: AuthenticatedActor,
    attemptId: string
  ): Promise<unknown> {
    try {
      const rows = await this.asUser<{ res: unknown }>(
        actor.uid,
        `SELECT public.student_get_attempt_questions($1::uuid) AS res`,
        [attemptId]
      );
      return rows[0]?.res;
    } catch (err) {
      throw translateDatabaseError(err);
    }
  }

  async studentSaveAnswer(
    actor: AuthenticatedActor,
    attemptId: string,
    questionId: string,
    selectedOptionId: string | null,
    answerValue: string | null = null
  ): Promise<unknown> {
    try {
      const rows = await this.asUser<{ res: unknown }>(
        actor.uid,
        `SELECT public.student_save_answer($1::uuid, $2::uuid, $3::uuid, $4::text) AS res`,
        [attemptId, questionId, selectedOptionId, answerValue]
      );
      return rows[0]?.res;
    } catch (err) {
      throw translateDatabaseError(err);
    }
  }

  async studentSubmitAttempt(actor: AuthenticatedActor, attemptId: string): Promise<unknown> {
    try {
      const rows = await this.asUser<{ res: unknown }>(
        actor.uid,
        `SELECT public.student_submit_attempt($1::uuid) AS res`,
        [attemptId]
      );
      return rows[0]?.res;
    } catch (err) {
      throw translateDatabaseError(err);
    }
  }

  async studentGetReleasedResults(actor: AuthenticatedActor): Promise<unknown> {
    try {
      const rows = await this.asUser<{ res: unknown }>(
        actor.uid,
        `SELECT public.student_get_released_results() AS res`
      );
      return rows[0]?.res ?? [];
    } catch (err) {
      throw translateDatabaseError(err);
    }
  }

  async studentGetAttemptReview(actor: AuthenticatedActor, attemptId: string): Promise<unknown> {
    try {
      const rows = await this.asUser<{ res: unknown }>(
        actor.uid,
        `SELECT public.student_get_attempt_review($1::uuid) AS res`,
        [attemptId]
      );
      return rows[0]?.res;
    } catch (err) {
      throw translateDatabaseError(err);
    }
  }

  async adminGetExamStatistics(actor: AuthenticatedActor, examId: string): Promise<unknown> {
    try {
      const rows = await this.asUser<{ res: unknown }>(
        actor.uid,
        `SELECT public.admin_get_exam_statistics($1::uuid) AS res`,
        [examId]
      );
      return rows[0]?.res;
    } catch (err) {
      throw translateDatabaseError(err);
    }
  }

  async adminListExamAttempts(actor: AuthenticatedActor, examId: string): Promise<unknown> {
    try {
      const rows = await this.asUser<{ res: unknown }>(
        actor.uid,
        `SELECT public.admin_list_exam_attempts($1::uuid) AS res`,
        [examId]
      );
      return rows[0]?.res ?? [];
    } catch (err) {
      throw translateDatabaseError(err);
    }
  }

  async adminGetAttemptDetail(actor: AuthenticatedActor, attemptId: string): Promise<unknown> {
    try {
      const rows = await this.asUser<{ res: unknown }>(
        actor.uid,
        `SELECT public.admin_get_attempt_detail($1::uuid) AS res`,
        [attemptId]
      );
      return rows[0]?.res;
    } catch (err) {
      throw translateDatabaseError(err);
    }
  }

  async adminGetQuestionAnalytics(actor: AuthenticatedActor, examId: string): Promise<unknown> {
    try {
      const rows = await this.asUser<{ res: unknown }>(
        actor.uid,
        `SELECT public.admin_get_question_analytics($1::uuid) AS res`,
        [examId]
      );
      return rows[0]?.res ?? [];
    } catch (err) {
      throw translateDatabaseError(err);
    }
  }

  async adminGetClassPerformanceSummary(
    actor: AuthenticatedActor,
    examId: string
  ): Promise<unknown> {
    try {
      const rows = await this.asUser<{ res: unknown }>(
        actor.uid,
        `SELECT public.admin_get_class_performance_summary($1::uuid) AS res`,
        [examId]
      );
      return rows[0]?.res ?? [];
    } catch (err) {
      throw translateDatabaseError(err);
    }
  }

  async adminExportExamResultsRows(
    actor: AuthenticatedActor,
    examId: string
  ): Promise<ExportResultRow[]> {
    try {
      return await this.asUser<ExportResultRow>(
        actor.uid,
        `SELECT * FROM public.admin_export_exam_results_rows($1::uuid)`,
        [examId]
      );
    } catch (err) {
      throw translateDatabaseError(err);
    }
  }

  async adminListAuditLogs(actor: AuthenticatedActor, limit = 100): Promise<unknown> {
    try {
      return await this.asUser(
        actor.uid,
        `SELECT * FROM public.audit_logs ORDER BY created_at DESC LIMIT $1`,
        [Math.min(Math.max(1, limit), 500)]
      );
    } catch (err) {
      throw translateDatabaseError(err);
    }
  }

  async finalizeExpiredAttemptsSweep(batchLimit = 200): Promise<unknown> {
    try {
      const rows = await this.asServiceRole<{ res: unknown }>(
        `SELECT public.finalize_expired_attempts($1::integer) AS res`,
        [batchLimit]
      );
      return rows[0]?.res;
    } catch (err) {
      throw translateDatabaseError(err);
    }
  }
}
