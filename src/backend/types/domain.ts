export type UserRole = 'student' | 'admin';
export type AccountStatus = 'active' | 'suspended' | 'pending_approval';
export type MembershipStatus = 'active' | 'inactive';
export type ExamStatus = 'draft' | 'published' | 'archived';
export type ResultReleasePolicy = 'immediate' | 'after_window' | 'manual';
export type QuestionType = 'multiple_choice' | 'true_false' | 'fill_in_blank' | 'short_answer';
export type AssignmentStatus = 'active' | 'revoked';
export type AttemptStatus = 'in_progress' | 'submitted' | 'auto_submitted' | 'voided';

export interface DemoAccountSummary {
  label: string;
  role: UserRole;
  username?: string;
  email: string;
  password: string;
  note: string;
}

export interface Profile {
  id: string;
  institution_id: string;
  email: string;
  username?: string | null;
  full_name: string;
  student_identifier: string | null;
  role: UserRole;
  account_status: AccountStatus;
  created_at: string;
  updated_at: string;
}

export interface AuthenticatedActor {
  uid: string;
  email: string;
  accessToken: string;
  profile: Profile;
}

export interface CreateExamInput {
  title: string;
  description?: string | null;
  instructions?: string | null;
  duration_minutes: number;
  passing_percentage?: number;
  scheduled_start_at?: string | null;
  scheduled_end_at?: string | null;
  result_release_policy?: ResultReleasePolicy;
  allow_review?: boolean;
  shuffle_questions?: boolean;
  shuffle_options?: boolean;
  max_attempts?: number;
  retake_cooldown_minutes?: number;
  open_to_all?: boolean;
  is_open?: boolean;
}

export interface ExamAccessSettingsInput {
  is_open?: boolean;
  open_to_all?: boolean;
  title?: string;
  retake_cooldown_minutes?: number;
  max_attempts?: number;
}

export interface QuestionOptionInput {
  option_text: string;
  display_order?: number;
  is_correct: boolean;
}

export type RubricKeywordsInput =
  | string[][]
  | {
      required_matches?: number;
      groups: string[][];
    };

export interface UpsertQuestionInput {
  question_id?: string | null;
  question_text: string;
  question_type: QuestionType;
  marks: number;
  negative_marks?: number;
  explanation?: string | null;
  display_order?: number | null;
  is_required?: boolean;
  options?: QuestionOptionInput[];
  accepted_answers?: string[];
  rubric_keywords?: RubricKeywordsInput;
}

export interface ExportResultRow {
  student_name: string;
  student_identifier: string;
  student_email: string;
  exam_title: string;
  attempt_number: number;
  attempt_status: string;
  started_at: string | null;
  submitted_at: string | null;
  time_taken_seconds: number | null;
  marks_obtained: string | number | null;
  total_marks: string | number | null;
  percentage: string | number | null;
  pass_status: string;
}
