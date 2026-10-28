-- ============================================================================
-- Migration 0008: Username-First Authentication, Auto-Cohort Enrollment, & Admin Support
-- Project: QuizPocket — Online Examination & Assessment Platform
-- ============================================================================

-- 1. Add username column on public.profiles and backfill existing accounts
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS username text NULL
  CHECK (username IS NULL OR char_length(btrim(username)) BETWEEN 1 AND 80);

DO $$
BEGIN
  PERFORM set_config('quizpocket.trusted_context', 'on', true);

  UPDATE public.profiles
  SET username = left(btrim(full_name), 80)
  WHERE username IS NULL;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_institution_username_uidx
  ON public.profiles (institution_id, lower(btrim(username)))
  WHERE username IS NOT NULL;

-- 2. Allow classes to opt in to automatic enrollment for self-registered student accounts
ALTER TABLE public.classes
  ADD COLUMN IF NOT EXISTS auto_enroll_new_students boolean NOT NULL DEFAULT false;

-- 3. Protect username alongside email/role/status from untrusted direct mutation
CREATE OR REPLACE FUNCTION public.protect_profile_sensitive_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_trusted boolean;
BEGIN
  v_trusted := (
    current_user IN ('postgres', 'service_role', 'supabase_admin', 'supabase_auth_admin')
    OR current_setting('quizpocket.trusted_context', true) = 'on'
    OR public.is_active_admin()
  );

  IF TG_OP = 'INSERT' THEN
    IF NOT v_trusted THEN
      IF NEW.role <> 'student' THEN
        RAISE EXCEPTION 'FORBIDDEN_ROLE_ASSIGNMENT: Public registration cannot assign privileged roles.'
          USING ERRCODE = '42501';
      END IF;
      IF NEW.account_status = 'active' THEN
        NEW.role := 'student';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NOT v_trusted THEN
      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.role IS DISTINCT FROM OLD.role
         OR NEW.account_status IS DISTINCT FROM OLD.account_status
         OR NEW.institution_id IS DISTINCT FROM OLD.institution_id
         OR NEW.student_identifier IS DISTINCT FROM OLD.student_identifier
         OR lower(btrim(NEW.email)) IS DISTINCT FROM lower(btrim(OLD.email))
         OR lower(btrim(COALESCE(NEW.username, ''))) IS DISTINCT FROM lower(btrim(COALESCE(OLD.username, '')))
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'FORBIDDEN_PROFILE_MODIFICATION: Protected profile attributes cannot be modified by students.'
          USING ERRCODE = '42501';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

-- 4. Synchronize auth.users signup with username + auto-enrollment into designated default cohorts
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_username text;
  v_full_name text;
  v_inst uuid := '00000000-0000-0000-0000-000000000001';
BEGIN
  PERFORM set_config('quizpocket.trusted_context', 'on', true);

  v_username := COALESCE(
    NULLIF(btrim(NEW.raw_user_meta_data ->> 'username'), ''),
    NULLIF(btrim(NEW.raw_user_meta_data ->> 'full_name'), ''),
    split_part(COALESCE(NEW.email, 'student@users.quizpocket.local'), '@', 1)
  );

  v_full_name := COALESCE(
    NULLIF(btrim(NEW.raw_user_meta_data ->> 'full_name'), ''),
    v_username
  );

  INSERT INTO public.profiles (
    id,
    institution_id,
    email,
    username,
    full_name,
    role,
    account_status
  )
  VALUES (
    NEW.id,
    v_inst,
    COALESCE(NEW.email, NEW.id::text || '@users.quizpocket.local'),
    left(v_username, 80),
    left(v_full_name, 200),
    'student',
    'active'
  )
  ON CONFLICT (id) DO NOTHING;

  -- Automatically enroll newly created student profiles into default cohorts (e.g., HIM-101)
  INSERT INTO public.class_memberships (class_id, student_id, membership_status)
  SELECT c.id, NEW.id, 'active'
  FROM public.classes c
  WHERE c.institution_id = v_inst
    AND c.auto_enroll_new_students = true
  ON CONFLICT (class_id, student_id) DO NOTHING;

  RETURN NEW;
END;
$$;

-- 5. Update bootstrap_initial_admin to set username and clear any student auto-enrollments
CREATE OR REPLACE FUNCTION public.bootstrap_initial_admin(
  p_user_id uuid,
  p_full_name text DEFAULT NULL
)
RETURNS public.profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_auth_email text;
  v_auth_username text;
  v_resolved_name text;
  v_profile public.profiles%ROWTYPE;
BEGIN
  IF current_user NOT IN ('postgres', 'service_role', 'supabase_admin')
     AND COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'FORBIDDEN_SERVICE_ROLE_ONLY: Initial administrator promotion requires service_role privileges.'
      USING ERRCODE = '42501';
  END IF;

  SELECT u.email, NULLIF(btrim(u.raw_user_meta_data ->> 'username'), '')
  INTO v_auth_email, v_auth_username
  FROM auth.users u
  WHERE u.id = p_user_id;

  IF v_auth_email IS NULL THEN
    RAISE EXCEPTION 'AUTH_USER_NOT_FOUND: Target auth user % does not exist.', p_user_id;
  END IF;

  PERFORM set_config('quizpocket.trusted_context', 'on', true);

  -- Remove any student class memberships created during initial auth trigger
  DELETE FROM public.class_memberships WHERE student_id = p_user_id;

  v_resolved_name := COALESCE(
    NULLIF(btrim(p_full_name), ''),
    v_auth_username,
    split_part(v_auth_email, '@', 1)
  );

  INSERT INTO public.profiles (
    id,
    institution_id,
    email,
    username,
    full_name,
    role,
    account_status
  )
  VALUES (
    p_user_id,
    '00000000-0000-0000-0000-000000000001',
    v_auth_email,
    left(COALESCE(v_auth_username, v_resolved_name), 80),
    left(v_resolved_name, 200),
    'admin',
    'active'
  )
  ON CONFLICT (id) DO UPDATE
    SET role = 'admin',
        account_status = 'active',
        username = left(COALESCE(v_auth_username, NULLIF(btrim(p_full_name), ''), public.profiles.username), 80),
        full_name = left(COALESCE(NULLIF(btrim(p_full_name), ''), public.profiles.full_name), 200)
  RETURNING * INTO v_profile;

  PERFORM public.internal_write_audit_log(
    v_profile.institution_id,
    p_user_id,
    'system',
    'admin_bootstrapped',
    'profile',
    p_user_id,
    jsonb_build_object('username', v_profile.username, 'email', v_profile.email)
  );

  RETURN v_profile;
END;
$$;

REVOKE ALL ON FUNCTION public.bootstrap_initial_admin(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bootstrap_initial_admin(uuid, text) TO service_role;

-- 6. Update admin_configure_student_profile to maintain username cleanly
CREATE OR REPLACE FUNCTION public.admin_configure_student_profile(
  p_student_id uuid,
  p_full_name text,
  p_student_identifier text DEFAULT NULL,
  p_account_status public.account_status DEFAULT 'active'
)
RETURNS public.profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin_inst uuid;
  v_auth_email text;
  v_auth_username text;
  v_existing public.profiles%ROWTYPE;
  v_profile public.profiles%ROWTYPE;
BEGIN
  IF NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY: Active administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  v_admin_inst := public.current_institution_id();

  SELECT u.email, NULLIF(btrim(u.raw_user_meta_data ->> 'username'), '')
  INTO v_auth_email, v_auth_username
  FROM auth.users u
  WHERE u.id = p_student_id;

  IF v_auth_email IS NULL THEN
    RAISE EXCEPTION 'AUTH_USER_NOT_FOUND: Student auth account does not exist.';
  END IF;

  SELECT * INTO v_existing FROM public.profiles WHERE id = p_student_id;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.institution_id <> v_admin_inst THEN
      RAISE EXCEPTION 'CROSS_INSTITUTION_ERROR: Profile belongs to another institution.'
        USING ERRCODE = '42501';
    END IF;
    IF v_existing.role = 'admin' THEN
      RAISE EXCEPTION 'INVALID_TARGET_ROLE: Cannot manage an administrator through student profile RPC.';
    END IF;
  END IF;

  PERFORM set_config('quizpocket.trusted_context', 'on', true);

  INSERT INTO public.profiles (
    id,
    institution_id,
    email,
    username,
    full_name,
    student_identifier,
    role,
    account_status
  )
  VALUES (
    p_student_id,
    v_admin_inst,
    v_auth_email,
    left(COALESCE(v_auth_username, btrim(p_full_name)), 80),
    btrim(p_full_name),
    NULLIF(btrim(p_student_identifier), ''),
    'student',
    p_account_status
  )
  ON CONFLICT (id) DO UPDATE
    SET full_name = btrim(p_full_name),
        username = COALESCE(public.profiles.username, left(btrim(p_full_name), 80)),
        student_identifier = NULLIF(btrim(p_student_identifier), ''),
        account_status = p_account_status
  RETURNING * INTO v_profile;

  PERFORM public.internal_write_audit_log(
    v_admin_inst,
    auth.uid(),
    'admin',
    'student_profile_managed',
    'profile',
    v_profile.id,
    jsonb_build_object(
      'account_status', v_profile.account_status,
      'student_identifier', v_profile.student_identifier
    )
  );

  RETURN v_profile;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_configure_student_profile(uuid, text, text, public.account_status) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_configure_student_profile(uuid, text, text, public.account_status) TO authenticated, service_role;

-- 7. Service-role login resolver (resolves username, full_name, or email to auth email)
CREATE OR REPLACE FUNCTION public.service_resolve_login_email(p_identifier text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ident text := lower(btrim(COALESCE(p_identifier, '')));
  v_email text;
BEGIN
  IF current_user NOT IN ('postgres', 'service_role', 'supabase_admin')
     AND COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'FORBIDDEN_SERVICE_ROLE_ONLY: Login resolution requires service_role privileges.'
      USING ERRCODE = '42501';
  END IF;

  IF v_ident = '' THEN
    RETURN NULL;
  END IF;

  SELECT p.email INTO v_email
  FROM public.profiles p
  WHERE lower(btrim(COALESCE(p.username, ''))) = v_ident
     OR lower(btrim(p.email)) = v_ident
     OR lower(btrim(p.full_name)) = v_ident
  ORDER BY
    CASE
      WHEN lower(btrim(COALESCE(p.username, ''))) = v_ident THEN 1
      WHEN lower(btrim(p.email)) = v_ident THEN 2
      ELSE 3
    END,
    p.created_at ASC
  LIMIT 1;

  RETURN v_email;
END;
$$;

REVOKE ALL ON FUNCTION public.service_resolve_login_email(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.service_resolve_login_email(text) TO service_role;
