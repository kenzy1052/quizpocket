-- ============================================================================
-- Migration 0001: Extensions, Domain Enums, and Core Time Helpers
-- Project: QuizPocket — Online Examination & Assessment Platform
-- ============================================================================

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
EXCEPTION
  WHEN OTHERS THEN
    -- Core PostgreSQL 13+ provides gen_random_uuid() natively even when
    -- extension installation privileges are restricted.
    NULL;
END
$$;

DO $$ BEGIN
  CREATE TYPE public.user_role AS ENUM ('student', 'admin');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.account_status AS ENUM ('active', 'suspended', 'pending_approval');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.membership_status AS ENUM ('active', 'inactive');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.exam_status AS ENUM ('draft', 'published', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.result_release_policy AS ENUM ('immediate', 'after_window', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.question_type AS ENUM ('multiple_choice', 'true_false');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.assignment_status AS ENUM ('active', 'revoked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.attempt_status AS ENUM ('in_progress', 'submitted', 'auto_submitted', 'voided');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Authoritative UTC server timestamp helper. Never accepts client clock input.
CREATE OR REPLACE FUNCTION public.utc_now()
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT timezone('utc', now());
$$;

-- Standard updated_at maintenance trigger function
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := public.utc_now();
  RETURN NEW;
END;
$$;
-- ============================================================================
-- Migration 0002: Normalized Core Tables, Constraints, Indexes, and Triggers
-- Project: QuizPocket — Online Examination & Assessment Platform
-- ============================================================================

-- 1. Institutions (supports single-teacher MVP via default tenant while keeping
--    student identifiers scoped per institution for future expansion)
CREATE TABLE IF NOT EXISTS public.institutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9\-]{0,62}$'),
  created_at timestamptz NOT NULL DEFAULT public.utc_now(),
  updated_at timestamptz NOT NULL DEFAULT public.utc_now()
);

INSERT INTO public.institutions (id, name, slug)
VALUES ('00000000-0000-0000-0000-000000000001', 'QuizPocket Default Institution', 'default')
ON CONFLICT (id) DO NOTHING;

DROP TRIGGER IF EXISTS trg_institutions_updated_at ON public.institutions;
CREATE TRIGGER trg_institutions_updated_at
  BEFORE UPDATE ON public.institutions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 2. Profiles (1:1 with auth.users)
CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  institution_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
    REFERENCES public.institutions(id) ON DELETE RESTRICT,
  email text NOT NULL CHECK (char_length(btrim(email)) BETWEEN 3 AND 320),
  full_name text NOT NULL CHECK (char_length(btrim(full_name)) BETWEEN 1 AND 200),
  student_identifier text NULL CHECK (
    student_identifier IS NULL OR char_length(btrim(student_identifier)) BETWEEN 1 AND 64
  ),
  role public.user_role NOT NULL DEFAULT 'student',
  account_status public.account_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT public.utc_now(),
  updated_at timestamptz NOT NULL DEFAULT public.utc_now()
);

CREATE UNIQUE INDEX IF NOT EXISTS profiles_institution_student_identifier_uidx
  ON public.profiles (institution_id, lower(btrim(student_identifier)))
  WHERE student_identifier IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_institution_email_uidx
  ON public.profiles (institution_id, lower(btrim(email)));

CREATE INDEX IF NOT EXISTS profiles_role_status_idx
  ON public.profiles (institution_id, role, account_status);

DROP TRIGGER IF EXISTS trg_profiles_updated_at ON public.profiles;
CREATE TRIGGER trg_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Non-recursive SECURITY DEFINER authorization helpers
CREATE OR REPLACE FUNCTION public.current_institution_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p.institution_id
  FROM public.profiles p
  WHERE p.id = auth.uid()
    AND p.account_status = 'active';
$$;

CREATE OR REPLACE FUNCTION public.is_active_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.role = 'admin'
      AND p.account_status = 'active'
  );
$$;

CREATE OR REPLACE FUNCTION public.is_active_student()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.role = 'student'
      AND p.account_status = 'active'
  );
$$;

-- Guard profile writes against self-promotion or status tampering
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
        -- Permitted only when explicitly created as student; still force student role
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

DROP TRIGGER IF EXISTS trg_protect_profile_sensitive_fields ON public.profiles;
CREATE TRIGGER trg_protect_profile_sensitive_fields
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_profile_sensitive_fields();

-- Auth user signup synchronization trigger (NEVER trusts client-supplied role metadata)
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_full_name text;
BEGIN
  PERFORM set_config('quizpocket.trusted_context', 'on', true);

  v_full_name := COALESCE(
    NULLIF(btrim(NEW.raw_user_meta_data ->> 'full_name'), ''),
    split_part(COALESCE(NEW.email, 'student@quizpocket.local'), '@', 1)
  );

  INSERT INTO public.profiles (
    id,
    institution_id,
    email,
    full_name,
    role,
    account_status
  )
  VALUES (
    NEW.id,
    '00000000-0000-0000-0000-000000000001',
    COALESCE(NEW.email, NEW.id::text || '@quizpocket.local'),
    left(v_full_name, 200),
    'student',
    'active'
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

-- 3. Classes
CREATE TABLE IF NOT EXISTS public.classes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
    REFERENCES public.institutions(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 150),
  description text NULL CHECK (description IS NULL OR char_length(description) <= 1000),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT public.utc_now(),
  updated_at timestamptz NOT NULL DEFAULT public.utc_now()
);

CREATE UNIQUE INDEX IF NOT EXISTS classes_institution_name_uidx
  ON public.classes (institution_id, lower(btrim(name)));

DROP TRIGGER IF EXISTS trg_classes_updated_at ON public.classes;
CREATE TRIGGER trg_classes_updated_at
  BEFORE UPDATE ON public.classes
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 4. Class Memberships
CREATE TABLE IF NOT EXISTS public.class_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id uuid NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  membership_status public.membership_status NOT NULL DEFAULT 'active',
  joined_at timestamptz NOT NULL DEFAULT public.utc_now(),
  updated_at timestamptz NOT NULL DEFAULT public.utc_now(),
  CONSTRAINT class_memberships_unique_pair UNIQUE (class_id, student_id)
);

CREATE INDEX IF NOT EXISTS class_memberships_student_active_idx
  ON public.class_memberships (student_id, membership_status);

DROP TRIGGER IF EXISTS trg_class_memberships_updated_at ON public.class_memberships;
CREATE TRIGGER trg_class_memberships_updated_at
  BEFORE UPDATE ON public.class_memberships
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE OR REPLACE FUNCTION public.validate_class_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_class_inst uuid;
  v_student_inst uuid;
  v_student_role public.user_role;
BEGIN
  SELECT c.institution_id INTO v_class_inst
  FROM public.classes c WHERE c.id = NEW.class_id;

  SELECT p.institution_id, p.role INTO v_student_inst, v_student_role
  FROM public.profiles p WHERE p.id = NEW.student_id;

  IF v_class_inst IS NULL OR v_student_inst IS NULL THEN
    RAISE EXCEPTION 'INVALID_MEMBERSHIP_REFERENCE: Class or student profile not found.';
  END IF;

  IF v_student_role <> 'student' THEN
    RAISE EXCEPTION 'INVALID_MEMBER_ROLE: Only student profiles may be enrolled in classes.';
  END IF;

  IF v_class_inst <> v_student_inst THEN
    RAISE EXCEPTION 'CROSS_INSTITUTION_ERROR: Class and student belong to different institutions.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_class_membership ON public.class_memberships;
CREATE TRIGGER trg_validate_class_membership
  BEFORE INSERT OR UPDATE ON public.class_memberships
  FOR EACH ROW EXECUTE FUNCTION public.validate_class_membership();

-- 5. Examinations
CREATE TABLE IF NOT EXISTS public.exams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
    REFERENCES public.institutions(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 250),
  description text NULL CHECK (description IS NULL OR char_length(description) <= 4000),
  instructions text NULL CHECK (instructions IS NULL OR char_length(instructions) <= 8000),
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 1 AND 720),
  total_marks numeric(8,2) NOT NULL DEFAULT 0 CHECK (total_marks >= 0),
  passing_percentage numeric(5,2) NOT NULL DEFAULT 50.00
    CHECK (passing_percentage >= 0 AND passing_percentage <= 100),
  status public.exam_status NOT NULL DEFAULT 'draft',
  scheduled_start_at timestamptz NULL,
  scheduled_end_at timestamptz NULL,
  result_release_policy public.result_release_policy NOT NULL DEFAULT 'immediate',
  results_released_manually boolean NOT NULL DEFAULT false,
  allow_review boolean NOT NULL DEFAULT true,
  shuffle_questions boolean NOT NULL DEFAULT false,
  shuffle_options boolean NOT NULL DEFAULT false,
  max_attempts integer NOT NULL DEFAULT 1 CHECK (max_attempts BETWEEN 1 AND 50),
  retake_cooldown_minutes integer NOT NULL DEFAULT 180
    CHECK (retake_cooldown_minutes BETWEEN 0 AND 43200),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  published_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT public.utc_now(),
  updated_at timestamptz NOT NULL DEFAULT public.utc_now(),
  CONSTRAINT exams_valid_schedule_window CHECK (
    scheduled_start_at IS NULL
    OR scheduled_end_at IS NULL
    OR scheduled_end_at > scheduled_start_at
  )
);

CREATE INDEX IF NOT EXISTS exams_institution_status_idx
  ON public.exams (institution_id, status);

DROP TRIGGER IF EXISTS trg_exams_updated_at ON public.exams;
CREATE TRIGGER trg_exams_updated_at
  BEFORE UPDATE ON public.exams
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 6. Exam Questions (isolated from direct student access; delivered via sanitized RPCs)
CREATE TABLE IF NOT EXISTS public.exam_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id uuid NOT NULL REFERENCES public.exams(id) ON DELETE CASCADE,
  question_text text NOT NULL CHECK (char_length(btrim(question_text)) BETWEEN 1 AND 6000),
  question_type public.question_type NOT NULL,
  marks numeric(8,2) NOT NULL CHECK (marks > 0 AND marks <= 1000),
  negative_marks numeric(8,2) NOT NULL DEFAULT 0
    CHECK (negative_marks >= 0 AND negative_marks <= marks),
  explanation text NULL CHECK (explanation IS NULL OR char_length(explanation) <= 6000),
  display_order integer NOT NULL CHECK (display_order >= 1),
  is_required boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT public.utc_now(),
  updated_at timestamptz NOT NULL DEFAULT public.utc_now(),
  CONSTRAINT exam_questions_unique_order UNIQUE (exam_id, display_order)
);

CREATE INDEX IF NOT EXISTS exam_questions_exam_idx
  ON public.exam_questions (exam_id, display_order);

DROP TRIGGER IF EXISTS trg_exam_questions_updated_at ON public.exam_questions;
CREATE TRIGGER trg_exam_questions_updated_at
  BEFORE UPDATE ON public.exam_questions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 7. Question Options (contains protected is_correct; blocked from direct student SELECT)
CREATE TABLE IF NOT EXISTS public.question_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id uuid NOT NULL REFERENCES public.exam_questions(id) ON DELETE CASCADE,
  option_text text NOT NULL CHECK (char_length(btrim(option_text)) BETWEEN 1 AND 2000),
  display_order integer NOT NULL CHECK (display_order >= 1),
  is_correct boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT public.utc_now(),
  CONSTRAINT question_options_unique_order UNIQUE (question_id, display_order)
);

CREATE INDEX IF NOT EXISTS question_options_question_idx
  ON public.question_options (question_id, display_order);

-- Enforce at most ONE correct option per question at DB index level for MVP single-answer types
CREATE UNIQUE INDEX IF NOT EXISTS question_options_single_correct_uidx
  ON public.question_options (question_id)
  WHERE is_correct = true;

-- 8. Exam Assignments (student OR class target, strictly mutually exclusive)
CREATE TABLE IF NOT EXISTS public.exam_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id uuid NOT NULL REFERENCES public.exams(id) ON DELETE CASCADE,
  student_id uuid NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  class_id uuid NULL REFERENCES public.classes(id) ON DELETE CASCADE,
  assigned_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  assignment_status public.assignment_status NOT NULL DEFAULT 'active',
  assigned_at timestamptz NOT NULL DEFAULT public.utc_now(),
  CONSTRAINT exam_assignments_target_xor CHECK (
    (student_id IS NOT NULL AND class_id IS NULL)
    OR (student_id IS NULL AND class_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS exam_assignments_exam_student_uidx
  ON public.exam_assignments (exam_id, student_id)
  WHERE student_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS exam_assignments_exam_class_uidx
  ON public.exam_assignments (exam_id, class_id)
  WHERE class_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS exam_assignments_student_active_idx
  ON public.exam_assignments (student_id, assignment_status)
  WHERE student_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS exam_assignments_class_active_idx
  ON public.exam_assignments (class_id, assignment_status)
  WHERE class_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.validate_exam_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_exam_inst uuid;
  v_target_inst uuid;
  v_student_role public.user_role;
BEGIN
  SELECT e.institution_id INTO v_exam_inst
  FROM public.exams e WHERE e.id = NEW.exam_id;

  IF v_exam_inst IS NULL THEN
    RAISE EXCEPTION 'INVALID_ASSIGNMENT_EXAM: Examination not found.';
  END IF;

  IF NEW.student_id IS NOT NULL THEN
    SELECT p.institution_id, p.role INTO v_target_inst, v_student_role
    FROM public.profiles p WHERE p.id = NEW.student_id;

    IF v_target_inst IS NULL OR v_student_role <> 'student' THEN
      RAISE EXCEPTION 'INVALID_ASSIGNMENT_STUDENT: Target user must be an existing student profile.';
    END IF;
  ELSE
    SELECT c.institution_id INTO v_target_inst
    FROM public.classes c WHERE c.id = NEW.class_id;

    IF v_target_inst IS NULL THEN
      RAISE EXCEPTION 'INVALID_ASSIGNMENT_CLASS: Target class not found.';
    END IF;
  END IF;

  IF v_exam_inst <> v_target_inst THEN
    RAISE EXCEPTION 'CROSS_INSTITUTION_ERROR: Assignment target belongs to a different institution.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_exam_assignment ON public.exam_assignments;
CREATE TRIGGER trg_validate_exam_assignment
  BEFORE INSERT OR UPDATE ON public.exam_assignments
  FOR EACH ROW EXECUTE FUNCTION public.validate_exam_assignment();

-- 9. Exam Attempts
CREATE TABLE IF NOT EXISTS public.exam_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id uuid NOT NULL REFERENCES public.exams(id) ON DELETE RESTRICT,
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  attempt_number integer NOT NULL CHECK (attempt_number >= 1),
  status public.attempt_status NOT NULL DEFAULT 'in_progress',
  started_at timestamptz NOT NULL DEFAULT public.utc_now(),
  deadline_at timestamptz NOT NULL,
  submitted_at timestamptz NULL,
  last_activity_at timestamptz NOT NULL DEFAULT public.utc_now(),
  created_at timestamptz NOT NULL DEFAULT public.utc_now(),
  CONSTRAINT exam_attempts_unique_number UNIQUE (exam_id, student_id, attempt_number),
  CONSTRAINT exam_attempts_valid_deadline CHECK (deadline_at > started_at),
  CONSTRAINT exam_attempts_submission_state CHECK (
    (status = 'in_progress' AND submitted_at IS NULL)
    OR (status IN ('submitted', 'auto_submitted') AND submitted_at IS NOT NULL)
    OR status = 'voided'
  )
);

-- Prevent concurrent duplicate active attempts for the same student and exam
CREATE UNIQUE INDEX IF NOT EXISTS exam_attempts_single_active_uidx
  ON public.exam_attempts (exam_id, student_id)
  WHERE status = 'in_progress';

CREATE INDEX IF NOT EXISTS exam_attempts_expiry_sweep_idx
  ON public.exam_attempts (deadline_at)
  WHERE status = 'in_progress';

CREATE INDEX IF NOT EXISTS exam_attempts_student_exam_idx
  ON public.exam_attempts (student_id, exam_id, attempt_number DESC);

-- 10. Student Answers
CREATE TABLE IF NOT EXISTS public.student_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES public.exam_attempts(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES public.exam_questions(id) ON DELETE RESTRICT,
  selected_option_id uuid NULL REFERENCES public.question_options(id) ON DELETE RESTRICT,
  answer_value text NULL CHECK (answer_value IS NULL OR char_length(answer_value) <= 4000),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  saved_at timestamptz NOT NULL DEFAULT public.utc_now(),
  CONSTRAINT student_answers_unique_attempt_question UNIQUE (attempt_id, question_id)
);

CREATE INDEX IF NOT EXISTS student_answers_attempt_idx
  ON public.student_answers (attempt_id);

-- 11. Finalized Results
CREATE TABLE IF NOT EXISTS public.results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL UNIQUE REFERENCES public.exam_attempts(id) ON DELETE RESTRICT,
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  exam_id uuid NOT NULL REFERENCES public.exams(id) ON DELETE RESTRICT,
  marks_obtained numeric(8,2) NOT NULL CHECK (marks_obtained >= 0),
  total_marks numeric(8,2) NOT NULL CHECK (total_marks > 0),
  percentage numeric(5,2) NOT NULL CHECK (percentage >= 0 AND percentage <= 100),
  passed boolean NOT NULL,
  correct_count integer NOT NULL DEFAULT 0 CHECK (correct_count >= 0),
  incorrect_count integer NOT NULL DEFAULT 0 CHECK (incorrect_count >= 0),
  unanswered_count integer NOT NULL DEFAULT 0 CHECK (unanswered_count >= 0),
  marking_version integer NOT NULL DEFAULT 1 CHECK (marking_version >= 1),
  finalized_at timestamptz NOT NULL DEFAULT public.utc_now()
);

CREATE INDEX IF NOT EXISTS results_exam_idx ON public.results (exam_id, finalized_at DESC);
CREATE INDEX IF NOT EXISTS results_student_idx ON public.results (student_id, finalized_at DESC);

-- 12. Result Items (per-question immutable grading breakdown for review & analytics)
CREATE TABLE IF NOT EXISTS public.result_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  result_id uuid NOT NULL REFERENCES public.results(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL REFERENCES public.exam_attempts(id) ON DELETE CASCADE,
  exam_id uuid NOT NULL REFERENCES public.exams(id) ON DELETE RESTRICT,
  question_id uuid NOT NULL REFERENCES public.exam_questions(id) ON DELETE RESTRICT,
  selected_option_id uuid NULL REFERENCES public.question_options(id) ON DELETE RESTRICT,
  correct_option_id uuid NOT NULL REFERENCES public.question_options(id) ON DELETE RESTRICT,
  outcome text NOT NULL CHECK (outcome IN ('correct', 'incorrect', 'unanswered')),
  marks_awarded numeric(8,2) NOT NULL,
  max_marks numeric(8,2) NOT NULL CHECK (max_marks > 0),
  CONSTRAINT result_items_unique_question UNIQUE (result_id, question_id)
);

CREATE INDEX IF NOT EXISTS result_items_exam_question_idx
  ON public.result_items (exam_id, question_id, outcome);

-- 13. Immutable Audit Logs
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
    REFERENCES public.institutions(id) ON DELETE RESTRICT,
  actor_id uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  actor_role text NOT NULL CHECK (actor_role IN ('admin', 'student', 'system')),
  event_type text NOT NULL CHECK (char_length(btrim(event_type)) BETWEEN 1 AND 100),
  entity_type text NOT NULL CHECK (char_length(btrim(entity_type)) BETWEEN 1 AND 100),
  entity_id uuid NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT public.utc_now()
);

CREATE INDEX IF NOT EXISTS audit_logs_institution_created_idx
  ON public.audit_logs (institution_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.prevent_audit_log_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'AUDIT_LOG_IMMUTABLE: Audit records cannot be modified or deleted.'
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_audit_log_mutation ON public.audit_logs;
CREATE TRIGGER trg_prevent_audit_log_mutation
  BEFORE UPDATE OR DELETE ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.prevent_audit_log_mutation();

-- Controlled Editing & Total Marks Synchronization Triggers
CREATE OR REPLACE FUNCTION public.guard_exam_mutation_with_attempts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_has_attempts boolean;
BEGIN
  IF current_setting('quizpocket.allow_total_marks_sync', true) = 'on' THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.exam_attempts a WHERE a.exam_id = OLD.id
  ) INTO v_has_attempts;

  IF v_has_attempts THEN
    IF NEW.status = 'draft' AND OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'EXAM_LOCKED_BY_ATTEMPTS: Cannot revert an examination with recorded attempts back to draft.';
    END IF;
    IF NEW.duration_minutes IS DISTINCT FROM OLD.duration_minutes
       OR NEW.total_marks IS DISTINCT FROM OLD.total_marks
       OR NEW.passing_percentage IS DISTINCT FROM OLD.passing_percentage
       OR NEW.institution_id IS DISTINCT FROM OLD.institution_id THEN
      RAISE EXCEPTION 'EXAM_LOCKED_BY_ATTEMPTS: Duration, total marks, and passing threshold cannot be altered after attempts exist.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_exam_mutation_with_attempts ON public.exams;
CREATE TRIGGER trg_guard_exam_mutation_with_attempts
  BEFORE UPDATE ON public.exams
  FOR EACH ROW EXECUTE FUNCTION public.guard_exam_mutation_with_attempts();

CREATE OR REPLACE FUNCTION public.guard_and_sync_exam_questions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_exam_id uuid;
  v_has_attempts boolean;
  v_new_total numeric(8,2);
BEGIN
  v_exam_id := COALESCE(NEW.exam_id, OLD.exam_id);

  SELECT EXISTS (
    SELECT 1 FROM public.exam_attempts a WHERE a.exam_id = v_exam_id
  ) INTO v_has_attempts;

  IF v_has_attempts THEN
    -- Allow updating ONLY explanation text via authorized admin correction if needed;
    -- forbid structural/scoring edits that would invalidate historical scores.
    IF TG_OP IN ('INSERT', 'DELETE') THEN
      RAISE EXCEPTION 'EXAM_LOCKED_BY_ATTEMPTS: Cannot add or remove questions once student attempts exist.';
    END IF;
    IF TG_OP = 'UPDATE' AND (
      NEW.exam_id IS DISTINCT FROM OLD.exam_id
      OR NEW.question_text IS DISTINCT FROM OLD.question_text
      OR NEW.question_type IS DISTINCT FROM OLD.question_type
      OR NEW.marks IS DISTINCT FROM OLD.marks
      OR NEW.negative_marks IS DISTINCT FROM OLD.negative_marks
      OR NEW.display_order IS DISTINCT FROM OLD.display_order
    ) THEN
      RAISE EXCEPTION 'EXAM_LOCKED_BY_ATTEMPTS: Question scoring and content are locked because attempts already exist.';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.recalculate_exam_total_marks()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_exam_id uuid;
  v_total numeric(8,2);
BEGIN
  v_exam_id := COALESCE(NEW.exam_id, OLD.exam_id);

  SELECT COALESCE(SUM(q.marks), 0)
  INTO v_total
  FROM public.exam_questions q
  WHERE q.exam_id = v_exam_id;

  PERFORM set_config('quizpocket.allow_total_marks_sync', 'on', true);

  UPDATE public.exams
  SET total_marks = v_total
  WHERE id = v_exam_id;

  PERFORM set_config('quizpocket.allow_total_marks_sync', 'off', true);

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_exam_questions_before ON public.exam_questions;
CREATE TRIGGER trg_guard_exam_questions_before
  BEFORE INSERT OR UPDATE OR DELETE ON public.exam_questions
  FOR EACH ROW EXECUTE FUNCTION public.guard_and_sync_exam_questions();

DROP TRIGGER IF EXISTS trg_recalculate_exam_total_marks ON public.exam_questions;
CREATE TRIGGER trg_recalculate_exam_total_marks
  AFTER INSERT OR UPDATE OR DELETE ON public.exam_questions
  FOR EACH ROW EXECUTE FUNCTION public.recalculate_exam_total_marks();

CREATE OR REPLACE FUNCTION public.guard_question_options_with_attempts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_question_id uuid;
  v_exam_id uuid;
BEGIN
  v_question_id := COALESCE(NEW.question_id, OLD.question_id);

  SELECT q.exam_id INTO v_exam_id
  FROM public.exam_questions q WHERE q.id = v_question_id;

  IF v_exam_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.exam_attempts a WHERE a.exam_id = v_exam_id
  ) THEN
    RAISE EXCEPTION 'EXAM_LOCKED_BY_ATTEMPTS: Answer options cannot be altered once student attempts exist.';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_question_options_with_attempts ON public.question_options;
CREATE TRIGGER trg_guard_question_options_with_attempts
  BEFORE INSERT OR UPDATE OR DELETE ON public.question_options
  FOR EACH ROW EXECUTE FUNCTION public.guard_question_options_with_attempts();

-- Answer integrity trigger (enforces attempt active status, deadline, and relational ownership)
CREATE OR REPLACE FUNCTION public.validate_student_answer_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_attempt record;
  v_question_exam_id uuid;
  v_option_question_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT a.status, a.deadline_at INTO v_attempt
    FROM public.exam_attempts a WHERE a.id = OLD.attempt_id;
    IF v_attempt.status <> 'in_progress' OR public.utc_now() > v_attempt.deadline_at THEN
      RAISE EXCEPTION 'ATTEMPT_FINALIZED: Answers cannot be deleted after attempt completion or expiry.';
    END IF;
    RETURN OLD;
  END IF;

  SELECT a.id, a.exam_id, a.student_id, a.status, a.deadline_at
  INTO v_attempt
  FROM public.exam_attempts a
  WHERE a.id = NEW.attempt_id;

  IF v_attempt.id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ATTEMPT: Attempt does not exist.';
  END IF;

  IF v_attempt.status <> 'in_progress' THEN
    RAISE EXCEPTION 'ATTEMPT_NOT_ACTIVE: Answers cannot be modified after submission.';
  END IF;

  IF public.utc_now() > v_attempt.deadline_at THEN
    RAISE EXCEPTION 'ATTEMPT_DEADLINE_EXPIRED: Server deadline has elapsed.';
  END IF;

  SELECT q.exam_id INTO v_question_exam_id
  FROM public.exam_questions q
  WHERE q.id = NEW.question_id;

  IF v_question_exam_id IS NULL OR v_question_exam_id <> v_attempt.exam_id THEN
    RAISE EXCEPTION 'QUESTION_EXAM_MISMATCH: Question does not belong to this examination.';
  END IF;

  IF NEW.selected_option_id IS NOT NULL THEN
    SELECT o.question_id INTO v_option_question_id
    FROM public.question_options o
    WHERE o.id = NEW.selected_option_id;

    IF v_option_question_id IS NULL OR v_option_question_id <> NEW.question_id THEN
      RAISE EXCEPTION 'OPTION_QUESTION_MISMATCH: Selected option does not belong to the specified question.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_student_answer_write ON public.student_answers;
CREATE TRIGGER trg_validate_student_answer_write
  BEFORE INSERT OR UPDATE OR DELETE ON public.student_answers
  FOR EACH ROW EXECUTE FUNCTION public.validate_student_answer_write();
-- ============================================================================
-- Migration 0003: Row Level Security (RLS), Access Helpers, and Least-Privilege Grants
-- Project: QuizPocket — Online Examination & Assessment Platform
-- ============================================================================

-- Eligibility & Result-Release Helper Functions (SECURITY DEFINER with fixed search_path)
CREATE OR REPLACE FUNCTION public.is_student_assigned_to_exam(
  p_exam_id uuid,
  p_student_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.exam_assignments ea
    WHERE ea.exam_id = p_exam_id
      AND ea.assignment_status = 'active'
      AND (
        ea.student_id = p_student_id
        OR (
          ea.class_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM public.class_memberships cm
            WHERE cm.class_id = ea.class_id
              AND cm.student_id = p_student_id
              AND cm.membership_status = 'active'
          )
        )
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.is_result_released_for_exam(p_exam_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.exams e
    WHERE e.id = p_exam_id
      AND (
        e.results_released_manually = true
        OR e.result_release_policy = 'immediate'
        OR (
          e.result_release_policy = 'after_window'
          AND e.scheduled_end_at IS NOT NULL
          AND public.utc_now() >= e.scheduled_end_at
        )
      )
  );
$$;

-- Enable Row Level Security on EVERY application table
ALTER TABLE public.institutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.class_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.question_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.result_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- Revoke blanket privileges from PUBLIC and anon
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon;

-- Grant explicit baseline table privileges to authenticated (all gated by RLS!)
GRANT SELECT ON public.institutions TO authenticated;
GRANT SELECT, UPDATE (full_name) ON public.profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.classes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.class_memberships TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.exams TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.exam_questions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.question_options TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.exam_assignments TO authenticated;
GRANT SELECT ON public.exam_attempts TO authenticated;
GRANT SELECT ON public.student_answers TO authenticated;
GRANT SELECT ON public.results TO authenticated;
GRANT SELECT ON public.result_items TO authenticated;
GRANT SELECT ON public.audit_logs TO authenticated;

GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;

-- Restrict helper function execution grants
REVOKE ALL ON FUNCTION public.current_institution_id() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_active_admin() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_active_student() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_student_assigned_to_exam(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_result_released_for_exam(uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.utc_now() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.current_institution_id() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_active_admin() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_active_student() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_student_assigned_to_exam(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_result_released_for_exam(uuid) TO authenticated, service_role;

-- ============================================================================
-- TABLE POLICIES
-- ============================================================================

-- 1. institutions
DROP POLICY IF EXISTS institutions_select_member ON public.institutions;
CREATE POLICY institutions_select_member
  ON public.institutions
  FOR SELECT
  TO authenticated
  USING (id = public.current_institution_id());

-- 2. profiles
-- Note: Disabled/suspended users cannot pass is_active_student() or is_active_admin(),
-- locking them out of all protected operations immediately.
DROP POLICY IF EXISTS profiles_select_self_or_admin ON public.profiles;
CREATE POLICY profiles_select_self_or_admin
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (
    (id = auth.uid() AND account_status = 'active')
    OR (public.is_active_admin() AND institution_id = public.current_institution_id())
  );

DROP POLICY IF EXISTS profiles_update_self_permitted ON public.profiles;
CREATE POLICY profiles_update_self_permitted
  ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (
    (id = auth.uid() AND account_status = 'active')
    OR (public.is_active_admin() AND institution_id = public.current_institution_id())
  )
  WITH CHECK (
    (id = auth.uid() AND account_status = 'active')
    OR (public.is_active_admin() AND institution_id = public.current_institution_id())
  );

-- 3. classes
DROP POLICY IF EXISTS classes_admin_all ON public.classes;
CREATE POLICY classes_admin_all
  ON public.classes
  FOR ALL
  TO authenticated
  USING (public.is_active_admin() AND institution_id = public.current_institution_id())
  WITH CHECK (public.is_active_admin() AND institution_id = public.current_institution_id());

DROP POLICY IF EXISTS classes_student_select_enrolled ON public.classes;
CREATE POLICY classes_student_select_enrolled
  ON public.classes
  FOR SELECT
  TO authenticated
  USING (
    public.is_active_student()
    AND institution_id = public.current_institution_id()
    AND EXISTS (
      SELECT 1
      FROM public.class_memberships cm
      WHERE cm.class_id = classes.id
        AND cm.student_id = auth.uid()
        AND cm.membership_status = 'active'
    )
  );

-- 4. class_memberships
DROP POLICY IF EXISTS class_memberships_admin_all ON public.class_memberships;
CREATE POLICY class_memberships_admin_all
  ON public.class_memberships
  FOR ALL
  TO authenticated
  USING (
    public.is_active_admin()
    AND EXISTS (
      SELECT 1 FROM public.classes c
      WHERE c.id = class_memberships.class_id
        AND c.institution_id = public.current_institution_id()
    )
  )
  WITH CHECK (
    public.is_active_admin()
    AND EXISTS (
      SELECT 1 FROM public.classes c
      WHERE c.id = class_memberships.class_id
        AND c.institution_id = public.current_institution_id()
    )
  );

DROP POLICY IF EXISTS class_memberships_student_select_own ON public.class_memberships;
CREATE POLICY class_memberships_student_select_own
  ON public.class_memberships
  FOR SELECT
  TO authenticated
  USING (
    public.is_active_student()
    AND student_id = auth.uid()
    AND membership_status = 'active'
  );

-- 5. exams
DROP POLICY IF EXISTS exams_admin_all ON public.exams;
CREATE POLICY exams_admin_all
  ON public.exams
  FOR ALL
  TO authenticated
  USING (public.is_active_admin() AND institution_id = public.current_institution_id())
  WITH CHECK (public.is_active_admin() AND institution_id = public.current_institution_id());

DROP POLICY IF EXISTS exams_student_select_assigned_published ON public.exams;
CREATE POLICY exams_student_select_assigned_published
  ON public.exams
  FOR SELECT
  TO authenticated
  USING (
    public.is_active_student()
    AND institution_id = public.current_institution_id()
    AND status = 'published'
    AND public.is_student_assigned_to_exam(exams.id, auth.uid())
  );

-- 6. exam_questions (STRICT ANSWER-KEY ISOLATION: Admin-only direct table access!
--    Students receive active questions strictly via sanitized RPC student_get_attempt_questions)
DROP POLICY IF EXISTS exam_questions_admin_all ON public.exam_questions;
CREATE POLICY exam_questions_admin_all
  ON public.exam_questions
  FOR ALL
  TO authenticated
  USING (
    public.is_active_admin()
    AND EXISTS (
      SELECT 1 FROM public.exams e
      WHERE e.id = exam_questions.exam_id
        AND e.institution_id = public.current_institution_id()
    )
  )
  WITH CHECK (
    public.is_active_admin()
    AND EXISTS (
      SELECT 1 FROM public.exams e
      WHERE e.id = exam_questions.exam_id
        AND e.institution_id = public.current_institution_id()
    )
  );

-- 7. question_options (STRICT ANSWER-KEY ISOLATION: Admin-only direct table access!
--    Students NEVER have direct SELECT access to question_options.is_correct)
DROP POLICY IF EXISTS question_options_admin_all ON public.question_options;
CREATE POLICY question_options_admin_all
  ON public.question_options
  FOR ALL
  TO authenticated
  USING (
    public.is_active_admin()
    AND EXISTS (
      SELECT 1
      FROM public.exam_questions q
      JOIN public.exams e ON e.id = q.exam_id
      WHERE q.id = question_options.question_id
        AND e.institution_id = public.current_institution_id()
    )
  )
  WITH CHECK (
    public.is_active_admin()
    AND EXISTS (
      SELECT 1
      FROM public.exam_questions q
      JOIN public.exams e ON e.id = q.exam_id
      WHERE q.id = question_options.question_id
        AND e.institution_id = public.current_institution_id()
    )
  );

-- 8. exam_assignments
DROP POLICY IF EXISTS exam_assignments_admin_all ON public.exam_assignments;
CREATE POLICY exam_assignments_admin_all
  ON public.exam_assignments
  FOR ALL
  TO authenticated
  USING (
    public.is_active_admin()
    AND EXISTS (
      SELECT 1 FROM public.exams e
      WHERE e.id = exam_assignments.exam_id
        AND e.institution_id = public.current_institution_id()
    )
  )
  WITH CHECK (
    public.is_active_admin()
    AND EXISTS (
      SELECT 1 FROM public.exams e
      WHERE e.id = exam_assignments.exam_id
        AND e.institution_id = public.current_institution_id()
    )
  );

DROP POLICY IF EXISTS exam_assignments_student_select_eligible ON public.exam_assignments;
CREATE POLICY exam_assignments_student_select_eligible
  ON public.exam_assignments
  FOR SELECT
  TO authenticated
  USING (
    public.is_active_student()
    AND assignment_status = 'active'
    AND (
      student_id = auth.uid()
      OR (
        class_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM public.class_memberships cm
          WHERE cm.class_id = exam_assignments.class_id
            AND cm.student_id = auth.uid()
            AND cm.membership_status = 'active'
        )
      )
    )
  );

-- 9. exam_attempts (Read-only via RLS; mutations strictly enforced through server RPCs)
DROP POLICY IF EXISTS exam_attempts_admin_select ON public.exam_attempts;
CREATE POLICY exam_attempts_admin_select
  ON public.exam_attempts
  FOR SELECT
  TO authenticated
  USING (
    public.is_active_admin()
    AND EXISTS (
      SELECT 1 FROM public.exams e
      WHERE e.id = exam_attempts.exam_id
        AND e.institution_id = public.current_institution_id()
    )
  );

DROP POLICY IF EXISTS exam_attempts_student_select_own ON public.exam_attempts;
CREATE POLICY exam_attempts_student_select_own
  ON public.exam_attempts
  FOR SELECT
  TO authenticated
  USING (
    public.is_active_student()
    AND student_id = auth.uid()
  );

-- 10. student_answers (Read-only via RLS; writes strictly gated by student_save_answer RPC)
DROP POLICY IF EXISTS student_answers_admin_select ON public.student_answers;
CREATE POLICY student_answers_admin_select
  ON public.student_answers
  FOR SELECT
  TO authenticated
  USING (
    public.is_active_admin()
    AND EXISTS (
      SELECT 1
      FROM public.exam_attempts a
      JOIN public.exams e ON e.id = a.exam_id
      WHERE a.id = student_answers.attempt_id
        AND e.institution_id = public.current_institution_id()
    )
  );

DROP POLICY IF EXISTS student_answers_student_select_own ON public.student_answers;
CREATE POLICY student_answers_student_select_own
  ON public.student_answers
  FOR SELECT
  TO authenticated
  USING (
    public.is_active_student()
    AND EXISTS (
      SELECT 1
      FROM public.exam_attempts a
      WHERE a.id = student_answers.attempt_id
        AND a.student_id = auth.uid()
    )
  );

-- 11. results (Student can SELECT own result ONLY when exam's result_release_policy permits)
DROP POLICY IF EXISTS results_admin_select ON public.results;
CREATE POLICY results_admin_select
  ON public.results
  FOR SELECT
  TO authenticated
  USING (
    public.is_active_admin()
    AND EXISTS (
      SELECT 1 FROM public.exams e
      WHERE e.id = results.exam_id
        AND e.institution_id = public.current_institution_id()
    )
  );

DROP POLICY IF EXISTS results_student_select_released ON public.results;
CREATE POLICY results_student_select_released
  ON public.results
  FOR SELECT
  TO authenticated
  USING (
    public.is_active_student()
    AND student_id = auth.uid()
    AND public.is_result_released_for_exam(results.exam_id)
  );

-- 12. result_items (Contains correct_option_id! Student can SELECT own items ONLY when
--     BOTH results are released AND exam.allow_review = true)
DROP POLICY IF EXISTS result_items_admin_select ON public.result_items;
CREATE POLICY result_items_admin_select
  ON public.result_items
  FOR SELECT
  TO authenticated
  USING (
    public.is_active_admin()
    AND EXISTS (
      SELECT 1 FROM public.exams e
      WHERE e.id = result_items.exam_id
        AND e.institution_id = public.current_institution_id()
    )
  );

DROP POLICY IF EXISTS result_items_student_select_released_review ON public.result_items;
CREATE POLICY result_items_student_select_released_review
  ON public.result_items
  FOR SELECT
  TO authenticated
  USING (
    public.is_active_student()
    AND EXISTS (
      SELECT 1
      FROM public.results r
      JOIN public.exams e ON e.id = r.exam_id
      WHERE r.id = result_items.result_id
        AND r.student_id = auth.uid()
        AND e.allow_review = true
        AND public.is_result_released_for_exam(e.id)
    )
  );

-- 13. audit_logs (Admin read-only within institution; append-only via trusted RPCs)
DROP POLICY IF EXISTS audit_logs_admin_select ON public.audit_logs;
CREATE POLICY audit_logs_admin_select
  ON public.audit_logs
  FOR SELECT
  TO authenticated
  USING (
    public.is_active_admin()
    AND institution_id = public.current_institution_id()
  );
-- ============================================================================
-- Migration 0004: Authoritative Server-Side Examination Engine RPCs
-- Project: QuizPocket — Online Examination & Assessment Platform
-- ============================================================================

-- Internal Audit Helper (NOT executable directly by client roles)
CREATE OR REPLACE FUNCTION public.internal_write_audit_log(
  p_institution_id uuid,
  p_actor_id uuid,
  p_actor_role text,
  p_event_type text,
  p_entity_type text,
  p_entity_id uuid,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_log_id uuid;
BEGIN
  INSERT INTO public.audit_logs (
    institution_id,
    actor_id,
    actor_role,
    event_type,
    entity_type,
    entity_id,
    metadata,
    created_at
  )
  VALUES (
    COALESCE(p_institution_id, '00000000-0000-0000-0000-000000000001'),
    p_actor_id,
    p_actor_role,
    p_event_type,
    p_entity_type,
    p_entity_id,
    COALESCE(p_metadata, '{}'::jsonb),
    public.utc_now()
  )
  RETURNING id INTO v_log_id;

  RETURN v_log_id;
END;
$$;

REVOKE ALL ON FUNCTION public.internal_write_audit_log(uuid, uuid, text, text, text, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.internal_write_audit_log(uuid, uuid, text, text, text, uuid, jsonb)
  TO service_role;

-- Internal Transactional Marking & Attempt Finalizer (Idempotent!)
CREATE OR REPLACE FUNCTION public.internal_finalize_attempt(
  p_attempt_id uuid,
  p_target_status public.attempt_status,
  p_effective_submitted_at timestamptz,
  p_actor_id uuid DEFAULT NULL,
  p_actor_role text DEFAULT 'system'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_attempt public.exam_attempts%ROWTYPE;
  v_exam public.exams%ROWTYPE;
  v_existing_result public.results%ROWTYPE;
  v_result_id uuid;
  v_q record;
  v_correct_option_id uuid;
  v_selected_option_id uuid;
  v_outcome text;
  v_awarded numeric(8,2);
  v_raw_marks numeric(8,2) := 0;
  v_final_marks numeric(8,2) := 0;
  v_total_marks numeric(8,2) := 0;
  v_percentage numeric(5,2) := 0;
  v_passed boolean := false;
  v_correct_count integer := 0;
  v_incorrect_count integer := 0;
  v_unanswered_count integer := 0;
  v_now timestamptz := public.utc_now();
  v_submitted_ts timestamptz;
BEGIN
  IF p_target_status NOT IN ('submitted', 'auto_submitted') THEN
    RAISE EXCEPTION 'INVALID_FINALIZE_STATUS: Target status must be submitted or auto_submitted.';
  END IF;

  -- Lock the attempt row to guarantee atomic, single-execution marking
  SELECT * INTO v_attempt
  FROM public.exam_attempts a
  WHERE a.id = p_attempt_id
  FOR UPDATE;

  IF v_attempt.id IS NULL THEN
    RAISE EXCEPTION 'ATTEMPT_NOT_FOUND: Examination attempt does not exist.';
  END IF;

  SELECT * INTO v_exam
  FROM public.exams e
  WHERE e.id = v_attempt.exam_id;

  -- Idempotency: if already finalized, return existing state without duplicating results
  IF v_attempt.status IN ('submitted', 'auto_submitted') THEN
    SELECT * INTO v_existing_result
    FROM public.results r
    WHERE r.attempt_id = v_attempt.id;

    RETURN jsonb_build_object(
      'already_finalized', true,
      'attempt_id', v_attempt.id,
      'status', v_attempt.status,
      'submitted_at', v_attempt.submitted_at,
      'result_id', v_existing_result.id
    );
  END IF;

  IF v_attempt.status = 'voided' THEN
    RAISE EXCEPTION 'ATTEMPT_VOIDED: Voided attempts cannot be finalized.';
  END IF;

  -- Compute total marks across exam questions and validate > 0
  SELECT COALESCE(SUM(q.marks), 0) INTO v_total_marks
  FROM public.exam_questions q
  WHERE q.exam_id = v_exam.id;

  IF v_total_marks <= 0 THEN
    RAISE EXCEPTION 'INVALID_EXAM_TOTAL_MARKS: Examination has zero configured marks.';
  END IF;

  v_submitted_ts := GREATEST(
    v_attempt.started_at + interval '1 millisecond',
    COALESCE(p_effective_submitted_at, v_now)
  );

  -- Update attempt status first while still holding FOR UPDATE lock
  UPDATE public.exam_attempts
  SET status = p_target_status,
      submitted_at = v_submitted_ts,
      last_activity_at = v_now
  WHERE id = v_attempt.id;

  -- Create placeholder result record first so result_items can reference it inside same tx
  INSERT INTO public.results (
    attempt_id,
    student_id,
    exam_id,
    marks_obtained,
    total_marks,
    percentage,
    passed,
    correct_count,
    incorrect_count,
    unanswered_count,
    marking_version,
    finalized_at
  )
  VALUES (
    v_attempt.id,
    v_attempt.student_id,
    v_exam.id,
    0,
    v_total_marks,
    0,
    false,
    0,
    0,
    0,
    1,
    v_now
  )
  RETURNING id INTO v_result_id;

  -- Grade every question deterministically on the server
  FOR v_q IN
    SELECT q.id, q.marks, q.negative_marks
    FROM public.exam_questions q
    WHERE q.exam_id = v_exam.id
    ORDER BY q.display_order ASC
  LOOP
    SELECT o.id INTO v_correct_option_id
    FROM public.question_options o
    WHERE o.question_id = v_q.id
      AND o.is_correct = true
    LIMIT 1;

    IF v_correct_option_id IS NULL THEN
      RAISE EXCEPTION 'MISSING_ANSWER_KEY: Question % has no configured correct option.', v_q.id;
    END IF;

    SELECT sa.selected_option_id INTO v_selected_option_id
    FROM public.student_answers sa
    WHERE sa.attempt_id = v_attempt.id
      AND sa.question_id = v_q.id;

    IF v_selected_option_id IS NULL THEN
      v_outcome := 'unanswered';
      v_awarded := 0;
      v_unanswered_count := v_unanswered_count + 1;
    ELSIF v_selected_option_id = v_correct_option_id THEN
      v_outcome := 'correct';
      v_awarded := v_q.marks;
      v_correct_count := v_correct_count + 1;
    ELSE
      v_outcome := 'incorrect';
      v_awarded := -1 * COALESCE(v_q.negative_marks, 0);
      v_incorrect_count := v_incorrect_count + 1;
    END IF;

    v_raw_marks := v_raw_marks + v_awarded;

    INSERT INTO public.result_items (
      result_id,
      attempt_id,
      exam_id,
      question_id,
      selected_option_id,
      correct_option_id,
      outcome,
      marks_awarded,
      max_marks
    )
    VALUES (
      v_result_id,
      v_attempt.id,
      v_exam.id,
      v_q.id,
      v_selected_option_id,
      v_correct_option_id,
      v_outcome,
      v_awarded,
      v_q.marks
    );
  END LOOP;

  -- Clamp overall marks at 0 so negative marking never yields < 0%
  v_final_marks := LEAST(v_total_marks, GREATEST(0, v_raw_marks));
  v_percentage := ROUND((v_final_marks / v_total_marks) * 100.0, 2);
  v_passed := (v_percentage >= v_exam.passing_percentage);

  UPDATE public.results
  SET marks_obtained = v_final_marks,
      total_marks = v_total_marks,
      percentage = v_percentage,
      passed = v_passed,
      correct_count = v_correct_count,
      incorrect_count = v_incorrect_count,
      unanswered_count = v_unanswered_count
  WHERE id = v_result_id;

  PERFORM public.internal_write_audit_log(
    v_exam.institution_id,
    p_actor_id,
    p_actor_role,
    CASE WHEN p_target_status = 'auto_submitted' THEN 'attempt_auto_submitted' ELSE 'attempt_submitted' END,
    'exam_attempt',
    v_attempt.id,
    jsonb_build_object(
      'exam_id', v_exam.id,
      'student_id', v_attempt.student_id,
      'attempt_number', v_attempt.attempt_number,
      'result_id', v_result_id
    )
  );

  PERFORM public.internal_write_audit_log(
    v_exam.institution_id,
    p_actor_id,
    p_actor_role,
    'result_finalized',
    'result',
    v_result_id,
    jsonb_build_object(
      'attempt_id', v_attempt.id,
      'exam_id', v_exam.id,
      'marks_obtained', v_final_marks,
      'total_marks', v_total_marks,
      'percentage', v_percentage,
      'passed', v_passed
    )
  );

  RETURN jsonb_build_object(
    'already_finalized', false,
    'attempt_id', v_attempt.id,
    'status', p_target_status,
    'submitted_at', v_submitted_ts,
    'result_id', v_result_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.internal_finalize_attempt(uuid, public.attempt_status, timestamptz, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.internal_finalize_attempt(uuid, public.attempt_status, timestamptz, uuid, text)
  TO service_role;

-- ============================================================================
-- BOOTSTRAP & ADMIN MANAGEMENT RPCs
-- ============================================================================

-- Restricted to service_role / DB owner ONLY for initial documented admin setup
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
  v_profile public.profiles%ROWTYPE;
BEGIN
  IF current_user NOT IN ('postgres', 'service_role', 'supabase_admin')
     AND COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'FORBIDDEN_SERVICE_ROLE_ONLY: Initial administrator promotion requires service_role privileges.'
      USING ERRCODE = '42501';
  END IF;

  SELECT u.email INTO v_auth_email
  FROM auth.users u
  WHERE u.id = p_user_id;

  IF v_auth_email IS NULL THEN
    RAISE EXCEPTION 'AUTH_USER_NOT_FOUND: Target auth user % does not exist.', p_user_id;
  END IF;

  PERFORM set_config('quizpocket.trusted_context', 'on', true);

  INSERT INTO public.profiles (
    id,
    institution_id,
    email,
    full_name,
    role,
    account_status
  )
  VALUES (
    p_user_id,
    '00000000-0000-0000-0000-000000000001',
    v_auth_email,
    COALESCE(NULLIF(btrim(p_full_name), ''), split_part(v_auth_email, '@', 1)),
    'admin',
    'active'
  )
  ON CONFLICT (id) DO UPDATE
    SET role = 'admin',
        account_status = 'active',
        full_name = COALESCE(NULLIF(btrim(p_full_name), ''), public.profiles.full_name)
  RETURNING * INTO v_profile;

  PERFORM public.internal_write_audit_log(
    v_profile.institution_id,
    p_user_id,
    'system',
    'admin_bootstrapped',
    'profile',
    p_user_id,
    jsonb_build_object('email', v_profile.email)
  );

  RETURN v_profile;
END;
$$;

REVOKE ALL ON FUNCTION public.bootstrap_initial_admin(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bootstrap_initial_admin(uuid, text) TO service_role;

-- Admin: Configure or update a student profile (name, identifier, status)
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
  v_existing public.profiles%ROWTYPE;
  v_profile public.profiles%ROWTYPE;
BEGIN
  IF NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY: Active administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  v_admin_inst := public.current_institution_id();

  SELECT u.email INTO v_auth_email
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
    full_name,
    student_identifier,
    role,
    account_status
  )
  VALUES (
    p_student_id,
    v_admin_inst,
    v_auth_email,
    btrim(p_full_name),
    NULLIF(btrim(p_student_identifier), ''),
    'student',
    p_account_status
  )
  ON CONFLICT (id) DO UPDATE
    SET full_name = btrim(p_full_name),
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

-- Admin: Create class
CREATE OR REPLACE FUNCTION public.admin_create_class(
  p_name text,
  p_description text DEFAULT NULL
)
RETURNS public.classes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inst uuid;
  v_class public.classes%ROWTYPE;
BEGIN
  IF NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY: Active administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  v_inst := public.current_institution_id();

  INSERT INTO public.classes (institution_id, name, description, created_by)
  VALUES (v_inst, btrim(p_name), NULLIF(btrim(p_description), ''), auth.uid())
  RETURNING * INTO v_class;

  PERFORM public.internal_write_audit_log(
    v_inst, auth.uid(), 'admin', 'class_created', 'class', v_class.id,
    jsonb_build_object('name', v_class.name)
  );

  RETURN v_class;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_create_class(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_create_class(text, text) TO authenticated, service_role;

-- Admin: Set class membership status (enroll or deactivate student in class)
CREATE OR REPLACE FUNCTION public.admin_set_class_membership(
  p_class_id uuid,
  p_student_id uuid,
  p_status public.membership_status DEFAULT 'active'
)
RETURNS public.class_memberships
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inst uuid;
  v_class_inst uuid;
  v_membership public.class_memberships%ROWTYPE;
BEGIN
  IF NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY: Active administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  v_inst := public.current_institution_id();
  SELECT c.institution_id INTO v_class_inst FROM public.classes c WHERE c.id = p_class_id;

  IF v_class_inst IS NULL OR v_class_inst <> v_inst THEN
    RAISE EXCEPTION 'CLASS_NOT_FOUND: Class not found in your institution.';
  END IF;

  INSERT INTO public.class_memberships (class_id, student_id, membership_status)
  VALUES (p_class_id, p_student_id, p_status)
  ON CONFLICT (class_id, student_id) DO UPDATE
    SET membership_status = p_status
  RETURNING * INTO v_membership;

  PERFORM public.internal_write_audit_log(
    v_inst, auth.uid(), 'admin', 'class_membership_changed', 'class_membership', v_membership.id,
    jsonb_build_object('class_id', p_class_id, 'student_id', p_student_id, 'status', p_status)
  );

  RETURN v_membership;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_class_membership(uuid, uuid, public.membership_status) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_class_membership(uuid, uuid, public.membership_status) TO authenticated, service_role;

-- Admin: Create examination (starts in draft)
CREATE OR REPLACE FUNCTION public.admin_create_exam(
  p_title text,
  p_description text DEFAULT NULL,
  p_instructions text DEFAULT NULL,
  p_duration_minutes integer DEFAULT 30,
  p_passing_percentage numeric DEFAULT 50.00,
  p_scheduled_start_at timestamptz DEFAULT NULL,
  p_scheduled_end_at timestamptz DEFAULT NULL,
  p_result_release_policy public.result_release_policy DEFAULT 'immediate',
  p_allow_review boolean DEFAULT true,
  p_shuffle_questions boolean DEFAULT false,
  p_shuffle_options boolean DEFAULT false,
  p_max_attempts integer DEFAULT 1,
  p_retake_cooldown_minutes integer DEFAULT 180
)
RETURNS public.exams
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inst uuid;
  v_exam public.exams%ROWTYPE;
BEGIN
  IF NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY: Active administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  v_inst := public.current_institution_id();

  INSERT INTO public.exams (
    institution_id,
    title,
    description,
    instructions,
    duration_minutes,
    passing_percentage,
    status,
    scheduled_start_at,
    scheduled_end_at,
    result_release_policy,
    allow_review,
    shuffle_questions,
    shuffle_options,
    max_attempts,
    retake_cooldown_minutes,
    created_by
  )
  VALUES (
    v_inst,
    btrim(p_title),
    NULLIF(btrim(p_description), ''),
    NULLIF(btrim(p_instructions), ''),
    p_duration_minutes,
    p_passing_percentage,
    'draft',
    p_scheduled_start_at,
    p_scheduled_end_at,
    COALESCE(p_result_release_policy, 'immediate'),
    COALESCE(p_allow_review, true),
    COALESCE(p_shuffle_questions, false),
    COALESCE(p_shuffle_options, false),
    COALESCE(p_max_attempts, 1),
    COALESCE(p_retake_cooldown_minutes, 180),
    auth.uid()
  )
  RETURNING * INTO v_exam;

  PERFORM public.internal_write_audit_log(
    v_inst, auth.uid(), 'admin', 'exam_created', 'exam', v_exam.id,
    jsonb_build_object('title', v_exam.title, 'duration_minutes', v_exam.duration_minutes)
  );

  RETURN v_exam;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_create_exam(
  text, text, text, integer, numeric, timestamptz, timestamptz,
  public.result_release_policy, boolean, boolean, boolean, integer, integer
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_create_exam(
  text, text, text, integer, numeric, timestamptz, timestamptz,
  public.result_release_policy, boolean, boolean, boolean, integer, integer
) TO authenticated, service_role;

-- Admin: Upsert Question & Options Atomically (validates single correct answer & lock rules)
CREATE OR REPLACE FUNCTION public.admin_upsert_question_with_options(
  p_exam_id uuid,
  p_question_text text,
  p_question_type public.question_type,
  p_marks numeric,
  p_options jsonb,
  p_question_id uuid DEFAULT NULL,
  p_negative_marks numeric DEFAULT 0,
  p_explanation text DEFAULT NULL,
  p_display_order integer DEFAULT NULL,
  p_is_required boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inst uuid;
  v_exam public.exams%ROWTYPE;
  v_opt_count integer;
  v_correct_count integer := 0;
  v_distinct_texts integer;
  v_order integer;
  v_q_id uuid;
  v_idx integer := 0;
  v_opt jsonb;
  v_opt_text text;
  v_opt_correct boolean;
BEGIN
  IF NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY: Active administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  v_inst := public.current_institution_id();

  SELECT * INTO v_exam
  FROM public.exams e
  WHERE e.id = p_exam_id
    AND e.institution_id = v_inst
  FOR UPDATE;

  IF v_exam.id IS NULL THEN
    RAISE EXCEPTION 'EXAM_NOT_FOUND: Examination not found in your institution.';
  END IF;

  IF EXISTS (SELECT 1 FROM public.exam_attempts a WHERE a.exam_id = p_exam_id) THEN
    RAISE EXCEPTION 'EXAM_LOCKED_BY_ATTEMPTS: Questions and answer keys cannot be modified once attempts exist.';
  END IF;

  IF p_options IS NULL OR jsonb_typeof(p_options) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_OPTIONS_PAYLOAD: Options must be provided as a JSON array.';
  END IF;

  v_opt_count := jsonb_array_length(p_options);

  IF p_question_type = 'true_false' AND v_opt_count <> 2 THEN
    RAISE EXCEPTION 'INVALID_OPTION_COUNT: True/false questions must have exactly 2 options.';
  END IF;

  IF p_question_type = 'multiple_choice' AND (v_opt_count < 2 OR v_opt_count > 8) THEN
    RAISE EXCEPTION 'INVALID_OPTION_COUNT: Multiple-choice questions must have between 2 and 8 options.';
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE COALESCE((elem ->> 'is_correct')::boolean, false) = true),
    COUNT(DISTINCT lower(btrim(COALESCE(elem ->> 'option_text', ''))))
  INTO v_correct_count, v_distinct_texts
  FROM jsonb_array_elements(p_options) AS elem;

  IF v_correct_count <> 1 THEN
    RAISE EXCEPTION 'INVALID_CORRECT_OPTION_COUNT: Exactly 1 option must be marked as correct (received %).', v_correct_count;
  END IF;

  IF v_distinct_texts <> v_opt_count THEN
    RAISE EXCEPTION 'DUPLICATE_OPTION_TEXT: Answer options within a question must have distinct text.';
  END IF;

  IF p_display_order IS NULL THEN
    SELECT COALESCE(MAX(q.display_order), 0) + 1 INTO v_order
    FROM public.exam_questions q WHERE q.exam_id = p_exam_id;
  ELSE
    v_order := p_display_order;
  END IF;

  IF p_question_id IS NULL THEN
    INSERT INTO public.exam_questions (
      exam_id,
      question_text,
      question_type,
      marks,
      negative_marks,
      explanation,
      display_order,
      is_required
    )
    VALUES (
      p_exam_id,
      btrim(p_question_text),
      p_question_type,
      p_marks,
      COALESCE(p_negative_marks, 0),
      NULLIF(btrim(p_explanation), ''),
      v_order,
      COALESCE(p_is_required, true)
    )
    RETURNING id INTO v_q_id;
  ELSE
    UPDATE public.exam_questions
    SET question_text = btrim(p_question_text),
        question_type = p_question_type,
        marks = p_marks,
        negative_marks = COALESCE(p_negative_marks, 0),
        explanation = NULLIF(btrim(p_explanation), ''),
        display_order = v_order,
        is_required = COALESCE(p_is_required, true)
    WHERE id = p_question_id
      AND exam_id = p_exam_id
    RETURNING id INTO v_q_id;

    IF v_q_id IS NULL THEN
      RAISE EXCEPTION 'QUESTION_NOT_FOUND: Target question not found on this examination.';
    END IF;

    DELETE FROM public.question_options WHERE question_id = v_q_id;
  END IF;

  FOR v_opt IN SELECT * FROM jsonb_array_elements(p_options)
  LOOP
    v_idx := v_idx + 1;
    v_opt_text := btrim(COALESCE(v_opt ->> 'option_text', ''));
    v_opt_correct := COALESCE((v_opt ->> 'is_correct')::boolean, false);

    IF char_length(v_opt_text) = 0 THEN
      RAISE EXCEPTION 'EMPTY_OPTION_TEXT: Option text cannot be empty.';
    END IF;

    INSERT INTO public.question_options (
      question_id,
      option_text,
      display_order,
      is_correct
    )
    VALUES (
      v_q_id,
      v_opt_text,
      COALESCE((v_opt ->> 'display_order')::integer, v_idx),
      v_opt_correct
    );
  END LOOP;

  PERFORM public.internal_write_audit_log(
    v_inst, auth.uid(), 'admin', 'question_upserted', 'exam_question', v_q_id,
    jsonb_build_object('exam_id', p_exam_id, 'question_type', p_question_type, 'marks', p_marks)
  );

  RETURN (
    SELECT jsonb_build_object(
      'question_id', q.id,
      'exam_id', q.exam_id,
      'marks', q.marks,
      'exam_total_marks', e.total_marks,
      'options', (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', o.id,
            'option_text', o.option_text,
            'display_order', o.display_order,
            'is_correct', o.is_correct
          )
          ORDER BY o.display_order ASC
        )
        FROM public.question_options o
        WHERE o.question_id = q.id
      )
    )
    FROM public.exam_questions q
    JOIN public.exams e ON e.id = q.exam_id
    WHERE q.id = v_q_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_upsert_question_with_options(
  uuid, text, public.question_type, numeric, jsonb, uuid, numeric, text, integer, boolean
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_upsert_question_with_options(
  uuid, text, public.question_type, numeric, jsonb, uuid, numeric, text, integer, boolean
) TO authenticated, service_role;

-- Admin: Publish examination (validates questions, answer keys, and total_marks > 0)
CREATE OR REPLACE FUNCTION public.admin_publish_exam(p_exam_id uuid)
RETURNS public.exams
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inst uuid;
  v_exam public.exams%ROWTYPE;
  v_q_count integer;
  v_invalid_q_count integer;
BEGIN
  IF NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY: Active administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  v_inst := public.current_institution_id();

  SELECT * INTO v_exam
  FROM public.exams e
  WHERE e.id = p_exam_id
    AND e.institution_id = v_inst
  FOR UPDATE;

  IF v_exam.id IS NULL THEN
    RAISE EXCEPTION 'EXAM_NOT_FOUND: Examination not found in your institution.';
  END IF;

  IF v_exam.status = 'archived' THEN
    RAISE EXCEPTION 'INVALID_EXAM_STATE: Archived examinations cannot be published directly.';
  END IF;

  SELECT COUNT(*) INTO v_q_count
  FROM public.exam_questions q
  WHERE q.exam_id = p_exam_id;

  IF v_q_count = 0 OR v_exam.total_marks <= 0 THEN
    RAISE EXCEPTION 'EXAM_INCOMPLETE: Examination must have at least one question and positive total marks before publishing.';
  END IF;

  -- Verify every question has >= 2 options and exactly 1 correct option
  SELECT COUNT(*) INTO v_invalid_q_count
  FROM public.exam_questions q
  WHERE q.exam_id = p_exam_id
    AND (
      (SELECT COUNT(*) FROM public.question_options o WHERE o.question_id = q.id) < 2
      OR (SELECT COUNT(*) FROM public.question_options o WHERE o.question_id = q.id AND o.is_correct = true) <> 1
    );

  IF v_invalid_q_count > 0 THEN
    RAISE EXCEPTION 'EXAM_INVALID_ANSWER_KEY: Every question must have at least 2 options and exactly 1 correct answer.';
  END IF;

  UPDATE public.exams
  SET status = 'published',
      published_at = COALESCE(published_at, public.utc_now())
  WHERE id = p_exam_id
  RETURNING * INTO v_exam;

  PERFORM public.internal_write_audit_log(
    v_inst, auth.uid(), 'admin', 'exam_published', 'exam', v_exam.id,
    jsonb_build_object('total_marks', v_exam.total_marks, 'question_count', v_q_count)
  );

  RETURN v_exam;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_publish_exam(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_publish_exam(uuid) TO authenticated, service_role;

-- Admin: Archive examination
CREATE OR REPLACE FUNCTION public.admin_archive_exam(p_exam_id uuid)
RETURNS public.exams
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inst uuid;
  v_exam public.exams%ROWTYPE;
BEGIN
  IF NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY: Active administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  v_inst := public.current_institution_id();

  UPDATE public.exams
  SET status = 'archived'
  WHERE id = p_exam_id
    AND institution_id = v_inst
  RETURNING * INTO v_exam;

  IF v_exam.id IS NULL THEN
    RAISE EXCEPTION 'EXAM_NOT_FOUND: Examination not found in your institution.';
  END IF;

  PERFORM public.internal_write_audit_log(
    v_inst, auth.uid(), 'admin', 'exam_archived', 'exam', v_exam.id, '{}'::jsonb
  );

  RETURN v_exam;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_archive_exam(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_archive_exam(uuid) TO authenticated, service_role;

-- Admin: Release or withhold manual results & update review settings safely
CREATE OR REPLACE FUNCTION public.admin_set_exam_release_settings(
  p_exam_id uuid,
  p_result_release_policy public.result_release_policy DEFAULT NULL,
  p_results_released_manually boolean DEFAULT NULL,
  p_allow_review boolean DEFAULT NULL
)
RETURNS public.exams
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inst uuid;
  v_exam public.exams%ROWTYPE;
BEGIN
  IF NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY: Active administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  v_inst := public.current_institution_id();

  UPDATE public.exams
  SET result_release_policy = COALESCE(p_result_release_policy, result_release_policy),
      results_released_manually = COALESCE(p_results_released_manually, results_released_manually),
      allow_review = COALESCE(p_allow_review, allow_review)
  WHERE id = p_exam_id
    AND institution_id = v_inst
  RETURNING * INTO v_exam;

  IF v_exam.id IS NULL THEN
    RAISE EXCEPTION 'EXAM_NOT_FOUND: Examination not found in your institution.';
  END IF;

  PERFORM public.internal_write_audit_log(
    v_inst, auth.uid(), 'admin', 'exam_release_settings_updated', 'exam', v_exam.id,
    jsonb_build_object(
      'result_release_policy', v_exam.result_release_policy,
      'results_released_manually', v_exam.results_released_manually,
      'allow_review', v_exam.allow_review
    )
  );

  RETURN v_exam;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_exam_release_settings(uuid, public.result_release_policy, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_exam_release_settings(uuid, public.result_release_policy, boolean, boolean) TO authenticated, service_role;

-- Admin: Assign exam to student or class
CREATE OR REPLACE FUNCTION public.admin_assign_exam(
  p_exam_id uuid,
  p_student_id uuid DEFAULT NULL,
  p_class_id uuid DEFAULT NULL,
  p_status public.assignment_status DEFAULT 'active'
)
RETURNS public.exam_assignments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inst uuid;
  v_exam_inst uuid;
  v_assignment public.exam_assignments%ROWTYPE;
BEGIN
  IF NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY: Active administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  IF (p_student_id IS NULL AND p_class_id IS NULL)
     OR (p_student_id IS NOT NULL AND p_class_id IS NOT NULL) THEN
    RAISE EXCEPTION 'INVALID_ASSIGNMENT_TARGET: Specify exactly one of p_student_id or p_class_id.';
  END IF;

  v_inst := public.current_institution_id();
  SELECT e.institution_id INTO v_exam_inst FROM public.exams e WHERE e.id = p_exam_id;

  IF v_exam_inst IS NULL OR v_exam_inst <> v_inst THEN
    RAISE EXCEPTION 'EXAM_NOT_FOUND: Examination not found in your institution.';
  END IF;

  IF p_student_id IS NOT NULL THEN
    INSERT INTO public.exam_assignments (exam_id, student_id, assigned_by, assignment_status)
    VALUES (p_exam_id, p_student_id, auth.uid(), p_status)
    ON CONFLICT (exam_id, student_id) WHERE student_id IS NOT NULL
    DO UPDATE SET assignment_status = p_status, assigned_by = auth.uid(), assigned_at = public.utc_now()
    RETURNING * INTO v_assignment;
  ELSE
    INSERT INTO public.exam_assignments (exam_id, class_id, assigned_by, assignment_status)
    VALUES (p_exam_id, p_class_id, auth.uid(), p_status)
    ON CONFLICT (exam_id, class_id) WHERE class_id IS NOT NULL
    DO UPDATE SET assignment_status = p_status, assigned_by = auth.uid(), assigned_at = public.utc_now()
    RETURNING * INTO v_assignment;
  END IF;

  PERFORM public.internal_write_audit_log(
    v_inst, auth.uid(), 'admin', 'exam_assigned', 'exam_assignment', v_assignment.id,
    jsonb_build_object(
      'exam_id', p_exam_id,
      'student_id', p_student_id,
      'class_id', p_class_id,
      'status', p_status
    )
  );

  RETURN v_assignment;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_assign_exam(uuid, uuid, uuid, public.assignment_status) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_assign_exam(uuid, uuid, uuid, public.assignment_status) TO authenticated, service_role;

-- Admin: Explicit, Audited Result Correction Procedure (Section 11 & 13)
CREATE OR REPLACE FUNCTION public.admin_correct_result(
  p_result_id uuid,
  p_corrected_marks numeric,
  p_reason text
)
RETURNS public.results
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inst uuid;
  v_res public.results%ROWTYPE;
  v_exam public.exams%ROWTYPE;
  v_old_marks numeric(8,2);
  v_new_pct numeric(5,2);
  v_new_passed boolean;
BEGIN
  IF NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY: Active administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 5 THEN
    RAISE EXCEPTION 'REASON_REQUIRED: Result corrections require an explicit audit reason (>= 5 characters).';
  END IF;

  v_inst := public.current_institution_id();

  SELECT r.* INTO v_res
  FROM public.results r
  JOIN public.exams e ON e.id = r.exam_id
  WHERE r.id = p_result_id
    AND e.institution_id = v_inst
  FOR UPDATE OF r;

  IF v_res.id IS NULL THEN
    RAISE EXCEPTION 'RESULT_NOT_FOUND: Result record not found in your institution.';
  END IF;

  SELECT * INTO v_exam FROM public.exams WHERE id = v_res.exam_id;

  IF p_corrected_marks < 0 OR p_corrected_marks > v_res.total_marks THEN
    RAISE EXCEPTION 'INVALID_MARKS_RANGE: Corrected marks must be between 0 and %.', v_res.total_marks;
  END IF;

  v_old_marks := v_res.marks_obtained;
  v_new_pct := ROUND((p_corrected_marks / v_res.total_marks) * 100.0, 2);
  v_new_passed := (v_new_pct >= v_exam.passing_percentage);

  UPDATE public.results
  SET marks_obtained = p_corrected_marks,
      percentage = v_new_pct,
      passed = v_new_passed,
      marking_version = marking_version + 1,
      finalized_at = public.utc_now()
  WHERE id = p_result_id
  RETURNING * INTO v_res;

  PERFORM public.internal_write_audit_log(
    v_inst, auth.uid(), 'admin', 'result_corrected', 'result', v_res.id,
    jsonb_build_object(
      'previous_marks', v_old_marks,
      'corrected_marks', p_corrected_marks,
      'percentage', v_new_pct,
      'passed', v_new_passed,
      'marking_version', v_res.marking_version,
      'reason', btrim(p_reason)
    )
  );

  RETURN v_res;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_correct_result(uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_correct_result(uuid, numeric, text) TO authenticated, service_role;

-- ============================================================================
-- STUDENT EXAMINATION ENGINE RPCs
-- ============================================================================

-- Student: List eligible published examinations with availability & cooldown metadata
CREATE OR REPLACE FUNCTION public.student_list_eligible_exams()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_inst uuid;
  v_now timestamptz := public.utc_now();
  v_payload jsonb;
BEGIN
  IF NOT public.is_active_student() THEN
    RAISE EXCEPTION 'FORBIDDEN_STUDENT_ONLY: Active student account required.'
      USING ERRCODE = '42501';
  END IF;

  v_inst := public.current_institution_id();

  SELECT COALESCE(jsonb_agg(item ORDER BY item->>'created_at' DESC), '[]'::jsonb)
  INTO v_payload
  FROM (
    SELECT jsonb_build_object(
      'id', e.id,
      'title', e.title,
      'description', e.description,
      'instructions', e.instructions,
      'duration_minutes', e.duration_minutes,
      'total_marks', e.total_marks,
      'passing_percentage', e.passing_percentage,
      'scheduled_start_at', e.scheduled_start_at,
      'scheduled_end_at', e.scheduled_end_at,
      'max_attempts', e.max_attempts,
      'retake_cooldown_minutes', e.retake_cooldown_minutes,
      'result_release_policy', e.result_release_policy,
      'allow_review', e.allow_review,
      'server_now', v_now,
      'is_window_open', (
        (e.scheduled_start_at IS NULL OR v_now >= e.scheduled_start_at)
        AND (e.scheduled_end_at IS NULL OR v_now <= e.scheduled_end_at)
      ),
      'active_attempt_id', (
        SELECT a.id FROM public.exam_attempts a
        WHERE a.exam_id = e.id AND a.student_id = v_uid
          AND a.status = 'in_progress' AND a.deadline_at > v_now
        LIMIT 1
      ),
      'completed_attempts', (
        SELECT COUNT(*) FROM public.exam_attempts a
        WHERE a.exam_id = e.id AND a.student_id = v_uid
          AND a.status IN ('submitted', 'auto_submitted')
      ),
      'next_retake_eligible_at', (
        SELECT a.submitted_at + make_interval(mins => e.retake_cooldown_minutes)
        FROM public.exam_attempts a
        WHERE a.exam_id = e.id AND a.student_id = v_uid
          AND a.status IN ('submitted', 'auto_submitted')
        ORDER BY a.submitted_at DESC
        LIMIT 1
      ),
      'created_at', e.created_at
    ) AS item
    FROM public.exams e
    WHERE e.institution_id = v_inst
      AND e.status = 'published'
      AND public.is_student_assigned_to_exam(e.id, v_uid)
  ) sub;

  RETURN v_payload;
END;
$$;

REVOKE ALL ON FUNCTION public.student_list_eligible_exams() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.student_list_eligible_exams() TO authenticated, service_role;

-- Student: Start or Resume an Examination Attempt (Atomic, Race-Condition-Safe)
CREATE OR REPLACE FUNCTION public.student_start_or_resume_attempt(p_exam_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_inst uuid;
  v_exam public.exams%ROWTYPE;
  v_active public.exam_attempts%ROWTYPE;
  v_completed_count integer := 0;
  v_last_submitted_at timestamptz;
  v_next_eligible_at timestamptz;
  v_next_attempt_number integer;
  v_new_attempt public.exam_attempts%ROWTYPE;
  v_now timestamptz := public.utc_now();
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_student() THEN
    RAISE EXCEPTION 'FORBIDDEN_STUDENT_ONLY: Active authenticated student account required.'
      USING ERRCODE = '42501';
  END IF;

  -- Serialize simultaneous start requests for the same (exam_id, student_id)
  PERFORM pg_advisory_xact_lock(hashtextextended(p_exam_id::text || ':' || v_uid::text, 0));

  v_inst := public.current_institution_id();

  SELECT * INTO v_exam
  FROM public.exams e
  WHERE e.id = p_exam_id
    AND e.institution_id = v_inst;

  IF v_exam.id IS NULL OR v_exam.status <> 'published' THEN
    RAISE EXCEPTION 'EXAM_NOT_AVAILABLE: Examination does not exist or is not published.'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_student_assigned_to_exam(p_exam_id, v_uid) THEN
    RAISE EXCEPTION 'EXAM_NOT_ASSIGNED: You are not assigned to this examination.'
      USING ERRCODE = '42501';
  END IF;

  -- Check for any existing in_progress attempt
  SELECT * INTO v_active
  FROM public.exam_attempts a
  WHERE a.exam_id = p_exam_id
    AND a.student_id = v_uid
    AND a.status = 'in_progress'
  FOR UPDATE;

  IF v_active.id IS NOT NULL THEN
    IF v_now >= v_active.deadline_at THEN
      -- Expired in_progress attempt: auto-finalize first before evaluating retake rules
      PERFORM public.internal_finalize_attempt(
        v_active.id, 'auto_submitted', v_active.deadline_at, NULL, 'system'
      );
    ELSE
      -- Valid active attempt: resume without creating a duplicate attempt
      UPDATE public.exam_attempts
      SET last_activity_at = v_now
      WHERE id = v_active.id;

      RETURN jsonb_build_object(
        'attempt_id', v_active.id,
        'exam_id', v_active.exam_id,
        'attempt_number', v_active.attempt_number,
        'status', v_active.status,
        'started_at', v_active.started_at,
        'deadline_at', v_active.deadline_at,
        'server_now', v_now,
        'resumed', true
      );
    END IF;
  END IF;

  -- Enforce availability window for starting a NEW attempt
  IF v_exam.scheduled_start_at IS NOT NULL AND v_now < v_exam.scheduled_start_at THEN
    RAISE EXCEPTION 'EXAM_NOT_YET_OPEN: Examination window opens at %.', v_exam.scheduled_start_at;
  END IF;

  IF v_exam.scheduled_end_at IS NOT NULL AND v_now > v_exam.scheduled_end_at THEN
    RAISE EXCEPTION 'EXAM_WINDOW_CLOSED: Examination availability window closed at %.', v_exam.scheduled_end_at;
  END IF;

  -- Enforce max_attempts
  SELECT COUNT(*), MAX(a.submitted_at)
  INTO v_completed_count, v_last_submitted_at
  FROM public.exam_attempts a
  WHERE a.exam_id = p_exam_id
    AND a.student_id = v_uid
    AND a.status IN ('submitted', 'auto_submitted');

  IF v_completed_count >= v_exam.max_attempts THEN
    RAISE EXCEPTION 'MAX_ATTEMPTS_REACHED: Maximum allowed attempts (%) reached for this examination.', v_exam.max_attempts;
  END IF;

  -- Enforce retake cooldown using authoritative server timestamps
  IF v_last_submitted_at IS NOT NULL AND v_exam.retake_cooldown_minutes > 0 THEN
    v_next_eligible_at := v_last_submitted_at + make_interval(mins => v_exam.retake_cooldown_minutes);
    IF v_now < v_next_eligible_at THEN
      RAISE EXCEPTION 'RETAKE_COOLDOWN_ACTIVE: Next attempt permitted after %.', v_next_eligible_at;
    END IF;
  END IF;

  SELECT COALESCE(MAX(a.attempt_number), 0) + 1
  INTO v_next_attempt_number
  FROM public.exam_attempts a
  WHERE a.exam_id = p_exam_id
    AND a.student_id = v_uid;

  INSERT INTO public.exam_attempts (
    exam_id,
    student_id,
    attempt_number,
    status,
    started_at,
    deadline_at,
    last_activity_at
  )
  VALUES (
    p_exam_id,
    v_uid,
    v_next_attempt_number,
    'in_progress',
    v_now,
    v_now + make_interval(mins => v_exam.duration_minutes),
    v_now
  )
  RETURNING * INTO v_new_attempt;

  PERFORM public.internal_write_audit_log(
    v_inst, v_uid, 'student', 'attempt_started', 'exam_attempt', v_new_attempt.id,
    jsonb_build_object(
      'exam_id', p_exam_id,
      'attempt_number', v_new_attempt.attempt_number,
      'deadline_at', v_new_attempt.deadline_at
    )
  );

  RETURN jsonb_build_object(
    'attempt_id', v_new_attempt.id,
    'exam_id', v_new_attempt.exam_id,
    'attempt_number', v_new_attempt.attempt_number,
    'status', v_new_attempt.status,
    'started_at', v_new_attempt.started_at,
    'deadline_at', v_new_attempt.deadline_at,
    'server_now', v_now,
    'resumed', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.student_start_or_resume_attempt(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.student_start_or_resume_attempt(uuid) TO authenticated, service_role;

-- Student: Get Active Attempt Questions (ZERO Answer-Key or Explanation Leakage!)
CREATE OR REPLACE FUNCTION public.student_get_attempt_questions(p_attempt_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_attempt public.exam_attempts%ROWTYPE;
  v_exam public.exams%ROWTYPE;
  v_now timestamptz := public.utc_now();
  v_questions jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_student() THEN
    RAISE EXCEPTION 'FORBIDDEN_STUDENT_ONLY: Active student account required.'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_attempt
  FROM public.exam_attempts a
  WHERE a.id = p_attempt_id
  FOR UPDATE;

  IF v_attempt.id IS NULL OR v_attempt.student_id <> v_uid THEN
    RAISE EXCEPTION 'FORBIDDEN_ATTEMPT_ACCESS: Attempt not found or access denied.'
      USING ERRCODE = '42501';
  END IF;

  IF v_attempt.status <> 'in_progress' THEN
    RAISE EXCEPTION 'ATTEMPT_NOT_ACTIVE: Attempt is no longer active (%).', v_attempt.status;
  END IF;

  IF v_now > v_attempt.deadline_at THEN
    PERFORM public.internal_finalize_attempt(
      v_attempt.id, 'auto_submitted', v_attempt.deadline_at, NULL, 'system'
    );
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'ATTEMPT_DEADLINE_EXPIRED',
      'attempt_status', 'auto_submitted',
      'deadline_at', v_attempt.deadline_at,
      'server_now', v_now
    );
  END IF;

  SELECT * INTO v_exam FROM public.exams WHERE id = v_attempt.exam_id;

  -- Strictly project ONLY student-permitted fields (NO is_correct, NO explanation!)
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', q.id,
        'question_text', q.question_text,
        'question_type', q.question_type,
        'marks', q.marks,
        'negative_marks', q.negative_marks,
        'display_order', q.display_order,
        'is_required', q.is_required,
        'saved_selected_option_id', sa.selected_option_id,
        'saved_revision', sa.revision,
        'options', (
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', o.id,
              'option_text', o.option_text,
              'display_order', o.display_order
            )
            ORDER BY
              CASE WHEN v_exam.shuffle_options THEN md5(v_attempt.id::text || ':' || o.id::text) ELSE NULL END ASC,
              o.display_order ASC
          )
          FROM public.question_options o
          WHERE o.question_id = q.id
        )
      )
      ORDER BY
        CASE WHEN v_exam.shuffle_questions THEN md5(v_attempt.id::text || ':' || q.id::text) ELSE NULL END ASC,
        q.display_order ASC
    ),
    '[]'::jsonb
  )
  INTO v_questions
  FROM public.exam_questions q
  LEFT JOIN public.student_answers sa
    ON sa.attempt_id = v_attempt.id
   AND sa.question_id = q.id
  WHERE q.exam_id = v_exam.id;

  RETURN jsonb_build_object(
    'ok', true,
    'attempt_id', v_attempt.id,
    'exam_id', v_exam.id,
    'exam_title', v_exam.title,
    'instructions', v_exam.instructions,
    'duration_minutes', v_exam.duration_minutes,
    'started_at', v_attempt.started_at,
    'deadline_at', v_attempt.deadline_at,
    'server_now', v_now,
    'questions', v_questions
  );
END;
$$;

REVOKE ALL ON FUNCTION public.student_get_attempt_questions(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.student_get_attempt_questions(uuid) TO authenticated, service_role;

-- Student: Save an Answer (Idempotent Upsert + Server Deadline Guard)
CREATE OR REPLACE FUNCTION public.student_save_answer(
  p_attempt_id uuid,
  p_question_id uuid,
  p_selected_option_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_attempt public.exam_attempts%ROWTYPE;
  v_question_exam_id uuid;
  v_option_question_id uuid;
  v_answer public.student_answers%ROWTYPE;
  v_now timestamptz := public.utc_now();
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_student() THEN
    RAISE EXCEPTION 'FORBIDDEN_STUDENT_ONLY: Active student account required.'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_attempt
  FROM public.exam_attempts a
  WHERE a.id = p_attempt_id
  FOR UPDATE;

  IF v_attempt.id IS NULL OR v_attempt.student_id <> v_uid THEN
    RAISE EXCEPTION 'FORBIDDEN_ATTEMPT_ACCESS: Attempt not found or belongs to another student.'
      USING ERRCODE = '42501';
  END IF;

  IF v_attempt.status <> 'in_progress' THEN
    RAISE EXCEPTION 'ATTEMPT_NOT_ACTIVE: Attempt is already finalized (%).', v_attempt.status;
  END IF;

  -- If server deadline has passed, commit auto-submission and reject the late answer write
  IF v_now > v_attempt.deadline_at THEN
    PERFORM public.internal_finalize_attempt(
      v_attempt.id, 'auto_submitted', v_attempt.deadline_at, NULL, 'system'
    );
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'ATTEMPT_DEADLINE_EXPIRED',
      'message', 'Examination deadline has elapsed. Your attempt was automatically submitted.',
      'attempt_status', 'auto_submitted',
      'deadline_at', v_attempt.deadline_at,
      'server_now', v_now
    );
  END IF;

  SELECT q.exam_id INTO v_question_exam_id
  FROM public.exam_questions q
  WHERE q.id = p_question_id;

  IF v_question_exam_id IS NULL OR v_question_exam_id <> v_attempt.exam_id THEN
    RAISE EXCEPTION 'QUESTION_EXAM_MISMATCH: Question does not belong to this examination.';
  END IF;

  IF p_selected_option_id IS NOT NULL THEN
    SELECT o.question_id INTO v_option_question_id
    FROM public.question_options o
    WHERE o.id = p_selected_option_id;

    IF v_option_question_id IS NULL OR v_option_question_id <> p_question_id THEN
      RAISE EXCEPTION 'OPTION_QUESTION_MISMATCH: Selected option does not belong to the specified question.';
    END IF;
  END IF;

  INSERT INTO public.student_answers (
    attempt_id,
    question_id,
    selected_option_id,
    revision,
    saved_at
  )
  VALUES (
    p_attempt_id,
    p_question_id,
    p_selected_option_id,
    1,
    v_now
  )
  ON CONFLICT (attempt_id, question_id) DO UPDATE
    SET selected_option_id = EXCLUDED.selected_option_id,
        revision = public.student_answers.revision + 1,
        saved_at = v_now
  RETURNING * INTO v_answer;

  UPDATE public.exam_attempts
  SET last_activity_at = v_now
  WHERE id = p_attempt_id;

  RETURN jsonb_build_object(
    'ok', true,
    'attempt_id', v_answer.attempt_id,
    'question_id', v_answer.question_id,
    'selected_option_id', v_answer.selected_option_id,
    'revision', v_answer.revision,
    'saved_at', v_answer.saved_at,
    'deadline_at', v_attempt.deadline_at,
    'server_now', v_now
  );
END;
$$;

REVOKE ALL ON FUNCTION public.student_save_answer(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.student_save_answer(uuid, uuid, uuid) TO authenticated, service_role;

-- Student: Submit Attempt (Atomic, Idempotent, Respects Result-Release Policy)
CREATE OR REPLACE FUNCTION public.student_submit_attempt(p_attempt_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_attempt public.exam_attempts%ROWTYPE;
  v_exam public.exams%ROWTYPE;
  v_now timestamptz := public.utc_now();
  v_finalize_out jsonb;
  v_result public.results%ROWTYPE;
  v_released boolean;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_student() THEN
    RAISE EXCEPTION 'FORBIDDEN_STUDENT_ONLY: Active student account required.'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_attempt
  FROM public.exam_attempts a
  WHERE a.id = p_attempt_id
  FOR UPDATE;

  IF v_attempt.id IS NULL OR v_attempt.student_id <> v_uid THEN
    RAISE EXCEPTION 'FORBIDDEN_ATTEMPT_ACCESS: Attempt not found or belongs to another student.'
      USING ERRCODE = '42501';
  END IF;

  IF v_attempt.status = 'voided' THEN
    RAISE EXCEPTION 'ATTEMPT_VOIDED: Voided attempts cannot be submitted.';
  END IF;

  IF v_attempt.status IN ('submitted', 'auto_submitted') THEN
    v_finalize_out := jsonb_build_object(
      'already_finalized', true,
      'attempt_id', v_attempt.id,
      'status', v_attempt.status,
      'submitted_at', v_attempt.submitted_at
    );
  ELSIF v_now > v_attempt.deadline_at THEN
    -- Submission arrived after server deadline: finalize as auto_submitted at deadline cutoff
    v_finalize_out := public.internal_finalize_attempt(
      v_attempt.id, 'auto_submitted', v_attempt.deadline_at, v_uid, 'student'
    );
  ELSE
    v_finalize_out := public.internal_finalize_attempt(
      v_attempt.id, 'submitted', v_now, v_uid, 'student'
    );
  END IF;

  SELECT * INTO v_exam FROM public.exams WHERE id = v_attempt.exam_id;
  v_released := public.is_result_released_for_exam(v_exam.id);

  IF v_released THEN
    SELECT * INTO v_result FROM public.results WHERE attempt_id = v_attempt.id;
    RETURN jsonb_build_object(
      'attempt_id', v_attempt.id,
      'exam_id', v_exam.id,
      'status', v_finalize_out ->> 'status',
      'submitted_at', v_finalize_out ->> 'submitted_at',
      'already_finalized', (v_finalize_out ->> 'already_finalized')::boolean,
      'result_released', true,
      'result', jsonb_build_object(
        'marks_obtained', v_result.marks_obtained,
        'total_marks', v_result.total_marks,
        'percentage', v_result.percentage,
        'passed', v_result.passed,
        'correct_count', v_result.correct_count,
        'incorrect_count', v_result.incorrect_count,
        'unanswered_count', v_result.unanswered_count,
        'finalized_at', v_result.finalized_at
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'attempt_id', v_attempt.id,
    'exam_id', v_exam.id,
    'status', v_finalize_out ->> 'status',
    'submitted_at', v_finalize_out ->> 'submitted_at',
    'already_finalized', (v_finalize_out ->> 'already_finalized')::boolean,
    'result_released', false,
    'result_release_policy', v_exam.result_release_policy
  );
END;
$$;

REVOKE ALL ON FUNCTION public.student_submit_attempt(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.student_submit_attempt(uuid) TO authenticated, service_role;

-- Scheduled / Administrative Batch Expiry Sweep (Idempotent, SKIP LOCKED)
CREATE OR REPLACE FUNCTION public.finalize_expired_attempts(p_batch_limit integer DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz := public.utc_now();
  v_rec record;
  v_finalized_count integer := 0;
  v_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF current_user NOT IN ('postgres', 'service_role', 'supabase_admin')
     AND COALESCE(auth.role(), '') <> 'service_role'
     AND NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_EXPIRY_SWEEP: Only service_role or active administrators may run expiry sweeps.'
      USING ERRCODE = '42501';
  END IF;

  FOR v_rec IN
    SELECT a.id, a.deadline_at
    FROM public.exam_attempts a
    WHERE a.status = 'in_progress'
      AND a.deadline_at <= v_now
    ORDER BY a.deadline_at ASC
    LIMIT GREATEST(1, LEAST(COALESCE(p_batch_limit, 100), 1000))
    FOR UPDATE SKIP LOCKED
  LOOP
    PERFORM public.internal_finalize_attempt(
      v_rec.id, 'auto_submitted', v_rec.deadline_at, NULL, 'system'
    );
    v_finalized_count := v_finalized_count + 1;
    v_ids := array_append(v_ids, v_rec.id);
  END LOOP;

  RETURN jsonb_build_object(
    'swept_at', v_now,
    'finalized_count', v_finalized_count,
    'attempt_ids', to_jsonb(v_ids)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_expired_attempts(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finalize_expired_attempts(integer) TO authenticated, service_role;

-- Student: Get Own Released Results Summary
CREATE OR REPLACE FUNCTION public.student_get_released_results()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_payload jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_student() THEN
    RAISE EXCEPTION 'FORBIDDEN_STUDENT_ONLY: Active student account required.'
      USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'result_id', r.id,
        'attempt_id', a.id,
        'attempt_number', a.attempt_number,
        'exam_id', e.id,
        'exam_title', e.title,
        'started_at', a.started_at,
        'submitted_at', a.submitted_at,
        'status', a.status,
        'marks_obtained', r.marks_obtained,
        'total_marks', r.total_marks,
        'percentage', r.percentage,
        'passed', r.passed,
        'allow_review', e.allow_review,
        'finalized_at', r.finalized_at
      )
      ORDER BY r.finalized_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_payload
  FROM public.results r
  JOIN public.exam_attempts a ON a.id = r.attempt_id
  JOIN public.exams e ON e.id = r.exam_id
  WHERE r.student_id = v_uid
    AND public.is_result_released_for_exam(e.id);

  RETURN v_payload;
END;
$$;

REVOKE ALL ON FUNCTION public.student_get_released_results() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.student_get_released_results() TO authenticated, service_role;

-- Student: Get Detailed Answer Review (Requires Released Result AND allow_review = true)
CREATE OR REPLACE FUNCTION public.student_get_attempt_review(p_attempt_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_attempt public.exam_attempts%ROWTYPE;
  v_exam public.exams%ROWTYPE;
  v_result public.results%ROWTYPE;
  v_items jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_student() THEN
    RAISE EXCEPTION 'FORBIDDEN_STUDENT_ONLY: Active student account required.'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_attempt FROM public.exam_attempts WHERE id = p_attempt_id;

  IF v_attempt.id IS NULL OR v_attempt.student_id <> v_uid THEN
    RAISE EXCEPTION 'FORBIDDEN_ATTEMPT_ACCESS: Attempt not found or belongs to another student.'
      USING ERRCODE = '42501';
  END IF;

  IF v_attempt.status NOT IN ('submitted', 'auto_submitted') THEN
    RAISE EXCEPTION 'ATTEMPT_NOT_FINALIZED: Review is available only after submission.';
  END IF;

  SELECT * INTO v_exam FROM public.exams WHERE id = v_attempt.exam_id;

  IF NOT public.is_result_released_for_exam(v_exam.id) THEN
    RAISE EXCEPTION 'RESULT_NOT_RELEASED: Examination results have not been released yet.'
      USING ERRCODE = '42501';
  END IF;

  IF NOT v_exam.allow_review THEN
    RAISE EXCEPTION 'REVIEW_NOT_PERMITTED: Detailed answer review is disabled for this examination.'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_result FROM public.results WHERE attempt_id = v_attempt.id;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'question_id', q.id,
        'display_order', q.display_order,
        'question_text', q.question_text,
        'question_type', q.question_type,
        'max_marks', ri.max_marks,
        'marks_awarded', ri.marks_awarded,
        'outcome', ri.outcome,
        'selected_option_id', ri.selected_option_id,
        'correct_option_id', ri.correct_option_id,
        'explanation', q.explanation,
        'options', (
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', o.id,
              'option_text', o.option_text,
              'display_order', o.display_order,
              'is_correct', o.is_correct
            )
            ORDER BY o.display_order ASC
          )
          FROM public.question_options o
          WHERE o.question_id = q.id
        )
      )
      ORDER BY q.display_order ASC
    ),
    '[]'::jsonb
  )
  INTO v_items
  FROM public.result_items ri
  JOIN public.exam_questions q ON q.id = ri.question_id
  WHERE ri.result_id = v_result.id;

  RETURN jsonb_build_object(
    'attempt_id', v_attempt.id,
    'exam_id', v_exam.id,
    'exam_title', v_exam.title,
    'started_at', v_attempt.started_at,
    'submitted_at', v_attempt.submitted_at,
    'marks_obtained', v_result.marks_obtained,
    'total_marks', v_result.total_marks,
    'percentage', v_result.percentage,
    'passed', v_result.passed,
    'questions', v_items
  );
END;
$$;

REVOKE ALL ON FUNCTION public.student_get_attempt_review(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.student_get_attempt_review(uuid) TO authenticated, service_role;
-- ============================================================================
-- Migration 0005: Administrative Analytics, Breakdowns, and Sanitized CSV Exports
-- Project: QuizPocket — Online Examination & Assessment Platform
-- ============================================================================

-- Spreadsheet Formula-Injection Sanitizer (defends against =, +, -, @, \t, \r)
CREATE OR REPLACE FUNCTION public.sanitize_csv_text(p_value text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_trimmed text;
BEGIN
  IF p_value IS NULL THEN
    RETURN '';
  END IF;

  v_trimmed := ltrim(p_value, ' ');

  IF left(p_value, 1) IN ('=', '+', '-', '@', chr(9), chr(13))
     OR left(v_trimmed, 1) IN ('=', '+', '-', '@', chr(9), chr(13)) THEN
    RETURN '''' || p_value;
  END IF;

  RETURN p_value;
END;
$$;

GRANT EXECUTE ON FUNCTION public.sanitize_csv_text(text) TO authenticated, service_role;

-- 1. Examination-Level Statistics (Admin Only)
CREATE OR REPLACE FUNCTION public.admin_get_exam_statistics(p_exam_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inst uuid;
  v_exam public.exams%ROWTYPE;
  v_assigned_students integer := 0;
  v_started_students integer := 0;
  v_completed_students integer := 0;
  v_not_attempted_students integer := 0;
  v_total_started_attempts integer := 0;
  v_submitted_attempts integer := 0;
  v_auto_submitted_attempts integer := 0;
  v_in_progress_attempts integer := 0;
  v_finalized_results integer := 0;
  v_avg_score numeric(8,2) := 0;
  v_avg_percentage numeric(5,2) := 0;
  v_highest_score numeric(8,2) := 0;
  v_lowest_score numeric(8,2) := 0;
  v_pass_rate numeric(5,2) := 0;
  v_failure_rate numeric(5,2) := 0;
  v_completion_rate numeric(5,2) := 0;
BEGIN
  IF NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY: Active administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  v_inst := public.current_institution_id();

  SELECT * INTO v_exam
  FROM public.exams e
  WHERE e.id = p_exam_id
    AND e.institution_id = v_inst;

  IF v_exam.id IS NULL THEN
    RAISE EXCEPTION 'EXAM_NOT_FOUND: Examination not found in your institution.';
  END IF;

  -- Distinct active assigned students (combining direct and active class memberships)
  WITH eligible_students AS (
    SELECT DISTINCT p.id AS student_id
    FROM public.profiles p
    WHERE p.institution_id = v_inst
      AND p.role = 'student'
      AND p.account_status = 'active'
      AND public.is_student_assigned_to_exam(p_exam_id, p.id)
  )
  SELECT
    COUNT(*),
    COUNT(*) FILTER (
      WHERE NOT EXISTS (
        SELECT 1 FROM public.exam_attempts a
        WHERE a.exam_id = p_exam_id
          AND a.student_id = es.student_id
          AND a.status <> 'voided'
      )
    ),
    COUNT(*) FILTER (
      WHERE EXISTS (
        SELECT 1 FROM public.exam_attempts a
        WHERE a.exam_id = p_exam_id
          AND a.student_id = es.student_id
          AND a.status IN ('submitted', 'auto_submitted')
      )
    )
  INTO v_assigned_students, v_not_attempted_students, v_completed_students
  FROM eligible_students es;

  SELECT
    COUNT(DISTINCT a.student_id) FILTER (WHERE a.status <> 'voided'),
    COUNT(*) FILTER (WHERE a.status <> 'voided'),
    COUNT(*) FILTER (WHERE a.status = 'submitted'),
    COUNT(*) FILTER (WHERE a.status = 'auto_submitted'),
    COUNT(*) FILTER (WHERE a.status = 'in_progress')
  INTO
    v_started_students,
    v_total_started_attempts,
    v_submitted_attempts,
    v_auto_submitted_attempts,
    v_in_progress_attempts
  FROM public.exam_attempts a
  WHERE a.exam_id = p_exam_id;

  SELECT
    COUNT(*),
    COALESCE(ROUND(AVG(r.marks_obtained), 2), 0),
    COALESCE(ROUND(AVG(r.percentage), 2), 0),
    COALESCE(MAX(r.marks_obtained), 0),
    COALESCE(MIN(r.marks_obtained), 0),
    CASE WHEN COUNT(*) > 0
      THEN ROUND((COUNT(*) FILTER (WHERE r.passed = true)::numeric / COUNT(*)::numeric) * 100.0, 2)
      ELSE 0
    END,
    CASE WHEN COUNT(*) > 0
      THEN ROUND((COUNT(*) FILTER (WHERE r.passed = false)::numeric / COUNT(*)::numeric) * 100.0, 2)
      ELSE 0
    END
  INTO
    v_finalized_results,
    v_avg_score,
    v_avg_percentage,
    v_highest_score,
    v_lowest_score,
    v_pass_rate,
    v_failure_rate
  FROM public.results r
  WHERE r.exam_id = p_exam_id;

  IF v_assigned_students > 0 THEN
    v_completion_rate := ROUND((v_completed_students::numeric / v_assigned_students::numeric) * 100.0, 2);
  ELSIF v_total_started_attempts > 0 THEN
    v_completion_rate := ROUND(((v_submitted_attempts + v_auto_submitted_attempts)::numeric / v_total_started_attempts::numeric) * 100.0, 2);
  END IF;

  RETURN jsonb_build_object(
    'exam_id', v_exam.id,
    'exam_title', v_exam.title,
    'total_marks', v_exam.total_marks,
    'passing_percentage', v_exam.passing_percentage,
    'assigned_students_count', v_assigned_students,
    'started_students_count', v_started_students,
    'not_attempted_students_count', v_not_attempted_students,
    'total_attempts_started', v_total_started_attempts,
    'submitted_count', v_submitted_attempts,
    'auto_submitted_count', v_auto_submitted_attempts,
    'in_progress_count', v_in_progress_attempts,
    'finalized_results_count', v_finalized_results,
    'average_score', v_avg_score,
    'average_percentage', v_avg_percentage,
    'highest_score', v_highest_score,
    'lowest_score', v_lowest_score,
    'pass_rate', v_pass_rate,
    'failure_rate', v_failure_rate,
    'completion_rate', v_completion_rate
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_get_exam_statistics(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_exam_statistics(uuid) TO authenticated, service_role;

-- 2. Student-Level Attempt History & Results for an Examination (Admin Only)
CREATE OR REPLACE FUNCTION public.admin_list_exam_attempts(p_exam_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inst uuid;
  v_exam public.exams%ROWTYPE;
  v_rows jsonb;
BEGIN
  IF NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY: Active administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  v_inst := public.current_institution_id();
  SELECT * INTO v_exam FROM public.exams WHERE id = p_exam_id AND institution_id = v_inst;

  IF v_exam.id IS NULL THEN
    RAISE EXCEPTION 'EXAM_NOT_FOUND: Examination not found in your institution.';
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'attempt_id', a.id,
        'student_id', p.id,
        'student_name', p.full_name,
        'student_identifier', p.student_identifier,
        'student_email', p.email,
        'exam_id', v_exam.id,
        'exam_title', v_exam.title,
        'attempt_number', a.attempt_number,
        'status', a.status,
        'started_at', a.started_at,
        'deadline_at', a.deadline_at,
        'submitted_at', a.submitted_at,
        'time_taken_seconds', CASE
          WHEN a.submitted_at IS NOT NULL
          THEN GREATEST(0, EXTRACT(EPOCH FROM (a.submitted_at - a.started_at))::integer)
          ELSE NULL
        END,
        'result_id', r.id,
        'marks_obtained', r.marks_obtained,
        'total_marks', COALESCE(r.total_marks, v_exam.total_marks),
        'percentage', r.percentage,
        'passed', r.passed,
        'marking_version', r.marking_version
      )
      ORDER BY a.started_at DESC, a.attempt_number DESC
    ),
    '[]'::jsonb
  )
  INTO v_rows
  FROM public.exam_attempts a
  JOIN public.profiles p ON p.id = a.student_id
  LEFT JOIN public.results r ON r.attempt_id = a.id
  WHERE a.exam_id = p_exam_id;

  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_exam_attempts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_exam_attempts(uuid) TO authenticated, service_role;

-- 3. Detailed Question-by-Question Result Breakdown for Any Student Attempt (Admin Only)
CREATE OR REPLACE FUNCTION public.admin_get_attempt_detail(p_attempt_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inst uuid;
  v_attempt public.exam_attempts%ROWTYPE;
  v_exam public.exams%ROWTYPE;
  v_student public.profiles%ROWTYPE;
  v_result public.results%ROWTYPE;
  v_questions jsonb;
BEGIN
  IF NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY: Active administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  v_inst := public.current_institution_id();

  SELECT a.* INTO v_attempt
  FROM public.exam_attempts a
  JOIN public.exams e ON e.id = a.exam_id
  WHERE a.id = p_attempt_id
    AND e.institution_id = v_inst;

  IF v_attempt.id IS NULL THEN
    RAISE EXCEPTION 'ATTEMPT_NOT_FOUND: Attempt not found in your institution.';
  END IF;

  SELECT * INTO v_exam FROM public.exams WHERE id = v_attempt.exam_id;
  SELECT * INTO v_student FROM public.profiles WHERE id = v_attempt.student_id;
  SELECT * INTO v_result FROM public.results WHERE attempt_id = v_attempt.id;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'question_id', q.id,
        'display_order', q.display_order,
        'question_text', q.question_text,
        'question_type', q.question_type,
        'marks', q.marks,
        'negative_marks', q.negative_marks,
        'selected_option_id', COALESCE(ri.selected_option_id, sa.selected_option_id),
        'correct_option_id', ri.correct_option_id,
        'outcome', ri.outcome,
        'marks_awarded', ri.marks_awarded,
        'explanation', q.explanation
      )
      ORDER BY q.display_order ASC
    ),
    '[]'::jsonb
  )
  INTO v_questions
  FROM public.exam_questions q
  LEFT JOIN public.student_answers sa
    ON sa.attempt_id = v_attempt.id AND sa.question_id = q.id
  LEFT JOIN public.result_items ri
    ON ri.result_id = v_result.id AND ri.question_id = q.id
  WHERE q.exam_id = v_exam.id;

  RETURN jsonb_build_object(
    'attempt_id', v_attempt.id,
    'attempt_number', v_attempt.attempt_number,
    'status', v_attempt.status,
    'started_at', v_attempt.started_at,
    'deadline_at', v_attempt.deadline_at,
    'submitted_at', v_attempt.submitted_at,
    'student', jsonb_build_object(
      'id', v_student.id,
      'full_name', v_student.full_name,
      'student_identifier', v_student.student_identifier,
      'email', v_student.email
    ),
    'exam', jsonb_build_object(
      'id', v_exam.id,
      'title', v_exam.title,
      'total_marks', v_exam.total_marks
    ),
    'result', CASE WHEN v_result.id IS NOT NULL THEN jsonb_build_object(
      'id', v_result.id,
      'marks_obtained', v_result.marks_obtained,
      'total_marks', v_result.total_marks,
      'percentage', v_result.percentage,
      'passed', v_result.passed,
      'marking_version', v_result.marking_version,
      'finalized_at', v_result.finalized_at
    ) ELSE NULL END,
    'questions', v_questions
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_get_attempt_detail(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_attempt_detail(uuid) TO authenticated, service_role;

-- 4. Question-Level Performance Analytics (Admin Only)
CREATE OR REPLACE FUNCTION public.admin_get_question_analytics(p_exam_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inst uuid;
  v_exam public.exams%ROWTYPE;
  v_rows jsonb;
BEGIN
  IF NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY: Active administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  v_inst := public.current_institution_id();
  SELECT * INTO v_exam FROM public.exams WHERE id = p_exam_id AND institution_id = v_inst;

  IF v_exam.id IS NULL THEN
    RAISE EXCEPTION 'EXAM_NOT_FOUND: Examination not found in your institution.';
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'question_id', q.id,
        'display_order', q.display_order,
        'question_text', q.question_text,
        'question_type', q.question_type,
        'marks', q.marks,
        'correct_count', stats.correct_count,
        'incorrect_count', stats.incorrect_count,
        'unanswered_count', stats.unanswered_count,
        'total_evaluated', stats.total_evaluated,
        'correct_percentage', stats.correct_percentage,
        'commonly_missed', (stats.total_evaluated > 0 AND stats.correct_percentage < 50.0)
      )
      ORDER BY q.display_order ASC
    ),
    '[]'::jsonb
  )
  INTO v_rows
  FROM public.exam_questions q
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*) FILTER (WHERE ri.outcome = 'correct') AS correct_count,
      COUNT(*) FILTER (WHERE ri.outcome = 'incorrect') AS incorrect_count,
      COUNT(*) FILTER (WHERE ri.outcome = 'unanswered') AS unanswered_count,
      COUNT(ri.id) AS total_evaluated,
      CASE WHEN COUNT(ri.id) > 0
        THEN ROUND((COUNT(*) FILTER (WHERE ri.outcome = 'correct')::numeric / COUNT(ri.id)::numeric) * 100.0, 2)
        ELSE 0.00
      END AS correct_percentage
    FROM public.result_items ri
    WHERE ri.question_id = q.id
  ) stats ON true
  WHERE q.exam_id = p_exam_id;

  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_get_question_analytics(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_question_analytics(uuid) TO authenticated, service_role;

-- 5. Class Performance Summary for an Examination (Admin Only)
CREATE OR REPLACE FUNCTION public.admin_get_class_performance_summary(p_exam_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inst uuid;
  v_exam public.exams%ROWTYPE;
  v_rows jsonb;
BEGIN
  IF NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY: Active administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  v_inst := public.current_institution_id();
  SELECT * INTO v_exam FROM public.exams WHERE id = p_exam_id AND institution_id = v_inst;

  IF v_exam.id IS NULL THEN
    RAISE EXCEPTION 'EXAM_NOT_FOUND: Examination not found in your institution.';
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'class_id', c.id,
        'class_name', c.name,
        'enrolled_students', cstats.enrolled_students,
        'completed_attempts', cstats.completed_attempts,
        'average_percentage', cstats.average_percentage,
        'pass_rate', cstats.pass_rate
      )
      ORDER BY c.name ASC
    ),
    '[]'::jsonb
  )
  INTO v_rows
  FROM public.classes c
  LEFT JOIN LATERAL (
    SELECT
      COUNT(DISTINCT cm.student_id) FILTER (WHERE cm.membership_status = 'active') AS enrolled_students,
      COUNT(r.id) AS completed_attempts,
      COALESCE(ROUND(AVG(r.percentage), 2), 0.00) AS average_percentage,
      CASE WHEN COUNT(r.id) > 0
        THEN ROUND((COUNT(*) FILTER (WHERE r.passed = true)::numeric / COUNT(r.id)::numeric) * 100.0, 2)
        ELSE 0.00
      END AS pass_rate
    FROM public.class_memberships cm
    LEFT JOIN public.results r
      ON r.student_id = cm.student_id
     AND r.exam_id = p_exam_id
    WHERE cm.class_id = c.id
      AND cm.membership_status = 'active'
  ) cstats ON true
  WHERE c.institution_id = v_inst
    AND EXISTS (
      SELECT 1 FROM public.exam_assignments ea
      WHERE ea.exam_id = p_exam_id
        AND ea.class_id = c.id
        AND ea.assignment_status = 'active'
    );

  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_get_class_performance_summary(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_class_performance_summary(uuid) TO authenticated, service_role;

-- 6. Authorized, Formula-Sanitized CSV Export Rows (Admin Only, Audited)
CREATE OR REPLACE FUNCTION public.admin_export_exam_results_rows(p_exam_id uuid)
RETURNS TABLE (
  student_name text,
  student_identifier text,
  student_email text,
  exam_title text,
  attempt_number integer,
  attempt_status text,
  started_at timestamptz,
  submitted_at timestamptz,
  time_taken_seconds integer,
  marks_obtained numeric,
  total_marks numeric,
  percentage numeric,
  pass_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inst uuid;
  v_exam public.exams%ROWTYPE;
BEGIN
  IF NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY: Active administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  v_inst := public.current_institution_id();
  SELECT * INTO v_exam FROM public.exams WHERE id = p_exam_id AND institution_id = v_inst;

  IF v_exam.id IS NULL THEN
    RAISE EXCEPTION 'EXAM_NOT_FOUND: Examination not found in your institution.';
  END IF;

  PERFORM public.internal_write_audit_log(
    v_inst, auth.uid(), 'admin', 'results_csv_exported', 'exam', v_exam.id,
    jsonb_build_object('exam_title', v_exam.title)
  );

  RETURN QUERY
  SELECT
    public.sanitize_csv_text(p.full_name) AS student_name,
    public.sanitize_csv_text(COALESCE(p.student_identifier, '')) AS student_identifier,
    public.sanitize_csv_text(p.email) AS student_email,
    public.sanitize_csv_text(v_exam.title) AS exam_title,
    a.attempt_number,
    a.status::text AS attempt_status,
    a.started_at,
    a.submitted_at,
    CASE
      WHEN a.submitted_at IS NOT NULL
      THEN GREATEST(0, EXTRACT(EPOCH FROM (a.submitted_at - a.started_at))::integer)
      ELSE NULL
    END AS time_taken_seconds,
    r.marks_obtained,
    COALESCE(r.total_marks, v_exam.total_marks) AS total_marks,
    r.percentage,
    CASE
      WHEN r.passed IS TRUE THEN 'PASS'
      WHEN r.passed IS FALSE THEN 'FAIL'
      ELSE 'PENDING'
    END AS pass_status
  FROM public.exam_attempts a
  JOIN public.profiles p ON p.id = a.student_id
  LEFT JOIN public.results r ON r.attempt_id = a.id
  WHERE a.exam_id = p_exam_id
  ORDER BY p.full_name ASC, a.attempt_number ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_export_exam_results_rows(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_export_exam_results_rows(uuid) TO authenticated, service_role;
-- ============================================================================
-- Migration 0006: Scheduled Automatic Submission (pg_cron when supported)
-- Project: QuizPocket — Online Examination & Assessment Platform
-- ============================================================================

-- On hosted Supabase projects with pg_cron enabled (Dashboard -> Integrations -> Cron),
-- register an idempotent every-minute sweep for expired in_progress attempts.
-- In environments without pg_cron (e.g., lightweight local PostgreSQL), this block
-- degrades gracefully and relies on the Edge Function / server scheduler + lazy guards.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;

    IF EXISTS (
      SELECT 1 FROM pg_namespace WHERE nspname = 'cron'
    ) THEN
      PERFORM cron.schedule(
        'quizpocket-finalize-expired-attempts',
        '* * * * *',
        $job$SELECT public.finalize_expired_attempts(200);$job$
      );
    END IF;
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    -- Non-fatal when pg_cron privileges are unavailable in local test runners.
    NULL;
END
$$;
-- ============================================================================
-- Migration 0007: Fill-in-the-Blank & Short-Answer Support, Rubric Grading,
--                 Admin Item-Level Grading, and Admin Query Helpers
-- Project: QuizPocket — Online Examination & Assessment Platform
-- ============================================================================

ALTER TYPE public.question_type ADD VALUE IF NOT EXISTS 'fill_in_blank';
ALTER TYPE public.question_type ADD VALUE IF NOT EXISTS 'short_answer';

-- Protected answer-key & rubric metadata columns on exam_questions
-- (Protected by existing admin-only RLS on public.exam_questions)
ALTER TABLE public.exam_questions
  ADD COLUMN IF NOT EXISTS accepted_answers jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS rubric_keywords jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Allow text-based questions in result_items (where correct_option_id is NULL)
ALTER TABLE public.result_items
  ALTER COLUMN correct_option_id DROP NOT NULL;

ALTER TABLE public.result_items
  ADD COLUMN IF NOT EXISTS submitted_text text NULL,
  ADD COLUMN IF NOT EXISTS expected_answer text NULL;

ALTER TABLE public.result_items
  DROP CONSTRAINT IF EXISTS result_items_outcome_check;

DO $$
DECLARE
  v_con record;
BEGIN
  FOR v_con IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.result_items'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%outcome%'
  LOOP
    EXECUTE format('ALTER TABLE public.result_items DROP CONSTRAINT IF EXISTS %I', v_con.conname);
  END LOOP;
END
$$;

ALTER TABLE public.result_items
  ADD CONSTRAINT result_items_outcome_valid_check
  CHECK (outcome IN ('correct', 'partial', 'incorrect', 'unanswered'));

-- Guard accepted_answers & rubric_keywords on locked exams too
CREATE OR REPLACE FUNCTION public.guard_and_sync_exam_questions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_exam_id uuid;
  v_has_attempts boolean;
BEGIN
  v_exam_id := COALESCE(NEW.exam_id, OLD.exam_id);

  SELECT EXISTS (
    SELECT 1 FROM public.exam_attempts a WHERE a.exam_id = v_exam_id
  ) INTO v_has_attempts;

  IF v_has_attempts THEN
    IF TG_OP IN ('INSERT', 'DELETE') THEN
      RAISE EXCEPTION 'EXAM_LOCKED_BY_ATTEMPTS: Cannot add or remove questions once student attempts exist.';
    END IF;
    IF TG_OP = 'UPDATE' AND (
      NEW.exam_id IS DISTINCT FROM OLD.exam_id
      OR NEW.question_text IS DISTINCT FROM OLD.question_text
      OR NEW.question_type IS DISTINCT FROM OLD.question_type
      OR NEW.marks IS DISTINCT FROM OLD.marks
      OR NEW.negative_marks IS DISTINCT FROM OLD.negative_marks
      OR NEW.display_order IS DISTINCT FROM OLD.display_order
      OR NEW.accepted_answers IS DISTINCT FROM OLD.accepted_answers
      OR NEW.rubric_keywords IS DISTINCT FROM OLD.rubric_keywords
    ) THEN
      RAISE EXCEPTION 'EXAM_LOCKED_BY_ATTEMPTS: Question scoring and answer keys are locked because attempts already exist.';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- Normalize fill-in-the-blank tokens for case- and punctuation-insensitive matching
CREATE OR REPLACE FUNCTION public.normalize_answer_token(p_val text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT btrim(regexp_replace(lower(COALESCE(p_val, '')), '[^a-z0-9]+', ' ', 'g'));
$$;

-- Compact no-space form so e.g. "ICD-10", "ICD 10", and "ICD10" match cleanly
CREATE OR REPLACE FUNCTION public.normalize_answer_compact(p_val text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT regexp_replace(lower(COALESCE(p_val, '')), '[^a-z0-9]+', '', 'g');
$$;

-- Update answer write validation trigger to validate both option-based and text-based questions
CREATE OR REPLACE FUNCTION public.validate_student_answer_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_attempt record;
  v_question record;
  v_option_question_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT a.status, a.deadline_at INTO v_attempt
    FROM public.exam_attempts a WHERE a.id = OLD.attempt_id;
    IF v_attempt.status <> 'in_progress' OR public.utc_now() > v_attempt.deadline_at THEN
      RAISE EXCEPTION 'ATTEMPT_FINALIZED: Answers cannot be deleted after attempt completion or expiry.';
    END IF;
    RETURN OLD;
  END IF;

  SELECT a.id, a.exam_id, a.student_id, a.status, a.deadline_at
  INTO v_attempt
  FROM public.exam_attempts a
  WHERE a.id = NEW.attempt_id;

  IF v_attempt.id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ATTEMPT: Attempt does not exist.';
  END IF;

  IF v_attempt.status <> 'in_progress' THEN
    RAISE EXCEPTION 'ATTEMPT_NOT_ACTIVE: Answers cannot be modified after submission.';
  END IF;

  IF public.utc_now() > v_attempt.deadline_at THEN
    RAISE EXCEPTION 'ATTEMPT_DEADLINE_EXPIRED: Server deadline has elapsed.';
  END IF;

  SELECT q.id, q.exam_id, q.question_type
  INTO v_question
  FROM public.exam_questions q
  WHERE q.id = NEW.question_id;

  IF v_question.id IS NULL OR v_question.exam_id <> v_attempt.exam_id THEN
    RAISE EXCEPTION 'QUESTION_EXAM_MISMATCH: Question does not belong to this examination.';
  END IF;

  IF v_question.question_type IN ('multiple_choice', 'true_false') THEN
    IF NEW.selected_option_id IS NOT NULL THEN
      SELECT o.question_id INTO v_option_question_id
      FROM public.question_options o
      WHERE o.id = NEW.selected_option_id;

      IF v_option_question_id IS NULL OR v_option_question_id <> NEW.question_id THEN
        RAISE EXCEPTION 'OPTION_QUESTION_MISMATCH: Selected option does not belong to the specified question.';
      END IF;
    END IF;
  ELSE
    -- Text-based question (fill_in_blank, short_answer)
    IF NEW.selected_option_id IS NOT NULL THEN
      RAISE EXCEPTION 'OPTION_QUESTION_MISMATCH: Text-response questions do not accept option IDs.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Upgrade admin_upsert_question_with_options to support all 4 question types cleanly
DROP FUNCTION IF EXISTS public.admin_upsert_question_with_options(
  uuid, text, public.question_type, numeric, jsonb, uuid, numeric, text, integer, boolean
);

CREATE OR REPLACE FUNCTION public.admin_upsert_question_with_options(
  p_exam_id uuid,
  p_question_text text,
  p_question_type public.question_type,
  p_marks numeric,
  p_options jsonb DEFAULT '[]'::jsonb,
  p_question_id uuid DEFAULT NULL,
  p_negative_marks numeric DEFAULT 0,
  p_explanation text DEFAULT NULL,
  p_display_order integer DEFAULT NULL,
  p_is_required boolean DEFAULT true,
  p_accepted_answers jsonb DEFAULT '[]'::jsonb,
  p_rubric_keywords jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inst uuid;
  v_exam public.exams%ROWTYPE;
  v_opt_count integer := 0;
  v_correct_count integer := 0;
  v_distinct_texts integer := 0;
  v_order integer;
  v_q_id uuid;
  v_idx integer := 0;
  v_opt jsonb;
  v_opt_text text;
  v_opt_correct boolean;
  v_clean_accepted jsonb := COALESCE(p_accepted_answers, '[]'::jsonb);
  v_clean_rubric jsonb := COALESCE(p_rubric_keywords, '[]'::jsonb);
BEGIN
  IF NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY: Active administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  v_inst := public.current_institution_id();

  SELECT * INTO v_exam
  FROM public.exams e
  WHERE e.id = p_exam_id
    AND e.institution_id = v_inst
  FOR UPDATE;

  IF v_exam.id IS NULL THEN
    RAISE EXCEPTION 'EXAM_NOT_FOUND: Examination not found in your institution.';
  END IF;

  IF EXISTS (SELECT 1 FROM public.exam_attempts a WHERE a.exam_id = p_exam_id) THEN
    RAISE EXCEPTION 'EXAM_LOCKED_BY_ATTEMPTS: Questions and answer keys cannot be modified once attempts exist.';
  END IF;

  IF p_question_type IN ('multiple_choice', 'true_false') THEN
    IF p_options IS NULL OR jsonb_typeof(p_options) <> 'array' THEN
      RAISE EXCEPTION 'INVALID_OPTIONS_PAYLOAD: Options must be provided as a JSON array.';
    END IF;

    v_opt_count := jsonb_array_length(p_options);

    IF p_question_type = 'true_false' AND v_opt_count <> 2 THEN
      RAISE EXCEPTION 'INVALID_OPTION_COUNT: True/false questions must have exactly 2 options.';
    END IF;

    IF p_question_type = 'multiple_choice' AND (v_opt_count < 2 OR v_opt_count > 8) THEN
      RAISE EXCEPTION 'INVALID_OPTION_COUNT: Multiple-choice questions must have between 2 and 8 options.';
    END IF;

    SELECT
      COUNT(*) FILTER (WHERE COALESCE((elem ->> 'is_correct')::boolean, false) = true),
      COUNT(DISTINCT lower(btrim(COALESCE(elem ->> 'option_text', ''))))
    INTO v_correct_count, v_distinct_texts
    FROM jsonb_array_elements(p_options) AS elem;

    IF v_correct_count <> 1 THEN
      RAISE EXCEPTION 'INVALID_CORRECT_OPTION_COUNT: Exactly 1 option must be marked as correct (received %).', v_correct_count;
    END IF;

    IF v_distinct_texts <> v_opt_count THEN
      RAISE EXCEPTION 'DUPLICATE_OPTION_TEXT: Answer options within a question must have distinct text.';
    END IF;

    v_clean_accepted := '[]'::jsonb;
    v_clean_rubric := '[]'::jsonb;
  ELSIF p_question_type = 'fill_in_blank' THEN
    IF jsonb_typeof(v_clean_accepted) <> 'array' OR jsonb_array_length(v_clean_accepted) < 1 THEN
      RAISE EXCEPTION 'INVALID_ANSWER_KEY: Fill-in-the-blank questions require at least one accepted answer.';
    END IF;
  ELSIF p_question_type = 'short_answer' THEN
    IF jsonb_typeof(v_clean_rubric) NOT IN ('array', 'object') THEN
      RAISE EXCEPTION 'INVALID_RUBRIC: Short-answer rubric_keywords must be a JSON array or object.';
    END IF;
  END IF;

  IF p_display_order IS NULL THEN
    SELECT COALESCE(MAX(q.display_order), 0) + 1 INTO v_order
    FROM public.exam_questions q WHERE q.exam_id = p_exam_id;
  ELSE
    v_order := p_display_order;
  END IF;

  IF p_question_id IS NULL THEN
    INSERT INTO public.exam_questions (
      exam_id,
      question_text,
      question_type,
      marks,
      negative_marks,
      explanation,
      display_order,
      is_required,
      accepted_answers,
      rubric_keywords
    )
    VALUES (
      p_exam_id,
      btrim(p_question_text),
      p_question_type,
      p_marks,
      COALESCE(p_negative_marks, 0),
      NULLIF(btrim(p_explanation), ''),
      v_order,
      COALESCE(p_is_required, true),
      v_clean_accepted,
      v_clean_rubric
    )
    RETURNING id INTO v_q_id;
  ELSE
    UPDATE public.exam_questions
    SET question_text = btrim(p_question_text),
        question_type = p_question_type,
        marks = p_marks,
        negative_marks = COALESCE(p_negative_marks, 0),
        explanation = NULLIF(btrim(p_explanation), ''),
        display_order = v_order,
        is_required = COALESCE(p_is_required, true),
        accepted_answers = v_clean_accepted,
        rubric_keywords = v_clean_rubric
    WHERE id = p_question_id
      AND exam_id = p_exam_id
    RETURNING id INTO v_q_id;

    IF v_q_id IS NULL THEN
      RAISE EXCEPTION 'QUESTION_NOT_FOUND: Target question not found on this examination.';
    END IF;

    DELETE FROM public.question_options WHERE question_id = v_q_id;
  END IF;

  IF p_question_type IN ('multiple_choice', 'true_false') THEN
    FOR v_opt IN SELECT * FROM jsonb_array_elements(p_options)
    LOOP
      v_idx := v_idx + 1;
      v_opt_text := btrim(COALESCE(v_opt ->> 'option_text', ''));
      v_opt_correct := COALESCE((v_opt ->> 'is_correct')::boolean, false);

      IF char_length(v_opt_text) = 0 THEN
        RAISE EXCEPTION 'EMPTY_OPTION_TEXT: Option text cannot be empty.';
      END IF;

      INSERT INTO public.question_options (
        question_id,
        option_text,
        display_order,
        is_correct
      )
      VALUES (
        v_q_id,
        v_opt_text,
        COALESCE((v_opt ->> 'display_order')::integer, v_idx),
        v_opt_correct
      );
    END LOOP;
  END IF;

  PERFORM public.internal_write_audit_log(
    v_inst, auth.uid(), 'admin', 'question_upserted', 'exam_question', v_q_id,
    jsonb_build_object('exam_id', p_exam_id, 'question_type', p_question_type, 'marks', p_marks)
  );

  RETURN (
    SELECT jsonb_build_object(
      'question_id', q.id,
      'exam_id', q.exam_id,
      'question_type', q.question_type,
      'marks', q.marks,
      'exam_total_marks', e.total_marks,
      'accepted_answers', q.accepted_answers,
      'options', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', o.id,
            'option_text', o.option_text,
            'display_order', o.display_order,
            'is_correct', o.is_correct
          )
          ORDER BY o.display_order ASC
        )
        FROM public.question_options o
        WHERE o.question_id = q.id
      ), '[]'::jsonb)
    )
    FROM public.exam_questions q
    JOIN public.exams e ON e.id = q.exam_id
    WHERE q.id = v_q_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_upsert_question_with_options(
  uuid, text, public.question_type, numeric, jsonb, uuid, numeric, text, integer, boolean, jsonb, jsonb
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_upsert_question_with_options(
  uuid, text, public.question_type, numeric, jsonb, uuid, numeric, text, integer, boolean, jsonb, jsonb
) TO authenticated, service_role;

-- Update admin_publish_exam validation to support fill_in_blank and short_answer questions
CREATE OR REPLACE FUNCTION public.admin_publish_exam(p_exam_id uuid)
RETURNS public.exams
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inst uuid;
  v_exam public.exams%ROWTYPE;
  v_q_count integer;
  v_invalid_q_count integer;
BEGIN
  IF NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY: Active administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  v_inst := public.current_institution_id();

  SELECT * INTO v_exam
  FROM public.exams e
  WHERE e.id = p_exam_id
    AND e.institution_id = v_inst
  FOR UPDATE;

  IF v_exam.id IS NULL THEN
    RAISE EXCEPTION 'EXAM_NOT_FOUND: Examination not found in your institution.';
  END IF;

  IF v_exam.status = 'archived' THEN
    RAISE EXCEPTION 'INVALID_EXAM_STATE: Archived examinations cannot be published directly.';
  END IF;

  SELECT COUNT(*) INTO v_q_count
  FROM public.exam_questions q
  WHERE q.exam_id = p_exam_id;

  IF v_q_count = 0 OR v_exam.total_marks <= 0 THEN
    RAISE EXCEPTION 'EXAM_INCOMPLETE: Examination must have at least one question and positive total marks before publishing.';
  END IF;

  SELECT COUNT(*) INTO v_invalid_q_count
  FROM public.exam_questions q
  WHERE q.exam_id = p_exam_id
    AND (
      (
        q.question_type IN ('multiple_choice', 'true_false')
        AND (
          (SELECT COUNT(*) FROM public.question_options o WHERE o.question_id = q.id) < 2
          OR (SELECT COUNT(*) FROM public.question_options o WHERE o.question_id = q.id AND o.is_correct = true) <> 1
        )
      )
      OR (
        q.question_type = 'fill_in_blank'
        AND (jsonb_typeof(q.accepted_answers) <> 'array' OR jsonb_array_length(q.accepted_answers) < 1)
      )
    );

  IF v_invalid_q_count > 0 THEN
    RAISE EXCEPTION 'EXAM_INVALID_ANSWER_KEY: Every question must have valid answer keys configured before publishing.';
  END IF;

  UPDATE public.exams
  SET status = 'published',
      published_at = COALESCE(published_at, public.utc_now())
  WHERE id = p_exam_id
  RETURNING * INTO v_exam;

  PERFORM public.internal_write_audit_log(
    v_inst, auth.uid(), 'admin', 'exam_published', 'exam', v_exam.id,
    jsonb_build_object('total_marks', v_exam.total_marks, 'question_count', v_q_count)
  );

  RETURN v_exam;
END;
$$;

-- Upgrade internal_finalize_attempt to grade MCQ, T/F, Fill-in-Blank, and Concept-Rubric Short Answer
CREATE OR REPLACE FUNCTION public.internal_finalize_attempt(
  p_attempt_id uuid,
  p_target_status public.attempt_status,
  p_effective_submitted_at timestamptz,
  p_actor_id uuid DEFAULT NULL,
  p_actor_role text DEFAULT 'system'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_attempt public.exam_attempts%ROWTYPE;
  v_exam public.exams%ROWTYPE;
  v_existing_result public.results%ROWTYPE;
  v_result_id uuid;
  v_q record;
  v_correct_option_id uuid;
  v_selected_option_id uuid;
  v_submitted_text text;
  v_expected_summary text;
  v_outcome text;
  v_awarded numeric(8,2);
  v_raw_marks numeric(8,2) := 0;
  v_final_marks numeric(8,2) := 0;
  v_total_marks numeric(8,2) := 0;
  v_percentage numeric(5,2) := 0;
  v_passed boolean := false;
  v_correct_count integer := 0;
  v_incorrect_count integer := 0;
  v_unanswered_count integer := 0;
  v_now timestamptz := public.utc_now();
  v_submitted_ts timestamptz;
  v_is_blank_match boolean;
  v_groups jsonb;
  v_required_matches integer;
  v_matched_groups integer;
  v_grp jsonb;
  v_syn text;
  v_group_hit boolean;
  v_lower_ans text;
BEGIN
  IF p_target_status NOT IN ('submitted', 'auto_submitted') THEN
    RAISE EXCEPTION 'INVALID_FINALIZE_STATUS: Target status must be submitted or auto_submitted.';
  END IF;

  SELECT * INTO v_attempt
  FROM public.exam_attempts a
  WHERE a.id = p_attempt_id
  FOR UPDATE;

  IF v_attempt.id IS NULL THEN
    RAISE EXCEPTION 'ATTEMPT_NOT_FOUND: Examination attempt does not exist.';
  END IF;

  SELECT * INTO v_exam
  FROM public.exams e
  WHERE e.id = v_attempt.exam_id;

  IF v_attempt.status IN ('submitted', 'auto_submitted') THEN
    SELECT * INTO v_existing_result
    FROM public.results r
    WHERE r.attempt_id = v_attempt.id;

    RETURN jsonb_build_object(
      'already_finalized', true,
      'attempt_id', v_attempt.id,
      'status', v_attempt.status,
      'submitted_at', v_attempt.submitted_at,
      'result_id', v_existing_result.id
    );
  END IF;

  IF v_attempt.status = 'voided' THEN
    RAISE EXCEPTION 'ATTEMPT_VOIDED: Voided attempts cannot be finalized.';
  END IF;

  SELECT COALESCE(SUM(q.marks), 0) INTO v_total_marks
  FROM public.exam_questions q
  WHERE q.exam_id = v_exam.id;

  IF v_total_marks <= 0 THEN
    RAISE EXCEPTION 'INVALID_EXAM_TOTAL_MARKS: Examination has zero configured marks.';
  END IF;

  v_submitted_ts := GREATEST(
    v_attempt.started_at + interval '1 millisecond',
    COALESCE(p_effective_submitted_at, v_now)
  );

  UPDATE public.exam_attempts
  SET status = p_target_status,
      submitted_at = v_submitted_ts,
      last_activity_at = v_now
  WHERE id = v_attempt.id;

  INSERT INTO public.results (
    attempt_id,
    student_id,
    exam_id,
    marks_obtained,
    total_marks,
    percentage,
    passed,
    correct_count,
    incorrect_count,
    unanswered_count,
    marking_version,
    finalized_at
  )
  VALUES (
    v_attempt.id,
    v_attempt.student_id,
    v_exam.id,
    0,
    v_total_marks,
    0,
    false,
    0,
    0,
    0,
    1,
    v_now
  )
  RETURNING id INTO v_result_id;

  FOR v_q IN
    SELECT q.id, q.question_type, q.marks, q.negative_marks, q.accepted_answers, q.rubric_keywords, q.explanation
    FROM public.exam_questions q
    WHERE q.exam_id = v_exam.id
    ORDER BY q.display_order ASC
  LOOP
    v_correct_option_id := NULL;
    v_selected_option_id := NULL;
    v_submitted_text := NULL;
    v_expected_summary := NULL;

    SELECT sa.selected_option_id, sa.answer_value
    INTO v_selected_option_id, v_submitted_text
    FROM public.student_answers sa
    WHERE sa.attempt_id = v_attempt.id
      AND sa.question_id = v_q.id;

    IF v_q.question_type IN ('multiple_choice', 'true_false') THEN
      SELECT o.id, o.option_text INTO v_correct_option_id, v_expected_summary
      FROM public.question_options o
      WHERE o.question_id = v_q.id
        AND o.is_correct = true
      LIMIT 1;

      IF v_correct_option_id IS NULL THEN
        RAISE EXCEPTION 'MISSING_ANSWER_KEY: Question % has no configured correct option.', v_q.id;
      END IF;

      IF v_selected_option_id IS NULL THEN
        v_outcome := 'unanswered';
        v_awarded := 0;
        v_unanswered_count := v_unanswered_count + 1;
      ELSIF v_selected_option_id = v_correct_option_id THEN
        v_outcome := 'correct';
        v_awarded := v_q.marks;
        v_correct_count := v_correct_count + 1;
      ELSE
        v_outcome := 'incorrect';
        v_awarded := -1 * COALESCE(v_q.negative_marks, 0);
        v_incorrect_count := v_incorrect_count + 1;
      END IF;

    ELSIF v_q.question_type = 'fill_in_blank' THEN
      SELECT string_agg(elem #>> '{}', ' / ')
      INTO v_expected_summary
      FROM jsonb_array_elements(v_q.accepted_answers) AS elem;

      IF v_submitted_text IS NULL OR btrim(v_submitted_text) = '' THEN
        v_outcome := 'unanswered';
        v_awarded := 0;
        v_unanswered_count := v_unanswered_count + 1;
      ELSE
        SELECT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(v_q.accepted_answers) AS ans
          WHERE public.normalize_answer_token(ans) = public.normalize_answer_token(v_submitted_text)
             OR public.normalize_answer_compact(ans) = public.normalize_answer_compact(v_submitted_text)
        ) INTO v_is_blank_match;

        IF v_is_blank_match THEN
          v_outcome := 'correct';
          v_awarded := v_q.marks;
          v_correct_count := v_correct_count + 1;
        ELSE
          v_outcome := 'incorrect';
          v_awarded := -1 * COALESCE(v_q.negative_marks, 0);
          v_incorrect_count := v_incorrect_count + 1;
        END IF;
      END IF;

    ELSIF v_q.question_type = 'short_answer' THEN
      v_expected_summary := v_q.explanation;

      IF v_submitted_text IS NULL OR btrim(v_submitted_text) = '' THEN
        v_outcome := 'unanswered';
        v_awarded := 0;
        v_unanswered_count := v_unanswered_count + 1;
      ELSE
        v_lower_ans := lower(v_submitted_text);
        IF jsonb_typeof(v_q.rubric_keywords) = 'object' THEN
          v_groups := COALESCE(v_q.rubric_keywords -> 'groups', '[]'::jsonb);
          v_required_matches := COALESCE((v_q.rubric_keywords ->> 'required_matches')::integer, jsonb_array_length(v_groups));
        ELSIF jsonb_typeof(v_q.rubric_keywords) = 'array' THEN
          v_groups := v_q.rubric_keywords;
          v_required_matches := jsonb_array_length(v_groups);
        ELSE
          v_groups := '[]'::jsonb;
          v_required_matches := 0;
        END IF;

        IF v_required_matches <= 0 OR jsonb_array_length(v_groups) = 0 THEN
          -- Manual-only rubric fallback: 0 initial auto-marks until teacher grades item
          v_outcome := 'partial';
          v_awarded := 0;
        ELSE
          v_matched_groups := 0;
          FOR v_grp IN SELECT * FROM jsonb_array_elements(v_groups)
          LOOP
            v_group_hit := false;
            IF jsonb_typeof(v_grp) = 'array' THEN
              FOR v_syn IN SELECT * FROM jsonb_array_elements_text(v_grp)
              LOOP
                IF char_length(btrim(v_syn)) > 0 AND position(lower(btrim(v_syn)) IN v_lower_ans) > 0 THEN
                  v_group_hit := true;
                  EXIT;
                END IF;
              END LOOP;
            ELSIF jsonb_typeof(v_grp) = 'string' THEN
              v_syn := v_grp #>> '{}';
              IF char_length(btrim(v_syn)) > 0 AND position(lower(btrim(v_syn)) IN v_lower_ans) > 0 THEN
                v_group_hit := true;
              END IF;
            END IF;

            IF v_group_hit THEN
              v_matched_groups := v_matched_groups + 1;
            END IF;
          END LOOP;

          v_matched_groups := LEAST(v_required_matches, v_matched_groups);
          v_awarded := ROUND((v_matched_groups::numeric / v_required_matches::numeric) * v_q.marks, 2);

          IF v_matched_groups >= v_required_matches THEN
            v_outcome := 'correct';
            v_awarded := v_q.marks;
            v_correct_count := v_correct_count + 1;
          ELSIF v_matched_groups > 0 THEN
            v_outcome := 'partial';
            -- Partial credit counts toward neither full-miss nor full-correct integer counters
          ELSE
            v_outcome := 'incorrect';
            v_awarded := 0;
            v_incorrect_count := v_incorrect_count + 1;
          END IF;
        END IF;
      END IF;
    END IF;

    v_raw_marks := v_raw_marks + v_awarded;

    INSERT INTO public.result_items (
      result_id,
      attempt_id,
      exam_id,
      question_id,
      selected_option_id,
      correct_option_id,
      submitted_text,
      expected_answer,
      outcome,
      marks_awarded,
      max_marks
    )
    VALUES (
      v_result_id,
      v_attempt.id,
      v_exam.id,
      v_q.id,
      v_selected_option_id,
      v_correct_option_id,
      v_submitted_text,
      v_expected_summary,
      v_outcome,
      v_awarded,
      v_q.marks
    );
  END LOOP;

  v_final_marks := LEAST(v_total_marks, GREATEST(0, v_raw_marks));
  v_percentage := ROUND((v_final_marks / v_total_marks) * 100.0, 2);
  v_passed := (v_percentage >= v_exam.passing_percentage);

  UPDATE public.results
  SET marks_obtained = v_final_marks,
      total_marks = v_total_marks,
      percentage = v_percentage,
      passed = v_passed,
      correct_count = v_correct_count,
      incorrect_count = v_incorrect_count,
      unanswered_count = v_unanswered_count
  WHERE id = v_result_id;

  PERFORM public.internal_write_audit_log(
    v_exam.institution_id,
    p_actor_id,
    p_actor_role,
    CASE WHEN p_target_status = 'auto_submitted' THEN 'attempt_auto_submitted' ELSE 'attempt_submitted' END,
    'exam_attempt',
    v_attempt.id,
    jsonb_build_object(
      'exam_id', v_exam.id,
      'student_id', v_attempt.student_id,
      'attempt_number', v_attempt.attempt_number,
      'result_id', v_result_id
    )
  );

  PERFORM public.internal_write_audit_log(
    v_exam.institution_id,
    p_actor_id,
    p_actor_role,
    'result_finalized',
    'result',
    v_result_id,
    jsonb_build_object(
      'attempt_id', v_attempt.id,
      'exam_id', v_exam.id,
      'marks_obtained', v_final_marks,
      'total_marks', v_total_marks,
      'percentage', v_percentage,
      'passed', v_passed
    )
  );

  RETURN jsonb_build_object(
    'already_finalized', false,
    'attempt_id', v_attempt.id,
    'status', p_target_status,
    'submitted_at', v_submitted_ts,
    'result_id', v_result_id
  );
END;
$$;

-- Upgrade student_get_attempt_questions to return saved_answer_value (still ZERO answer-key leakage!)
CREATE OR REPLACE FUNCTION public.student_get_attempt_questions(p_attempt_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_attempt public.exam_attempts%ROWTYPE;
  v_exam public.exams%ROWTYPE;
  v_now timestamptz := public.utc_now();
  v_questions jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_student() THEN
    RAISE EXCEPTION 'FORBIDDEN_STUDENT_ONLY: Active student account required.'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_attempt
  FROM public.exam_attempts a
  WHERE a.id = p_attempt_id
  FOR UPDATE;

  IF v_attempt.id IS NULL OR v_attempt.student_id <> v_uid THEN
    RAISE EXCEPTION 'FORBIDDEN_ATTEMPT_ACCESS: Attempt not found or access denied.'
      USING ERRCODE = '42501';
  END IF;

  IF v_attempt.status <> 'in_progress' THEN
    RAISE EXCEPTION 'ATTEMPT_NOT_ACTIVE: Attempt is no longer active (%).', v_attempt.status;
  END IF;

  IF v_now > v_attempt.deadline_at THEN
    PERFORM public.internal_finalize_attempt(
      v_attempt.id, 'auto_submitted', v_attempt.deadline_at, NULL, 'system'
    );
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'ATTEMPT_DEADLINE_EXPIRED',
      'attempt_status', 'auto_submitted',
      'deadline_at', v_attempt.deadline_at,
      'server_now', v_now
    );
  END IF;

  SELECT * INTO v_exam FROM public.exams WHERE id = v_attempt.exam_id;

  -- Strictly project ONLY student-permitted fields:
  -- NEVER returns is_correct, accepted_answers, rubric_keywords, or explanation!
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', q.id,
        'question_text', q.question_text,
        'question_type', q.question_type,
        'marks', q.marks,
        'negative_marks', q.negative_marks,
        'display_order', q.display_order,
        'is_required', q.is_required,
        'saved_selected_option_id', sa.selected_option_id,
        'saved_answer_value', sa.answer_value,
        'saved_revision', sa.revision,
        'options', COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', o.id,
              'option_text', o.option_text,
              'display_order', o.display_order
            )
            ORDER BY
              CASE WHEN v_exam.shuffle_options THEN md5(v_attempt.id::text || ':' || o.id::text) ELSE NULL END ASC,
              o.display_order ASC
          )
          FROM public.question_options o
          WHERE o.question_id = q.id
        ), '[]'::jsonb)
      )
      ORDER BY
        CASE WHEN v_exam.shuffle_questions THEN md5(v_attempt.id::text || ':' || q.id::text) ELSE NULL END ASC,
        q.display_order ASC
    ),
    '[]'::jsonb
  )
  INTO v_questions
  FROM public.exam_questions q
  LEFT JOIN public.student_answers sa
    ON sa.attempt_id = v_attempt.id
   AND sa.question_id = q.id
  WHERE q.exam_id = v_exam.id;

  RETURN jsonb_build_object(
    'ok', true,
    'attempt_id', v_attempt.id,
    'exam_id', v_exam.id,
    'exam_title', v_exam.title,
    'instructions', v_exam.instructions,
    'duration_minutes', v_exam.duration_minutes,
    'started_at', v_attempt.started_at,
    'deadline_at', v_attempt.deadline_at,
    'server_now', v_now,
    'questions', v_questions
  );
END;
$$;

-- Upgrade student_save_answer to accept both option selection and text responses
DROP FUNCTION IF EXISTS public.student_save_answer(uuid, uuid, uuid);

CREATE OR REPLACE FUNCTION public.student_save_answer(
  p_attempt_id uuid,
  p_question_id uuid,
  p_selected_option_id uuid DEFAULT NULL,
  p_answer_value text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_attempt public.exam_attempts%ROWTYPE;
  v_question record;
  v_option_question_id uuid;
  v_clean_text text;
  v_answer public.student_answers%ROWTYPE;
  v_now timestamptz := public.utc_now();
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_student() THEN
    RAISE EXCEPTION 'FORBIDDEN_STUDENT_ONLY: Active student account required.'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_attempt
  FROM public.exam_attempts a
  WHERE a.id = p_attempt_id
  FOR UPDATE;

  IF v_attempt.id IS NULL OR v_attempt.student_id <> v_uid THEN
    RAISE EXCEPTION 'FORBIDDEN_ATTEMPT_ACCESS: Attempt not found or belongs to another student.'
      USING ERRCODE = '42501';
  END IF;

  IF v_attempt.status <> 'in_progress' THEN
    RAISE EXCEPTION 'ATTEMPT_NOT_ACTIVE: Attempt is already finalized (%).', v_attempt.status;
  END IF;

  IF v_now > v_attempt.deadline_at THEN
    PERFORM public.internal_finalize_attempt(
      v_attempt.id, 'auto_submitted', v_attempt.deadline_at, NULL, 'system'
    );
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'ATTEMPT_DEADLINE_EXPIRED',
      'message', 'Examination deadline has elapsed. Your attempt was automatically submitted.',
      'attempt_status', 'auto_submitted',
      'deadline_at', v_attempt.deadline_at,
      'server_now', v_now
    );
  END IF;

  SELECT q.id, q.exam_id, q.question_type
  INTO v_question
  FROM public.exam_questions q
  WHERE q.id = p_question_id;

  IF v_question.id IS NULL OR v_question.exam_id <> v_attempt.exam_id THEN
    RAISE EXCEPTION 'QUESTION_EXAM_MISMATCH: Question does not belong to this examination.';
  END IF;

  IF v_question.question_type IN ('multiple_choice', 'true_false') THEN
    IF p_selected_option_id IS NOT NULL THEN
      SELECT o.question_id INTO v_option_question_id
      FROM public.question_options o
      WHERE o.id = p_selected_option_id;

      IF v_option_question_id IS NULL OR v_option_question_id <> p_question_id THEN
        RAISE EXCEPTION 'OPTION_QUESTION_MISMATCH: Selected option does not belong to the specified question.';
      END IF;
    END IF;
    v_clean_text := NULL;
  ELSE
    IF p_selected_option_id IS NOT NULL THEN
      RAISE EXCEPTION 'OPTION_QUESTION_MISMATCH: Text-response questions do not accept option IDs.';
    END IF;
    v_clean_text := NULLIF(btrim(COALESCE(p_answer_value, '')), '');
    IF v_clean_text IS NOT NULL AND char_length(v_clean_text) > 4000 THEN
      RAISE EXCEPTION 'VALIDATION_CONSTRAINT_FAILED: Answer exceeds maximum length of 4000 characters.';
    END IF;
  END IF;

  INSERT INTO public.student_answers (
    attempt_id,
    question_id,
    selected_option_id,
    answer_value,
    revision,
    saved_at
  )
  VALUES (
    p_attempt_id,
    p_question_id,
    p_selected_option_id,
    v_clean_text,
    1,
    v_now
  )
  ON CONFLICT (attempt_id, question_id) DO UPDATE
    SET selected_option_id = EXCLUDED.selected_option_id,
        answer_value = EXCLUDED.answer_value,
        revision = public.student_answers.revision + 1,
        saved_at = v_now
  RETURNING * INTO v_answer;

  UPDATE public.exam_attempts
  SET last_activity_at = v_now
  WHERE id = p_attempt_id;

  RETURN jsonb_build_object(
    'ok', true,
    'attempt_id', v_answer.attempt_id,
    'question_id', v_answer.question_id,
    'selected_option_id', v_answer.selected_option_id,
    'answer_value', v_answer.answer_value,
    'revision', v_answer.revision,
    'saved_at', v_answer.saved_at,
    'deadline_at', v_attempt.deadline_at,
    'server_now', v_now
  );
END;
$$;

REVOKE ALL ON FUNCTION public.student_save_answer(uuid, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.student_save_answer(uuid, uuid, uuid, text) TO authenticated, service_role;

-- Upgrade student_get_attempt_review to include submitted_text & expected_answer for text questions
CREATE OR REPLACE FUNCTION public.student_get_attempt_review(p_attempt_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_attempt public.exam_attempts%ROWTYPE;
  v_exam public.exams%ROWTYPE;
  v_result public.results%ROWTYPE;
  v_items jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_student() THEN
    RAISE EXCEPTION 'FORBIDDEN_STUDENT_ONLY: Active student account required.'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_attempt FROM public.exam_attempts WHERE id = p_attempt_id;

  IF v_attempt.id IS NULL OR v_attempt.student_id <> v_uid THEN
    RAISE EXCEPTION 'FORBIDDEN_ATTEMPT_ACCESS: Attempt not found or belongs to another student.'
      USING ERRCODE = '42501';
  END IF;

  IF v_attempt.status NOT IN ('submitted', 'auto_submitted') THEN
    RAISE EXCEPTION 'ATTEMPT_NOT_FINALIZED: Review is available only after submission.';
  END IF;

  SELECT * INTO v_exam FROM public.exams WHERE id = v_attempt.exam_id;

  IF NOT public.is_result_released_for_exam(v_exam.id) THEN
    RAISE EXCEPTION 'RESULT_NOT_RELEASED: Examination results have not been released yet.'
      USING ERRCODE = '42501';
  END IF;

  IF NOT v_exam.allow_review THEN
    RAISE EXCEPTION 'REVIEW_NOT_PERMITTED: Detailed answer review is disabled for this examination.'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_result FROM public.results WHERE attempt_id = v_attempt.id;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'question_id', q.id,
        'display_order', q.display_order,
        'question_text', q.question_text,
        'question_type', q.question_type,
        'max_marks', ri.max_marks,
        'marks_awarded', ri.marks_awarded,
        'outcome', ri.outcome,
        'selected_option_id', ri.selected_option_id,
        'correct_option_id', ri.correct_option_id,
        'submitted_text', ri.submitted_text,
        'expected_answer', ri.expected_answer,
        'accepted_answers', q.accepted_answers,
        'explanation', q.explanation,
        'options', COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', o.id,
              'option_text', o.option_text,
              'display_order', o.display_order,
              'is_correct', o.is_correct
            )
            ORDER BY o.display_order ASC
          )
          FROM public.question_options o
          WHERE o.question_id = q.id
        ), '[]'::jsonb)
      )
      ORDER BY q.display_order ASC
    ),
    '[]'::jsonb
  )
  INTO v_items
  FROM public.result_items ri
  JOIN public.exam_questions q ON q.id = ri.question_id
  WHERE ri.result_id = v_result.id;

  RETURN jsonb_build_object(
    'attempt_id', v_attempt.id,
    'exam_id', v_exam.id,
    'exam_title', v_exam.title,
    'started_at', v_attempt.started_at,
    'submitted_at', v_attempt.submitted_at,
    'marks_obtained', v_result.marks_obtained,
    'total_marks', v_result.total_marks,
    'percentage', v_result.percentage,
    'passed', v_result.passed,
    'questions', v_items
  );
END;
$$;

-- Upgrade admin_get_attempt_detail to include options, submitted_text, accepted_answers, and result_id
CREATE OR REPLACE FUNCTION public.admin_get_attempt_detail(p_attempt_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inst uuid;
  v_attempt public.exam_attempts%ROWTYPE;
  v_exam public.exams%ROWTYPE;
  v_student public.profiles%ROWTYPE;
  v_result public.results%ROWTYPE;
  v_questions jsonb;
BEGIN
  IF NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY: Active administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  v_inst := public.current_institution_id();

  SELECT a.* INTO v_attempt
  FROM public.exam_attempts a
  JOIN public.exams e ON e.id = a.exam_id
  WHERE a.id = p_attempt_id
    AND e.institution_id = v_inst;

  IF v_attempt.id IS NULL THEN
    RAISE EXCEPTION 'ATTEMPT_NOT_FOUND: Attempt not found in your institution.';
  END IF;

  SELECT * INTO v_exam FROM public.exams WHERE id = v_attempt.exam_id;
  SELECT * INTO v_student FROM public.profiles WHERE id = v_attempt.student_id;
  SELECT * INTO v_result FROM public.results WHERE attempt_id = v_attempt.id;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'question_id', q.id,
        'display_order', q.display_order,
        'question_text', q.question_text,
        'question_type', q.question_type,
        'marks', q.marks,
        'negative_marks', q.negative_marks,
        'selected_option_id', COALESCE(ri.selected_option_id, sa.selected_option_id),
        'correct_option_id', ri.correct_option_id,
        'submitted_text', COALESCE(ri.submitted_text, sa.answer_value),
        'expected_answer', ri.expected_answer,
        'accepted_answers', q.accepted_answers,
        'outcome', ri.outcome,
        'marks_awarded', ri.marks_awarded,
        'explanation', q.explanation,
        'options', COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', o.id,
              'option_text', o.option_text,
              'display_order', o.display_order,
              'is_correct', o.is_correct
            )
            ORDER BY o.display_order ASC
          )
          FROM public.question_options o
          WHERE o.question_id = q.id
        ), '[]'::jsonb)
      )
      ORDER BY q.display_order ASC
    ),
    '[]'::jsonb
  )
  INTO v_questions
  FROM public.exam_questions q
  LEFT JOIN public.student_answers sa
    ON sa.attempt_id = v_attempt.id AND sa.question_id = q.id
  LEFT JOIN public.result_items ri
    ON ri.result_id = v_result.id AND ri.question_id = q.id
  WHERE q.exam_id = v_exam.id;

  RETURN jsonb_build_object(
    'attempt_id', v_attempt.id,
    'attempt_number', v_attempt.attempt_number,
    'status', v_attempt.status,
    'started_at', v_attempt.started_at,
    'deadline_at', v_attempt.deadline_at,
    'submitted_at', v_attempt.submitted_at,
    'student', jsonb_build_object(
      'id', v_student.id,
      'full_name', v_student.full_name,
      'student_identifier', v_student.student_identifier,
      'email', v_student.email
    ),
    'exam', jsonb_build_object(
      'id', v_exam.id,
      'title', v_exam.title,
      'total_marks', v_exam.total_marks
    ),
    'result', CASE WHEN v_result.id IS NOT NULL THEN jsonb_build_object(
      'id', v_result.id,
      'marks_obtained', v_result.marks_obtained,
      'total_marks', v_result.total_marks,
      'percentage', v_result.percentage,
      'passed', v_result.passed,
      'marking_version', v_result.marking_version,
      'finalized_at', v_result.finalized_at
    ) ELSE NULL END,
    'questions', v_questions
  );
END;
$$;

-- Upgrade admin_get_question_analytics to report partial_count as well
CREATE OR REPLACE FUNCTION public.admin_get_question_analytics(p_exam_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inst uuid;
  v_exam public.exams%ROWTYPE;
  v_rows jsonb;
BEGIN
  IF NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY: Active administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  v_inst := public.current_institution_id();
  SELECT * INTO v_exam FROM public.exams WHERE id = p_exam_id AND institution_id = v_inst;

  IF v_exam.id IS NULL THEN
    RAISE EXCEPTION 'EXAM_NOT_FOUND: Examination not found in your institution.';
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'question_id', q.id,
        'display_order', q.display_order,
        'question_text', q.question_text,
        'question_type', q.question_type,
        'marks', q.marks,
        'correct_count', stats.correct_count,
        'partial_count', stats.partial_count,
        'incorrect_count', stats.incorrect_count,
        'unanswered_count', stats.unanswered_count,
        'total_evaluated', stats.total_evaluated,
        'correct_percentage', stats.correct_percentage,
        'average_marks_awarded', stats.avg_marks,
        'commonly_missed', (stats.total_evaluated > 0 AND stats.correct_percentage < 50.0)
      )
      ORDER BY q.display_order ASC
    ),
    '[]'::jsonb
  )
  INTO v_rows
  FROM public.exam_questions q
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*) FILTER (WHERE ri.outcome = 'correct') AS correct_count,
      COUNT(*) FILTER (WHERE ri.outcome = 'partial') AS partial_count,
      COUNT(*) FILTER (WHERE ri.outcome = 'incorrect') AS incorrect_count,
      COUNT(*) FILTER (WHERE ri.outcome = 'unanswered') AS unanswered_count,
      COUNT(ri.id) AS total_evaluated,
      COALESCE(ROUND(AVG(ri.marks_awarded), 2), 0.00) AS avg_marks,
      CASE WHEN COUNT(ri.id) > 0
        THEN ROUND((SUM(GREATEST(0, ri.marks_awarded)) / SUM(ri.max_marks)) * 100.0, 2)
        ELSE 0.00
      END AS correct_percentage
    FROM public.result_items ri
    WHERE ri.question_id = q.id
  ) stats ON true
  WHERE q.exam_id = p_exam_id;

  RETURN v_rows;
END;
$$;

-- Admin: Grade or adjust an individual question's awarded marks on a finalized result (Audited)
CREATE OR REPLACE FUNCTION public.admin_grade_result_item(
  p_result_id uuid,
  p_question_id uuid,
  p_marks_awarded numeric,
  p_reason text
)
RETURNS public.results
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inst uuid;
  v_res public.results%ROWTYPE;
  v_exam public.exams%ROWTYPE;
  v_item public.result_items%ROWTYPE;
  v_new_outcome text;
  v_raw_sum numeric(8,2);
  v_final_marks numeric(8,2);
  v_pct numeric(5,2);
  v_passed boolean;
  v_c_cnt integer;
  v_i_cnt integer;
  v_u_cnt integer;
BEGIN
  IF NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY: Active administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'REASON_REQUIRED: Please provide a brief grading note (>= 3 characters).';
  END IF;

  v_inst := public.current_institution_id();

  SELECT r.* INTO v_res
  FROM public.results r
  JOIN public.exams e ON e.id = r.exam_id
  WHERE r.id = p_result_id
    AND e.institution_id = v_inst
  FOR UPDATE OF r;

  IF v_res.id IS NULL THEN
    RAISE EXCEPTION 'RESULT_NOT_FOUND: Result record not found in your institution.';
  END IF;

  SELECT * INTO v_item
  FROM public.result_items ri
  WHERE ri.result_id = p_result_id
    AND ri.question_id = p_question_id
  FOR UPDATE;

  IF v_item.id IS NULL THEN
    RAISE EXCEPTION 'QUESTION_NOT_FOUND: Question item not found in this result.';
  END IF;

  IF p_marks_awarded < 0 OR p_marks_awarded > v_item.max_marks THEN
    RAISE EXCEPTION 'INVALID_MARKS_RANGE: Awarded marks must be between 0 and %.', v_item.max_marks;
  END IF;

  IF p_marks_awarded >= v_item.max_marks THEN
    v_new_outcome := 'correct';
  ELSIF p_marks_awarded > 0 THEN
    v_new_outcome := 'partial';
  ELSE
    v_new_outcome := 'incorrect';
  END IF;

  UPDATE public.result_items
  SET marks_awarded = ROUND(p_marks_awarded, 2),
      outcome = v_new_outcome
  WHERE id = v_item.id;

  SELECT
    COALESCE(SUM(ri.marks_awarded), 0),
    COUNT(*) FILTER (WHERE ri.outcome = 'correct'),
    COUNT(*) FILTER (WHERE ri.outcome = 'incorrect'),
    COUNT(*) FILTER (WHERE ri.outcome = 'unanswered')
  INTO v_raw_sum, v_c_cnt, v_i_cnt, v_u_cnt
  FROM public.result_items ri
  WHERE ri.result_id = p_result_id;

  SELECT * INTO v_exam FROM public.exams WHERE id = v_res.exam_id;

  v_final_marks := LEAST(v_res.total_marks, GREATEST(0, v_raw_sum));
  v_pct := ROUND((v_final_marks / v_res.total_marks) * 100.0, 2);
  v_passed := (v_pct >= v_exam.passing_percentage);

  UPDATE public.results
  SET marks_obtained = v_final_marks,
      percentage = v_pct,
      passed = v_passed,
      correct_count = v_c_cnt,
      incorrect_count = v_i_cnt,
      unanswered_count = v_u_cnt,
      marking_version = marking_version + 1,
      finalized_at = public.utc_now()
  WHERE id = p_result_id
  RETURNING * INTO v_res;

  PERFORM public.internal_write_audit_log(
    v_inst, auth.uid(), 'admin', 'result_item_graded', 'result', v_res.id,
    jsonb_build_object(
      'question_id', p_question_id,
      'previous_item_marks', v_item.marks_awarded,
      'new_item_marks', p_marks_awarded,
      'new_total_marks_obtained', v_final_marks,
      'reason', btrim(p_reason)
    )
  );

  RETURN v_res;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_grade_result_item(uuid, uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_grade_result_item(uuid, uuid, numeric, text) TO authenticated, service_role;

-- Admin: List all examinations in institution with counts & assignment summaries
CREATE OR REPLACE FUNCTION public.admin_list_exams()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inst uuid;
  v_rows jsonb;
BEGIN
  IF NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY: Active administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  v_inst := public.current_institution_id();

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', e.id,
        'title', e.title,
        'description', e.description,
        'instructions', e.instructions,
        'duration_minutes', e.duration_minutes,
        'total_marks', e.total_marks,
        'passing_percentage', e.passing_percentage,
        'status', e.status,
        'scheduled_start_at', e.scheduled_start_at,
        'scheduled_end_at', e.scheduled_end_at,
        'result_release_policy', e.result_release_policy,
        'results_released_manually', e.results_released_manually,
        'allow_review', e.allow_review,
        'shuffle_questions', e.shuffle_questions,
        'shuffle_options', e.shuffle_options,
        'max_attempts', e.max_attempts,
        'retake_cooldown_minutes', e.retake_cooldown_minutes,
        'published_at', e.published_at,
        'created_at', e.created_at,
        'question_count', (SELECT COUNT(*) FROM public.exam_questions q WHERE q.exam_id = e.id),
        'attempt_count', (SELECT COUNT(*) FROM public.exam_attempts a WHERE a.exam_id = e.id),
        'assignments', COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', ea.id,
              'student_id', ea.student_id,
              'class_id', ea.class_id,
              'assignment_status', ea.assignment_status
            )
          )
          FROM public.exam_assignments ea
          WHERE ea.exam_id = e.id
            AND ea.assignment_status = 'active'
        ), '[]'::jsonb)
      )
      ORDER BY e.created_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_rows
  FROM public.exams e
  WHERE e.institution_id = v_inst;

  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_exams() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_exams() TO authenticated, service_role;

-- Admin: Get full question & answer-key authoring list for an examination
CREATE OR REPLACE FUNCTION public.admin_get_exam_questions(p_exam_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inst uuid;
  v_exam public.exams%ROWTYPE;
  v_rows jsonb;
BEGIN
  IF NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY: Active administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  v_inst := public.current_institution_id();
  SELECT * INTO v_exam FROM public.exams WHERE id = p_exam_id AND institution_id = v_inst;

  IF v_exam.id IS NULL THEN
    RAISE EXCEPTION 'EXAM_NOT_FOUND: Examination not found in your institution.';
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', q.id,
        'exam_id', q.exam_id,
        'display_order', q.display_order,
        'question_text', q.question_text,
        'question_type', q.question_type,
        'marks', q.marks,
        'negative_marks', q.negative_marks,
        'explanation', q.explanation,
        'is_required', q.is_required,
        'accepted_answers', q.accepted_answers,
        'rubric_keywords', q.rubric_keywords,
        'options', COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', o.id,
              'option_text', o.option_text,
              'display_order', o.display_order,
              'is_correct', o.is_correct
            )
            ORDER BY o.display_order ASC
          )
          FROM public.question_options o
          WHERE o.question_id = q.id
        ), '[]'::jsonb)
      )
      ORDER BY q.display_order ASC
    ),
    '[]'::jsonb
  )
  INTO v_rows
  FROM public.exam_questions q
  WHERE q.exam_id = p_exam_id;

  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_get_exam_questions(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_exam_questions(uuid) TO authenticated, service_role;

-- Admin: List classes with enrolled members
CREATE OR REPLACE FUNCTION public.admin_list_classes()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inst uuid;
  v_rows jsonb;
BEGIN
  IF NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY: Active administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  v_inst := public.current_institution_id();

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', c.id,
        'name', c.name,
        'description', c.description,
        'created_at', c.created_at,
        'members', COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'student_id', p.id,
              'full_name', p.full_name,
              'student_identifier', p.student_identifier,
              'email', p.email,
              'membership_status', cm.membership_status
            )
            ORDER BY p.full_name ASC
          )
          FROM public.class_memberships cm
          JOIN public.profiles p ON p.id = cm.student_id
          WHERE cm.class_id = c.id
        ), '[]'::jsonb)
      )
      ORDER BY c.name ASC
    ),
    '[]'::jsonb
  )
  INTO v_rows
  FROM public.classes c
  WHERE c.institution_id = v_inst;

  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_classes() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_classes() TO authenticated, service_role;

-- Ensure student_submit_attempt returns result_id and allow_review when released
CREATE OR REPLACE FUNCTION public.student_submit_attempt(p_attempt_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_attempt public.exam_attempts%ROWTYPE;
  v_exam public.exams%ROWTYPE;
  v_now timestamptz := public.utc_now();
  v_finalize_out jsonb;
  v_result public.results%ROWTYPE;
  v_released boolean;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_student() THEN
    RAISE EXCEPTION 'FORBIDDEN_STUDENT_ONLY: Active student account required.'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_attempt
  FROM public.exam_attempts a
  WHERE a.id = p_attempt_id
  FOR UPDATE;

  IF v_attempt.id IS NULL OR v_attempt.student_id <> v_uid THEN
    RAISE EXCEPTION 'FORBIDDEN_ATTEMPT_ACCESS: Attempt not found or belongs to another student.'
      USING ERRCODE = '42501';
  END IF;

  IF v_attempt.status = 'voided' THEN
    RAISE EXCEPTION 'ATTEMPT_VOIDED: Voided attempts cannot be submitted.';
  END IF;

  IF v_attempt.status IN ('submitted', 'auto_submitted') THEN
    v_finalize_out := jsonb_build_object(
      'already_finalized', true,
      'attempt_id', v_attempt.id,
      'status', v_attempt.status,
      'submitted_at', v_attempt.submitted_at
    );
  ELSIF v_now > v_attempt.deadline_at THEN
    v_finalize_out := public.internal_finalize_attempt(
      v_attempt.id, 'auto_submitted', v_attempt.deadline_at, v_uid, 'student'
    );
  ELSE
    v_finalize_out := public.internal_finalize_attempt(
      v_attempt.id, 'submitted', v_now, v_uid, 'student'
    );
  END IF;

  SELECT * INTO v_exam FROM public.exams WHERE id = v_attempt.exam_id;
  v_released := public.is_result_released_for_exam(v_exam.id);

  IF v_released THEN
    SELECT * INTO v_result FROM public.results WHERE attempt_id = v_attempt.id;
    RETURN jsonb_build_object(
      'attempt_id', v_attempt.id,
      'exam_id', v_exam.id,
      'result_id', v_result.id,
      'status', v_finalize_out ->> 'status',
      'submitted_at', v_finalize_out ->> 'submitted_at',
      'already_finalized', (v_finalize_out ->> 'already_finalized')::boolean,
      'result_released', true,
      'allow_review', v_exam.allow_review,
      'result', jsonb_build_object(
        'marks_obtained', v_result.marks_obtained,
        'total_marks', v_result.total_marks,
        'percentage', v_result.percentage,
        'passed', v_result.passed,
        'correct_count', v_result.correct_count,
        'incorrect_count', v_result.incorrect_count,
        'unanswered_count', v_result.unanswered_count,
        'finalized_at', v_result.finalized_at
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'attempt_id', v_attempt.id,
    'exam_id', v_exam.id,
    'status', v_finalize_out ->> 'status',
    'submitted_at', v_finalize_out ->> 'submitted_at',
    'already_finalized', (v_finalize_out ->> 'already_finalized')::boolean,
    'result_released', false,
    'allow_review', false,
    'result_release_policy', v_exam.result_release_policy
  );
END;
$$;

-- Ensure student_get_released_results includes result_released and time_taken_seconds
CREATE OR REPLACE FUNCTION public.student_get_released_results()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_payload jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_student() THEN
    RAISE EXCEPTION 'FORBIDDEN_STUDENT_ONLY: Active student account required.'
      USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'result_id', r.id,
        'attempt_id', a.id,
        'attempt_number', a.attempt_number,
        'attempt_status', a.status,
        'status', a.status,
        'exam_id', e.id,
        'exam_title', e.title,
        'started_at', a.started_at,
        'submitted_at', a.submitted_at,
        'time_taken_seconds', CASE
          WHEN a.submitted_at IS NOT NULL THEN GREATEST(0, ROUND(EXTRACT(EPOCH FROM (a.submitted_at - a.started_at))))::integer
          ELSE NULL
        END,
        'result_released', true,
        'marks_obtained', r.marks_obtained,
        'total_marks', r.total_marks,
        'percentage', r.percentage,
        'passed', r.passed,
        'correct_count', r.correct_count,
        'incorrect_count', r.incorrect_count,
        'unanswered_count', r.unanswered_count,
        'allow_review', e.allow_review,
        'finalized_at', r.finalized_at
      )
      ORDER BY r.finalized_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_payload
  FROM public.results r
  JOIN public.exam_attempts a ON a.id = r.attempt_id
  JOIN public.exams e ON e.id = r.exam_id
  WHERE r.student_id = v_uid
    AND public.is_result_released_for_exam(e.id);

  RETURN v_payload;
END;
$$;
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
-- ============================================================================
-- Migration 0009: Quiz Open/Close Controls, 3-Hour Retake Cooldown Engine,
--                 Admin Per-Student & Quiz-Wide Overrides, and AIM 105 Upgrade
-- Project: QuizPocket — Online Examination & Assessment Platform
-- ============================================================================

-- 1. Expand max_attempts range (1..1000) and add open/close & override columns on public.exams
DO $$
DECLARE
  v_con record;
BEGIN
  FOR v_con IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.exams'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%max_attempts%'
  LOOP
    EXECUTE format('ALTER TABLE public.exams DROP CONSTRAINT IF EXISTS %I', v_con.conname);
  END LOOP;
END
$$;

ALTER TABLE public.exams
  ADD CONSTRAINT exams_max_attempts_check CHECK (max_attempts BETWEEN 1 AND 1000);

ALTER TABLE public.exams
  ADD COLUMN IF NOT EXISTS is_open boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS open_to_all boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cooldown_override_at timestamptz NULL;

-- 2. Per-student cooldown override table (allows Admin to unlock a single student immediately)
CREATE TABLE IF NOT EXISTS public.exam_retake_overrides (
  exam_id uuid NOT NULL REFERENCES public.exams(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  unlocked_at timestamptz NOT NULL DEFAULT public.utc_now(),
  unlocked_by uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  reason text NULL CHECK (reason IS NULL OR char_length(reason) <= 500),
  PRIMARY KEY (exam_id, student_id)
);

CREATE INDEX IF NOT EXISTS exam_retake_overrides_student_idx
  ON public.exam_retake_overrides (student_id, exam_id);

ALTER TABLE public.exam_retake_overrides ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.exam_retake_overrides FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.exam_retake_overrides TO authenticated;
GRANT ALL ON public.exam_retake_overrides TO service_role;

DROP POLICY IF EXISTS exam_retake_overrides_admin_all ON public.exam_retake_overrides;
CREATE POLICY exam_retake_overrides_admin_all
  ON public.exam_retake_overrides
  FOR ALL
  TO authenticated
  USING (
    public.is_active_admin()
    AND EXISTS (
      SELECT 1 FROM public.exams e
      WHERE e.id = exam_retake_overrides.exam_id
        AND e.institution_id = public.current_institution_id()
    )
  )
  WITH CHECK (
    public.is_active_admin()
    AND EXISTS (
      SELECT 1 FROM public.exams e
      WHERE e.id = exam_retake_overrides.exam_id
        AND e.institution_id = public.current_institution_id()
    )
  );

DROP POLICY IF EXISTS exam_retake_overrides_student_select_own ON public.exam_retake_overrides;
CREATE POLICY exam_retake_overrides_student_select_own
  ON public.exam_retake_overrides
  FOR SELECT
  TO authenticated
  USING (student_id = auth.uid());

-- 3. Update student assignment helper so open_to_all quizzes are eligible across the institution
--    while preserving strict assignment isolation when open_to_all = false
CREATE OR REPLACE FUNCTION public.is_student_assigned_to_exam(
  p_exam_id uuid,
  p_student_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.exams e
    JOIN public.profiles p ON p.id = p_student_id
    WHERE e.id = p_exam_id
      AND p.institution_id = e.institution_id
      AND p.role = 'student'
      AND p.account_status = 'active'
      AND (
        e.open_to_all = true
        OR EXISTS (
          SELECT 1
          FROM public.exam_assignments ea
          WHERE ea.exam_id = p_exam_id
            AND ea.assignment_status = 'active'
            AND (
              ea.student_id = p_student_id
              OR (
                ea.class_id IS NOT NULL
                AND EXISTS (
                  SELECT 1
                  FROM public.class_memberships cm
                  WHERE cm.class_id = ea.class_id
                    AND cm.student_id = p_student_id
                    AND cm.membership_status = 'active'
                )
              )
            )
        )
      )
  );
$$;

REVOKE ALL ON FUNCTION public.is_student_assigned_to_exam(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_student_assigned_to_exam(uuid, uuid) TO authenticated, service_role;

-- 4. Upgrade admin_create_exam to accept optional p_open_to_all & p_is_open while keeping 13-arg compatibility
DROP FUNCTION IF EXISTS public.admin_create_exam(
  text, text, text, integer, numeric, timestamptz, timestamptz,
  public.result_release_policy, boolean, boolean, boolean, integer, integer
);

CREATE OR REPLACE FUNCTION public.admin_create_exam(
  p_title text,
  p_description text DEFAULT NULL,
  p_instructions text DEFAULT NULL,
  p_duration_minutes integer DEFAULT 30,
  p_passing_percentage numeric DEFAULT 50.00,
  p_scheduled_start_at timestamptz DEFAULT NULL,
  p_scheduled_end_at timestamptz DEFAULT NULL,
  p_result_release_policy public.result_release_policy DEFAULT 'immediate',
  p_allow_review boolean DEFAULT true,
  p_shuffle_questions boolean DEFAULT false,
  p_shuffle_options boolean DEFAULT false,
  p_max_attempts integer DEFAULT 1,
  p_retake_cooldown_minutes integer DEFAULT 180,
  p_open_to_all boolean DEFAULT false,
  p_is_open boolean DEFAULT true
)
RETURNS public.exams
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inst uuid;
  v_exam public.exams%ROWTYPE;
BEGIN
  IF NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY: Active administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  v_inst := public.current_institution_id();

  INSERT INTO public.exams (
    institution_id,
    title,
    description,
    instructions,
    duration_minutes,
    passing_percentage,
    status,
    scheduled_start_at,
    scheduled_end_at,
    result_release_policy,
    allow_review,
    shuffle_questions,
    shuffle_options,
    max_attempts,
    retake_cooldown_minutes,
    open_to_all,
    is_open,
    created_by
  )
  VALUES (
    v_inst,
    btrim(p_title),
    NULLIF(btrim(p_description), ''),
    NULLIF(btrim(p_instructions), ''),
    p_duration_minutes,
    p_passing_percentage,
    'draft',
    p_scheduled_start_at,
    p_scheduled_end_at,
    COALESCE(p_result_release_policy, 'immediate'),
    COALESCE(p_allow_review, true),
    COALESCE(p_shuffle_questions, false),
    COALESCE(p_shuffle_options, false),
    COALESCE(p_max_attempts, 1),
    COALESCE(p_retake_cooldown_minutes, 180),
    COALESCE(p_open_to_all, false),
    COALESCE(p_is_open, true),
    auth.uid()
  )
  RETURNING * INTO v_exam;

  PERFORM public.internal_write_audit_log(
    v_inst, auth.uid(), 'admin', 'exam_created', 'exam', v_exam.id,
    jsonb_build_object(
      'title', v_exam.title,
      'duration_minutes', v_exam.duration_minutes,
      'open_to_all', v_exam.open_to_all,
      'is_open', v_exam.is_open
    )
  );

  RETURN v_exam;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_create_exam(
  text, text, text, integer, numeric, timestamptz, timestamptz,
  public.result_release_policy, boolean, boolean, boolean, integer, integer, boolean, boolean
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_create_exam(
  text, text, text, integer, numeric, timestamptz, timestamptz,
  public.result_release_policy, boolean, boolean, boolean, integer, integer, boolean, boolean
) TO authenticated, service_role;

-- 5. Admin RPC: Open / Close quiz, toggle open_to_all, rename quiz, or update cooldown/attempt limits
CREATE OR REPLACE FUNCTION public.admin_set_exam_access(
  p_exam_id uuid,
  p_is_open boolean DEFAULT NULL,
  p_open_to_all boolean DEFAULT NULL,
  p_title text DEFAULT NULL,
  p_retake_cooldown_minutes integer DEFAULT NULL,
  p_max_attempts integer DEFAULT NULL
)
RETURNS public.exams
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inst uuid;
  v_exam public.exams%ROWTYPE;
  v_clean_title text;
BEGIN
  IF NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY: Active administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  v_inst := public.current_institution_id();
  v_clean_title := NULLIF(btrim(COALESCE(p_title, '')), '');

  UPDATE public.exams
  SET is_open = COALESCE(p_is_open, is_open),
      open_to_all = COALESCE(p_open_to_all, open_to_all),
      title = COALESCE(v_clean_title, title),
      retake_cooldown_minutes = COALESCE(p_retake_cooldown_minutes, retake_cooldown_minutes),
      max_attempts = COALESCE(p_max_attempts, max_attempts)
  WHERE id = p_exam_id
    AND institution_id = v_inst
  RETURNING * INTO v_exam;

  IF v_exam.id IS NULL THEN
    RAISE EXCEPTION 'EXAM_NOT_FOUND: Examination not found in your institution.';
  END IF;

  PERFORM public.internal_write_audit_log(
    v_inst, auth.uid(), 'admin', 'exam_access_updated', 'exam', v_exam.id,
    jsonb_build_object(
      'title', v_exam.title,
      'is_open', v_exam.is_open,
      'open_to_all', v_exam.open_to_all,
      'retake_cooldown_minutes', v_exam.retake_cooldown_minutes,
      'max_attempts', v_exam.max_attempts
    )
  );

  RETURN v_exam;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_exam_access(uuid, boolean, boolean, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_exam_access(uuid, boolean, boolean, text, integer, integer) TO authenticated, service_role;

-- 6. Admin RPC: Override the 3-hour retake cooldown (for one student or all students on a quiz)
CREATE OR REPLACE FUNCTION public.admin_override_exam_cooldown(
  p_exam_id uuid,
  p_student_id uuid DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inst uuid;
  v_exam public.exams%ROWTYPE;
  v_student public.profiles%ROWTYPE;
  v_now timestamptz := public.utc_now();
  v_unlock_ts timestamptz;
  v_exp record;
BEGIN
  IF NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY: Active administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  v_inst := public.current_institution_id();

  SELECT * INTO v_exam
  FROM public.exams e
  WHERE e.id = p_exam_id
    AND e.institution_id = v_inst
  FOR UPDATE;

  IF v_exam.id IS NULL THEN
    RAISE EXCEPTION 'EXAM_NOT_FOUND: Examination not found in your institution.';
  END IF;

  -- Sweep any expired in_progress attempts first so they are finalized prior to unlock
  FOR v_exp IN
    SELECT a.id, a.deadline_at
    FROM public.exam_attempts a
    WHERE a.exam_id = p_exam_id
      AND (p_student_id IS NULL OR a.student_id = p_student_id)
      AND a.status = 'in_progress'
      AND a.deadline_at <= v_now
  LOOP
    PERFORM public.internal_finalize_attempt(
      v_exp.id, 'auto_submitted', v_exp.deadline_at, NULL, 'system'
    );
  END LOOP;

  v_unlock_ts := GREATEST(
    v_now,
    COALESCE((
      SELECT MAX(COALESCE(a.submitted_at, a.deadline_at))
      FROM public.exam_attempts a
      WHERE a.exam_id = p_exam_id
        AND (p_student_id IS NULL OR a.student_id = p_student_id)
        AND a.status IN ('submitted', 'auto_submitted')
    ), v_now)
  );

  IF p_student_id IS NOT NULL THEN
    SELECT * INTO v_student
    FROM public.profiles p
    WHERE p.id = p_student_id
      AND p.institution_id = v_inst
      AND p.role = 'student';

    IF v_student.id IS NULL THEN
      RAISE EXCEPTION 'AUTH_USER_NOT_FOUND: Student profile not found in your institution.';
    END IF;

    INSERT INTO public.exam_retake_overrides (exam_id, student_id, unlocked_at, unlocked_by, reason)
    VALUES (p_exam_id, p_student_id, v_unlock_ts, auth.uid(), NULLIF(btrim(COALESCE(p_reason, '')), ''))
    ON CONFLICT (exam_id, student_id) DO UPDATE
      SET unlocked_at = v_unlock_ts,
          unlocked_by = auth.uid(),
          reason = EXCLUDED.reason;

    PERFORM public.internal_write_audit_log(
      v_inst, auth.uid(), 'admin', 'exam_cooldown_overridden_student', 'exam', v_exam.id,
      jsonb_build_object(
        'student_id', p_student_id,
        'student_name', v_student.full_name,
        'unlocked_at', v_unlock_ts,
        'reason', NULLIF(btrim(COALESCE(p_reason, '')), '')
      )
    );
  ELSE
    UPDATE public.exams
    SET cooldown_override_at = v_unlock_ts
    WHERE id = p_exam_id;

    PERFORM public.internal_write_audit_log(
      v_inst, auth.uid(), 'admin', 'exam_cooldown_overridden_all', 'exam', v_exam.id,
      jsonb_build_object(
        'unlocked_at', v_unlock_ts,
        'reason', NULLIF(btrim(COALESCE(p_reason, '')), '')
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'exam_id', p_exam_id,
    'student_id', p_student_id,
    'unlocked_at', v_unlock_ts
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_override_exam_cooldown(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_override_exam_cooldown(uuid, uuid, text) TO authenticated, service_role;

-- 7. Upgrade student_list_eligible_exams to compute authoritative availability_state & 3-hour cooldown
CREATE OR REPLACE FUNCTION public.student_list_eligible_exams()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_inst uuid;
  v_now timestamptz := public.utc_now();
  v_exp record;
  v_payload jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_student() THEN
    RAISE EXCEPTION 'FORBIDDEN_STUDENT_ONLY: Active student account required.'
      USING ERRCODE = '42501';
  END IF;

  v_inst := public.current_institution_id();

  -- Auto-finalize any expired in_progress attempts for this student immediately so
  -- finished timers transition directly into finalized scores + 3-hour cooldown
  FOR v_exp IN
    SELECT a.id, a.deadline_at
    FROM public.exam_attempts a
    WHERE a.student_id = v_uid
      AND a.status = 'in_progress'
      AND a.deadline_at <= v_now
  LOOP
    PERFORM public.internal_finalize_attempt(
      v_exp.id, 'auto_submitted', v_exp.deadline_at, NULL, 'system'
    );
  END LOOP;

  SELECT COALESCE(jsonb_agg(item ORDER BY item->>'created_at' DESC), '[]'::jsonb)
  INTO v_payload
  FROM (
    SELECT jsonb_build_object(
      'id', e.id,
      'title', e.title,
      'description', e.description,
      'instructions', e.instructions,
      'duration_minutes', e.duration_minutes,
      'total_marks', e.total_marks,
      'passing_percentage', e.passing_percentage,
      'scheduled_start_at', e.scheduled_start_at,
      'scheduled_end_at', e.scheduled_end_at,
      'max_attempts', e.max_attempts,
      'retake_cooldown_minutes', e.retake_cooldown_minutes,
      'result_release_policy', e.result_release_policy,
      'allow_review', e.allow_review,
      'is_open', e.is_open,
      'open_to_all', e.open_to_all,
      'server_now', v_now,
      'is_window_open', (
        e.is_open = true
        AND (e.scheduled_start_at IS NULL OR v_now >= e.scheduled_start_at)
        AND (e.scheduled_end_at IS NULL OR v_now <= e.scheduled_end_at)
      ),
      'active_attempt_id', CASE WHEN e.is_open THEN calc.active_attempt_id ELSE NULL END,
      'active_attempt_deadline_at', CASE WHEN e.is_open THEN calc.active_deadline_at ELSE NULL END,
      'completed_attempts', calc.total_completed,
      'attempts_used', calc.effective_completed,
      'latest_submitted_at', calc.last_ended_at,
      'next_retake_eligible_at', calc.next_eligible_at,
      'next_eligible_attempt_at', calc.next_eligible_at,
      'availability_state', CASE
        WHEN e.is_open = false THEN 'closed'
        WHEN calc.active_attempt_id IS NOT NULL THEN 'in_progress'
        WHEN e.scheduled_start_at IS NOT NULL AND v_now < e.scheduled_start_at THEN 'upcoming'
        WHEN e.scheduled_end_at IS NOT NULL AND v_now > e.scheduled_end_at THEN 'closed'
        WHEN calc.effective_completed >= e.max_attempts THEN 'attempts_exhausted'
        WHEN calc.next_eligible_at IS NOT NULL AND v_now < calc.next_eligible_at THEN 'cooldown'
        ELSE 'available'
      END,
      'created_at', e.created_at
    ) AS item
    FROM public.exams e
    LEFT JOIN LATERAL (
      SELECT
        act.id AS active_attempt_id,
        act.deadline_at AS active_deadline_at,
        comp.total_completed,
        comp.effective_completed,
        comp.last_ended_at,
        CASE
          WHEN comp.last_ended_at IS NOT NULL
               AND e.retake_cooldown_minutes > 0
               AND (ovr.override_at IS NULL OR comp.last_ended_at > ovr.override_at)
          THEN comp.last_ended_at + make_interval(mins => e.retake_cooldown_minutes)
          ELSE NULL
        END AS next_eligible_at
      FROM (
        SELECT CASE
          WHEN e.cooldown_override_at IS NOT NULL AND ero.unlocked_at IS NOT NULL
            THEN GREATEST(e.cooldown_override_at, ero.unlocked_at)
          ELSE COALESCE(e.cooldown_override_at, ero.unlocked_at)
        END AS override_at
        FROM (SELECT 1) AS dummy
        LEFT JOIN public.exam_retake_overrides ero
          ON ero.exam_id = e.id AND ero.student_id = v_uid
      ) ovr
      LEFT JOIN LATERAL (
        SELECT a.id, a.deadline_at
        FROM public.exam_attempts a
        WHERE a.exam_id = e.id
          AND a.student_id = v_uid
          AND a.status = 'in_progress'
          AND a.deadline_at > v_now
        LIMIT 1
      ) act ON true
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::integer AS total_completed,
          COUNT(*) FILTER (
            WHERE ovr.override_at IS NULL OR COALESCE(a.submitted_at, a.deadline_at) > ovr.override_at
          )::integer AS effective_completed,
          MAX(COALESCE(a.submitted_at, a.deadline_at)) AS last_ended_at
        FROM public.exam_attempts a
        WHERE a.exam_id = e.id
          AND a.student_id = v_uid
          AND a.status IN ('submitted', 'auto_submitted')
      ) comp ON true
    ) calc ON true
    WHERE e.institution_id = v_inst
      AND e.status = 'published'
      AND public.is_student_assigned_to_exam(e.id, v_uid)
  ) sub;

  RETURN v_payload;
END;
$$;

REVOKE ALL ON FUNCTION public.student_list_eligible_exams() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.student_list_eligible_exams() TO authenticated, service_role;

-- 8. Upgrade student_start_or_resume_attempt to enforce Admin Open/Close & 3-hour cooldown + overrides
CREATE OR REPLACE FUNCTION public.student_start_or_resume_attempt(p_exam_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_inst uuid;
  v_exam public.exams%ROWTYPE;
  v_active public.exam_attempts%ROWTYPE;
  v_student_override timestamptz;
  v_override_at timestamptz;
  v_effective_completed integer := 0;
  v_last_ended_at timestamptz;
  v_next_eligible_at timestamptz;
  v_next_attempt_number integer;
  v_start_ts timestamptz;
  v_new_attempt public.exam_attempts%ROWTYPE;
  v_now timestamptz := public.utc_now();
BEGIN
  IF v_uid IS NULL OR NOT public.is_active_student() THEN
    RAISE EXCEPTION 'FORBIDDEN_STUDENT_ONLY: Active authenticated student account required.'
      USING ERRCODE = '42501';
  END IF;

  -- Serialize simultaneous start requests for the same (exam_id, student_id)
  PERFORM pg_advisory_xact_lock(hashtextextended(p_exam_id::text || ':' || v_uid::text, 0));

  v_inst := public.current_institution_id();

  SELECT * INTO v_exam
  FROM public.exams e
  WHERE e.id = p_exam_id
    AND e.institution_id = v_inst;

  IF v_exam.id IS NULL OR v_exam.status <> 'published' THEN
    RAISE EXCEPTION 'EXAM_NOT_AVAILABLE: Examination does not exist or is not published.'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_student_assigned_to_exam(p_exam_id, v_uid) THEN
    RAISE EXCEPTION 'EXAM_NOT_ASSIGNED: You are not assigned to this examination.'
      USING ERRCODE = '42501';
  END IF;

  IF v_exam.is_open = false THEN
    RAISE EXCEPTION 'EXAM_CLOSED_BY_ADMIN: This quiz is currently closed by the administrator.';
  END IF;

  -- Check for any existing in_progress attempt
  SELECT * INTO v_active
  FROM public.exam_attempts a
  WHERE a.exam_id = p_exam_id
    AND a.student_id = v_uid
    AND a.status = 'in_progress'
  FOR UPDATE;

  IF v_active.id IS NOT NULL THEN
    IF v_now >= v_active.deadline_at THEN
      -- Expired in_progress attempt: auto-finalize first before evaluating 3-hour retake rules
      PERFORM public.internal_finalize_attempt(
        v_active.id, 'auto_submitted', v_active.deadline_at, NULL, 'system'
      );
    ELSE
      -- Valid active attempt: resume without creating a duplicate attempt
      UPDATE public.exam_attempts
      SET last_activity_at = v_now
      WHERE id = v_active.id;

      RETURN jsonb_build_object(
        'attempt_id', v_active.id,
        'exam_id', v_active.exam_id,
        'attempt_number', v_active.attempt_number,
        'status', v_active.status,
        'started_at', v_active.started_at,
        'deadline_at', v_active.deadline_at,
        'server_now', v_now,
        'resumed', true
      );
    END IF;
  END IF;

  -- Enforce availability window for starting a NEW attempt
  IF v_exam.scheduled_start_at IS NOT NULL AND v_now < v_exam.scheduled_start_at THEN
    RAISE EXCEPTION 'EXAM_NOT_YET_OPEN: Examination window opens at %.', v_exam.scheduled_start_at;
  END IF;

  IF v_exam.scheduled_end_at IS NOT NULL AND v_now > v_exam.scheduled_end_at THEN
    RAISE EXCEPTION 'EXAM_WINDOW_CLOSED: Examination availability window closed at %.', v_exam.scheduled_end_at;
  END IF;

  -- Resolve latest admin override timestamp (quiz-wide or per-student)
  SELECT ero.unlocked_at INTO v_student_override
  FROM public.exam_retake_overrides ero
  WHERE ero.exam_id = p_exam_id
    AND ero.student_id = v_uid;

  IF v_exam.cooldown_override_at IS NOT NULL AND v_student_override IS NOT NULL THEN
    v_override_at := GREATEST(v_exam.cooldown_override_at, v_student_override);
  ELSE
    v_override_at := COALESCE(v_exam.cooldown_override_at, v_student_override);
  END IF;

  -- Evaluate effective completed attempts & latest end time
  SELECT
    COUNT(*) FILTER (
      WHERE v_override_at IS NULL OR COALESCE(a.submitted_at, a.deadline_at) > v_override_at
    )::integer,
    MAX(COALESCE(a.submitted_at, a.deadline_at))
  INTO v_effective_completed, v_last_ended_at
  FROM public.exam_attempts a
  WHERE a.exam_id = p_exam_id
    AND a.student_id = v_uid
    AND a.status IN ('submitted', 'auto_submitted');

  IF v_effective_completed >= v_exam.max_attempts THEN
    RAISE EXCEPTION 'MAX_ATTEMPTS_REACHED: Maximum allowed attempts (%) reached for this examination.', v_exam.max_attempts;
  END IF;

  -- Enforce 3-hour retake cooldown using authoritative server timestamps unless overridden by Admin
  IF v_last_ended_at IS NOT NULL
     AND v_exam.retake_cooldown_minutes > 0
     AND (v_override_at IS NULL OR v_last_ended_at > v_override_at) THEN
    v_next_eligible_at := v_last_ended_at + make_interval(mins => v_exam.retake_cooldown_minutes);
    IF v_now < v_next_eligible_at THEN
      RAISE EXCEPTION 'RETAKE_COOLDOWN_ACTIVE: Next attempt permitted after %.', v_next_eligible_at;
    END IF;
  END IF;

  SELECT COALESCE(MAX(a.attempt_number), 0) + 1
  INTO v_next_attempt_number
  FROM public.exam_attempts a
  WHERE a.exam_id = p_exam_id
    AND a.student_id = v_uid;

  v_start_ts := GREATEST(
    v_now,
    COALESCE(v_override_at + interval '1 millisecond', v_now)
  );

  INSERT INTO public.exam_attempts (
    exam_id,
    student_id,
    attempt_number,
    status,
    started_at,
    deadline_at,
    last_activity_at
  )
  VALUES (
    p_exam_id,
    v_uid,
    v_next_attempt_number,
    'in_progress',
    v_start_ts,
    v_start_ts + make_interval(mins => v_exam.duration_minutes),
    v_now
  )
  RETURNING * INTO v_new_attempt;

  PERFORM public.internal_write_audit_log(
    v_inst, v_uid, 'student', 'attempt_started', 'exam_attempt', v_new_attempt.id,
    jsonb_build_object(
      'exam_id', p_exam_id,
      'attempt_number', v_new_attempt.attempt_number,
      'deadline_at', v_new_attempt.deadline_at
    )
  );

  RETURN jsonb_build_object(
    'attempt_id', v_new_attempt.id,
    'exam_id', v_new_attempt.exam_id,
    'attempt_number', v_new_attempt.attempt_number,
    'status', v_new_attempt.status,
    'started_at', v_new_attempt.started_at,
    'deadline_at', v_new_attempt.deadline_at,
    'server_now', v_now,
    'resumed', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.student_start_or_resume_attempt(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.student_start_or_resume_attempt(uuid) TO authenticated, service_role;

-- 9. Upgrade Admin Query RPCs (include is_open, open_to_all, cooldown status & unified analytics keys)
CREATE OR REPLACE FUNCTION public.admin_list_exams()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inst uuid;
  v_rows jsonb;
BEGIN
  IF NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY: Active administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  v_inst := public.current_institution_id();

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', e.id,
        'title', e.title,
        'description', e.description,
        'instructions', e.instructions,
        'duration_minutes', e.duration_minutes,
        'total_marks', e.total_marks,
        'passing_percentage', e.passing_percentage,
        'status', e.status,
        'is_open', e.is_open,
        'open_to_all', e.open_to_all,
        'cooldown_override_at', e.cooldown_override_at,
        'scheduled_start_at', e.scheduled_start_at,
        'scheduled_end_at', e.scheduled_end_at,
        'result_release_policy', e.result_release_policy,
        'results_released_manually', e.results_released_manually,
        'allow_review', e.allow_review,
        'shuffle_questions', e.shuffle_questions,
        'shuffle_options', e.shuffle_options,
        'max_attempts', e.max_attempts,
        'retake_cooldown_minutes', e.retake_cooldown_minutes,
        'published_at', e.published_at,
        'created_at', e.created_at,
        'question_count', (SELECT COUNT(*) FROM public.exam_questions q WHERE q.exam_id = e.id),
        'attempt_count', (SELECT COUNT(*) FROM public.exam_attempts a WHERE a.exam_id = e.id),
        'assignments', COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', ea.id,
              'student_id', ea.student_id,
              'class_id', ea.class_id,
              'assignment_status', ea.assignment_status
            )
          )
          FROM public.exam_assignments ea
          WHERE ea.exam_id = e.id
            AND ea.assignment_status = 'active'
        ), '[]'::jsonb)
      )
      ORDER BY e.created_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_rows
  FROM public.exams e
  WHERE e.institution_id = v_inst;

  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_exams() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_exams() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_list_exam_attempts(p_exam_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inst uuid;
  v_exam public.exams%ROWTYPE;
  v_now timestamptz := public.utc_now();
  v_exp record;
  v_rows jsonb;
BEGIN
  IF NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY: Active administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  v_inst := public.current_institution_id();
  SELECT * INTO v_exam FROM public.exams WHERE id = p_exam_id AND institution_id = v_inst;

  IF v_exam.id IS NULL THEN
    RAISE EXCEPTION 'EXAM_NOT_FOUND: Examination not found in your institution.';
  END IF;

  -- Sweep expired attempts on this exam so Admin sees accurate statuses & cooldown locks
  FOR v_exp IN
    SELECT a.id, a.deadline_at
    FROM public.exam_attempts a
    WHERE a.exam_id = p_exam_id
      AND a.status = 'in_progress'
      AND a.deadline_at <= v_now
  LOOP
    PERFORM public.internal_finalize_attempt(
      v_exp.id, 'auto_submitted', v_exp.deadline_at, NULL, 'system'
    );
  END LOOP;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'attempt_id', a.id,
        'student_id', p.id,
        'student_name', p.full_name,
        'student_identifier', p.student_identifier,
        'student_email', p.email,
        'exam_id', v_exam.id,
        'exam_title', v_exam.title,
        'attempt_number', a.attempt_number,
        'status', a.status,
        'started_at', a.started_at,
        'deadline_at', a.deadline_at,
        'submitted_at', a.submitted_at,
        'time_taken_seconds', CASE
          WHEN a.submitted_at IS NOT NULL
          THEN GREATEST(0, EXTRACT(EPOCH FROM (a.submitted_at - a.started_at))::integer)
          ELSE NULL
        END,
        'result_id', r.id,
        'marks_obtained', r.marks_obtained,
        'total_marks', COALESCE(r.total_marks, v_exam.total_marks),
        'percentage', r.percentage,
        'passed', r.passed,
        'marking_version', r.marking_version,
        'cooldown_until', cd.cooldown_until,
        'in_cooldown', (cd.cooldown_until IS NOT NULL AND cd.cooldown_until > v_now)
      )
      ORDER BY a.started_at DESC, a.attempt_number DESC
    ),
    '[]'::jsonb
  )
  INTO v_rows
  FROM public.exam_attempts a
  JOIN public.profiles p ON p.id = a.student_id
  LEFT JOIN public.results r ON r.attempt_id = a.id
  LEFT JOIN public.exam_retake_overrides ero
    ON ero.exam_id = v_exam.id AND ero.student_id = p.id
  LEFT JOIN LATERAL (
    SELECT CASE
      WHEN latest.last_ended_at IS NOT NULL
           AND v_exam.retake_cooldown_minutes > 0
           AND (
             (CASE
               WHEN v_exam.cooldown_override_at IS NOT NULL AND ero.unlocked_at IS NOT NULL
                 THEN GREATEST(v_exam.cooldown_override_at, ero.unlocked_at)
               ELSE COALESCE(v_exam.cooldown_override_at, ero.unlocked_at)
             END) IS NULL
             OR latest.last_ended_at > (CASE
               WHEN v_exam.cooldown_override_at IS NOT NULL AND ero.unlocked_at IS NOT NULL
                 THEN GREATEST(v_exam.cooldown_override_at, ero.unlocked_at)
               ELSE COALESCE(v_exam.cooldown_override_at, ero.unlocked_at)
             END)
           )
      THEN latest.last_ended_at + make_interval(mins => v_exam.retake_cooldown_minutes)
      ELSE NULL
    END AS cooldown_until
    FROM (
      SELECT MAX(COALESCE(sa2.submitted_at, sa2.deadline_at)) AS last_ended_at
      FROM public.exam_attempts sa2
      WHERE sa2.exam_id = v_exam.id
        AND sa2.student_id = p.id
        AND sa2.status IN ('submitted', 'auto_submitted')
    ) latest
  ) cd ON true
  WHERE a.exam_id = p_exam_id;

  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_exam_attempts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_exam_attempts(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_get_exam_statistics(p_exam_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inst uuid;
  v_exam public.exams%ROWTYPE;
  v_assigned_students integer := 0;
  v_started_students integer := 0;
  v_completed_students integer := 0;
  v_not_attempted_students integer := 0;
  v_total_started_attempts integer := 0;
  v_submitted_attempts integer := 0;
  v_auto_submitted_attempts integer := 0;
  v_in_progress_attempts integer := 0;
  v_finalized_results integer := 0;
  v_pass_count integer := 0;
  v_fail_count integer := 0;
  v_avg_score numeric(8,2) := 0;
  v_avg_percentage numeric(5,2) := 0;
  v_highest_score numeric(8,2) := 0;
  v_lowest_score numeric(8,2) := 0;
  v_pass_rate numeric(5,2) := 0;
  v_failure_rate numeric(5,2) := 0;
  v_completion_rate numeric(5,2) := 0;
BEGIN
  IF NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY: Active administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  v_inst := public.current_institution_id();

  SELECT * INTO v_exam
  FROM public.exams e
  WHERE e.id = p_exam_id
    AND e.institution_id = v_inst;

  IF v_exam.id IS NULL THEN
    RAISE EXCEPTION 'EXAM_NOT_FOUND: Examination not found in your institution.';
  END IF;

  WITH eligible_students AS (
    SELECT DISTINCT p.id AS student_id
    FROM public.profiles p
    WHERE p.institution_id = v_inst
      AND p.role = 'student'
      AND p.account_status = 'active'
      AND public.is_student_assigned_to_exam(p_exam_id, p.id)
  )
  SELECT
    COUNT(*),
    COUNT(*) FILTER (
      WHERE NOT EXISTS (
        SELECT 1 FROM public.exam_attempts a
        WHERE a.exam_id = p_exam_id
          AND a.student_id = es.student_id
          AND a.status <> 'voided'
      )
    ),
    COUNT(*) FILTER (
      WHERE EXISTS (
        SELECT 1 FROM public.exam_attempts a
        WHERE a.exam_id = p_exam_id
          AND a.student_id = es.student_id
          AND a.status IN ('submitted', 'auto_submitted')
      )
    )
  INTO v_assigned_students, v_not_attempted_students, v_completed_students
  FROM eligible_students es;

  SELECT
    COUNT(DISTINCT a.student_id) FILTER (WHERE a.status <> 'voided'),
    COUNT(*) FILTER (WHERE a.status <> 'voided'),
    COUNT(*) FILTER (WHERE a.status = 'submitted'),
    COUNT(*) FILTER (WHERE a.status = 'auto_submitted'),
    COUNT(*) FILTER (WHERE a.status = 'in_progress')
  INTO
    v_started_students,
    v_total_started_attempts,
    v_submitted_attempts,
    v_auto_submitted_attempts,
    v_in_progress_attempts
  FROM public.exam_attempts a
  WHERE a.exam_id = p_exam_id;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE r.passed = true),
    COUNT(*) FILTER (WHERE r.passed = false),
    COALESCE(ROUND(AVG(r.marks_obtained), 2), 0),
    COALESCE(ROUND(AVG(r.percentage), 2), 0),
    COALESCE(MAX(r.marks_obtained), 0),
    COALESCE(MIN(r.marks_obtained), 0),
    CASE WHEN COUNT(*) > 0
      THEN ROUND((COUNT(*) FILTER (WHERE r.passed = true)::numeric / COUNT(*)::numeric) * 100.0, 2)
      ELSE 0
    END,
    CASE WHEN COUNT(*) > 0
      THEN ROUND((COUNT(*) FILTER (WHERE r.passed = false)::numeric / COUNT(*)::numeric) * 100.0, 2)
      ELSE 0
    END
  INTO
    v_finalized_results,
    v_pass_count,
    v_fail_count,
    v_avg_score,
    v_avg_percentage,
    v_highest_score,
    v_lowest_score,
    v_pass_rate,
    v_failure_rate
  FROM public.results r
  WHERE r.exam_id = p_exam_id;

  IF v_assigned_students > 0 THEN
    v_completion_rate := ROUND((v_completed_students::numeric / v_assigned_students::numeric) * 100.0, 2);
  ELSIF v_total_started_attempts > 0 THEN
    v_completion_rate := ROUND(((v_submitted_attempts + v_auto_submitted_attempts)::numeric / v_total_started_attempts::numeric) * 100.0, 2);
  END IF;

  RETURN jsonb_build_object(
    'exam_id', v_exam.id,
    'exam_title', v_exam.title,
    'total_marks', v_exam.total_marks,
    'passing_percentage', v_exam.passing_percentage,
    'assigned_students_count', v_assigned_students,
    'started_students_count', v_started_students,
    'not_attempted_students_count', v_not_attempted_students,
    'total_attempts_started', v_total_started_attempts,
    'submitted_count', v_submitted_attempts,
    'auto_submitted_count', v_auto_submitted_attempts,
    'completed_attempts', (v_submitted_attempts + v_auto_submitted_attempts),
    'in_progress_count', v_in_progress_attempts,
    'finalized_results_count', v_finalized_results,
    'pass_count', v_pass_count,
    'fail_count', v_fail_count,
    'average_score', v_avg_score,
    'average_marks', v_avg_score,
    'average_percentage', v_avg_percentage,
    'highest_score', v_highest_score,
    'highest_marks', v_highest_score,
    'lowest_score', v_lowest_score,
    'lowest_marks', v_lowest_score,
    'pass_rate', v_pass_rate,
    'pass_rate_percentage', v_pass_rate,
    'failure_rate', v_failure_rate,
    'completion_rate', v_completion_rate,
    'completion_rate_percentage', v_completion_rate
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_get_exam_statistics(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_exam_statistics(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_get_class_performance_summary(p_exam_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inst uuid;
  v_exam public.exams%ROWTYPE;
  v_rows jsonb;
BEGIN
  IF NOT public.is_active_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY: Active administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  v_inst := public.current_institution_id();
  SELECT * INTO v_exam FROM public.exams WHERE id = p_exam_id AND institution_id = v_inst;

  IF v_exam.id IS NULL THEN
    RAISE EXCEPTION 'EXAM_NOT_FOUND: Examination not found in your institution.';
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'class_id', c.id,
        'class_name', c.name,
        'enrolled_students', cstats.enrolled_students,
        'active_students', cstats.enrolled_students,
        'completed_attempts', cstats.completed_attempts,
        'average_percentage', cstats.average_percentage,
        'pass_rate', cstats.pass_rate,
        'pass_rate_percentage', cstats.pass_rate
      )
      ORDER BY c.name ASC
    ),
    '[]'::jsonb
  )
  INTO v_rows
  FROM public.classes c
  LEFT JOIN LATERAL (
    SELECT
      COUNT(DISTINCT cm.student_id) FILTER (WHERE cm.membership_status = 'active') AS enrolled_students,
      COUNT(r.id) AS completed_attempts,
      COALESCE(ROUND(AVG(r.percentage), 2), 0.00) AS average_percentage,
      CASE WHEN COUNT(r.id) > 0
        THEN ROUND((COUNT(*) FILTER (WHERE r.passed = true)::numeric / COUNT(r.id)::numeric) * 100.0, 2)
        ELSE 0.00
      END AS pass_rate
    FROM public.class_memberships cm
    LEFT JOIN public.results r
      ON r.student_id = cm.student_id
     AND r.exam_id = p_exam_id
    WHERE cm.class_id = c.id
      AND cm.membership_status = 'active'
  ) cstats ON true
  WHERE c.institution_id = v_inst
    AND (
      v_exam.open_to_all = true
      OR EXISTS (
        SELECT 1 FROM public.exam_assignments ea
        WHERE ea.exam_id = p_exam_id
          AND ea.class_id = c.id
          AND ea.assignment_status = 'active'
      )
    );

  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_get_class_performance_summary(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_class_performance_summary(uuid) TO authenticated, service_role;

-- 10. Clean up legacy HIS 202 draft quiz & upgrade HIM 101 -> AIM 105 on pre-existing databases
DO $$
DECLARE
  v_inst uuid;
  v_target_class_id uuid;
  v_source record;
BEGIN
  DELETE FROM public.exams e
  WHERE e.status = 'draft'
    AND e.title ILIKE 'HIS 202%'
    AND NOT EXISTS (SELECT 1 FROM public.exam_attempts a WHERE a.exam_id = e.id);

  UPDATE public.exams
  SET title = 'AIM 105: Health Information Management & Hospital Information Systems',
      is_open = true,
      open_to_all = true,
      max_attempts = GREATEST(max_attempts, 100),
      retake_cooldown_minutes = 180
  WHERE title ILIKE 'HIM 101%'
     OR title ILIKE 'AIM 105%';

  -- Consolidate legacy and canonical cohort rows before renaming. Updating both
  -- names at once violates classes_institution_name_uidx when both already exist.
  FOR v_inst IN
    SELECT DISTINCT c.institution_id
    FROM public.classes c
    WHERE lower(btrim(c.name)) IN (
      lower('HIM-101 Health Information Management Cohort'),
      lower('AIM 105 Health Information Management Cohort')
    )
  LOOP
    v_target_class_id := NULL;

    SELECT c.id
    INTO v_target_class_id
    FROM public.classes c
    WHERE c.institution_id = v_inst
      AND lower(btrim(c.name)) = lower('AIM 105 Health Information Management Cohort')
    ORDER BY c.created_at, c.id
    LIMIT 1;

    IF v_target_class_id IS NULL THEN
      SELECT c.id
      INTO v_target_class_id
      FROM public.classes c
      WHERE c.institution_id = v_inst
        AND lower(btrim(c.name)) = lower('HIM-101 Health Information Management Cohort')
      ORDER BY c.created_at, c.id
      LIMIT 1;
    END IF;

    IF v_target_class_id IS NULL THEN
      CONTINUE;
    END IF;

    FOR v_source IN
      SELECT c.id
      FROM public.classes c
      WHERE c.institution_id = v_inst
        AND c.id <> v_target_class_id
        AND lower(btrim(c.name)) IN (
          lower('HIM-101 Health Information Management Cohort'),
          lower('AIM 105 Health Information Management Cohort')
        )
      ORDER BY c.id
    LOOP
      INSERT INTO public.class_memberships AS existing_membership (
        class_id, student_id, membership_status, joined_at, updated_at
      )
      SELECT
        v_target_class_id, cm.student_id, cm.membership_status, cm.joined_at, cm.updated_at
      FROM public.class_memberships cm
      WHERE cm.class_id = v_source.id
      ON CONFLICT (class_id, student_id) DO UPDATE
      SET membership_status = CASE
            WHEN existing_membership.membership_status = 'active'
              OR EXCLUDED.membership_status = 'active'
              THEN 'active'::public.membership_status
            ELSE 'inactive'::public.membership_status
          END,
          joined_at = LEAST(existing_membership.joined_at, EXCLUDED.joined_at),
          updated_at = GREATEST(existing_membership.updated_at, EXCLUDED.updated_at);

      INSERT INTO public.exam_assignments AS existing_assignment (
        exam_id, class_id, assigned_by, assignment_status, assigned_at
      )
      SELECT
        ea.exam_id, v_target_class_id, ea.assigned_by, ea.assignment_status, ea.assigned_at
      FROM public.exam_assignments ea
      WHERE ea.class_id = v_source.id
      ON CONFLICT (exam_id, class_id) WHERE class_id IS NOT NULL DO UPDATE
      SET assignment_status = CASE
            WHEN existing_assignment.assignment_status = 'active'
              OR EXCLUDED.assignment_status = 'active'
              THEN 'active'::public.assignment_status
            ELSE 'revoked'::public.assignment_status
          END,
          assigned_at = LEAST(existing_assignment.assigned_at, EXCLUDED.assigned_at);

      UPDATE public.classes target
      SET description = COALESCE(target.description, source.description)
      FROM public.classes source
      WHERE target.id = v_target_class_id
        AND source.id = v_source.id;

      DELETE FROM public.classes
      WHERE id = v_source.id;
    END LOOP;

    UPDATE public.classes
    SET name = 'AIM 105 Health Information Management Cohort',
        auto_enroll_new_students = true
    WHERE id = v_target_class_id;
  END LOOP;
END
$$;
-- ============================================================================
-- Local Development Seed Data (FICTIONAL TEST ACCOUNTS ONLY — NEVER USE IN PROD)
-- Project: QuizPocket — Online Examination & Assessment Platform
-- ============================================================================
-- Seeds the 20-question Health Information Management (HIM 101) examination
-- for `supabase db reset` workflows.

DO $$
DECLARE
  v_admin_id uuid := '11111111-1111-4111-8111-111111111111';
  v_student1_id uuid := '22222222-2222-4222-8222-222222222221';
  v_student2_id uuid := '22222222-2222-4222-8222-222222222222';
  v_class_id uuid := '33333333-3333-4333-8333-333333333333';
  v_exam_id uuid := '44444444-4444-4444-8444-444444444444';
  v_q_id uuid;
  v_admin_pw_hash text := NULL;
BEGIN
  SELECT id INTO v_admin_id FROM auth.users WHERE lower(email) = 'kenzy@users.quizpocket.local' LIMIT 1;
  v_admin_id := COALESCE(v_admin_id, '11111111-1111-4111-8111-111111111111'::uuid);

  SELECT id INTO v_student1_id FROM auth.users WHERE lower(email) = 'amina.okafor@quizpocket.edu' LIMIT 1;
  v_student1_id := COALESCE(v_student1_id, '22222222-2222-4222-8222-222222222221'::uuid);

  SELECT id INTO v_student2_id FROM auth.users WHERE lower(email) = 'marcus.rivera@quizpocket.edu' LIMIT 1;
  v_student2_id := COALESCE(v_student2_id, '22222222-2222-4222-8222-222222222222'::uuid);

  BEGIN
    EXECUTE 'SELECT crypt($1, gen_salt(''bf''))' INTO v_admin_pw_hash USING 'kenzy1052';
  EXCEPTION WHEN OTHERS THEN
    v_admin_pw_hash := NULL;
  END;

  INSERT INTO auth.users (id, email, encrypted_password, raw_user_meta_data)
  VALUES
    (v_admin_id, 'kenzy@users.quizpocket.local', v_admin_pw_hash, '{"username": "kenzy", "full_name": "kenzy"}'::jsonb),
    (v_student1_id, 'amina.okafor@quizpocket.edu', NULL, '{"username": "Amina Okafor", "full_name": "Amina Okafor"}'::jsonb),
    (v_student2_id, 'marcus.rivera@quizpocket.edu', NULL, '{"username": "Marcus Rivera", "full_name": "Marcus Rivera"}'::jsonb)
  ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email,
        encrypted_password = COALESCE(auth.users.encrypted_password, EXCLUDED.encrypted_password),
        raw_user_meta_data = EXCLUDED.raw_user_meta_data;

  -- Backfill any existing auth.users into public.profiles if created prior to running migrations
  PERFORM set_config('quizpocket.trusted_context', 'on', true);
  INSERT INTO public.profiles (id, institution_id, email, username, full_name, role, account_status)
  SELECT
    u.id,
    '00000000-0000-0000-0000-000000000001',
    u.email,
    left(COALESCE(NULLIF(btrim(u.raw_user_meta_data ->> 'username'), ''), split_part(u.email, '@', 1)), 80),
    left(COALESCE(NULLIF(btrim(u.raw_user_meta_data ->> 'full_name'), ''), split_part(u.email, '@', 1)), 200),
    'student',
    'active'
  FROM auth.users u
  ON CONFLICT (id) DO NOTHING;

  PERFORM public.bootstrap_initial_admin(v_admin_id, 'kenzy');
  PERFORM set_config('quizpocket.trusted_context', 'on', true);

  UPDATE public.profiles
  SET student_identifier = 'HIM-2026-014', username = 'Amina Okafor', full_name = 'Amina Okafor', account_status = 'active'
  WHERE id = v_student1_id;

  UPDATE public.profiles
  SET student_identifier = 'HIM-2026-008', username = 'Marcus Rivera', full_name = 'Marcus Rivera', account_status = 'active'
  WHERE id = v_student2_id;

  -- Impersonate kenzy (Admin) so all exam & question creation uses production RPCs
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_id::text, 'role', 'authenticated')::text, true);

  IF NOT EXISTS (SELECT 1 FROM public.classes WHERE id = v_class_id) THEN
    INSERT INTO public.classes (id, institution_id, name, description, auto_enroll_new_students, created_by)
    VALUES (
      v_class_id,
      '00000000-0000-0000-0000-000000000001',
      'AIM 105 Health Information Management Cohort',
      'Undergraduate Health Information Management & Hospital Administration Cohort',
      true,
      v_admin_id
    );
  ELSE
    UPDATE public.classes
    SET name = 'AIM 105 Health Information Management Cohort',
        auto_enroll_new_students = true
    WHERE id = v_class_id;
  END IF;

  INSERT INTO public.class_memberships (class_id, student_id, membership_status)
  VALUES
    (v_class_id, v_student1_id, 'active'),
    (v_class_id, v_student2_id, 'active')
  ON CONFLICT (class_id, student_id) DO NOTHING;

  DELETE FROM public.exams e
  WHERE e.status = 'draft'
    AND e.title ILIKE 'HIS 202%'
    AND NOT EXISTS (SELECT 1 FROM public.exam_attempts a WHERE a.exam_id = e.id);

  IF NOT EXISTS (SELECT 1 FROM public.exams WHERE id = v_exam_id) THEN
    INSERT INTO public.exams (
      id, institution_id, title, description, instructions,
      duration_minutes, passing_percentage, status, result_release_policy,
      allow_review, max_attempts, retake_cooldown_minutes, is_open, open_to_all, created_by
    )
    VALUES (
      v_exam_id,
      '00000000-0000-0000-0000-000000000001',
      'AIM 105: Health Information Management & Hospital Information Systems',
      'Comprehensive assessment covering the evolution of Health Information Management, coding systems, career pathways, core HIM domains, and Hospital Information Systems (HIS).',
      'Read each question carefully. Questions 1–10 are Multiple Choice (1 mark each), Questions 11–15 are Short Answer (5 marks each), Questions 16–17 are True or False (1 mark each), and Questions 18–20 are Fill-in-the-Blank (1 mark each).',
      45, 60.00, 'draft', 'immediate', true, 100, 180, true, true, v_admin_id
    );

    -- Q1
    PERFORM public.admin_upsert_question_with_options(
      v_exam_id,
      'Which of the following periods marked the introduction of computers and coding systems into Health Information Management?',
      'multiple_choice', 1,
      '[{"option_text":"1920s–1940s","is_correct":false},{"option_text":"1950s–1970s","is_correct":false},{"option_text":"1980s–1990s","is_correct":true},{"option_text":"2000s–Present","is_correct":false}]'::jsonb,
      NULL, 0, 'The 1980s–1990s marked the introduction of computers and standardized coding systems into Health Information Management.', 1
    );
    -- Q2
    PERFORM public.admin_upsert_question_with_options(
      v_exam_id,
      'Which classification system is primarily used for coding procedures in HIM, as mentioned in the lecture?',
      'multiple_choice', 1,
      '[{"option_text":"ICD-10","is_correct":false},{"option_text":"CPT","is_correct":true},{"option_text":"HIPAA","is_correct":false},{"option_text":"LIS","is_correct":false}]'::jsonb,
      NULL, 0, 'ICD-10 is used for diagnoses, while CPT is used for procedures.', 2
    );
    -- Q3
    PERFORM public.admin_upsert_question_with_options(
      v_exam_id,
      'In which stage of the HIM career pathway are positions like a Health Information Clerk or Coding Specialist typically found?',
      'multiple_choice', 1,
      '[{"option_text":"Management","is_correct":false},{"option_text":"Mid-Level","is_correct":false},{"option_text":"Executive","is_correct":false},{"option_text":"Entry-Level","is_correct":true}]'::jsonb,
      NULL, 0, 'Entry-level pathways typically require a certificate or associate degree for roles like Health Information Clerks and Coding Specialists.', 3
    );
    -- Q4
    PERFORM public.admin_upsert_question_with_options(
      v_exam_id,
      'Which professional organization stands for AHIMA?',
      'multiple_choice', 1,
      '[{"option_text":"American Academy of Professional Coders","is_correct":false},{"option_text":"American Health Information Management Association","is_correct":true},{"option_text":"Healthcare Information and Management Systems Society","is_correct":false},{"option_text":"Association of Healthcare Information Management Professionals","is_correct":false}]'::jsonb,
      NULL, 0, 'AHIMA stands for the American Health Information Management Association.', 4
    );
    -- Q5
    PERFORM public.admin_upsert_question_with_options(
      v_exam_id,
      'What does the acronym HIS stand for in hospital administration?',
      'multiple_choice', 1,
      '[{"option_text":"Health Information Standard","is_correct":false},{"option_text":"Hospital Information System","is_correct":true},{"option_text":"Healthcare Integrated Service","is_correct":false},{"option_text":"Hospital Imaging System","is_correct":false}]'::jsonb,
      NULL, 0, 'HIS stands for Hospital Information System.', 5
    );
    -- Q6
    PERFORM public.admin_upsert_question_with_options(
      v_exam_id,
      'Which of the following is not listed as one of the ten applications of a Hospital Information System (HIS)?',
      'multiple_choice', 1,
      '[{"option_text":"Billing/Account Receivable (BAR)","is_correct":false},{"option_text":"Pharmacy (PHA)","is_correct":false},{"option_text":"Human Resources Payroll (HRP)","is_correct":true},{"option_text":"Community Wide Scheduling (CWS)","is_correct":false}]'::jsonb,
      NULL, 0, 'HRP is not part of the core ten applications listed; the list includes BAR, PHA, CWS, ADM/MRI/ABS, DR, ITS, LIS, OE/EMR, PCS, and Remote Physician Access.', 6
    );
    -- Q7
    PERFORM public.admin_upsert_question_with_options(
      v_exam_id,
      'What term describes the ability of different health information systems to communicate and share information seamlessly?',
      'multiple_choice', 1,
      '[{"option_text":"Interoperability","is_correct":true},{"option_text":"Data Repository","is_correct":false},{"option_text":"Clinical Documentation","is_correct":false},{"option_text":"Revenue Cycle Management","is_correct":false}]'::jsonb,
      NULL, 0, 'Interoperability means different systems can communicate and share information seamlessly.', 7
    );
    -- Q8
    PERFORM public.admin_upsert_question_with_options(
      v_exam_id,
      'Which HIM professional role is primarily responsible for querying physicians and improving the quality of clinical documentation?',
      'multiple_choice', 1,
      '[{"option_text":"Privacy Officer","is_correct":false},{"option_text":"Clinical Documentation Specialist","is_correct":true},{"option_text":"EHR Specialist","is_correct":false},{"option_text":"Data Analyst","is_correct":false}]'::jsonb,
      NULL, 0, 'A Clinical Documentation Specialist queries physicians to improve documentation quality.', 8
    );
    -- Q9
    PERFORM public.admin_upsert_question_with_options(
      v_exam_id,
      'Which component is considered the "memory and nervous system" of a hospital?',
      'multiple_choice', 1,
      '[{"option_text":"The Pharmacy Department","is_correct":false},{"option_text":"A Hospital Information System (HIS)","is_correct":true},{"option_text":"The Medical Records Paper Filing Room","is_correct":false},{"option_text":"The Billing Department","is_correct":false}]'::jsonb,
      NULL, 0, 'A HIS functions as the memory and nervous system of a hospital.', 9
    );
    -- Q10
    PERFORM public.admin_upsert_question_with_options(
      v_exam_id,
      'Which development step is part of the evolution or structure of Hospital Information Systems (HIS) components?',
      'multiple_choice', 1,
      '[{"option_text":"GMIS (Geographical Management Information System)","is_correct":false},{"option_text":"CIS (Clinical Information System)","is_correct":false},{"option_text":"MIS (Management Information System)","is_correct":false},{"option_text":"All of the above","is_correct":true}]'::jsonb,
      NULL, 0, 'GMIS, CIS, and MIS are all referenced in relation to the development steps of HIS components.', 10
    );
    -- Q11..Q15 Short Answer
    PERFORM public.admin_upsert_question_with_options(
      v_exam_id, 'Define Health Information Management (HIM) based on the lecture.',
      'short_answer', 5, '[]'::jsonb, NULL, 0,
      'Health Information Management is the professional practice of collecting, organizing, storing, protecting, and using patients'' health information to support healthcare delivery, decision-making, research, and legal and administrative processes.',
      11, true, '[]'::jsonb,
      '{"required_matches":5,"groups":[["collect","acquir","gather"],["organiz","stor","manag"],["protect","secu","privac","confidential"],["health information","patient","medical record"],["healthcare delivery","decision","research","legal","administrat"]]}'::jsonb
    );
    PERFORM public.admin_upsert_question_with_options(
      v_exam_id, 'List the five main stages in the evolution of Health Information Management.',
      'short_answer', 5, '[]'::jsonb, NULL, 0,
      '1) Paper-based records; 2) Standardized medical records; 3) Professionalization of medical records; 4) Computerized health information systems; 5) Modern digital HIM.',
      12, true, '[]'::jsonb,
      '{"required_matches":5,"groups":[["paper","handwritten","1920"],["standardiz"],["professionaliz"],["computeriz","electronic","1980"],["modern","digital","2000"]]}'::jsonb
    );
    PERFORM public.admin_upsert_question_with_options(
      v_exam_id, 'What are the six core domains of HIM?',
      'short_answer', 5, '[]'::jsonb, NULL, 0,
      'Data Management; Privacy and Security; Clinical Documentation; Coding and Classification; Compliance and Regulation; Informatics and Technology.',
      13, true, '[]'::jsonb,
      '{"required_matches":6,"groups":[["data management"],["privacy","security"],["clinical documentation"],["coding","classification"],["compliance","regulation"],["informatics","technology"]]}'::jsonb
    );
    PERFORM public.admin_upsert_question_with_options(
      v_exam_id, 'Identify five different sources of hospital information.',
      'short_answer', 5, '[]'::jsonb, NULL, 0,
      'Front office / Admissions; Doctors'' consultation rooms; Inpatient wards; Laboratories; Service providers (financial, NHIS, pharmacy, radiology).',
      14, true, '[]'::jsonb,
      '{"required_matches":5,"groups":[["front office","reception","admission","registration"],["consultation","doctor","physician","outpatient","clinic"],["ward","inpatient","nursing"],["laborator","lab","pathology"],["service provider","financial","nhis","insurance","billing","pharmacy","radiology"]]}'::jsonb
    );
    PERFORM public.admin_upsert_question_with_options(
      v_exam_id, 'State five reasons why a Hospital Information System (HIS) is important to a hospital.',
      'short_answer', 5, '[]'::jsonb, NULL, 0,
      '1) Quality factor in healthcare delivery; 2) Cost factor influencing operations; 3) Supports competitiveness between hospitals; 4) Provides a holistic view of patients and operations; 5) Serves as the memory and nervous system of the hospital.',
      15, true, '[]'::jsonb,
      '{"required_matches":5,"groups":[["quality"],["cost","financial","efficiency"],["competitiv"],["holistic","comprehensive","complete view","integrated"],["memory","nervous system"]]}'::jsonb
    );
    -- Q16..Q17 True/False
    PERFORM public.admin_upsert_question_with_options(
      v_exam_id,
      'True or False: Before the 20th century, patient information was primarily recorded manually using handwritten notes, and records were kept by individual physicians without standard formats.',
      'true_false', 1,
      '[{"option_text":"True","is_correct":true},{"option_text":"False","is_correct":false}]'::jsonb,
      NULL, 0, 'True. Early records before the 20th century were handwritten notes maintained individually by physicians without standard formats.', 16
    );
    PERFORM public.admin_upsert_question_with_options(
      v_exam_id,
      'True or False: Incomplete or vague clinical documentation can lead to misdiagnosis, delayed treatment, and denied insurance claims.',
      'true_false', 1,
      '[{"option_text":"True","is_correct":true},{"option_text":"False","is_correct":false}]'::jsonb,
      NULL, 0, 'True. Incomplete or vague documentation can cause misdiagnosis, delayed treatment, and denied insurance claims.', 17
    );
    -- Q18..Q20 Fill-in-the-Blank
    PERFORM public.admin_upsert_question_with_options(
      v_exam_id,
      'Translating medical encounters into standardized codes, such as using ________ for diagnoses, is a core domain of HIM.',
      'fill_in_blank', 1, '[]'::jsonb, NULL, 0,
      'ICD-10 is used for diagnoses, while CPT is used for procedures.',
      18, true, '["ICD-10","ICD 10","ICD10","ICD-10-CM"]'::jsonb, '[]'::jsonb
    );
    PERFORM public.admin_upsert_question_with_options(
      v_exam_id,
      'The credential RHIA stands for Registered Health Information ________.',
      'fill_in_blank', 1, '[]'::jsonb, NULL, 0,
      'RHIA stands for Registered Health Information Administrator (whereas RHIT stands for Registered Health Information Technician).',
      19, true, '["Administrator"]'::jsonb, '[]'::jsonb
    );
    PERFORM public.admin_upsert_question_with_options(
      v_exam_id,
      'In the ten applications of HIS, ADM/MRI/ABS stands for Admissions, Medical Records and ________.',
      'fill_in_blank', 1, '[]'::jsonb, NULL, 0,
      'ADM/MRI/ABS stands for Admissions, Medical Records and Abstracting.',
      20, true, '["Abstracting"]'::jsonb, '[]'::jsonb
    );

    PERFORM public.admin_publish_exam(v_exam_id);
  ELSE
    UPDATE public.exams
    SET title = 'AIM 105: Health Information Management & Hospital Information Systems',
        is_open = true,
        open_to_all = true,
        max_attempts = GREATEST(max_attempts, 100),
        retake_cooldown_minutes = 180
    WHERE id = v_exam_id;
  END IF;

  INSERT INTO public.exam_assignments (exam_id, class_id, assigned_by, assignment_status)
  VALUES (v_exam_id, v_class_id, v_admin_id, 'active')
  ON CONFLICT (exam_id, class_id) WHERE class_id IS NOT NULL DO NOTHING;
END
$$;
