import {
  AccountStatus,
  AttemptStatus,
  DemoAccountSummary,
  ExamStatus,
  Profile,
  QuestionType,
  ResultReleasePolicy,
  RubricKeywordsInput,
} from '../backend/types/domain.ts';

export type {
  AccountStatus,
  AttemptStatus,
  DemoAccountSummary,
  ExamStatus,
  Profile,
  QuestionType,
  ResultReleasePolicy,
  RubricKeywordsInput,
};

export interface StudentEligibleExam {
  id: string;
  title: string;
  description: string | null;
  instructions: string | null;
  duration_minutes: number;
  total_marks: number;
  passing_percentage: number;
  scheduled_start_at: string | null;
  scheduled_end_at: string | null;
  result_release_policy: ResultReleasePolicy;
  allow_review: boolean;
  max_attempts: number;
  retake_cooldown_minutes: number;
  is_open?: boolean;
  open_to_all?: boolean;
  created_at?: string;
  attempts_used: number;
  active_attempt_id: string | null;
  active_attempt_deadline_at: string | null;
  latest_submitted_at: string | null;
  next_eligible_attempt_at: string | null;
  availability_state:
    | 'in_progress'
    | 'upcoming'
    | 'closed'
    | 'attempts_exhausted'
    | 'cooldown'
    | 'available';
  server_now: string;
}

export interface StartOrResumeAttemptResult {
  resumed: boolean;
  attempt_id: string;
  exam_id: string;
  attempt_number: number;
  status: AttemptStatus;
  started_at: string;
  deadline_at: string;
  server_now: string;
}

export interface StudentQuestionOption {
  id: string;
  option_text: string;
  display_order: number;
}

export interface StudentAttemptQuestion {
  id: string;
  question_text: string;
  question_type: QuestionType;
  marks: number;
  negative_marks: number;
  display_order: number;
  is_required: boolean;
  saved_selected_option_id: string | null;
  saved_answer_value: string | null;
  saved_revision: number | null;
  options: StudentQuestionOption[];
}

export interface ActiveAttemptQuestionsPayload {
  ok: boolean;
  attempt_id: string;
  exam_id: string;
  exam_title: string;
  instructions: string | null;
  duration_minutes: number;
  started_at: string;
  deadline_at: string;
  server_now: string;
  questions: StudentAttemptQuestion[];
}

export interface SaveAnswerResult {
  ok: boolean;
  attempt_id: string;
  question_id: string;
  selected_option_id: string | null;
  answer_value: string | null;
  revision: number;
  saved_at: string;
  deadline_at: string;
  server_now: string;
}

export interface SubmitAttemptResult {
  already_finalized: boolean;
  attempt_id: string;
  status: AttemptStatus;
  submitted_at: string;
  result_id: string;
  result_released: boolean;
  allow_review: boolean;
  marks_obtained?: number;
  total_marks?: number;
  percentage?: number;
  passed?: boolean;
  result: {
    marks_obtained: number;
    total_marks: number;
    percentage: number;
    passed: boolean;
    correct_count: number;
    incorrect_count: number;
    unanswered_count: number;
  } | null;
}

export interface StudentReleasedResultRow {
  result_id: string;
  attempt_id: string;
  attempt_number: number;
  attempt_status: AttemptStatus;
  exam_id: string;
  exam_title: string;
  started_at: string;
  submitted_at: string;
  finalized_at?: string;
  time_taken_seconds: number;
  result_released: boolean;
  allow_review: boolean;
  marks_obtained: number | null;
  total_marks: number | null;
  percentage: number | null;
  passed: boolean | null;
  correct_count: number | null;
  incorrect_count: number | null;
  unanswered_count: number | null;
}

export interface ReviewOptionItem {
  id: string;
  option_text: string;
  display_order: number;
  is_correct: boolean;
}

export interface ReviewQuestionItem {
  question_id: string;
  display_order: number;
  question_text: string;
  question_type: QuestionType;
  max_marks: number;
  marks_awarded: number;
  outcome: 'correct' | 'partial' | 'incorrect' | 'unanswered';
  selected_option_id: string | null;
  correct_option_id: string | null;
  submitted_text: string | null;
  expected_answer: string | null;
  accepted_answers: string[];
  explanation: string | null;
  options: ReviewOptionItem[];
}

export interface AttemptReviewPayload {
  attempt_id: string;
  attempt_number?: number;
  finalized_at?: string;
  exam_id: string;
  exam_title: string;
  started_at: string;
  submitted_at: string;
  marks_obtained: number;
  total_marks: number;
  percentage: number;
  passed: boolean;
  questions: ReviewQuestionItem[];
}

export interface AdminExamAssignmentSummary {
  id: string;
  student_id: string | null;
  class_id: string | null;
  assignment_status: 'active' | 'revoked';
}

export interface AdminExamSummary {
  id: string;
  title: string;
  description: string | null;
  instructions: string | null;
  duration_minutes: number;
  total_marks: number;
  passing_percentage: number;
  status: ExamStatus;
  scheduled_start_at: string | null;
  scheduled_end_at: string | null;
  result_release_policy: ResultReleasePolicy;
  results_released_manually: boolean;
  allow_review: boolean;
  shuffle_questions: boolean;
  shuffle_options: boolean;
  max_attempts: number;
  retake_cooldown_minutes: number;
  is_open?: boolean;
  open_to_all?: boolean;
  cooldown_override_at?: string | null;
  published_at: string | null;
  created_at: string;
  question_count: number;
  attempt_count: number;
  assignments: AdminExamAssignmentSummary[];
}

export interface AdminQuestionItem {
  id: string;
  exam_id: string;
  display_order: number;
  question_text: string;
  question_type: QuestionType;
  marks: number;
  negative_marks: number;
  explanation: string | null;
  is_required: boolean;
  accepted_answers: string[];
  rubric_keywords: RubricKeywordsInput;
  options: ReviewOptionItem[];
}

export interface AdminClassMember {
  student_id: string;
  full_name: string;
  student_identifier: string | null;
  email: string;
  membership_status: 'active' | 'inactive';
}

export interface AdminClassItem {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  members: AdminClassMember[];
}

export interface ExamStatisticsPayload {
  exam_id: string;
  title: string;
  status: ExamStatus;
  total_marks: number;
  passing_percentage: number;
  assigned_students_count: number;
  total_attempts: number;
  in_progress_attempts: number;
  completed_attempts: number;
  distinct_students_attempted: number;
  completion_rate_percentage: number;
  average_marks: number;
  highest_marks: number;
  lowest_marks: number;
  average_percentage: number;
  pass_count: number;
  fail_count: number;
  pass_rate_percentage: number;
  average_score?: number;
  pass_rate?: number;
  completion_rate?: number;
  submitted_count?: number;
  auto_submitted_count?: number;
  total_attempts_started?: number;
  lowest_score?: number;
  highest_score?: number;
}

export interface AdminAttemptSummaryRow {
  id?: string;
  attempt_id: string;
  attempt_number: number;
  status: AttemptStatus;
  started_at: string;
  deadline_at: string;
  submitted_at: string | null;
  time_taken_seconds: number | null;
  student_id: string;
  student_name: string;
  student_identifier: string | null;
  student_email: string;
  result_id: string | null;
  marks_obtained: number | null;
  final_marks?: number | null;
  total_marks: number | null;
  percentage: number | null;
  passed: boolean | null;
  correct_count: number | null;
  incorrect_count: number | null;
  unanswered_count: number | null;
  in_cooldown?: boolean;
  cooldown_until?: string | null;
}

export interface AdminAttemptDetailQuestion {
  question_id: string;
  display_order: number;
  question_text: string;
  question_type: QuestionType;
  marks: number;
  negative_marks: number;
  selected_option_id: string | null;
  correct_option_id: string | null;
  submitted_text: string | null;
  expected_answer: string | null;
  accepted_answers: string[];
  outcome: 'correct' | 'partial' | 'incorrect' | 'unanswered' | null;
  marks_awarded: number | null;
  explanation: string | null;
  options: ReviewOptionItem[];
}

export interface AdminAttemptDetailPayload {
  attempt_id: string;
  attempt_number: number;
  status: AttemptStatus;
  started_at: string;
  deadline_at: string;
  submitted_at: string | null;
  student: {
    id: string;
    full_name: string;
    student_identifier: string | null;
    email: string;
  };
  exam: {
    id: string;
    title: string;
    total_marks: number;
  };
  result: {
    id: string;
    marks_obtained: number;
    total_marks: number;
    percentage: number;
    passed: boolean;
    marking_version: number;
    finalized_at: string;
  } | null;
  questions: AdminAttemptDetailQuestion[];
}

export interface QuestionAnalyticsRow {
  question_id: string;
  display_order: number;
  question_text: string;
  question_type: QuestionType;
  marks: number;
  correct_count: number;
  partial_count: number;
  incorrect_count: number;
  unanswered_count: number;
  total_evaluated: number;
  correct_percentage: number;
  average_marks_awarded: number;
  commonly_missed: boolean;
}

export interface ClassPerformanceRow {
  class_id: string;
  class_name: string;
  active_students: number;
  completed_attempts: number;
  average_percentage: number;
  pass_rate_percentage: number;
}

export interface AuditLogRow {
  id: string;
  institution_id: string;
  actor_id: string | null;
  actor_role: string;
  event_type?: string;
  action?: string;
  entity_type: string;
  entity_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface LiveMonitoringAttempt {
  attempt_id: string;
  student_id: string;
  student_name: string;
  student_identifier: string | null;
  student_email: string;
  exam_id: string;
  exam_title: string;
  duration_minutes: number;
  attempt_number: number;
  status: AttemptStatus;
  started_at: string;
  deadline_at: string;
  submitted_at: string | null;
  last_activity_at: string;
  current_question_index: number;
  total_questions: number;
  answered_questions: number;
  seconds_remaining: number;
  is_active: boolean;
}

export interface LiveMonitoringQuestionItem {
  question_id: string;
  display_order: number;
  question_type: QuestionType;
  marks: number;
  is_answered: boolean;
  saved_at: string | null;
  revision: number | null;
  is_current: boolean;
}

export interface LiveMonitoringAttemptDetail {
  attempt_id: string;
  exam_id: string;
  exam_title: string;
  duration_minutes: number;
  student_id: string;
  student_name: string;
  student_identifier: string | null;
  student_email: string;
  status: AttemptStatus;
  attempt_number: number;
  started_at: string;
  deadline_at: string;
  submitted_at: string | null;
  last_activity_at: string;
  current_question_index: number;
  seconds_remaining: number;
  total_questions: number;
  questions: LiveMonitoringQuestionItem[];
}

export type ExamListItem = AdminExamSummary;
export type ExamStatistics = ExamStatisticsPayload;
export type StudentReleasedResult = StudentReleasedResultRow;
export type CreateExamInput = Partial<AdminExamSummary> & {
  title: string;
  duration_minutes?: number;
  instructions?: string;
  description?: string;
  passing_percentage?: number;
};
