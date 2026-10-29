-- Migration 20261025001100: Add current_question_index and live monitoring RPCs

ALTER TABLE public.exam_attempts
  ADD COLUMN IF NOT EXISTS current_question_index integer NOT NULL DEFAULT 0;

-- Function for student to update their current question index & ping heartbeat
CREATE OR REPLACE FUNCTION public.student_record_question_position(
  p_attempt_id uuid,
  p_question_index integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_student_id uuid;
  v_attempt public.exam_attempts%ROWTYPE;
BEGIN
  v_student_id := auth.uid();
  IF v_student_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHORIZED: Authentication required.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_attempt
  FROM public.exam_attempts
  WHERE id = p_attempt_id AND student_id = v_student_id;

  IF v_attempt.id IS NULL THEN
    RAISE EXCEPTION 'ATTEMPT_NOT_FOUND: Attempt not found.' USING ERRCODE = 'P0002';
  END IF;

  IF v_attempt.status = 'in_progress' AND public.utc_now() > v_attempt.deadline_at THEN
    -- If deadline has expired, perform automatic submission
    PERFORM public.student_submit_attempt(p_attempt_id);
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'ATTEMPT_DEADLINE_EXPIRED',
      'message', 'The examination deadline has elapsed.'
    );
  END IF;

  IF v_attempt.status = 'in_progress' THEN
    UPDATE public.exam_attempts
    SET
      current_question_index = GREATEST(0, p_question_index),
      last_activity_at = public.utc_now()
    WHERE id = p_attempt_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'current_question_index', GREATEST(0, p_question_index));
END;
$$;

REVOKE ALL ON FUNCTION public.student_record_question_position(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.student_record_question_position(uuid, integer) TO authenticated, service_role;

-- Function for administrators to monitor live examination attempts
CREATE OR REPLACE FUNCTION public.admin_list_live_monitoring(p_exam_id uuid DEFAULT NULL)
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
        'attempt_id', a.id,
        'student_id', p.id,
        'student_name', p.full_name,
        'student_identifier', p.student_identifier,
        'student_email', p.email,
        'exam_id', e.id,
        'exam_title', e.title,
        'duration_minutes', e.duration_minutes,
        'attempt_number', a.attempt_number,
        'status', a.status,
        'started_at', a.started_at,
        'deadline_at', a.deadline_at,
        'submitted_at', a.submitted_at,
        'last_activity_at', a.last_activity_at,
        'current_question_index', COALESCE(a.current_question_index, 0),
        'total_questions', (
          SELECT COUNT(*)::integer
          FROM public.exam_questions eq
          WHERE eq.exam_id = e.id
        ),
        'answered_questions', (
          SELECT COUNT(DISTINCT sa.question_id)::integer
          FROM public.student_answers sa
          WHERE sa.attempt_id = a.id
            AND (sa.selected_option_id IS NOT NULL OR (sa.answer_value IS NOT NULL AND btrim(sa.answer_value) <> ''))
        ),
        'seconds_remaining', GREATEST(0, EXTRACT(EPOCH FROM (a.deadline_at - public.utc_now()))::integer),
        'is_active', (a.status = 'in_progress' AND a.deadline_at > public.utc_now())
      )
      ORDER BY
        (a.status = 'in_progress') DESC,
        a.last_activity_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_rows
  FROM public.exam_attempts a
  JOIN public.exams e ON e.id = a.exam_id
  JOIN public.profiles p ON p.id = a.student_id
  WHERE e.institution_id = v_inst
    AND (p_exam_id IS NULL OR a.exam_id = p_exam_id)
    AND (
      a.status = 'in_progress'
      OR a.submitted_at >= (public.utc_now() - interval '4 hours')
    );

  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_live_monitoring(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_live_monitoring(uuid) TO authenticated, service_role;

-- Function for administrator to get live question-by-question progress for an individual attempt
CREATE OR REPLACE FUNCTION public.admin_get_attempt_live_status(p_attempt_id uuid)
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
    RAISE EXCEPTION 'ATTEMPT_NOT_FOUND: Attempt not found in your institution.' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_exam FROM public.exams WHERE id = v_attempt.exam_id;
  SELECT * INTO v_student FROM public.profiles WHERE id = v_attempt.student_id;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'question_id', q.id,
        'display_order', q.display_order,
        'question_type', q.question_type,
        'marks', q.marks,
        'is_answered', (sa.id IS NOT NULL AND (sa.selected_option_id IS NOT NULL OR (sa.answer_value IS NOT NULL AND btrim(sa.answer_value) <> ''))),
        'saved_at', sa.saved_at,
        'revision', sa.revision,
        'is_current', (q.display_order = (COALESCE(v_attempt.current_question_index, 0) + 1))
      )
      ORDER BY q.display_order ASC
    ),
    '[]'::jsonb
  )
  INTO v_questions
  FROM public.exam_questions q
  LEFT JOIN public.student_answers sa
    ON sa.attempt_id = v_attempt.id AND sa.question_id = q.id
  WHERE q.exam_id = v_exam.id;

  RETURN jsonb_build_object(
    'attempt_id', v_attempt.id,
    'exam_id', v_exam.id,
    'exam_title', v_exam.title,
    'duration_minutes', v_exam.duration_minutes,
    'student_id', v_student.id,
    'student_name', v_student.full_name,
    'student_identifier', v_student.student_identifier,
    'student_email', v_student.email,
    'status', v_attempt.status,
    'attempt_number', v_attempt.attempt_number,
    'started_at', v_attempt.started_at,
    'deadline_at', v_attempt.deadline_at,
    'submitted_at', v_attempt.submitted_at,
    'last_activity_at', v_attempt.last_activity_at,
    'current_question_index', COALESCE(v_attempt.current_question_index, 0),
    'seconds_remaining', GREATEST(0, EXTRACT(EPOCH FROM (v_attempt.deadline_at - public.utc_now()))::integer),
    'total_questions', jsonb_array_length(v_questions),
    'questions', v_questions
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_get_attempt_live_status(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_attempt_live_status(uuid) TO authenticated, service_role;
