-- ============================================================================
-- Migration 0011: Seed "HIM 101: Software System" Examination (40 Questions, 60 Min, 50 Marks)
-- Project: QuizPocket — Online Examination & Assessment Platform
-- Covers: HIM 101 Computer Software & System Software (Slides 1–62)
-- Structure:
--   • Section A: Questions 1–35 — Multiple Choice (1 Mark each = 35 Marks, auto-graded)
--   • Section B: Questions 36–40 — Short Answer (3 Marks each = 15 Marks, instructor reviewed)
--   • Total: 50 Marks | Duration: 60 Minutes | Passing: 50%
-- ============================================================================

DO $$
DECLARE
  v_admin_id uuid;
  v_inst_id uuid;
  v_exam_id uuid;
  v_q_id uuid;
  v_class_rec record;
BEGIN
  -- 1. Identify active administrator and institution
  SELECT id INTO v_admin_id
  FROM public.profiles
  WHERE role = 'admin'
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_admin_id IS NULL THEN
    SELECT id INTO v_admin_id FROM public.profiles ORDER BY created_at ASC LIMIT 1;
  END IF;

  IF v_admin_id IS NULL THEN
    -- In fresh test harnesses where migrations run before seed users exist,
    -- the runtime gateway (LocalPostgresBackendGateway / runtimeGatewayFactory)
    -- will seed HIM 101 once the admin user is created.
    RETURN;
  END IF;

  SELECT id INTO v_inst_id FROM public.institutions LIMIT 1;
  IF v_inst_id IS NULL THEN
    v_inst_id := '00000000-0000-0000-0000-000000000001'::uuid;
  END IF;

  -- 2. Prevent legacy rename conflict
  UPDATE public.exams
  SET title = 'HIM 105 Lecture 1'
  WHERE title IN ('HIM-101', 'HIM 101', 'HIM 101 Health Information Management');

  -- 3. Idempotently create or locate "HIM 101: Software System"
  SELECT id INTO v_exam_id
  FROM public.exams
  WHERE title = 'HIM 101: Software System'
    AND status <> 'archived'
  LIMIT 1;

  IF v_exam_id IS NULL THEN
    INSERT INTO public.exams (
      institution_id,
      title,
      description,
      instructions,
      duration_minutes,
      total_marks,
      passing_percentage,
      status,
      result_release_policy,
      results_released_manually,
      allow_review,
      shuffle_questions,
      shuffle_options,
      max_attempts,
      retake_cooldown_minutes,
      open_to_all,
      is_open,
      created_by,
      published_at,
      created_at,
      updated_at
    )
    VALUES (
      v_inst_id,
      'HIM 101: Software System',
      'Comprehensive examination on Computer Software & System Software covering operating system functions, 5-stage booting, process and memory management, virtual memory and thrashing, spooling, device drivers, server OS, virtualization, and utility programs.',
      'This examination consists of 40 questions allocated for 60 minutes (1 hour) with a total of 50 marks. Section A contains 35 Multiple Choice Questions (Questions 1–35, 1 mark each = 35 marks). Section B contains 5 Short Answer Questions (Questions 36–40, 3 marks each = 15 marks). You may navigate between questions using the Question Navigator pane. When you submit your exam, your Section A objective score (out of 35) is calculated immediately. Your Section B short answer responses are submitted to the instructor for evaluation (out of 15 marks). Your final score (out of 50) will be released following instructor review.',
      60,
      50,
      50.00,
      'published',
      'immediate',
      false,
      true,
      false,
      false,
      100,
      180,
      true,
      true,
      v_admin_id,
      public.utc_now(),
      public.utc_now(),
      public.utc_now()
    )
    RETURNING id INTO v_exam_id;
  ELSE
    UPDATE public.exams
    SET description = 'Comprehensive examination on Computer Software & System Software covering operating system functions, 5-stage booting, process and memory management, virtual memory and thrashing, spooling, device drivers, server OS, virtualization, and utility programs.',
        instructions = 'This examination consists of 40 questions allocated for 60 minutes (1 hour) with a total of 50 marks. Section A contains 35 Multiple Choice Questions (Questions 1–35, 1 mark each = 35 marks). Section B contains 5 Short Answer Questions (Questions 36–40, 3 marks each = 15 marks). You may navigate between questions using the Question Navigator pane. When you submit your exam, your Section A objective score (out of 35) is calculated immediately. Your Section B short answer responses are submitted to the instructor for evaluation (out of 15 marks). Your final score (out of 50) will be released following instructor review.',
        duration_minutes = 60,
        total_marks = 50,
        passing_percentage = 50.00,
        status = 'published',
        is_open = true,
        open_to_all = true,
        max_attempts = 100,
        retake_cooldown_minutes = 180,
        updated_at = public.utc_now()
    WHERE id = v_exam_id;

    -- Clean previous questions to ensure pristine sequence on re-run
    DELETE FROM public.question_options
    WHERE question_id IN (SELECT id FROM public.exam_questions WHERE exam_id = v_exam_id);
    DELETE FROM public.exam_questions WHERE exam_id = v_exam_id;
  END IF;

  -- ============================================================================
  -- SECTION A: 35 MULTIPLE CHOICE QUESTIONS (Q1–Q35, 1 Mark Each = 35 Marks)
  -- ============================================================================

  -- Q1
  INSERT INTO public.exam_questions (exam_id, display_order, question_type, marks, negative_marks, is_required, question_text, explanation)
  VALUES (v_exam_id, 1, 'multiple_choice', 1, 0, true,
    'Which of the following best defines computer software?',
    'Software consists of a series of related instructions, organized for a common purpose, that directs hardware on what operations to perform and how to carry them out.'
  ) RETURNING id INTO v_q_id;
  INSERT INTO public.question_options (question_id, display_order, is_correct, option_text) VALUES
    (v_q_id, 1, false, 'The physical, electronic, and mechanical components that comprise a computer system'),
    (v_q_id, 2, true,  'A series of related instructions organized for a common purpose that tells the computer what tasks to perform and how'),
    (v_q_id, 3, false, 'The permanent semiconductor chips embedded on the motherboard storing system firmware'),
    (v_q_id, 4, false, 'The peripheral input and output devices used to interface with human operators');

  -- Q2
  INSERT INTO public.exam_questions (exam_id, display_order, question_type, marks, negative_marks, is_required, question_text, explanation)
  VALUES (v_exam_id, 2, 'multiple_choice', 1, 0, true,
    'How does system software fundamentally differ from application software?',
    'System software controls and maintains the operations of the computer and its devices, serving as the bridge between application software, human users, and system hardware.'
  ) RETURNING id INTO v_q_id;
  INSERT INTO public.question_options (question_id, display_order, is_correct, option_text) VALUES
    (v_q_id, 1, false, 'System software is exclusively written in interpreted languages, whereas application software is compiled.'),
    (v_q_id, 2, true,  'System software serves as the interface between the user, application software, and computer hardware, whereas application software performs user-specific productivity tasks.'),
    (v_q_id, 3, false, 'System software can only run when connected to the Internet, whereas application software runs completely offline.'),
    (v_q_id, 4, false, 'System software requires user interaction for every instruction, whereas application software operates autonomously in background firmware.');

  -- Q3
  INSERT INTO public.exam_questions (exam_id, display_order, question_type, marks, negative_marks, is_required, question_text, explanation)
  VALUES (v_exam_id, 3, 'multiple_choice', 1, 0, true,
    'Which category of software is permanently or semi-permanently etched into non-volatile read-only memory (ROM) chips on hardware devices?',
    'Firmware consists of ROM-based software instructions etched onto hardware chips (such as the system BIOS) that control basic device operation without needing disk storage.'
  ) RETURNING id INTO v_q_id;
  INSERT INTO public.question_options (question_id, display_order, is_correct, option_text) VALUES
    (v_q_id, 1, false, 'Middleware'),
    (v_q_id, 2, true,  'Firmware'),
    (v_q_id, 3, false, 'Freeware'),
    (v_q_id, 4, false, 'Shareware');

  -- Q4
  INSERT INTO public.exam_questions (exam_id, display_order, question_type, marks, negative_marks, is_required, question_text, explanation)
  VALUES (v_exam_id, 4, 'multiple_choice', 1, 0, true,
    'What is the primary function of middleware in enterprise software environments?',
    'Middleware is software that acts as a bridge or connector between different applications, databases, or network architectures to allow seamless data exchange.'
  ) RETURNING id INTO v_q_id;
  INSERT INTO public.question_options (question_id, display_order, is_correct, option_text) VALUES
    (v_q_id, 1, false, 'To provide diagnostic hardware cooling controls inside system chassis'),
    (v_q_id, 2, true,  'To enable communication, data exchange, and management between disparate software applications and operating systems'),
    (v_q_id, 3, false, 'To compile source code into machine instructions during system booting'),
    (v_q_id, 4, false, 'To defragment fragmented disk blocks on optical storage media');

  -- Q5
  INSERT INTO public.exam_questions (exam_id, display_order, question_type, marks, negative_marks, is_required, question_text, explanation)
  VALUES (v_exam_id, 5, 'multiple_choice', 1, 0, true,
    'What is the core component of an operating system that remains resident in RAM while the computer is running?',
    'The kernel is the core of an operating system. It manages memory, processes, and devices, maintaining resident status in RAM from boot time until the computer is powered down.'
  ) RETURNING id INTO v_q_id;
  INSERT INTO public.question_options (question_id, display_order, is_correct, option_text) VALUES
    (v_q_id, 1, false, 'The Shell'),
    (v_q_id, 2, true,  'The Kernel'),
    (v_q_id, 3, false, 'The Spooler'),
    (v_q_id, 4, false, 'The Hypervisor');

  -- Q6
  INSERT INTO public.exam_questions (exam_id, display_order, question_type, marks, negative_marks, is_required, question_text, explanation)
  VALUES (v_exam_id, 6, 'multiple_choice', 1, 0, true,
    'What distinguishes a "cold boot" from a "warm boot"?',
    'A cold boot (cold start) powers up a computer from a completely unpowered state, whereas a warm boot restarts the system while electrical power remains active.'
  ) RETURNING id INTO v_q_id;
  INSERT INTO public.question_options (question_id, display_order, is_correct, option_text) VALUES
    (v_q_id, 1, false, 'A cold boot restarts the computer using an operating system menu command, whereas a warm boot requires cycling electrical power switches.'),
    (v_q_id, 2, true,  'A cold boot powers on a computer that has been turned completely off, whereas a warm boot uses operating system instructions to restart without turning power off.'),
    (v_q_id, 3, false, 'A cold boot clears cache memory only, whereas a warm boot overwrites firmware instructions in CMOS.'),
    (v_q_id, 4, false, 'A cold boot is used solely for server operating systems, whereas a warm boot is restricted to embedded systems.');

  -- Q7
  INSERT INTO public.exam_questions (exam_id, display_order, question_type, marks, negative_marks, is_required, question_text, explanation)
  VALUES (v_exam_id, 7, 'multiple_choice', 1, 0, true,
    'During the 5-step boot process, what is the immediate purpose of the Power-On Self-Test (POST)?',
    'The Power-On Self-Test (POST) runs during step 2 of booting. The BIOS tests system hardware components (such as memory modules, keyboard, and storage controllers) for functional integrity.'
  ) RETURNING id INTO v_q_id;
  INSERT INTO public.question_options (question_id, display_order, is_correct, option_text) VALUES
    (v_q_id, 1, false, 'To compress user documents on the primary solid-state drive'),
    (v_q_id, 2, true,  'To perform diagnostic tests that check system components like RAM, keyboard, buses, and drives for proper electrical function'),
    (v_q_id, 3, false, 'To establish an encrypted VPN connection to the institutional domain controller'),
    (v_q_id, 4, false, 'To defragment fragmented clusters in virtual memory before loading the GUI');

  -- Q8
  INSERT INTO public.exam_questions (exam_id, display_order, question_type, marks, negative_marks, is_required, question_text, explanation)
  VALUES (v_exam_id, 8, 'multiple_choice', 1, 0, true,
    'What role does the CMOS chip play during the system boot sequence?',
    'CMOS memory stores configuration data such as drive parameters, current time/date, and hardware inventory, which the BIOS compares against hardware detected during POST.'
  ) RETURNING id INTO v_q_id;
  INSERT INTO public.question_options (question_id, display_order, is_correct, option_text) VALUES
    (v_q_id, 1, false, 'It stores the entire operating system graphical user interface permanently.'),
    (v_q_id, 2, true,  'It contains the configuration parameters (such as drive configurations, system clock, and boot order) that POST compares against detected hardware.'),
    (v_q_id, 3, false, 'It acts as the primary paging swap file for virtual memory.'),
    (v_q_id, 4, false, 'It translates high-level printer commands into dot-matrix raster patterns.');

  -- Q9
  INSERT INTO public.exam_questions (exam_id, display_order, question_type, marks, negative_marks, is_required, question_text, explanation)
  VALUES (v_exam_id, 9, 'multiple_choice', 1, 0, true,
    'How does Sleep mode differ from Hibernate mode on a modern workstation?',
    'Sleep mode saves the active desktop state to RAM and enters a low-power state for near-instant wake-up. Hibernate saves RAM state to a disk file (hiberfil.sys) and powers off completely.'
  ) RETURNING id INTO v_q_id;
  INSERT INTO public.question_options (question_id, display_order, is_correct, option_text) VALUES
    (v_q_id, 1, false, 'Sleep mode writes open state to the hard disk and cuts all power, whereas Hibernate mode keeps RAM powered.'),
    (v_q_id, 2, true,  'Sleep mode maintains open documents and programs in physical RAM using low power, whereas Hibernate mode writes all memory contents to the disk/SSD and cuts power completely.'),
    (v_q_id, 3, false, 'Sleep mode takes several minutes to resume, whereas Hibernate mode resumes in milliseconds.'),
    (v_q_id, 4, false, 'Sleep mode deletes unsaved data, whereas Hibernate mode automatically sends unsaved files to cloud storage.');

  -- Q10
  INSERT INTO public.exam_questions (exam_id, display_order, question_type, marks, negative_marks, is_required, question_text, explanation)
  VALUES (v_exam_id, 10, 'multiple_choice', 1, 0, true,
    'Which operating system user interface requires users to type exact keywords, parameters, and syntax to issue instructions to the computer?',
    'A Command-Line Interface (CLI) requires users to type precise text commands, switches, and parameters at a prompt to direct operating system operations.'
  ) RETURNING id INTO v_q_id;
  INSERT INTO public.question_options (question_id, display_order, is_correct, option_text) VALUES
    (v_q_id, 1, false, 'Graphical User Interface (GUI)'),
    (v_q_id, 2, true,  'Command-Line Interface (CLI)'),
    (v_q_id, 3, false, 'Natural User Interface (NUI)'),
    (v_q_id, 4, false, 'Touch Gesture Interface (TGI)');

  -- Q11
  INSERT INTO public.exam_questions (exam_id, display_order, question_type, marks, negative_marks, is_required, question_text, explanation)
  VALUES (v_exam_id, 11, 'multiple_choice', 1, 0, true,
    'A user interacts with software by speaking voice commands, touching multi-touch displays, or making physical gestures in front of depth cameras. Which interface model does this describe?',
    'Natural User Interfaces (NUIs) enable interaction through natural human behaviors including speech, touch gestures, facial recognition, and body motion.'
  ) RETURNING id INTO v_q_id;
  INSERT INTO public.question_options (question_id, display_order, is_correct, option_text) VALUES
    (v_q_id, 1, false, 'Command-Line Interface (CLI)'),
    (v_q_id, 2, false, 'Batch Processing Interface (BPI)'),
    (v_q_id, 3, true,  'Natural User Interface (NUI)'),
    (v_q_id, 4, false, 'Menu-Driven Character Interface (MDCI)');

  -- Q12
  INSERT INTO public.exam_questions (exam_id, display_order, question_type, marks, negative_marks, is_required, question_text, explanation)
  VALUES (v_exam_id, 12, 'multiple_choice', 1, 0, true,
    'What capability allows an operating system to execute two or more programs or active tasks concurrently for a single user?',
    'Multitasking allows a computer to run multiple programs concurrently, with the CPU switching between task execution slices so rapidly that they appear simultaneous.'
  ) RETURNING id INTO v_q_id;
  INSERT INTO public.question_options (question_id, display_order, is_correct, option_text) VALUES
    (v_q_id, 1, false, 'Single-tasking'),
    (v_q_id, 2, true,  'Multitasking'),
    (v_q_id, 3, false, 'Virtual Spooling'),
    (v_q_id, 4, false, 'Single-threading');

  -- Q13
  INSERT INTO public.exam_questions (exam_id, display_order, question_type, marks, negative_marks, is_required, question_text, explanation)
  VALUES (v_exam_id, 13, 'multiple_choice', 1, 0, true,
    'In preemptive multitasking, how does the operating system maintain control over processor utilization?',
    'Preemptive multitasking gives the OS authoritative control to interrupt (preempt) running programs and allocate CPU time slices according to priority.'
  ) RETURNING id INTO v_q_id;
  INSERT INTO public.question_options (question_id, display_order, is_correct, option_text) VALUES
    (v_q_id, 1, false, 'It waits until each application voluntarily relinquishes the CPU before giving time to the next program.'),
    (v_q_id, 2, true,  'It allocates specific CPU time slices and interrupts executing programs to switch control to another waiting process.'),
    (v_q_id, 3, false, 'It disables virtual memory whenever more than two background tasks are active.'),
    (v_q_id, 4, false, 'It converts multi-threaded programs into sequential batch cards.');

  -- Q14
  INSERT INTO public.exam_questions (exam_id, display_order, question_type, marks, negative_marks, is_required, question_text, explanation)
  VALUES (v_exam_id, 14, 'multiple_choice', 1, 0, true,
    'What is multiprocessing in modern computing architectures?',
    'Multiprocessing refers to an operating system utilizing two or more physical CPUs or multi-core processors simultaneously to divide and process workloads.'
  ) RETURNING id INTO v_q_id;
  INSERT INTO public.question_options (question_id, display_order, is_correct, option_text) VALUES
    (v_q_id, 1, false, 'Running two copies of an antivirus program on a single core simultaneously'),
    (v_q_id, 2, true,  'The simultaneous use of two or more central processing units or execution cores within a single computer system to execute instructions'),
    (v_q_id, 3, false, 'Storing multiple copies of a document across separate physical hard disk sectors'),
    (v_q_id, 4, false, 'Allowing multiple remote students to log in using a single shared password');

  -- Q15
  INSERT INTO public.exam_questions (exam_id, display_order, question_type, marks, negative_marks, is_required, question_text, explanation)
  VALUES (v_exam_id, 15, 'multiple_choice', 1, 0, true,
    'What is virtual memory?',
    'Virtual memory allows an OS to overcome physical RAM constraints by allocating secondary storage (such as a hard disk or SSD) as an extension of main memory.'
  ) RETURNING id INTO v_q_id;
  INSERT INTO public.question_options (question_id, display_order, is_correct, option_text) VALUES
    (v_q_id, 1, false, 'A software simulation of a 3D gaming headset using cloud rendering'),
    (v_q_id, 2, true,  'A memory management capability where the operating system allocates a portion of secondary storage to function as additional physical RAM'),
    (v_q_id, 3, false, 'A temporary RAM drive created solely for storing firmware updates'),
    (v_q_id, 4, false, 'A permanent read-only sector on optical disks used for system recovery');

  -- Q16
  INSERT INTO public.exam_questions (exam_id, display_order, question_type, marks, negative_marks, is_required, question_text, explanation)
  VALUES (v_exam_id, 16, 'multiple_choice', 1, 0, true,
    'What is the fixed-size block of data transferred between physical RAM and secondary storage during virtual memory operations called?',
    'In virtual memory systems, data and instructions are divided into fixed-size blocks called "pages", which are swapped between RAM and secondary storage.'
  ) RETURNING id INTO v_q_id;
  INSERT INTO public.question_options (question_id, display_order, is_correct, option_text) VALUES
    (v_q_id, 1, false, 'A sector'),
    (v_q_id, 2, false, 'A cluster'),
    (v_q_id, 3, true,  'A page'),
    (v_q_id, 4, false, 'A cylinder');

  -- Q17
  INSERT INTO public.exam_questions (exam_id, display_order, question_type, marks, negative_marks, is_required, question_text, explanation)
  VALUES (v_exam_id, 17, 'multiple_choice', 1, 0, true,
    'What condition occurs when an operating system spends more time swapping pages between RAM and disk than executing instructions, resulting in severe performance degradation?',
    'Thrashing occurs when physical RAM is exhausted and the operating system is forced into continuous, heavy page-swapping between RAM and disk storage, slowing execution to a halt.'
  ) RETURNING id INTO v_q_id;
  INSERT INTO public.question_options (question_id, display_order, is_correct, option_text) VALUES
    (v_q_id, 1, false, 'Deadlock'),
    (v_q_id, 2, true,  'Thrashing'),
    (v_q_id, 3, false, 'Spooling'),
    (v_q_id, 4, false, 'Buffering');

  -- Q18
  INSERT INTO public.exam_questions (exam_id, display_order, question_type, marks, negative_marks, is_required, question_text, explanation)
  VALUES (v_exam_id, 18, 'multiple_choice', 1, 0, true,
    'What is the designated secondary storage file where pages of inactive data from physical memory are temporarily stored in virtual memory called?',
    'A swap file (or paging file, such as pagefile.sys) is the dedicated file on secondary storage used by the OS to hold memory pages swapped out of RAM.'
  ) RETURNING id INTO v_q_id;
  INSERT INTO public.question_options (question_id, display_order, is_correct, option_text) VALUES
    (v_q_id, 1, false, 'Registry file'),
    (v_q_id, 2, true,  'Swap file (pagefile)'),
    (v_q_id, 3, false, 'Index file'),
    (v_q_id, 4, false, 'Spool catalog');

  -- Q19
  INSERT INTO public.exam_questions (exam_id, display_order, question_type, marks, negative_marks, is_required, question_text, explanation)
  VALUES (v_exam_id, 19, 'multiple_choice', 1, 0, true,
    'What is print spooling?',
    'Print spooling sends print jobs to a buffer or temporary storage on disk (the spool) where they wait in queue, releasing the application and CPU immediately without waiting for physical print speeds.'
  ) RETURNING id INTO v_q_id;
  INSERT INTO public.question_options (question_id, display_order, is_correct, option_text) VALUES
    (v_q_id, 1, false, 'The physical process of winding ink ribbons inside impact printers'),
    (v_q_id, 2, true,  'The process of intercepting print jobs, writing them to a disk buffer or queue, and feeding them to the printer at device speed so the CPU remains free for applications'),
    (v_q_id, 3, false, 'Compressing graphics files into vector format before sending them over Bluetooth'),
    (v_q_id, 4, false, 'Scanning documents for optical character recognition before archiving');

  -- Q20
  INSERT INTO public.exam_questions (exam_id, display_order, question_type, marks, negative_marks, is_required, question_text, explanation)
  VALUES (v_exam_id, 20, 'multiple_choice', 1, 0, true,
    'What is a device driver?',
    'A device driver is a specialized software program that converts generalized operating system I/O instructions into the proprietary hardware signals required by a specific peripheral device.'
  ) RETURNING id INTO v_q_id;
  INSERT INTO public.question_options (question_id, display_order, is_correct, option_text) VALUES
    (v_q_id, 1, false, 'A mechanical arm that aligns laser heads inside magnetic storage drives'),
    (v_q_id, 2, true,  'A specialized program that tells the operating system how to communicate with and control a specific hardware device'),
    (v_q_id, 3, false, 'A utility program designed solely to clean dust and debris from cooling fans'),
    (v_q_id, 4, false, 'A hardware expansion card that provides additional USB ports');

  -- Q21
  INSERT INTO public.exam_questions (exam_id, display_order, question_type, marks, negative_marks, is_required, question_text, explanation)
  VALUES (v_exam_id, 21, 'multiple_choice', 1, 0, true,
    'What is the feature of modern operating systems that automatically configures new hardware devices as soon as they are connected to the computer?',
    'Plug and Play (PnP) enables the operating system to automatically detect, assign resources to, and load drivers for newly connected hardware peripherals without manual jumper configuration.'
  ) RETURNING id INTO v_q_id;
  INSERT INTO public.question_options (question_id, display_order, is_correct, option_text) VALUES
    (v_q_id, 1, true,  'Plug and Play (PnP)'),
    (v_q_id, 2, false, 'Dynamic Link Library (DLL)'),
    (v_q_id, 3, false, 'Spool and Run'),
    (v_q_id, 4, false, 'Auto-Defrag');

  -- Q22
  INSERT INTO public.exam_questions (exam_id, display_order, question_type, marks, negative_marks, is_required, question_text, explanation)
  VALUES (v_exam_id, 22, 'multiple_choice', 1, 0, true,
    'Which operating system tool tracks and displays real-time statistics regarding processor utilization, memory allocation, network throughput, and disk read/write activity?',
    'A Performance Monitor or Resource Monitor utility assesses and reports real-time system resource consumption, including CPU, memory, disk activity, and network bandwidth.'
  ) RETURNING id INTO v_q_id;
  INSERT INTO public.question_options (question_id, display_order, is_correct, option_text) VALUES
    (v_q_id, 1, false, 'Disk Defragmenter'),
    (v_q_id, 2, true,  'Performance Monitor (Resource Monitor)'),
    (v_q_id, 3, false, 'File Compression Utility'),
    (v_q_id, 4, false, 'Uninstaller');

  -- Q23
  INSERT INTO public.exam_questions (exam_id, display_order, question_type, marks, negative_marks, is_required, question_text, explanation)
  VALUES (v_exam_id, 23, 'multiple_choice', 1, 0, true,
    'Which Microsoft operating system family is specifically engineered to manage client-server enterprise networks, Active Directory domains, and virtualization workloads?',
    'Windows Server (such as Windows Server 2008, 2016, 2019, 2022) is engineered for enterprise networks, managing shared resources, domain security, network services, and virtualization.'
  ) RETURNING id INTO v_q_id;
  INSERT INTO public.question_options (question_id, display_order, is_correct, option_text) VALUES
    (v_q_id, 1, false, 'Windows 10 Home'),
    (v_q_id, 2, true,  'Windows Server'),
    (v_q_id, 3, false, 'Windows CE'),
    (v_q_id, 4, false, 'MS-DOS');

  -- Q24
  INSERT INTO public.exam_questions (exam_id, display_order, question_type, marks, negative_marks, is_required, question_text, explanation)
  VALUES (v_exam_id, 24, 'multiple_choice', 1, 0, true,
    'What is virtualization in server computing?',
    'Virtualization abstracts physical hardware so that multiple isolated virtual environments (virtual machines) can run their own operating systems on one physical server.'
  ) RETURNING id INTO v_q_id;
  INSERT INTO public.question_options (question_id, display_order, is_correct, option_text) VALUES
    (v_q_id, 1, false, 'Replacing physical computer monitors with virtual reality headsets'),
    (v_q_id, 2, true,  'The practice of sharing or partitioning computing resources to run multiple operating system environments simultaneously on a single physical host machine'),
    (v_q_id, 3, false, 'Backing up database tables to optical CD-ROM discs'),
    (v_q_id, 4, false, 'Translating high-level programming languages into assembly language');

  -- Q25
  INSERT INTO public.exam_questions (exam_id, display_order, question_type, marks, negative_marks, is_required, question_text, explanation)
  VALUES (v_exam_id, 25, 'multiple_choice', 1, 0, true,
    'In virtualization terminology, what is the role of the "host operating system"?',
    'The host operating system is installed directly on the physical hardware and coordinates physical resources, supporting the virtualization layer that hosts guest operating systems.'
  ) RETURNING id INTO v_q_id;
  INSERT INTO public.question_options (question_id, display_order, is_correct, option_text) VALUES
    (v_q_id, 1, false, 'The guest operating system running inside a virtual sandbox'),
    (v_q_id, 2, true,  'The primary operating system that runs directly on the physical computer hardware and hosts the virtualization software or hypervisor'),
    (v_q_id, 3, false, 'An application software package used exclusively for viewing PDF documents'),
    (v_q_id, 4, false, 'A temporary boot firmware chip located on the graphics card');

  -- Q26
  INSERT INTO public.exam_questions (exam_id, display_order, question_type, marks, negative_marks, is_required, question_text, explanation)
  VALUES (v_exam_id, 26, 'multiple_choice', 1, 0, true,
    'What is the operating system running inside an isolated virtual machine called?',
    'The operating system installed inside a virtual machine environment is referred to as the guest operating system.'
  ) RETURNING id INTO v_q_id;
  INSERT INTO public.question_options (question_id, display_order, is_correct, option_text) VALUES
    (v_q_id, 1, false, 'Host OS'),
    (v_q_id, 2, true,  'Guest OS'),
    (v_q_id, 3, false, 'Firmware OS'),
    (v_q_id, 4, false, 'Master OS');

  -- Q27
  INSERT INTO public.exam_questions (exam_id, display_order, question_type, marks, negative_marks, is_required, question_text, explanation)
  VALUES (v_exam_id, 27, 'multiple_choice', 1, 0, true,
    'Which edition of Windows 10 is designed specifically for academic institutions, incorporating enterprise-grade security and classroom management tools?',
    'Windows 10 Education is customized for academic settings, providing staff and students with advanced security, management, and administrative tools derived from Windows 10 Enterprise.'
  ) RETURNING id INTO v_q_id;
  INSERT INTO public.question_options (question_id, display_order, is_correct, option_text) VALUES
    (v_q_id, 1, false, 'Windows 10 Home'),
    (v_q_id, 2, false, 'Windows 10 Mobile'),
    (v_q_id, 3, true,  'Windows 10 Education'),
    (v_q_id, 4, false, 'Windows 10 Starter');

  -- Q28
  INSERT INTO public.exam_questions (exam_id, display_order, question_type, marks, negative_marks, is_required, question_text, explanation)
  VALUES (v_exam_id, 28, 'multiple_choice', 1, 0, true,
    'The Mac operating system (macOS / OS X) is fundamentally built upon which established operating system foundation?',
    'macOS (originally Mac OS X) is built upon a UNIX-based kernel (Darwin), delivering high stability, POSIX compliance, and robust multi-user security.'
  ) RETURNING id INTO v_q_id;
  INSERT INTO public.question_options (question_id, display_order, is_correct, option_text) VALUES
    (v_q_id, 1, false, 'MS-DOS'),
    (v_q_id, 2, true,  'UNIX'),
    (v_q_id, 3, false, 'OS/2 Warp'),
    (v_q_id, 4, false, 'VMS');

  -- Q29
  INSERT INTO public.exam_questions (exam_id, display_order, question_type, marks, negative_marks, is_required, question_text, explanation)
  VALUES (v_exam_id, 29, 'multiple_choice', 1, 0, true,
    'Which operating system was created by Linus Torvalds in 1991 as an open-source, UNIX-compatible operating system kernel available under free software licenses?',
    'Linux was developed by Linus Torvalds in 1991. It is an open-source, UNIX-compatible kernel whose source code can be modified and distributed by anyone worldwide.'
  ) RETURNING id INTO v_q_id;
  INSERT INTO public.question_options (question_id, display_order, is_correct, option_text) VALUES
    (v_q_id, 1, false, 'Windows NT'),
    (v_q_id, 2, false, 'Solaris'),
    (v_q_id, 3, true,  'Linux'),
    (v_q_id, 4, false, 'iOS');

  -- Q30
  INSERT INTO public.exam_questions (exam_id, display_order, question_type, marks, negative_marks, is_required, question_text, explanation)
  VALUES (v_exam_id, 30, 'multiple_choice', 1, 0, true,
    'Where are embedded operating systems typically found?',
    'Embedded operating systems reside on ROM chips inside dedicated electronic devices, smartphones, consumer appliances, smart cars, and medical telemetry units.'
  ) RETURNING id INTO v_q_id;
  INSERT INTO public.question_options (question_id, display_order, is_correct, option_text) VALUES
    (v_q_id, 1, false, 'Exclusively in multi-chassis corporate data centers'),
    (v_q_id, 2, true,  'In specialized devices such as digital cameras, automotive dashboard systems, smart TVs, and medical telemetry devices'),
    (v_q_id, 3, false, 'Only on high-end mainframe supercomputers'),
    (v_q_id, 4, false, 'In legacy punch-card reading machines');

  -- Q31
  INSERT INTO public.exam_questions (exam_id, display_order, question_type, marks, negative_marks, is_required, question_text, explanation)
  VALUES (v_exam_id, 31, 'multiple_choice', 1, 0, true,
    'What is the function of a disk defragmenter utility program?',
    'A disk defragmenter reorganizes fragmented files on magnetic storage so that related file sectors are physically contiguous, minimizing drive head movements and accelerating read/write speeds.'
  ) RETURNING id INTO v_q_id;
  INSERT INTO public.question_options (question_id, display_order, is_correct, option_text) VALUES
    (v_q_id, 1, false, 'To erase all temporary browser cookies and caches from the computer'),
    (v_q_id, 2, true,  'To reorganize contiguous files and unused space on a magnetic hard disk so that files are stored in contiguous sectors, speeding up file access'),
    (v_q_id, 3, false, 'To create duplicate copies of the operating system kernel across multiple partitions'),
    (v_q_id, 4, false, 'To convert lossy JPEG images into lossless PNG formats');

  -- Q32
  INSERT INTO public.exam_questions (exam_id, display_order, question_type, marks, negative_marks, is_required, question_text, explanation)
  VALUES (v_exam_id, 32, 'multiple_choice', 1, 0, true,
    'What is the primary role of a personal firewall utility?',
    'A personal firewall inspects inbound and outbound network communications, blocking unauthorized traffic and protecting the computer from network-based exploits and unauthorized access.'
  ) RETURNING id INTO v_q_id;
  INSERT INTO public.question_options (question_id, display_order, is_correct, option_text) VALUES
    (v_q_id, 1, false, 'To extinguish physical electrical fires inside the computer power supply unit'),
    (v_q_id, 2, true,  'To detect and protect a personal computer and its data from unauthorized network intrusions and suspect incoming/outgoing network packets'),
    (v_q_id, 3, false, 'To compress email attachments before transmission'),
    (v_q_id, 4, false, 'To remove physical scratches from optical compact discs');

  -- Q33
  INSERT INTO public.exam_questions (exam_id, display_order, question_type, marks, negative_marks, is_required, question_text, explanation)
  VALUES (v_exam_id, 33, 'multiple_choice', 1, 0, true,
    'How does a computer worm differ from a computer virus?',
    'A computer virus requires an existing host file and human action to propagate, whereas a computer worm is independent malware that actively replicates itself across computer networks without user intervention.'
  ) RETURNING id INTO v_q_id;
  INSERT INTO public.question_options (question_id, display_order, is_correct, option_text) VALUES
    (v_q_id, 1, true,  'A virus requires human execution of an infected host file to spread, whereas a worm copies itself automatically across networks without user intervention.'),
    (v_q_id, 2, false, 'A worm only infects mobile phones, whereas a virus only infects mainframe computers.'),
    (v_q_id, 3, false, 'A virus is open-source software, whereas a worm is proprietary commercial software.'),
    (v_q_id, 4, false, 'A worm harmlessly cleans cache files, whereas a virus permanently deletes BIOS firmware.');

  -- Q34
  INSERT INTO public.exam_questions (exam_id, display_order, question_type, marks, negative_marks, is_required, question_text, explanation)
  VALUES (v_exam_id, 34, 'multiple_choice', 1, 0, true,
    'What type of malicious program masquerades as a legitimate, desirable application (such as a game or utility) while hiding destructive code?',
    'A Trojan horse disguises itself as a legitimate application to deceive the user into installing it. Unlike viruses and worms, a Trojan horse does not replicate itself.'
  ) RETURNING id INTO v_q_id;
  INSERT INTO public.question_options (question_id, display_order, is_correct, option_text) VALUES
    (v_q_id, 1, true,  'Trojan horse'),
    (v_q_id, 2, false, 'Firewall filter'),
    (v_q_id, 3, false, 'Disk defragmenter'),
    (v_q_id, 4, false, 'Print spooler');

  -- Q35
  INSERT INTO public.exam_questions (exam_id, display_order, question_type, marks, negative_marks, is_required, question_text, explanation)
  VALUES (v_exam_id, 35, 'multiple_choice', 1, 0, true,
    'Which file compression category allows exact bit-for-bit reconstruction of the original file when decompressed, making it mandatory for medical records, spreadsheets, and program executables?',
    'Lossless compression preserves 100% of original data bits upon decompression (e.g., ZIP format). Lossy compression (e.g., JPEG, MP3) permanently discards redundant data to achieve higher compression ratios.'
  ) RETURNING id INTO v_q_id;
  INSERT INTO public.question_options (question_id, display_order, is_correct, option_text) VALUES
    (v_q_id, 1, false, 'Lossy compression'),
    (v_q_id, 2, true,  'Lossless compression'),
    (v_q_id, 3, false, 'Destructive sampling'),
    (v_q_id, 4, false, 'Vector rendering');

  -- ============================================================================
  -- SECTION B: 5 SHORT ANSWER QUESTIONS (Q36–Q40, 3 Marks Each = 15 Marks)
  -- ============================================================================

  -- Q36
  INSERT INTO public.exam_questions (
    exam_id, display_order, question_type, marks, negative_marks, is_required,
    question_text, explanation, accepted_answers, rubric_keywords
  )
  VALUES (
    v_exam_id, 36, 'short_answer', 3, 0, true,
    'Distinguish between a cold boot and a warm boot, and explain the specific function of the Power-On Self-Test (POST) during the boot process.',
    'Model Answer & 3-Mark Rubric:
• Point 1 (1 Mark): Cold Boot — powering on a computer that has been turned completely off (cold start).
• Point 2 (1 Mark): Warm Boot — using operating system commands or key combinations (e.g. Ctrl+Alt+Del) to restart the computer without turning electrical power off (warm start).
• Point 3 (1 Mark): Power-On Self-Test (POST) — a diagnostic routine executed by system BIOS/firmware during boot step 2 that checks hardware components (RAM, motherboard, keyboard, storage drives) for proper electrical and functional operation.',
    '[]'::jsonb,
    '[]'::jsonb
  );

  -- Q37
  INSERT INTO public.exam_questions (
    exam_id, display_order, question_type, marks, negative_marks, is_required,
    question_text, explanation, accepted_answers, rubric_keywords
  )
  VALUES (
    v_exam_id, 37, 'short_answer', 3, 0, true,
    'Explain how virtual memory works in modern operating systems. In your response, define the roles of the swap file, paging, and the consequence of thrashing.',
    'Model Answer & 3-Mark Rubric:
• Point 1 (1 Mark): Virtual Memory Concept — a memory management technique where the OS allocates secondary storage (hard disk or SSD) to act as an extension of physical RAM when main memory is full.
• Point 2 (1 Mark): Paging & Swap File — memory is divided into fixed-size blocks called pages; inactive pages are swapped between RAM and a dedicated swap file (paging file, e.g. pagefile.sys) on disk.
• Point 3 (1 Mark): Thrashing — occurs when the operating system spends more time continuously swapping pages between RAM and disk than executing user instructions, causing the computer to become sluggish or completely unresponsive.',
    '[]'::jsonb,
    '[]'::jsonb
  );

  -- Q38
  INSERT INTO public.exam_questions (
    exam_id, display_order, question_type, marks, negative_marks, is_required,
    question_text, explanation, accepted_answers, rubric_keywords
  )
  VALUES (
    v_exam_id, 38, 'short_answer', 3, 0, true,
    'Differentiate between a host operating system and a guest operating system in the context of system virtualization.',
    'Model Answer & 3-Mark Rubric:
• Point 1 (1.5 Marks): Host Operating System — the primary operating system installed directly on the physical hardware or hypervisor host that manages physical processors, memory, storage, and network interfaces, and provides the virtualization platform.
• Point 2 (1.5 Marks): Guest Operating System — the secondary operating system installed and executing inside an isolated virtual machine (VM) environment on top of the host, unaware that its hardware is virtualized.',
    '[]'::jsonb,
    '[]'::jsonb
  );

  -- Q39
  INSERT INTO public.exam_questions (
    exam_id, display_order, question_type, marks, negative_marks, is_required,
    question_text, explanation, accepted_answers, rubric_keywords
  )
  VALUES (
    v_exam_id, 39, 'short_answer', 3, 0, true,
    'Compare Sleep mode and Hibernate mode in terms of where active system state is preserved and total electrical power consumption.',
    'Model Answer & 3-Mark Rubric:
• Point 1 (1.5 Marks): Sleep Mode — saves active open documents, programs, and desktop state in physical RAM; maintains a tiny trickle of electrical power to RAM chips; allows near-instantaneous resume (seconds).
• Point 2 (1.5 Marks): Hibernate Mode — copies all contents of RAM to a dedicated file on non-volatile secondary storage (hard drive/SSD, e.g. hiberfil.sys) and powers off the computer completely (zero electrical power draw); takes slightly longer to restart as disk state is read back into RAM.',
    '[]'::jsonb,
    '[]'::jsonb
  );

  -- Q40
  INSERT INTO public.exam_questions (
    exam_id, display_order, question_type, marks, negative_marks, is_required,
    question_text, explanation, accepted_answers, rubric_keywords
  )
  VALUES (
    v_exam_id, 40, 'short_answer', 3, 0, true,
    'Contrast computer viruses, computer worms, and Trojan horses with respect to how they replicate and conceal themselves.',
    'Model Answer & 3-Mark Rubric:
• Point 1 (1 Mark): Computer Virus — malicious code that attaches itself to a host program or file; requires human action (such as executing an infected file) to replicate and spread.
• Point 2 (1 Mark): Computer Worm — standalone malicious program that replicates itself automatically across computer networks without requiring human interaction or an existing host file.
• Point 3 (1 Mark): Trojan Horse — malicious software that conceals itself by masquerading as a legitimate, desirable application (game, utility); unlike viruses and worms, it does NOT replicate itself.',
    '[]'::jsonb,
    '[]'::jsonb
  );

  -- 4. Assign to all active auto-enrolling cohorts so every student accesses it
  FOR v_class_rec IN
    SELECT id FROM public.classes WHERE auto_enroll_new_students = true
  LOOP
    INSERT INTO public.exam_assignments (exam_id, class_id, assignment_status, assigned_by)
    VALUES (v_exam_id, v_class_rec.id, 'active', v_admin_id)
    ON CONFLICT (exam_id, class_id) DO UPDATE SET assignment_status = 'active';
  END LOOP;

  -- 5. Auto-enroll all active students into the default cohort
  INSERT INTO public.class_memberships (class_id, student_id, membership_status)
  SELECT c.id, p.id, 'active'::public.membership_status
  FROM public.classes c
  CROSS JOIN public.profiles p
  WHERE c.auto_enroll_new_students = true
    AND p.role = 'student'
    AND p.account_status = 'active'
  ON CONFLICT (class_id, student_id) DO UPDATE SET membership_status = 'active';

END
$$;
