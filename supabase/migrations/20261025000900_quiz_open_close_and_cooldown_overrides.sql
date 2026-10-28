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
