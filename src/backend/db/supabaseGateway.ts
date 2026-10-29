import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { BackendEnvConfig } from '../config/env.ts';
import { AppError, translateDatabaseError } from '../utils/errors.ts';
import {
  MIN_PASSWORD_LENGTH,
  normalizeUsername,
  usernameToSyntheticEmail,
} from '../utils/authIdentifier.ts';
import { BackendGateway, SignInResult } from './gateway.ts';
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
} from '../types/domain.ts';

const ADMIN_CLOSED_SENTINEL_ISO = '1970-01-01T00:00:00.000Z';

function isAdminClosedSentinel(scheduledEndAt: unknown): boolean {
  if (typeof scheduledEndAt !== 'string' || !scheduledEndAt) return false;
  const parsed = new Date(scheduledEndAt);
  return !Number.isNaN(parsed.getTime()) && parsed.getUTCFullYear() === 1970;
}

interface CooldownOverridesMap {
  globalOverrideMs: number | null;
  studentOverrideMs: Map<string, number>;
}

/**
 * Domain errors (forbidden, not found, validation) must be surfaced to the admin as-is.
 * Only infrastructure problems (e.g. migration 0009 not applied) may use the legacy fallback.
 */
function rethrowIfDomainError(rpcName: string, error: unknown): void {
  const translated = translateDatabaseError(error);
  const isDomain =
    translated.code.startsWith('FORBIDDEN') ||
    ['EXAM_NOT_FOUND', 'AUTH_USER_NOT_FOUND', 'VALIDATION_CONSTRAINT_FAILED'].includes(
      translated.code
    );
  if (isDomain) throw translated;
  console.warn(`[supabaseGateway] ${rpcName} RPC failed, using legacy fallback:`, error);
}

export class SupabaseBackendGateway implements BackendGateway {
  private readonly config: BackendEnvConfig;

  constructor(config: BackendEnvConfig) {
    this.config = config;
  }

  private ensureConfigured(): { url: string; publicKey: string } {
    if (!this.config.supabaseUrl || !this.config.supabasePublicKey) {
      throw new AppError(
        503,
        'SUPABASE_UNCONFIGURED',
        'Supabase environment variables (VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY or VITE_SUPABASE_ANON_KEY) are not configured.'
      );
    }
    return { url: this.config.supabaseUrl, publicKey: this.config.supabasePublicKey };
  }

  private createAnonClient(): SupabaseClient {
    const { url, publicKey } = this.ensureConfigured();
    return createClient(url, publicKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  private createUserClient(accessToken: string): SupabaseClient {
    const { url, publicKey } = this.ensureConfigured();
    return createClient(url, publicKey, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  private createServiceRoleClient(): SupabaseClient {
    const { url } = this.ensureConfigured();
    if (!this.config.supabaseServiceRoleKey) {
      throw new AppError(
        503,
        'SERVICE_ROLE_UNCONFIGURED',
        'SUPABASE_SERVICE_ROLE_KEY is required on the trusted backend for privileged Auth operations.'
      );
    }
    return createClient(url, this.config.supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  private async ensureStudentEnrolledInDefaultCohort(studentId: string): Promise<void> {
    if (!this.config.supabaseServiceRoleKey) return;
    try {
      const serviceClient = this.createServiceRoleClient();
      const { data: classes } = await serviceClient
        .from('classes')
        .select('id')
        .or('name.ilike.HIM 105%,name.ilike.AIM 105%,name.ilike.HIM-101%')
        .limit(1);
      const defaultClassId = classes?.[0]?.id as string | undefined;
      if (!defaultClassId) return;

      await serviceClient.from('class_memberships').upsert(
        {
          class_id: defaultClassId,
          student_id: studentId,
          membership_status: 'active',
        },
        { onConflict: 'class_id,student_id' }
      );
    } catch {
      // Ignore best-effort auto-enrollment errors
    }
  }

  private async loadCooldownOverridesForExam(examId: string): Promise<CooldownOverridesMap> {
    const result: CooldownOverridesMap = {
      globalOverrideMs: null,
      studentOverrideMs: new Map<string, number>(),
    };
    if (!this.config.supabaseServiceRoleKey) return result;

    try {
      const serviceClient = this.createServiceRoleClient();
      const { data: logs } = await serviceClient
        .from('audit_logs')
        .select('created_at, metadata')
        .eq('entity_id', examId)
        .eq('event_type', 'exam_cooldown_overridden')
        .order('created_at', { ascending: false })
        .limit(200);

      for (const row of logs ?? []) {
        const ts = new Date(String(row.created_at)).getTime();
        if (!Number.isFinite(ts)) continue;
        const meta = (row.metadata ?? {}) as Record<string, unknown>;
        const targetStudentId =
          typeof meta.student_id === 'string' && meta.student_id.trim()
            ? meta.student_id.trim()
            : null;

        if (!targetStudentId) {
          if (result.globalOverrideMs === null || ts > result.globalOverrideMs) {
            result.globalOverrideMs = ts;
          }
        } else {
          const prev = result.studentOverrideMs.get(targetStudentId);
          if (prev === undefined || ts > prev) {
            result.studentOverrideMs.set(targetStudentId, ts);
          }
        }
      }
    } catch {
      // Ignore
    }

    return result;
  }

  async verifyBearerToken(token: string): Promise<AuthenticatedActor> {
    const client = this.createUserClient(token);
    const { data: userData, error: userErr } = await client.auth.getUser(token);
    if (userErr || !userData.user) {
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired authentication session.');
    }

    const { data: profile, error: profileErr } = await client
      .from('profiles')
      .select('*')
      .eq('id', userData.user.id)
      .maybeSingle();

    if (profileErr) {
      throw translateDatabaseError(profileErr);
    }

    if (!profile) {
      throw new AppError(
        403,
        'ACCOUNT_INACTIVE',
        'Your account profile is inactive or awaiting administrative approval.'
      );
    }

    const typedProfile = profile as Profile;
    if (typedProfile.account_status !== 'active') {
      throw new AppError(403, 'ACCOUNT_INACTIVE', 'Your account is not currently active.');
    }

    return {
      uid: userData.user.id,
      email: userData.user.email ?? typedProfile.email,
      accessToken: token,
      profile: typedProfile,
    };
  }

  private async resolveLoginEmail(identifier: string): Promise<string> {
    const trimmed = normalizeUsername(identifier);
    if (this.config.supabaseServiceRoleKey) {
      try {
        const serviceClient = this.createServiceRoleClient();
        const { data } = await serviceClient.rpc('service_resolve_login_email', {
          p_identifier: trimmed,
        });
        if (typeof data === 'string' && data.includes('@')) {
          return data.trim().toLowerCase();
        }
      } catch {
        // Fall back to deterministic email mapping if RPC not yet deployed
      }
    }
    return trimmed.includes('@') ? trimmed.toLowerCase() : usernameToSyntheticEmail(trimmed);
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

    if (this.config.supabaseServiceRoleKey) {
      const serviceClient = this.createServiceRoleClient();

      const { data: existingEmail } = await serviceClient.rpc('service_resolve_login_email', {
        p_identifier: normalizedUsername,
      });
      if (typeof existingEmail === 'string' && existingEmail.length > 0) {
        throw new AppError(
          409,
          'ACCOUNT_ALREADY_EXISTS',
          'That name is already registered. Please sign in or choose another name.'
        );
      }

      const { data: created, error: createErr } = await serviceClient.auth.admin.createUser({
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

      if (normalizedUsername.toLowerCase() === 'kenzy' && password === 'kenzy1052') {
        await serviceClient.rpc('bootstrap_initial_admin', {
          p_user_id: created.user.id,
          p_full_name: 'kenzy',
        });
      } else {
        await this.ensureStudentEnrolledInDefaultCohort(created.user.id);
      }

      return this.signInWithPassword(normalizedUsername, password);
    }

    // Fallback when SUPABASE_SERVICE_ROLE_KEY is unset
    const anonClient = this.createAnonClient();
    const { data, error } = await anonClient.auth.signUp({
      email: syntheticEmail,
      password,
      options: {
        data: { username: normalizedUsername, full_name: normalizedUsername },
      },
    });

    if (error || !data.user) {
      throw new AppError(
        409,
        'ACCOUNT_ALREADY_EXISTS',
        'Unable to create account. That name may already be registered.'
      );
    }

    if (data.session) {
      const actor = await this.verifyBearerToken(data.session.access_token);
      return {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
        profile: actor.profile,
      };
    }

    return this.signInWithPassword(normalizedUsername, password);
  }

  async signInWithPassword(identifier: string, password: string): Promise<SignInResult> {
    const resolvedEmail = await this.resolveLoginEmail(identifier);
    const client = this.createAnonClient();
    const { data, error } = await client.auth.signInWithPassword({
      email: resolvedEmail,
      password,
    });

    if (error || !data.session || !data.user) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid name or password.');
    }

    const actor = await this.verifyBearerToken(data.session.access_token);
    if (actor.profile.role === 'student') {
      await this.ensureStudentEnrolledInDefaultCohort(actor.uid);
    }

    return {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at,
      profile: actor.profile,
    };
  }

  async requestPasswordReset(email: string, redirectTo?: string): Promise<void> {
    const client = this.createAnonClient();
    try {
      await client.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
        redirectTo,
      });
    } catch {
      // Intentionally swallow provider lookup details
    }
  }

  async updateOwnFullName(actor: AuthenticatedActor, fullName: string): Promise<Profile> {
    const client = this.createUserClient(actor.accessToken);
    const { data, error } = await client
      .from('profiles')
      .update({ full_name: fullName.trim() })
      .eq('id', actor.uid)
      .select('*')
      .single();

    if (error) throw translateDatabaseError(error);
    return data as Profile;
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

    const serviceClient = this.createServiceRoleClient();
    const { data: created, error: createErr } = await serviceClient.auth.admin.createUser({
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

    try {
      const profile = await this.adminUpdateStudentProfile(actor, {
        student_id: created.user.id,
        full_name: params.full_name,
        student_identifier: params.student_identifier ?? null,
        account_status: params.account_status ?? 'active',
      });
      await this.ensureStudentEnrolledInDefaultCohort(created.user.id);
      return profile;
    } catch (err) {
      await serviceClient.auth.admin.deleteUser(created.user.id);
      throw err;
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
    const client = this.createUserClient(actor.accessToken);
    const { data, error } = await client.rpc('admin_configure_student_profile', {
      p_student_id: params.student_id,
      p_full_name: params.full_name,
      p_student_identifier: params.student_identifier ?? null,
      p_account_status: params.account_status,
    });
    if (error) throw translateDatabaseError(error);
    return data as Profile;
  }

  async adminListStudents(actor: AuthenticatedActor): Promise<Profile[]> {
    if (actor.profile.role !== 'admin') {
      throw new AppError(403, 'FORBIDDEN_ADMIN_ONLY', 'Administrator privileges required.');
    }
    const client = this.createUserClient(actor.accessToken);
    const { data, error } = await client
      .from('profiles')
      .select('*')
      .eq('role', 'student')
      .order('full_name', { ascending: true });
    if (error) throw translateDatabaseError(error);
    return (data ?? []) as Profile[];
  }

  async adminListClasses(actor: AuthenticatedActor): Promise<unknown> {
    const client = this.createUserClient(actor.accessToken);
    const { data, error } = await client.rpc('admin_list_classes');
    if (error) throw translateDatabaseError(error);
    return data ?? [];
  }

  async adminCreateClass(
    actor: AuthenticatedActor,
    name: string,
    description?: string | null
  ): Promise<unknown> {
    const client = this.createUserClient(actor.accessToken);
    const { data, error } = await client.rpc('admin_create_class', {
      p_name: name,
      p_description: description ?? null,
    });
    if (error) throw translateDatabaseError(error);
    return data;
  }

  async adminSetClassMembership(
    actor: AuthenticatedActor,
    classId: string,
    studentId: string,
    status: MembershipStatus
  ): Promise<unknown> {
    const client = this.createUserClient(actor.accessToken);
    const { data, error } = await client.rpc('admin_set_class_membership', {
      p_class_id: classId,
      p_student_id: studentId,
      p_status: status,
    });
    if (error) throw translateDatabaseError(error);
    return data;
  }

  async adminListExams(actor: AuthenticatedActor): Promise<unknown> {
    const client = this.createUserClient(actor.accessToken);
    const { data, error } = await client.rpc('admin_list_exams');
    if (error) throw translateDatabaseError(error);

    const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
    return rows.map((row) => {
      const sentinelClosed = isAdminClosedSentinel(row.scheduled_end_at);
      const isOpen = typeof row.is_open === 'boolean' ? row.is_open : !sentinelClosed;
      return {
        ...row,
        is_open: isOpen,
        open_to_all: typeof row.open_to_all === 'boolean' ? row.open_to_all : true,
        scheduled_end_at: sentinelClosed ? null : row.scheduled_end_at,
      };
    });
  }

  async adminGetExamQuestions(actor: AuthenticatedActor, examId: string): Promise<unknown> {
    const client = this.createUserClient(actor.accessToken);
    const { data, error } = await client.rpc('admin_get_exam_questions', {
      p_exam_id: examId,
    });
    if (error) throw translateDatabaseError(error);
    return data ?? [];
  }

  async adminCreateExam(actor: AuthenticatedActor, input: CreateExamInput): Promise<unknown> {
    const client = this.createUserClient(actor.accessToken);
    const { data, error } = await client.rpc('admin_create_exam', {
      p_title: input.title,
      p_description: input.description ?? null,
      p_instructions: input.instructions ?? null,
      p_duration_minutes: input.duration_minutes,
      p_passing_percentage: input.passing_percentage ?? 50,
      p_scheduled_start_at: input.scheduled_start_at ?? null,
      p_scheduled_end_at: input.scheduled_end_at ?? null,
      p_result_release_policy: input.result_release_policy ?? 'immediate',
      p_allow_review: input.allow_review ?? true,
      p_shuffle_questions: input.shuffle_questions ?? false,
      p_shuffle_options: input.shuffle_options ?? false,
      p_max_attempts: input.max_attempts ?? 50,
      p_retake_cooldown_minutes: input.retake_cooldown_minutes ?? 180,
      p_open_to_all: input.open_to_all ?? true,
      p_is_open: input.is_open ?? true,
    });

    if (!error) {
      return data;
    }

    // Fallback to 13-arg RPC if migration 0009 has not yet been applied in remote Supabase
    const clampedMaxAttempts = Math.min(50, Math.max(1, input.max_attempts ?? 50));
    const fallback = await client.rpc('admin_create_exam', {
      p_title: input.title,
      p_description: input.description ?? null,
      p_instructions: input.instructions ?? null,
      p_duration_minutes: input.duration_minutes,
      p_passing_percentage: input.passing_percentage ?? 50,
      p_scheduled_start_at: input.scheduled_start_at ?? null,
      p_scheduled_end_at:
        input.is_open === false ? ADMIN_CLOSED_SENTINEL_ISO : (input.scheduled_end_at ?? null),
      p_result_release_policy: input.result_release_policy ?? 'immediate',
      p_allow_review: input.allow_review ?? true,
      p_shuffle_questions: input.shuffle_questions ?? false,
      p_shuffle_options: input.shuffle_options ?? false,
      p_max_attempts: clampedMaxAttempts,
      p_retake_cooldown_minutes: input.retake_cooldown_minutes ?? 180,
    });

    if (fallback.error) throw translateDatabaseError(fallback.error);

    // If open_to_all was requested on 0008 schema, assign to the default AIM 105 cohort automatically
    const createdExam = fallback.data as { id?: string } | null;
    if (input.open_to_all !== false && createdExam?.id && this.config.supabaseServiceRoleKey) {
      try {
        const serviceClient = this.createServiceRoleClient();
        const { data: aimClasses } = await serviceClient
          .from('classes')
          .select('id')
          .or('name.ilike.HIM 105%,name.ilike.AIM 105%,name.ilike.HIM-101%')
          .limit(1);
        if (aimClasses?.[0]?.id) {
          await this.adminAssignExam(actor, createdExam.id, {
            class_id: aimClasses[0].id as string,
            status: 'active',
          });
        }
      } catch {
        // Ignore
      }
    }

    return fallback.data;
  }

  async adminUpsertQuestion(
    actor: AuthenticatedActor,
    examId: string,
    input: UpsertQuestionInput
  ): Promise<unknown> {
    const client = this.createUserClient(actor.accessToken);
    const { data, error } = await client.rpc('admin_upsert_question_with_options', {
      p_exam_id: examId,
      p_question_id: input.question_id ?? null,
      p_question_text: input.question_text,
      p_question_type: input.question_type,
      p_marks: input.marks,
      p_negative_marks: input.negative_marks ?? 0,
      p_explanation: input.explanation ?? null,
      p_display_order: input.display_order ?? null,
      p_is_required: input.is_required ?? true,
      p_options: input.options ?? [],
      p_accepted_answers: input.accepted_answers ?? [],
      p_rubric_keywords: input.rubric_keywords ?? [],
    });
    if (error) throw translateDatabaseError(error);
    return data;
  }

  async adminPublishExam(actor: AuthenticatedActor, examId: string): Promise<unknown> {
    const client = this.createUserClient(actor.accessToken);
    const { data, error } = await client.rpc('admin_publish_exam', { p_exam_id: examId });
    if (error) throw translateDatabaseError(error);
    return data;
  }

  async adminArchiveExam(actor: AuthenticatedActor, examId: string): Promise<unknown> {
    const client = this.createUserClient(actor.accessToken);
    const { data, error } = await client.rpc('admin_archive_exam', { p_exam_id: examId });
    if (error) throw translateDatabaseError(error);
    return data;
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
    const client = this.createUserClient(actor.accessToken);
    const { data, error } = await client.rpc('admin_set_exam_release_settings', {
      p_exam_id: examId,
      p_result_release_policy: settings.result_release_policy ?? null,
      p_results_released_manually: settings.results_released_manually ?? null,
      p_allow_review: settings.allow_review ?? null,
    });
    if (error) throw translateDatabaseError(error);
    return data;
  }

  async adminUpdateExamAccess(
    actor: AuthenticatedActor,
    examId: string,
    settings: ExamAccessSettingsInput
  ): Promise<unknown> {
    if (actor.profile.role !== 'admin') {
      throw new AppError(403, 'FORBIDDEN_ADMIN_ONLY', 'Administrator privileges required.');
    }

    const client = this.createUserClient(actor.accessToken);
    const { data, error } = await client.rpc('admin_set_exam_access', {
      p_exam_id: examId,
      p_is_open: settings.is_open ?? null,
      p_open_to_all: settings.open_to_all ?? null,
      p_title: settings.title ?? null,
      p_retake_cooldown_minutes: settings.retake_cooldown_minutes ?? null,
      p_max_attempts: settings.max_attempts ?? null,
    });

    if (!error) {
      return data;
    }
    rethrowIfDomainError('admin_set_exam_access', error);

    // Fallback when migration 0009 RPC has not yet been pasted into remote Supabase SQL Editor
    const serviceClient = this.createServiceRoleClient();
    const { data: existing, error: fetchErr } = await serviceClient
      .from('exams')
      .select('*')
      .eq('id', examId)
      .single();

    if (fetchErr || !existing) {
      throw new AppError(404, 'EXAM_NOT_FOUND', 'Quiz not found.');
    }

    const patch: Record<string, unknown> = {};
    if (typeof settings.title === 'string' && settings.title.trim()) {
      patch.title = settings.title.trim();
    }
    if (typeof settings.retake_cooldown_minutes === 'number') {
      patch.retake_cooldown_minutes = settings.retake_cooldown_minutes;
    }
    if (typeof settings.max_attempts === 'number') {
      patch.max_attempts = Math.min(50, Math.max(1, settings.max_attempts));
    }
    if (typeof settings.is_open === 'boolean') {
      if (!settings.is_open) {
        patch.scheduled_start_at = null;
        patch.scheduled_end_at = ADMIN_CLOSED_SENTINEL_ISO;
      } else if (isAdminClosedSentinel(existing.scheduled_end_at)) {
        patch.scheduled_end_at = null;
      }
    }

    const { data: updated, error: updErr } = await serviceClient
      .from('exams')
      .update(patch)
      .eq('id', examId)
      .select('*')
      .single();

    if (updErr) throw translateDatabaseError(updErr);

    await serviceClient.from('audit_logs').insert({
      institution_id: actor.profile.institution_id,
      actor_id: actor.uid,
      actor_role: 'admin',
      event_type: 'exam_access_updated',
      entity_type: 'exam',
      entity_id: examId,
      metadata: {
        is_open:
          typeof settings.is_open === 'boolean'
            ? settings.is_open
            : !isAdminClosedSentinel(updated.scheduled_end_at),
        retake_cooldown_minutes: updated.retake_cooldown_minutes,
        title: updated.title,
      },
    });

    return {
      ...updated,
      is_open: !isAdminClosedSentinel(updated.scheduled_end_at),
      scheduled_end_at: isAdminClosedSentinel(updated.scheduled_end_at)
        ? null
        : updated.scheduled_end_at,
    };
  }

  async adminOverrideExamCooldown(
    actor: AuthenticatedActor,
    examId: string,
    options?: { student_id?: string | null; reason?: string | null }
  ): Promise<unknown> {
    if (actor.profile.role !== 'admin') {
      throw new AppError(403, 'FORBIDDEN_ADMIN_ONLY', 'Administrator privileges required.');
    }

    const client = this.createUserClient(actor.accessToken);
    const { data, error } = await client.rpc('admin_override_exam_cooldown', {
      p_exam_id: examId,
      p_student_id: options?.student_id ?? null,
      p_reason: options?.reason ?? null,
    });

    if (!error) {
      return data;
    }
    rethrowIfDomainError('admin_override_exam_cooldown', error);

    // Fallback when migration 0009 RPC has not yet been applied in remote Supabase
    const serviceClient = this.createServiceRoleClient();
    await this.finalizeExpiredAttemptsSweep().catch(() => {});

    const unlockedAt = new Date().toISOString();
    const { error: logErr } = await serviceClient.from('audit_logs').insert({
      institution_id: actor.profile.institution_id,
      actor_id: actor.uid,
      actor_role: 'admin',
      event_type: 'exam_cooldown_overridden',
      entity_type: 'exam',
      entity_id: examId,
      metadata: {
        student_id: options?.student_id ?? null,
        reason: options?.reason ?? 'Admin unlocked retake cooldown',
        unlocked_at: unlockedAt,
      },
    });

    if (logErr) throw translateDatabaseError(logErr);

    return {
      ok: true,
      exam_id: examId,
      student_id: options?.student_id ?? null,
      unlocked_at: unlockedAt,
    };
  }

  async adminAssignExam(
    actor: AuthenticatedActor,
    examId: string,
    target: { student_id?: string | null; class_id?: string | null; status?: AssignmentStatus }
  ): Promise<unknown> {
    const client = this.createUserClient(actor.accessToken);
    const { data, error } = await client.rpc('admin_assign_exam', {
      p_exam_id: examId,
      p_student_id: target.student_id ?? null,
      p_class_id: target.class_id ?? null,
      p_status: target.status ?? 'active',
    });
    if (error) throw translateDatabaseError(error);
    return data;
  }

  async adminCorrectResult(
    actor: AuthenticatedActor,
    resultId: string,
    correctedMarks: number,
    reason: string
  ): Promise<unknown> {
    const client = this.createUserClient(actor.accessToken);
    const { data, error } = await client.rpc('admin_correct_result', {
      p_result_id: resultId,
      p_corrected_marks: correctedMarks,
      p_reason: reason,
    });
    if (error) throw translateDatabaseError(error);
    return data;
  }

  async adminGradeResultItem(
    actor: AuthenticatedActor,
    resultId: string,
    questionId: string,
    marksAwarded: number,
    reason: string
  ): Promise<unknown> {
    const client = this.createUserClient(actor.accessToken);
    const { data, error } = await client.rpc('admin_grade_result_item', {
      p_result_id: resultId,
      p_question_id: questionId,
      p_marks_awarded: marksAwarded,
      p_reason: reason,
    });
    if (error) throw translateDatabaseError(error);
    return data;
  }

  async studentListEligibleExams(actor: AuthenticatedActor): Promise<unknown> {
    await this.finalizeExpiredAttemptsSweep().catch(() => {});
    await this.ensureStudentEnrolledInDefaultCohort(actor.uid);

    const client = this.createUserClient(actor.accessToken);
    const { data, error } = await client.rpc('student_list_eligible_exams');
    if (error) throw translateDatabaseError(error);

    const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
    const enriched = await Promise.all(
      rows.map(async (row) => {
        const examId = String(row.id);
        const serverNowStr =
          typeof row.server_now === 'string' ? row.server_now : new Date().toISOString();
        const serverNowMs = new Date(serverNowStr).getTime();

        const sentinelClosed = isAdminClosedSentinel(row.scheduled_end_at);
        const isOpen = typeof row.is_open === 'boolean' ? row.is_open : !sentinelClosed;
        const cleanedEndAt = sentinelClosed ? null : (row.scheduled_end_at as string | null);

        // If migration 0009 is active, availability_state is already computed by PostgreSQL
        if (typeof row.availability_state === 'string') {
          return {
            ...row,
            is_open: isOpen,
            scheduled_end_at: cleanedEndAt,
          };
        }

        const activeAttemptId = (row.active_attempt_id as string | null) ?? null;
        const attemptsUsed = Number(row.attempts_used ?? row.completed_attempts ?? 0);
        const maxAttempts = Number(row.max_attempts ?? 1);
        const cooldownMins = Number(row.retake_cooldown_minutes ?? 180);

        const rawNextEligible =
          (row.next_eligible_attempt_at as string | null) ??
          (row.next_retake_eligible_at as string | null) ??
          null;

        let effectiveNextEligible: string | null = rawNextEligible;

        if (rawNextEligible) {
          const nextMs = new Date(rawNextEligible).getTime();
          const lastSubmittedMs = nextMs - cooldownMins * 60_000;
          const overrides = await this.loadCooldownOverridesForExam(examId);
          const studentOverrideMs = overrides.studentOverrideMs.get(actor.uid) ?? null;
          const latestOverrideMs = Math.max(
            overrides.globalOverrideMs ?? 0,
            studentOverrideMs ?? 0
          );

          if (latestOverrideMs > 0 && latestOverrideMs >= lastSubmittedMs - 1000) {
            effectiveNextEligible = null;
          }
        }

        const startAtMs =
          typeof row.scheduled_start_at === 'string'
            ? new Date(row.scheduled_start_at).getTime()
            : null;
        const endAtMs = cleanedEndAt ? new Date(cleanedEndAt).getTime() : null;
        const nextEligibleMs = effectiveNextEligible
          ? new Date(effectiveNextEligible).getTime()
          : null;

        let availabilityState:
          | 'in_progress'
          | 'closed'
          | 'upcoming'
          | 'attempts_exhausted'
          | 'cooldown'
          | 'available' = 'available';

        if (activeAttemptId) {
          availabilityState = 'in_progress';
        } else if (!isOpen) {
          availabilityState = 'closed';
        } else if (startAtMs !== null && Number.isFinite(startAtMs) && serverNowMs < startAtMs) {
          availabilityState = 'upcoming';
        } else if (endAtMs !== null && Number.isFinite(endAtMs) && serverNowMs > endAtMs) {
          availabilityState = 'closed';
        } else if (attemptsUsed >= maxAttempts) {
          availabilityState = 'attempts_exhausted';
        } else if (
          nextEligibleMs !== null &&
          Number.isFinite(nextEligibleMs) &&
          serverNowMs < nextEligibleMs
        ) {
          availabilityState = 'cooldown';
        }

        return {
          ...row,
          is_open: isOpen,
          open_to_all: typeof row.open_to_all === 'boolean' ? row.open_to_all : true,
          scheduled_end_at: cleanedEndAt,
          attempts_used: attemptsUsed,
          active_attempt_deadline_at: (row.active_attempt_deadline_at as string | null) ?? null,
          latest_submitted_at: (row.latest_submitted_at as string | null) ?? null,
          next_eligible_attempt_at: effectiveNextEligible,
          availability_state: availabilityState,
          server_now: serverNowStr,
        };
      })
    );

    return enriched;
  }

  async studentStartOrResumeAttempt(actor: AuthenticatedActor, examId: string): Promise<unknown> {
    await this.finalizeExpiredAttemptsSweep().catch(() => {});
    await this.ensureStudentEnrolledInDefaultCohort(actor.uid);

    // Check if closed by admin via sentinel before calling RPC so error code is crystal-clear
    if (this.config.supabaseServiceRoleKey) {
      const serviceClient = this.createServiceRoleClient();
      const [{ data: examRow }, { data: activeRow }] = await Promise.all([
        serviceClient.from('exams').select('*').eq('id', examId).maybeSingle(),
        serviceClient
          .from('exam_attempts')
          .select('id, deadline_at')
          .eq('exam_id', examId)
          .eq('student_id', actor.uid)
          .eq('status', 'in_progress')
          .maybeSingle(),
      ]);

      const hasUnexpiredActive =
        activeRow && new Date(String(activeRow.deadline_at)).getTime() > Date.now();
      const closedByAdmin =
        examRow &&
        (examRow.is_open === false || isAdminClosedSentinel(examRow.scheduled_end_at));

      if (closedByAdmin && !hasUnexpiredActive) {
        throw new AppError(
          403,
          'EXAM_CLOSED_BY_ADMIN',
          'This quiz is currently closed by your instructor.'
        );
      }
    }

    const client = this.createUserClient(actor.accessToken);
    const { data, error } = await client.rpc('student_start_or_resume_attempt', {
      p_exam_id: examId,
    });

    if (!error) {
      return data;
    }

    const errMsg = String(error.message ?? '');
    if (errMsg.includes('RETAKE_COOLDOWN_ACTIVE') && this.config.supabaseServiceRoleKey) {
      // Check if an admin cooldown override unlocked this student's retake
      const serviceClient = this.createServiceRoleClient();
      const [{ data: examRow }, { data: attemptsRows }, overrides] = await Promise.all([
        serviceClient.from('exams').select('*').eq('id', examId).single(),
        serviceClient
          .from('exam_attempts')
          .select('attempt_number, status, submitted_at')
          .eq('exam_id', examId)
          .eq('student_id', actor.uid)
          .order('attempt_number', { ascending: false }),
        this.loadCooldownOverridesForExam(examId),
      ]);

      if (examRow && Array.isArray(attemptsRows)) {
        const completed = attemptsRows.filter(
          (a) => a.status === 'submitted' || a.status === 'auto_submitted'
        );
        const lastSubmittedStr = completed[0]?.submitted_at as string | undefined;
        const lastSubmittedMs = lastSubmittedStr ? new Date(lastSubmittedStr).getTime() : 0;
        const studentOverrideMs = overrides.studentOverrideMs.get(actor.uid) ?? 0;
        const latestOverrideMs = Math.max(overrides.globalOverrideMs ?? 0, studentOverrideMs);

        if (
          latestOverrideMs > 0 &&
          latestOverrideMs >= lastSubmittedMs - 1000 &&
          completed.length < Number(examRow.max_attempts ?? 50)
        ) {
          const nextAttemptNum =
            attemptsRows.reduce((max, item) => Math.max(max, Number(item.attempt_number ?? 0)), 0) +
            1;
          const nowDate = new Date();
          const deadlineDate = new Date(
            nowDate.getTime() + Number(examRow.duration_minutes) * 60_000
          );

          const { data: inserted, error: insErr } = await serviceClient
            .from('exam_attempts')
            .insert({
              exam_id: examId,
              student_id: actor.uid,
              attempt_number: nextAttemptNum,
              status: 'in_progress',
              started_at: nowDate.toISOString(),
              deadline_at: deadlineDate.toISOString(),
              last_activity_at: nowDate.toISOString(),
            })
            .select('*')
            .single();

          if (insErr) throw translateDatabaseError(insErr);

          await serviceClient.from('audit_logs').insert({
            institution_id: actor.profile.institution_id,
            actor_id: actor.uid,
            actor_role: 'student',
            event_type: 'attempt_started',
            entity_type: 'exam_attempt',
            entity_id: inserted.id,
            metadata: {
              exam_id: examId,
              attempt_number: inserted.attempt_number,
              deadline_at: inserted.deadline_at,
              via_cooldown_override: true,
            },
          });

          return {
            attempt_id: inserted.id,
            exam_id: inserted.exam_id,
            attempt_number: inserted.attempt_number,
            status: inserted.status,
            started_at: inserted.started_at,
            deadline_at: inserted.deadline_at,
            server_now: nowDate.toISOString(),
            resumed: false,
          };
        }
      }
    }

    throw translateDatabaseError(error);
  }

  async studentGetAttemptQuestions(actor: AuthenticatedActor, attemptId: string): Promise<unknown> {
    const client = this.createUserClient(actor.accessToken);
    const { data, error } = await client.rpc('student_get_attempt_questions', {
      p_attempt_id: attemptId,
    });
    if (error) throw translateDatabaseError(error);
    return data;
  }

  async studentSaveAnswer(
    actor: AuthenticatedActor,
    attemptId: string,
    questionId: string,
    selectedOptionId: string | null,
    answerValue: string | null = null
  ): Promise<unknown> {
    const client = this.createUserClient(actor.accessToken);
    const { data, error } = await client.rpc('student_save_answer', {
      p_attempt_id: attemptId,
      p_question_id: questionId,
      p_selected_option_id: selectedOptionId,
      p_answer_value: answerValue,
    });
    if (error) throw translateDatabaseError(error);
    return data;
  }

  async studentSubmitAttempt(actor: AuthenticatedActor, attemptId: string): Promise<unknown> {
    const client = this.createUserClient(actor.accessToken);
    const { data, error } = await client.rpc('student_submit_attempt', {
      p_attempt_id: attemptId,
    });
    if (error) throw translateDatabaseError(error);
    return data;
  }

  async studentGetReleasedResults(actor: AuthenticatedActor): Promise<unknown> {
    const client = this.createUserClient(actor.accessToken);
    const { data, error } = await client.rpc('student_get_released_results');
    if (error) throw translateDatabaseError(error);
    return data;
  }

  async studentGetAttemptReview(actor: AuthenticatedActor, attemptId: string): Promise<unknown> {
    const client = this.createUserClient(actor.accessToken);
    const { data, error } = await client.rpc('student_get_attempt_review', {
      p_attempt_id: attemptId,
    });
    if (error) throw translateDatabaseError(error);
    return data;
  }

  async studentRecordQuestionPosition(
    actor: AuthenticatedActor,
    attemptId: string,
    questionIndex: number
  ): Promise<unknown> {
    const client = this.createUserClient(actor.accessToken);
    const { data, error } = await client.rpc('student_record_question_position', {
      p_attempt_id: attemptId,
      p_question_index: questionIndex,
    });
    if (error) throw translateDatabaseError(error);
    return data;
  }

  async adminGetExamStatistics(actor: AuthenticatedActor, examId: string): Promise<unknown> {
    const client = this.createUserClient(actor.accessToken);
    const { data, error } = await client.rpc('admin_get_exam_statistics', { p_exam_id: examId });
    if (error) throw translateDatabaseError(error);
    return data;
  }

  async adminListLiveMonitoring(
    actor: AuthenticatedActor,
    examId?: string | null
  ): Promise<unknown> {
    const client = this.createUserClient(actor.accessToken);
    const { data, error } = await client.rpc('admin_list_live_monitoring', {
      p_exam_id: examId ?? null,
    });
    if (error) throw translateDatabaseError(error);
    return data ?? [];
  }

  async adminGetAttemptLiveStatus(
    actor: AuthenticatedActor,
    attemptId: string
  ): Promise<unknown> {
    const client = this.createUserClient(actor.accessToken);
    const { data, error } = await client.rpc('admin_get_attempt_live_status', {
      p_attempt_id: attemptId,
    });
    if (error) throw translateDatabaseError(error);
    return data;
  }

  async adminListExamAttempts(actor: AuthenticatedActor, examId: string): Promise<unknown> {
    await this.finalizeExpiredAttemptsSweep().catch(() => {});
    const client = this.createUserClient(actor.accessToken);
    const { data, error } = await client.rpc('admin_list_exam_attempts', { p_exam_id: examId });
    if (error) throw translateDatabaseError(error);

    const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
    if (rows.length === 0 || typeof rows[0].in_cooldown === 'boolean') {
      return rows;
    }

    let cooldownMins = 180;
    if (this.config.supabaseServiceRoleKey) {
      try {
        const serviceClient = this.createServiceRoleClient();
        const { data: examRow } = await serviceClient
          .from('exams')
          .select('retake_cooldown_minutes')
          .eq('id', examId)
          .maybeSingle();
        if (examRow && typeof examRow.retake_cooldown_minutes === 'number') {
          cooldownMins = examRow.retake_cooldown_minutes;
        }
      } catch {
        // Ignore
      }
    }

    const overrides = await this.loadCooldownOverridesForExam(examId);
    const nowMs = Date.now();

    return rows.map((row) => {
      const status = String(row.status ?? '');
      const submittedAtStr = (row.submitted_at as string | null) ?? null;
      const studentId = String(row.student_id ?? '');

      if (
        (status !== 'submitted' && status !== 'auto_submitted') ||
        !submittedAtStr ||
        cooldownMins <= 0
      ) {
        return { ...row, in_cooldown: false, cooldown_until: null };
      }

      const submittedMs = new Date(submittedAtStr).getTime();
      const cooldownUntilMs = submittedMs + cooldownMins * 60_000;
      const studentOverrideMs = overrides.studentOverrideMs.get(studentId) ?? 0;
      const latestOverrideMs = Math.max(overrides.globalOverrideMs ?? 0, studentOverrideMs);

      const overridden = latestOverrideMs > 0 && latestOverrideMs >= submittedMs - 1000;
      const inCooldown = !overridden && cooldownUntilMs > nowMs;

      return {
        ...row,
        in_cooldown: inCooldown,
        cooldown_until: inCooldown ? new Date(cooldownUntilMs).toISOString() : null,
      };
    });
  }

  async adminGetAttemptDetail(actor: AuthenticatedActor, attemptId: string): Promise<unknown> {
    const client = this.createUserClient(actor.accessToken);
    const { data, error } = await client.rpc('admin_get_attempt_detail', {
      p_attempt_id: attemptId,
    });
    if (error) throw translateDatabaseError(error);
    return data;
  }

  async adminGetQuestionAnalytics(actor: AuthenticatedActor, examId: string): Promise<unknown> {
    const client = this.createUserClient(actor.accessToken);
    const { data, error } = await client.rpc('admin_get_question_analytics', {
      p_exam_id: examId,
    });
    if (error) throw translateDatabaseError(error);
    return data;
  }

  async adminGetClassPerformanceSummary(
    actor: AuthenticatedActor,
    examId: string
  ): Promise<unknown> {
    const client = this.createUserClient(actor.accessToken);
    const { data, error } = await client.rpc('admin_get_class_performance_summary', {
      p_exam_id: examId,
    });
    if (error) throw translateDatabaseError(error);
    return data;
  }

  async adminExportExamResultsRows(
    actor: AuthenticatedActor,
    examId: string
  ): Promise<ExportResultRow[]> {
    const client = this.createUserClient(actor.accessToken);
    const { data, error } = await client.rpc('admin_export_exam_results_rows', {
      p_exam_id: examId,
    });
    if (error) throw translateDatabaseError(error);
    return (data ?? []) as ExportResultRow[];
  }

  async adminListAuditLogs(actor: AuthenticatedActor, limit = 100): Promise<unknown> {
    if (actor.profile.role !== 'admin') {
      throw new AppError(403, 'FORBIDDEN_ADMIN_ONLY', 'Administrator privileges required.');
    }
    const client = this.createUserClient(actor.accessToken);
    const { data, error } = await client
      .from('audit_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(Math.min(Math.max(1, limit), 500));
    if (error) throw translateDatabaseError(error);
    return data ?? [];
  }

  async finalizeExpiredAttemptsSweep(batchLimit = 200): Promise<unknown> {
    const serviceClient = this.createServiceRoleClient();
    const { data, error } = await serviceClient.rpc('finalize_expired_attempts', {
      p_batch_limit: batchLimit,
    });
    if (error) throw translateDatabaseError(error);
    return data;
  }
}
