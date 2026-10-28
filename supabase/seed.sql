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
