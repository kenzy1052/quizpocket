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
