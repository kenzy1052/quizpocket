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
