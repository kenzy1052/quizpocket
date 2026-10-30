import crypto from 'crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { BackendEnvConfig } from '../config/env.ts';
import { AppError } from '../utils/errors.ts';
import {
  MIN_PASSWORD_LENGTH,
  normalizeUsername,
  usernameToSyntheticEmail,
} from '../utils/authIdentifier.ts';
import { BackendGateway, SignInResult } from './gateway.ts';
import { SupabaseBackendGateway } from './supabaseGateway.ts';
import { LocalPostgresBackendGateway } from './localPostgresGateway.ts';
import { AccountStatus, AuthenticatedActor, Profile } from '../types/domain.ts';
import {
  HIM_20_QUESTIONS,
  HIM_DEMO_ACCOUNTS,
  HIM_EXAM_METADATA,
} from '../seed/himExamData.ts';
import { HIM103_CH1_METADATA, HIM103_CH1_QUESTIONS } from '../seed/him103Chapter1Data.ts';
import { HIM101_SW_METADATA, HIM101_SW_QUESTIONS } from '../seed/him101SoftwareData.ts';

interface CachedTokenIdentity {
  uid: string;
  email: string;
  username: string;
  fullName: string;
  expiresAtMs: number;
}

function hashTokenKey(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function ensureRemoteAuthUsers(
  serviceClient: SupabaseClient
): Promise<{ kenzyId: string | undefined }> {
  const kenzyEmail = usernameToSyntheticEmail('kenzy');
  let kenzyId: string | undefined;

  const { data: listData } = await serviceClient.auth.admin.listUsers({ page: 1, perPage: 200 });
  const existingUsers = listData?.users ?? [];
  const byEmail = new Map(existingUsers.map((u) => [(u.email ?? '').toLowerCase(), u]));

  const existingKenzy = byEmail.get(kenzyEmail);
  if (!existingKenzy) {
    const { data: created } = await serviceClient.auth.admin.createUser({
      email: kenzyEmail,
      password: 'kenzy1052',
      email_confirm: true,
      user_metadata: { username: 'kenzy', full_name: 'kenzy' },
    });
    kenzyId = created.user?.id;
  } else {
    kenzyId = existingKenzy.id;
    await serviceClient.auth.admin.updateUserById(existingKenzy.id, {
      password: 'kenzy1052',
      email_confirm: true,
      user_metadata: {
        ...(existingKenzy.user_metadata ?? {}),
        username: 'kenzy',
        full_name: 'kenzy',
      },
    });
  }

  // Preserve exclusively live Supabase Auth users; do not inject generic mock accounts
  return { kenzyId };
}

async function seedRemoteSupabaseIfNeeded(
  supabaseGateway: SupabaseBackendGateway,
  serviceClient: SupabaseClient,
  kenzyId: string | undefined
): Promise<void> {
  if (kenzyId) {
    await serviceClient.rpc('bootstrap_initial_admin', {
      p_user_id: kenzyId,
      p_full_name: 'kenzy',
    });
  }

  const adminSession = await supabaseGateway.signInWithPassword('kenzy', 'kenzy1052');
  const adminActor = await supabaseGateway.verifyBearerToken(adminSession.access_token);

  // 1. Ensure default cohort exists and is named HIM 105 Health Information Management Cohort
  await serviceClient
    .from('classes')
    .update({
      name: 'HIM 105 Health Information Management Cohort',
      auto_enroll_new_students: true,
    })
    .or('name.ilike.HIM-101%,name.ilike.AIM 105%,name.ilike.HIM 105%');

  const { data: existingClasses } = await serviceClient
    .from('classes')
    .select('id')
    .or('name.ilike.HIM 105%,name.ilike.AIM 105%,name.ilike.HIM-101%')
    .limit(1);

  let defaultClassId = existingClasses?.[0]?.id as string | undefined;
  if (!defaultClassId) {
    const createdClass = (await supabaseGateway.adminCreateClass(
      adminActor,
      'HIM 105 Health Information Management Cohort',
      'Undergraduate Health Information Management & Hospital Administration Cohort'
    )) as { id: string };
    defaultClassId = createdClass.id;
    await serviceClient
      .from('classes')
      .update({ auto_enroll_new_students: true })
      .eq('id', defaultClassId);
  }

  // 2. Clean up unattempted legacy/draft exams and archive attempted legacy exams
  const { data: allExams } = await serviceClient
    .from('exams')
    .select('id, title, status');

  let lecture1ExamId: string | undefined;
  let him103ExamId: string | undefined;
  let him101ExamId: string | undefined;

  for (const exam of allExams ?? []) {
    const eId = String(exam.id);
    const eTitle = String(exam.title ?? '').trim();
    if (eTitle === HIM_EXAM_METADATA.title && exam.status !== 'archived') {
      lecture1ExamId = eId;
      continue;
    }
    if (eTitle === HIM103_CH1_METADATA.title && exam.status !== 'archived') {
      him103ExamId = eId;
      continue;
    }
    if (eTitle === HIM101_SW_METADATA.title && exam.status !== 'archived') {
      him101ExamId = eId;
      continue;
    }

    const isLegacySeed =
      /^HIS 202/i.test(eTitle) ||
      /^AIM 105/i.test(eTitle) ||
      (eTitle !== HIM101_SW_METADATA.title && /^HIM 101/i.test(eTitle));

    if (!isLegacySeed) continue;

    const { count: attCnt } = await serviceClient
      .from('exam_attempts')
      .select('id', { count: 'exact', head: true })
      .eq('exam_id', eId);

    if ((attCnt ?? 0) === 0) {
      await serviceClient.from('exam_assignments').delete().eq('exam_id', eId);
      await serviceClient.from('exam_questions').delete().eq('exam_id', eId);
      await serviceClient.from('exams').delete().eq('id', eId);
    } else if (exam.status !== 'archived') {
      await supabaseGateway.adminArchiveExam(adminActor, eId).catch(async () => {
        await serviceClient.from('exams').update({ status: 'archived' }).eq('id', eId);
      });
    }
  }

  // 3. Provision HIM 105 Lecture 1 if not already present
  if (!lecture1ExamId) {
    const createdExam = (await supabaseGateway.adminCreateExam(
      adminActor,
      HIM_EXAM_METADATA
    )) as { id: string };
    lecture1ExamId = createdExam.id;

    for (const q of HIM_20_QUESTIONS) {
      await supabaseGateway.adminUpsertQuestion(adminActor, lecture1ExamId, q);
    }

    await supabaseGateway.adminPublishExam(adminActor, lecture1ExamId);
  }

  // 3b. Provision HIM 103 Chapter 1 (40 questions, 40 minutes) if not already present
  if (!him103ExamId) {
    const createdExam = (await supabaseGateway.adminCreateExam(
      adminActor,
      HIM103_CH1_METADATA
    )) as { id: string };
    him103ExamId = createdExam.id;

    for (const q of HIM103_CH1_QUESTIONS) {
      await supabaseGateway.adminUpsertQuestion(adminActor, him103ExamId, q);
    }

    await supabaseGateway.adminPublishExam(adminActor, him103ExamId);
  }

  if (defaultClassId && him103ExamId) {
    const chapterExamId = him103ExamId;
    await supabaseGateway
      .adminAssignExam(adminActor, chapterExamId, {
        class_id: defaultClassId,
        status: 'active',
      })
      .catch(async () => {
        await serviceClient.from('exam_assignments').upsert(
          {
            exam_id: chapterExamId,
            class_id: defaultClassId,
            assignment_status: 'active',
            assigned_by: kenzyId ?? adminActor.uid,
          },
          { onConflict: 'exam_id,class_id', ignoreDuplicates: true }
        );
      });
  }

  // 3c. Provision HIM 101: Software System (40 questions, 60 minutes, 50 marks) if not already present
  if (!him101ExamId) {
    const createdExam = (await supabaseGateway.adminCreateExam(
      adminActor,
      HIM101_SW_METADATA
    )) as { id: string };
    him101ExamId = createdExam.id;

    for (const q of HIM101_SW_QUESTIONS) {
      await supabaseGateway.adminUpsertQuestion(adminActor, him101ExamId, q);
    }

    await supabaseGateway.adminPublishExam(adminActor, him101ExamId);
  }

  if (defaultClassId && him101ExamId) {
    const softwareExamId = him101ExamId;
    await supabaseGateway
      .adminAssignExam(adminActor, softwareExamId, {
        class_id: defaultClassId,
        status: 'active',
      })
      .catch(async () => {
        await serviceClient.from('exam_assignments').upsert(
          {
            exam_id: softwareExamId,
            class_id: defaultClassId,
            assignment_status: 'active',
            assigned_by: kenzyId ?? adminActor.uid,
          },
          { onConflict: 'exam_id,class_id', ignoreDuplicates: true }
        );
      });
  }

  // 4. Assign HIM 105 Lecture 1 to default cohort & enroll all active students
  if (defaultClassId && lecture1ExamId) {
    await supabaseGateway
      .adminAssignExam(adminActor, lecture1ExamId, {
        class_id: defaultClassId,
        status: 'active',
      })
      .catch(async () => {
        await serviceClient.from('exam_assignments').upsert(
          {
            exam_id: lecture1ExamId,
            class_id: defaultClassId,
            assignment_status: 'active',
            assigned_by: kenzyId ?? adminActor.uid,
          },
          { onConflict: 'exam_id,class_id', ignoreDuplicates: true }
        );
      });
  }

  const { data: allStudents } = await serviceClient
    .from('profiles')
    .select('id')
    .eq('role', 'student')
    .eq('account_status', 'active');

  if (defaultClassId && Array.isArray(allStudents) && allStudents.length > 0) {
    await serviceClient.from('class_memberships').upsert(
      allStudents.map((s) => ({
        class_id: defaultClassId,
        student_id: s.id as string,
        membership_status: 'active' as const,
      })),
      { onConflict: 'class_id,student_id' }
    );
  }
}

/**
 * Wraps LocalPostgresBackendGateway when remote Supabase Auth is configured
 * (`VITE_SUPABASE_URL` + keys) while remote SQL tables (`public.profiles`, `public.exams`)
 * have not yet been applied in the Supabase Dashboard SQL Editor.
 *
 * All user creation & password authentication run against LIVE Supabase Auth (`auth.users`)
 * with real Supabase JWTs, while examination state runs on the embedded PostgreSQL 16 engine
 * with identical UUIDs.
 */
class HybridSupabaseAuthPostgresGateway implements BackendGateway {
  private readonly anonClient: SupabaseClient;
  private readonly serviceClient: SupabaseClient | null;
  private readonly local: LocalPostgresBackendGateway;
  private readonly tokenCache = new Map<string, CachedTokenIdentity>();

  constructor(params: {
    anonClient: SupabaseClient;
    serviceClient: SupabaseClient | null;
    local: LocalPostgresBackendGateway;
  }) {
    this.anonClient = params.anonClient;
    this.serviceClient = params.serviceClient;
    this.local = params.local;
  }

  async verifyBearerToken(token: string): Promise<AuthenticatedActor> {
    if (token.startsWith('qp.')) {
      return this.local.verifyBearerToken(token);
    }

    const cacheKey = hashTokenKey(token);
    const cached = this.tokenCache.get(cacheKey);
    if (cached && cached.expiresAtMs > Date.now()) {
      return this.local.loadActiveActorById(cached.uid, token);
    }

    const { data, error } = await this.anonClient.auth.getUser(token);
    if (error || !data.user) {
      this.tokenCache.delete(cacheKey);
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired authentication session.');
    }

    const user = data.user;
    const email = (user.email ?? `${user.id}@users.quizpocket.local`).toLowerCase();
    const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
    const username =
      typeof meta.username === 'string' && meta.username.trim()
        ? meta.username.trim()
        : typeof meta.full_name === 'string' && meta.full_name.trim()
          ? meta.full_name.trim()
          : email.split('@')[0];
    const fullName =
      typeof meta.full_name === 'string' && meta.full_name.trim()
        ? meta.full_name.trim()
        : username;
    const isAdmin = username.toLowerCase() === 'kenzy' || email === usernameToSyntheticEmail('kenzy');

    await this.local.ensureMirroredAuthUser({
      id: user.id,
      email,
      username,
      fullName,
      isAdmin,
    });

    this.tokenCache.set(cacheKey, {
      uid: user.id,
      email,
      username,
      fullName,
      expiresAtMs: Date.now() + 45_000,
    });

    return this.local.loadActiveActorById(user.id, token);
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

    const existingLocal = await this.local.resolveLocalLoginEmail(normalizedUsername);
    if (existingLocal) {
      throw new AppError(
        409,
        'ACCOUNT_ALREADY_EXISTS',
        'That name is already registered. Please sign in or choose another name.'
      );
    }

    const syntheticEmail = usernameToSyntheticEmail(normalizedUsername);

    if (this.serviceClient) {
      const { data: created, error: createErr } = await this.serviceClient.auth.admin.createUser({
        email: syntheticEmail,
        password,
        email_confirm: true,
        user_metadata: { username: normalizedUsername, full_name: normalizedUsername },
      });

      if (createErr || !created.user) {
        throw new AppError(
          409,
          'ACCOUNT_ALREADY_EXISTS',
          'That name is already registered. Please sign in or choose another name.'
        );
      }

      const isAdmin =
        normalizedUsername.toLowerCase() === 'kenzy' && password === 'kenzy1052';

      await this.local.ensureMirroredAuthUser({
        id: created.user.id,
        email: syntheticEmail,
        username: normalizedUsername,
        fullName: normalizedUsername,
        password,
        isAdmin,
      });

      return this.signInWithPassword(normalizedUsername, password);
    }

    return this.local.signUpWithUsername(normalizedUsername, password);
  }

  async signInWithPassword(identifier: string, password: string): Promise<SignInResult> {
    const trimmed = normalizeUsername(identifier);
    const localResolved = await this.local.resolveLocalLoginEmail(trimmed);
    const targetEmail =
      localResolved ||
      (trimmed.includes('@') ? trimmed.toLowerCase() : usernameToSyntheticEmail(trimmed));

    const { data, error } = await this.anonClient.auth.signInWithPassword({
      email: targetEmail.toLowerCase(),
      password,
    });

    if (!error && data.session && data.user) {
      const actor = await this.verifyBearerToken(data.session.access_token);
      return {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
        profile: actor.profile,
      };
    }

    // Fallback for local-only accounts if any
    return this.local.signInWithPassword(identifier, password);
  }

  requestPasswordReset(email: string, _redirectTo?: string) {
    return this.local.requestPasswordReset(email);
  }

  updateOwnFullName(actor: AuthenticatedActor, fullName: string) {
    return this.local.updateOwnFullName(actor, fullName);
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

    if (this.serviceClient) {
      const { data: created, error: createErr } = await this.serviceClient.auth.admin.createUser({
        email: targetEmail,
        password: params.password,
        email_confirm: true,
        user_metadata: { username: normalizedName, full_name: params.full_name.trim() },
      });

      if (createErr || !created.user) {
        throw new AppError(
          409,
          'STUDENT_CREATION_FAILED',
          'Unable to create student account. Verify that the name is not already registered.'
        );
      }

      await this.local.ensureMirroredAuthUser({
        id: created.user.id,
        email: targetEmail,
        username: normalizedName,
        fullName: params.full_name.trim(),
        password: params.password,
        isAdmin: false,
      });

      return this.local.adminUpdateStudentProfile(actor, {
        student_id: created.user.id,
        full_name: params.full_name.trim(),
        student_identifier: params.student_identifier ?? null,
        account_status: params.account_status ?? 'active',
      });
    }

    return this.local.adminCreateStudentAccount(actor, params);
  }

  adminUpdateStudentProfile: BackendGateway['adminUpdateStudentProfile'] = (...args) =>
    this.local.adminUpdateStudentProfile(...args);
  adminListStudents: BackendGateway['adminListStudents'] = (...args) =>
    this.local.adminListStudents(...args);
  adminListClasses: BackendGateway['adminListClasses'] = (...args) =>
    this.local.adminListClasses(...args);
  adminCreateClass: BackendGateway['adminCreateClass'] = (...args) =>
    this.local.adminCreateClass(...args);
  adminSetClassMembership: BackendGateway['adminSetClassMembership'] = (...args) =>
    this.local.adminSetClassMembership(...args);
  adminListExams: BackendGateway['adminListExams'] = (...args) =>
    this.local.adminListExams(...args);
  adminGetExamQuestions: BackendGateway['adminGetExamQuestions'] = (...args) =>
    this.local.adminGetExamQuestions(...args);
  adminCreateExam: BackendGateway['adminCreateExam'] = (...args) =>
    this.local.adminCreateExam(...args);
  adminUpsertQuestion: BackendGateway['adminUpsertQuestion'] = (...args) =>
    this.local.adminUpsertQuestion(...args);
  adminPublishExam: BackendGateway['adminPublishExam'] = (...args) =>
    this.local.adminPublishExam(...args);
  adminArchiveExam: BackendGateway['adminArchiveExam'] = (...args) =>
    this.local.adminArchiveExam(...args);
  adminUpdateReleaseSettings: BackendGateway['adminUpdateReleaseSettings'] = (...args) =>
    this.local.adminUpdateReleaseSettings(...args);
  adminUpdateExamAccess: BackendGateway['adminUpdateExamAccess'] = (...args) =>
    this.local.adminUpdateExamAccess(...args);
  adminOverrideExamCooldown: BackendGateway['adminOverrideExamCooldown'] = (...args) =>
    this.local.adminOverrideExamCooldown(...args);
  adminAssignExam: BackendGateway['adminAssignExam'] = (...args) =>
    this.local.adminAssignExam(...args);
  adminCorrectResult: BackendGateway['adminCorrectResult'] = (...args) =>
    this.local.adminCorrectResult(...args);
  adminGradeResultItem: BackendGateway['adminGradeResultItem'] = (...args) =>
    this.local.adminGradeResultItem(...args);
  studentListEligibleExams: BackendGateway['studentListEligibleExams'] = (...args) =>
    this.local.studentListEligibleExams(...args);
  studentStartOrResumeAttempt: BackendGateway['studentStartOrResumeAttempt'] = (...args) =>
    this.local.studentStartOrResumeAttempt(...args);
  studentGetAttemptQuestions: BackendGateway['studentGetAttemptQuestions'] = (...args) =>
    this.local.studentGetAttemptQuestions(...args);
  studentSaveAnswer: BackendGateway['studentSaveAnswer'] = (...args) =>
    this.local.studentSaveAnswer(...args);
  studentSubmitAttempt: BackendGateway['studentSubmitAttempt'] = (...args) =>
    this.local.studentSubmitAttempt(...args);
  studentGetReleasedResults: BackendGateway['studentGetReleasedResults'] = (...args) =>
    this.local.studentGetReleasedResults(...args);
  studentGetAttemptReview: BackendGateway['studentGetAttemptReview'] = (...args) =>
    this.local.studentGetAttemptReview(...args);
  studentRecordQuestionPosition: BackendGateway['studentRecordQuestionPosition'] = (...args) =>
    this.local.studentRecordQuestionPosition(...args);
  adminGetExamStatistics: BackendGateway['adminGetExamStatistics'] = (...args) =>
    this.local.adminGetExamStatistics(...args);
  adminListExamAttempts: BackendGateway['adminListExamAttempts'] = (...args) =>
    this.local.adminListExamAttempts(...args);
  adminGetAttemptDetail: BackendGateway['adminGetAttemptDetail'] = (...args) =>
    this.local.adminGetAttemptDetail(...args);
  adminListLiveMonitoring: BackendGateway['adminListLiveMonitoring'] = (...args) =>
    this.local.adminListLiveMonitoring(...args);
  adminGetAttemptLiveStatus: BackendGateway['adminGetAttemptLiveStatus'] = (...args) =>
    this.local.adminGetAttemptLiveStatus(...args);
  adminGetQuestionAnalytics: BackendGateway['adminGetQuestionAnalytics'] = (...args) =>
    this.local.adminGetQuestionAnalytics(...args);
  adminGetClassPerformanceSummary: BackendGateway['adminGetClassPerformanceSummary'] = (...args) =>
    this.local.adminGetClassPerformanceSummary(...args);
  adminExportExamResultsRows: BackendGateway['adminExportExamResultsRows'] = (...args) =>
    this.local.adminExportExamResultsRows(...args);
  adminListAuditLogs: BackendGateway['adminListAuditLogs'] = (...args) =>
    this.local.adminListAuditLogs(...args);
  finalizeExpiredAttemptsSweep: BackendGateway['finalizeExpiredAttemptsSweep'] = (...args) =>
    this.local.finalizeExpiredAttemptsSweep(...args);
}

export async function createRuntimeGateway(
  envConfig: BackendEnvConfig,
  localDataDir: string
): Promise<BackendGateway> {
  if (!envConfig.isSupabaseConfigured || !envConfig.supabaseUrl || !envConfig.supabasePublicKey) {
    return LocalPostgresBackendGateway.create({
      dataDir: localDataDir,
      seedDemoData: true,
    });
  }

  const anonClient = createClient(envConfig.supabaseUrl, envConfig.supabasePublicKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const serviceClient = envConfig.supabaseServiceRoleKey
    ? createClient(envConfig.supabaseUrl, envConfig.supabaseServiceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;

  let kenzySupabaseId: string | undefined;
  if (serviceClient) {
    try {
      const provisioned = await ensureRemoteAuthUsers(serviceClient);
      kenzySupabaseId = provisioned.kenzyId;
    } catch (err) {
      console.warn('Unable to pre-provision remote Supabase Auth users:', err);
    }
  }

  // Probe whether remote Supabase SQL migrations (public.profiles, public.exams) have been applied
  const probeClient = serviceClient ?? anonClient;
  const { error: schemaProbeError } = await probeClient.from('profiles').select('id').limit(1);

  const remoteSchemaReady = !schemaProbeError;
  if (remoteSchemaReady) {
    const supabaseGateway = new SupabaseBackendGateway(envConfig);
    if (serviceClient) {
      try {
        await seedRemoteSupabaseIfNeeded(supabaseGateway, serviceClient, kenzySupabaseId);
      } catch (err) {
        console.warn('Remote Supabase seed check warning:', err);
      }
    }
    return supabaseGateway;
  }

  // Remote Supabase Auth is active, while SQL tables haven't been pasted into Supabase SQL Editor yet:
  // sync all Auth accounts with live Supabase Auth and execute exam SQL on persistent local PostgreSQL 16.
  const local = await LocalPostgresBackendGateway.create({
    dataDir: localDataDir,
    seedDemoData: true,
    predefinedAdminId: kenzySupabaseId,
  });

  return new HybridSupabaseAuthPostgresGateway({
    anonClient,
    serviceClient,
    local,
  });
}
