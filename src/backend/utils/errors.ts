export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(statusCode: number, code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

const DOMAIN_ERROR_MAP: Record<string, { status: number; message: string }> = {
  FORBIDDEN_ADMIN_ONLY: {
    status: 403,
    message: 'Administrator privileges are required for this operation.',
  },
  FORBIDDEN_STUDENT_ONLY: {
    status: 403,
    message: 'An active student account is required for this operation.',
  },
  FORBIDDEN_SERVICE_ROLE_ONLY: {
    status: 403,
    message: 'This operation requires privileged server credentials.',
  },
  FORBIDDEN_ATTEMPT_ACCESS: {
    status: 403,
    message: 'You do not have permission to access this examination attempt.',
  },
  FORBIDDEN_ROLE_ASSIGNMENT: {
    status: 403,
    message: 'Role assignment is restricted to authorized administrative workflows.',
  },
  FORBIDDEN_PROFILE_MODIFICATION: {
    status: 403,
    message: 'One or more profile fields cannot be modified directly.',
  },
  FORBIDDEN_EXPIRY_SWEEP: {
    status: 403,
    message: 'You are not authorized to run attempt expiry sweeps.',
  },
  CROSS_INSTITUTION_ERROR: {
    status: 403,
    message: 'Cross-institution access is not permitted.',
  },
  EXAM_NOT_ASSIGNED: {
    status: 403,
    message: 'You are not assigned to this examination.',
  },
  EXAM_NOT_AVAILABLE: {
    status: 404,
    message: 'Examination is not available.',
  },
  EXAM_NOT_FOUND: {
    status: 404,
    message: 'Examination was not found.',
  },
  CLASS_NOT_FOUND: {
    status: 404,
    message: 'Class was not found.',
  },
  QUESTION_NOT_FOUND: {
    status: 404,
    message: 'Question was not found.',
  },
  ATTEMPT_NOT_FOUND: {
    status: 404,
    message: 'Examination attempt was not found.',
  },
  RESULT_NOT_FOUND: {
    status: 404,
    message: 'Result record was not found.',
  },
  AUTH_USER_NOT_FOUND: {
    status: 404,
    message: 'Target authentication account was not found.',
  },
  EXAM_NOT_YET_OPEN: {
    status: 409,
    message: 'This examination is not open yet.',
  },
  EXAM_CLOSED_BY_ADMIN: {
    status: 409,
    message: 'This quiz is currently closed by the administrator.',
  },
  EXAM_WINDOW_CLOSED: {
    status: 409,
    message: 'The availability window for this examination has closed.',
  },
  MAX_ATTEMPTS_REACHED: {
    status: 409,
    message: 'You have reached the maximum number of permitted attempts for this examination.',
  },
  RETAKE_COOLDOWN_ACTIVE: {
    status: 409,
    message: 'The retake cooldown period has not elapsed yet.',
  },
  ATTEMPT_NOT_ACTIVE: {
    status: 409,
    message: 'This examination attempt is already finalized and can no longer be modified.',
  },
  ATTEMPT_DEADLINE_EXPIRED: {
    status: 409,
    message: 'The server deadline for this attempt has expired.',
  },
  ATTEMPT_NOT_FINALIZED: {
    status: 409,
    message: 'Attempt must be submitted before reviewing results.',
  },
  RESULT_NOT_RELEASED: {
    status: 403,
    message: 'Results for this examination have not been released yet.',
  },
  REVIEW_NOT_PERMITTED: {
    status: 403,
    message: 'Detailed answer review is disabled for this examination.',
  },
  EXAM_LOCKED_BY_ATTEMPTS: {
    status: 409,
    message: 'This examination already has recorded attempts and its scoring structure is locked.',
  },
  EXAM_INCOMPLETE: {
    status: 422,
    message: 'Examination must contain at least one valid question before publishing.',
  },
  EXAM_INVALID_ANSWER_KEY: {
    status: 422,
    message: 'Every question must have valid answer keys configured before publishing.',
  },
  INVALID_ANSWER_KEY: {
    status: 422,
    message: 'Fill-in-the-blank questions require at least one accepted answer.',
  },
  INVALID_RUBRIC: {
    status: 422,
    message: 'Short-answer rubric configuration is invalid.',
  },
  INVALID_OPTION_COUNT: {
    status: 422,
    message: 'Invalid number of options for the selected question type.',
  },
  INVALID_CORRECT_OPTION_COUNT: {
    status: 422,
    message: 'Exactly one option must be marked as correct.',
  },
  DUPLICATE_OPTION_TEXT: {
    status: 422,
    message: 'Options within the same question must have distinct text.',
  },
  QUESTION_EXAM_MISMATCH: {
    status: 422,
    message: 'Submitted question does not belong to the active examination.',
  },
  OPTION_QUESTION_MISMATCH: {
    status: 422,
    message: 'Selected option does not belong to the specified question.',
  },
  INVALID_ASSIGNMENT_TARGET: {
    status: 422,
    message: 'Specify either a student or a class target, not both.',
  },
  REASON_REQUIRED: {
    status: 422,
    message: 'An explicit audit reason is required to correct a finalized result.',
  },
  INVALID_MARKS_RANGE: {
    status: 422,
    message: 'Corrected marks must be between zero and the examination total marks.',
  },
  AUDIT_LOG_IMMUTABLE: {
    status: 403,
    message: 'Audit log entries are immutable.',
  },
};

/**
 * Translates raw database or RPC exceptions into sanitized AppErrors
 * so internal table schemas, SQL queries, or credentials never leak to clients.
 */
export function translateDatabaseError(err: unknown): AppError {
  if (err instanceof AppError) {
    return err;
  }

  const rawMessage =
    err instanceof Error
      ? err.message
      : typeof err === 'object' && err !== null && 'message' in err
        ? String((err as { message: unknown }).message)
        : String(err);

  for (const [prefix, mapped] of Object.entries(DOMAIN_ERROR_MAP)) {
    if (rawMessage.includes(prefix)) {
      return new AppError(mapped.status, prefix, mapped.message, { cause: err });
    }
  }

  if (rawMessage.includes('duplicate key value') || rawMessage.includes('23505')) {
    return new AppError(
      409,
      'DUPLICATE_RECORD',
      'A record with the same unique identifier already exists.',
      { cause: err }
    );
  }

  if (rawMessage.includes('violates check constraint') || rawMessage.includes('23514')) {
    return new AppError(
      422,
      'VALIDATION_CONSTRAINT_FAILED',
      'Provided values violate examination validation constraints.',
      { cause: err }
    );
  }

  if (rawMessage.includes('permission denied') || rawMessage.includes('row-level security')) {
    return new AppError(
      403,
      'ACCESS_DENIED',
      'You do not have permission to perform this action.',
      { cause: err }
    );
  }

  // Missing column / table / function => the deployed database is behind the code.
  if (
    /PGRST20[24]|42703|42883|42P01|does not exist|Could not find the (function|table|column)|schema cache/i.test(
      rawMessage
    )
  ) {
    return new AppError(
      500,
      'DATABASE_SCHEMA_MISMATCH',
      'The database schema is out of date. Run supabase/migrations/20261025000900_quiz_open_close_and_cooldown_overrides.sql (and 20261025001000) in the Supabase SQL Editor, then try again.',
      { cause: err }
    );
  }

  return new AppError(
    500,
    'INTERNAL_OPERATION_FAILED',
    'An unexpected server error occurred while processing the request.',
    { cause: err }
  );
}
