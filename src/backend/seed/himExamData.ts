import { CreateExamInput, DemoAccountSummary, UpsertQuestionInput } from '../types/domain.ts';

export const HIM_DEMO_ACCOUNTS: DemoAccountSummary[] = [
  {
    label: 'Amina Okafor (Student)',
    role: 'student',
    username: 'Amina Okafor',
    email: 'amina.okafor@quizpocket.edu',
    password: 'QuizPocket#Student1',
    note: 'Assigned to HIM 105 Lecture 1 (20 questions, 30 min) — ready to start Attempt 1',
  },
  {
    label: 'kenzy (Administrator)',
    role: 'admin',
    username: 'kenzy',
    email: 'kenzy@users.quizpocket.local',
    password: 'kenzy1052',
    note: 'Full quiz open/close controls, cooldown overrides, rubric grading & CSV export',
  },
  {
    label: 'Marcus Rivera (Student)',
    role: 'student',
    username: 'Marcus Rivera',
    email: 'marcus.rivera@quizpocket.edu',
    password: 'QuizPocket#Student2',
    note: 'Completed Attempt 1 on HIM 105 Lecture 1 — in 3-hour cooldown & ready for score review',
  },
];

export const HIM_EXAM_METADATA: CreateExamInput = {
  title: 'HIM 105 Lecture 1',
  description:
    'Assessment based on HIM 105 Lecture 1 materials covering Health Information Management definitions, evolution, professional roles, core domains, and Hospital Information Systems (HIS).',
  instructions:
    'This quiz contains 20 questions allocated for 30 minutes: Part 1 has 12 Multiple Choice questions (Q1–Q12), Part 2 has 3 True or False questions (Q13–Q15), and Part 3 has 5 Fill-in-the-Blank questions (Q16–Q20). Answer one question at a time in order, or use the Question Navigator pane to jump directly to any question. Once you submit, your score, answers, and detailed explanations are shown immediately.',
  duration_minutes: 30,
  passing_percentage: 50,
  result_release_policy: 'immediate',
  allow_review: true,
  shuffle_questions: false,
  shuffle_options: false,
  max_attempts: 100,
  retake_cooldown_minutes: 180,
  open_to_all: true,
  is_open: true,
};

export const HIM_20_QUESTIONS: UpsertQuestionInput[] = [
  // ==========================================================================
  // PART 1: MULTIPLE CHOICE QUESTIONS (Q1–Q12, 1 mark each)
  // ==========================================================================
  {
    display_order: 1,
    question_type: 'multiple_choice',
    marks: 1,
    question_text:
      'What is the primary definition of Health Information Management (HIM) according to the lecture?',
    options: [
      {
        option_text:
          'The design and engineering of hospital networking hardware and computer chips.',
        display_order: 1,
        is_correct: false,
      },
      {
        option_text:
          'The professional practice of collecting, organizing, storing, protecting, and using patients’ health information to support healthcare delivery, decision-making, research, and legal/administrative processes.',
        display_order: 2,
        is_correct: true,
      },
      {
        option_text:
          'The direct clinical diagnosis and surgical treatment of patients in hospital wards.',
        display_order: 3,
        is_correct: false,
      },
      {
        option_text: 'The financial auditing of insurance companies and government tax refunds.',
        display_order: 4,
        is_correct: false,
      },
    ],
    explanation:
      'Definition: HIM is defined as the professional practice of collecting, organizing, storing, protecting, and using health information to support care, research, and administration.',
  },
  {
    display_order: 2,
    question_type: 'multiple_choice',
    marks: 1,
    question_text:
      'During which evolutionary phase of HIM were classification systems such as ICD introduced along with formal training programs?',
    options: [
      {
        option_text: 'Paper-based medical records (Before the 20th Century)',
        display_order: 1,
        is_correct: false,
      },
      {
        option_text: 'Standardized medical records (Early–Mid 20th Century)',
        display_order: 2,
        is_correct: false,
      },
      {
        option_text: 'Professionalization of medical record management (Mid–Late 20th Century)',
        display_order: 3,
        is_correct: true,
      },
      {
        option_text: 'Modern digital health information (2000s–Present)',
        display_order: 4,
        is_correct: false,
      },
    ],
    explanation:
      'Evolution: The mid-to-late 20th century marked the professionalization of medical record management, introducing classification systems like ICD and formal training.',
  },
  {
    display_order: 3,
    question_type: 'multiple_choice',
    marks: 1,
    question_text:
      'Which HIM professional role is primarily responsible for medical coding and record processing?',
    options: [
      { option_text: 'Privacy Officer', display_order: 1, is_correct: false },
      { option_text: 'HIM Manager/Director', display_order: 2, is_correct: false },
      { option_text: 'Health Information Technician', display_order: 3, is_correct: true },
      { option_text: 'Chief Health Information Officer', display_order: 4, is_correct: false },
    ],
    explanation:
      'Roles: Health Information Technicians focus primarily on medical coding and record processing.',
  },
  {
    display_order: 4,
    question_type: 'multiple_choice',
    marks: 1,
    question_text:
      'In which core domain of HIM are diagnoses and procedures translated into standardized codes like ICD-10 and CPT?',
    options: [
      { option_text: 'Data Management', display_order: 1, is_correct: false },
      { option_text: 'Privacy and Security', display_order: 2, is_correct: false },
      { option_text: 'Coding and Classification', display_order: 3, is_correct: true },
      { option_text: 'Compliance and Regulation', display_order: 4, is_correct: false },
    ],
    explanation:
      'Domains: Coding and classification involve converting diagnoses (ICD-10) and procedures (CPT) into standardized codes for reimbursement and research.',
  },
  {
    display_order: 5,
    question_type: 'multiple_choice',
    marks: 1,
    question_text:
      'What term refers to the capability of different information systems to communicate and share information seamlessly?',
    options: [
      { option_text: 'Redundancy', display_order: 1, is_correct: false },
      { option_text: 'Interoperability', display_order: 2, is_correct: true },
      { option_text: 'Abstraction', display_order: 3, is_correct: false },
      { option_text: 'Encryption', display_order: 4, is_correct: false },
    ],
    explanation:
      'Informatics: Interoperability means that different health information systems can successfully communicate and share information.',
  },
  {
    display_order: 6,
    question_type: 'multiple_choice',
    marks: 1,
    question_text:
      'Which of the following is listed as one of the developmental steps/components of a Hospital Information System (HIS)?',
    options: [
      { option_text: 'CIS (Clinical Information System)', display_order: 1, is_correct: true },
      { option_text: 'GPS (Global Positioning System)', display_order: 2, is_correct: false },
      { option_text: 'HTML (HyperText Markup Language)', display_order: 3, is_correct: false },
      { option_text: 'USB (Universal Serial Bus)', display_order: 4, is_correct: false },
    ],
    explanation:
      'Development: Clinical Information Systems (CIS) are part of the development steps alongside GMIS and MIS.',
  },
  {
    display_order: 7,
    question_type: 'multiple_choice',
    marks: 1,
    question_text:
      'Which of the following is NOT one of the ten official HIS applications listed in the lecture?',
    options: [
      { option_text: 'Billing/Accounts Receivable (BAR)', display_order: 1, is_correct: false },
      { option_text: 'Pharmacy (PHA)', display_order: 2, is_correct: false },
      {
        option_text: 'Social Media Engagement Management (SMEM)',
        display_order: 3,
        is_correct: true,
      },
      { option_text: 'Community-Wide Scheduling (CWS)', display_order: 4, is_correct: false },
    ],
    explanation:
      'Applications: Social Media Engagement Management is not listed. The ten official ones include BAR, CWS, DR, ITS, LIS, OE/EMR, PCS, PHA, Remote Physician Access, and ADM/MRI/ABS.',
  },
  {
    display_order: 8,
    question_type: 'multiple_choice',
    marks: 1,
    question_text:
      'According to the structural breakdown of the hospital community, which group falls under the "Administration Community"?',
    options: [
      {
        option_text: 'Radiological technologists and physicians',
        display_order: 1,
        is_correct: false,
      },
      {
        option_text: 'Reception Community and Medical Accounting Community',
        display_order: 2,
        is_correct: true,
      },
      { option_text: 'Inpatient and Outpatient Communities', display_order: 3, is_correct: false },
      { option_text: 'Clinical laboratory technologists', display_order: 4, is_correct: false },
    ],
    explanation:
      'Structure: The Administration Community explicitly includes the Reception Community and the Medical Accounting Community.',
  },
  {
    display_order: 9,
    question_type: 'multiple_choice',
    marks: 1,
    question_text:
      'Why is a Hospital Information System (HIS) described as an important factor regarding hospital economics?',
    options: [
      {
        option_text: 'It is an important cost factor that influences hospital operating costs.',
        display_order: 1,
        is_correct: true,
      },
      {
        option_text: 'It completely eliminates the need for any hospital staff or payroll.',
        display_order: 2,
        is_correct: false,
      },
      {
        option_text: 'It guarantees that the government will pay all hospital debts.',
        display_order: 3,
        is_correct: false,
      },
      {
        option_text: 'It prevents patients from ever filing insurance claims.',
        display_order: 4,
        is_correct: false,
      },
    ],
    explanation: 'Importance: HIS directly affects and influences hospital operating costs.',
  },
  {
    display_order: 10,
    question_type: 'multiple_choice',
    marks: 1,
    question_text:
      'Which professional credential stands for Registered Health Information Administrator?',
    options: [
      { option_text: 'RHIT', display_order: 1, is_correct: false },
      { option_text: 'CCS', display_order: 2, is_correct: false },
      { option_text: 'RHIA', display_order: 3, is_correct: true },
      { option_text: 'CDIP', display_order: 4, is_correct: false },
    ],
    explanation: 'Credentials: RHIA stands for Registered Health Information Administrator.',
  },
  {
    display_order: 11,
    question_type: 'multiple_choice',
    marks: 1,
    question_text:
      'What is the main purpose of clinical documentation within the core domains of HIM?',
    options: [
      {
        option_text: 'To advertise hospital services to the general public',
        display_order: 1,
        is_correct: false,
      },
      {
        option_text:
          'To maintain accurate and complete medical records including notes, orders, test results, and care plans to prevent errors and denied claims',
        display_order: 2,
        is_correct: true,
      },
      {
        option_text: 'To calculate employee monthly salaries and taxes',
        display_order: 3,
        is_correct: false,
      },
      {
        option_text: 'To design the physical layout of hospital parking lots',
        display_order: 4,
        is_correct: false,
      },
    ],
    explanation:
      'Documentation: Clinical documentation involves maintaining accurate records (notes, test results, care plans); poor documentation causes misdiagnosis and denied claims.',
  },
  {
    display_order: 12,
    question_type: 'multiple_choice',
    marks: 1,
    question_text:
      'Which statement best describes the role of a Privacy Officer in a healthcare facility?',
    options: [
      {
        option_text: 'Managing electrical wiring and plumbing in the hospital building',
        display_order: 1,
        is_correct: false,
      },
      {
        option_text:
          'Protecting patient information, ensuring HIPAA compliance, and managing data breaches',
        display_order: 2,
        is_correct: true,
      },
      {
        option_text: 'Writing software code for computer games in waiting rooms',
        display_order: 3,
        is_correct: false,
      },
      {
        option_text: 'Cooking meals for patients in the hospital kitchen',
        display_order: 4,
        is_correct: false,
      },
    ],
    explanation:
      'Roles: Privacy Officers manage HIPAA compliance, protect patient data, and handle data breaches.',
  },

  // ==========================================================================
  // PART 2: TRUE OR FALSE QUESTIONS (Q13–Q15, 1 mark each)
  // ==========================================================================
  {
    display_order: 13,
    question_type: 'true_false',
    marks: 1,
    question_text:
      'The five core functions of Health Information Management include data collection and documentation, information storage and retrieval, data quality and integrity, privacy and security, and data analysis and reporting.',
    options: [
      { option_text: 'True', display_order: 1, is_correct: true },
      { option_text: 'False', display_order: 2, is_correct: false },
    ],
    explanation:
      'These are the exact five core components/functions of HIM outlined in the lecture.',
  },
  {
    display_order: 14,
    question_type: 'true_false',
    marks: 1,
    question_text:
      'Incomplete or vague clinical documentation has no effect on insurance claims or patient treatment outcomes.',
    options: [
      { option_text: 'True', display_order: 1, is_correct: false },
      { option_text: 'False', display_order: 2, is_correct: true },
    ],
    explanation:
      'Incomplete or vague documentation leads directly to misdiagnosis, delayed treatment, and denied insurance claims.',
  },
  {
    display_order: 15,
    question_type: 'true_false',
    marks: 1,
    question_text:
      'A Hospital Information System (HIS) can be viewed metaphorically as the memory and nervous system of a hospital.',
    options: [
      { option_text: 'True', display_order: 1, is_correct: true },
      { option_text: 'False', display_order: 2, is_correct: false },
    ],
    explanation:
      'HIS acts as the memory and nervous system of a hospital by organizing and communicating needed information.',
  },

  // ==========================================================================
  // PART 3: FILL-IN-THE-BLANK QUESTIONS (Q16–Q20, 1 mark each)
  // ==========================================================================
  {
    display_order: 16,
    question_type: 'fill_in_blank',
    marks: 1,
    question_text:
      'Translating medical diagnoses into standardized codes uses __________ (for diagnoses) and CPT (for procedures).',
    accepted_answers: ['ICD-10', 'ICD 10', 'ICD10'],
    explanation: 'ICD-10 is used for diagnoses while CPT is used for procedures.',
  },
  {
    display_order: 17,
    question_type: 'fill_in_blank',
    marks: 1,
    question_text:
      'The professional organization abbreviated as AHIMA stands for American Health Information Management __________.',
    accepted_answers: ['Association'],
    explanation: 'AHIMA stands for the American Health Information Management Association.',
  },
  {
    display_order: 18,
    question_type: 'fill_in_blank',
    marks: 1,
    question_text:
      'In the evolution of HIM, the phase spanning the 1980s to 1990s marked the introduction of computers and __________ systems.',
    accepted_answers: ['coding'],
    explanation:
      'The 1980s–1990s introduced computers and coding systems into health information management.',
  },
  {
    display_order: 19,
    question_type: 'fill_in_blank',
    marks: 1,
    question_text:
      'The HIS application abbreviated as LIS stands for Laboratory, Microbiology, Blood Bank, and Anatomical __________.',
    accepted_answers: ['Pathology'],
    explanation: 'LIS stands for Laboratory, Microbiology, Blood Bank, and Anatomical Pathology.',
  },
  {
    display_order: 20,
    question_type: 'fill_in_blank',
    marks: 1,
    question_text:
      'A Hospital Information System (HIS) is defined as a system that supports all hospital functions and activities such as patient records, scheduling, administration, charging, and billing, and often links to clinical systems such as the __________ Information System (RIS).',
    accepted_answers: ['Radiology'],
    explanation: 'RIS stands for the Radiology Information System, which links to the HIS.',
  },
];
