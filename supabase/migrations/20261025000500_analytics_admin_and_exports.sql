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
