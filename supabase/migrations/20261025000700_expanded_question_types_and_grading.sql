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
