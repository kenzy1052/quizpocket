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
