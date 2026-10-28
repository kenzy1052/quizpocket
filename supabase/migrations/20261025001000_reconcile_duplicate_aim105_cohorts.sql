-- Safely reconcile the legacy HIM-101 and canonical AIM-105 cohort names.
-- This forward migration also repairs databases where migration 0009 had been
-- run manually or recorded as applied before the duplicate-name failure.
DO $$
DECLARE
  v_inst uuid;
  v_target_class_id uuid;
  v_source record;
BEGIN
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
