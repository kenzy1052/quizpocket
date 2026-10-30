import express, { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { BackendGateway } from './db/gateway.ts';
import { AppError, translateDatabaseError } from './utils/errors.ts';
import { MIN_PASSWORD_LENGTH, normalizeUsername } from './utils/authIdentifier.ts';
import { formatExamResultsCsv } from './utils/csv.ts';
import { createRateLimiter } from './middleware/rateLimit.ts';
import { AuthenticatedActor, UserRole } from './types/domain.ts';

export interface AuthenticatedRequest extends Request {
  actor?: AuthenticatedActor;
}

export interface CreateBackendAppOptions {
  gateway: BackendGateway;
  cronSecret?: string | null;
  authRateLimitMax?: number;
  attemptRateLimitMax?: number;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertValidUuid(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !UUID_REGEX.test(value)) {
    throw new AppError(400, 'INVALID_IDENTIFIER', `Invalid UUID provided for ${fieldName}.`);
  }
  return value;
}

function constantTimeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function createBackendApiRouter(options: CreateBackendAppOptions): express.Router {
  const router = express.Router();
  const { gateway } = options;

  router.use(express.json({ limit: '256kb' }));

  // Prevent browser/proxy caching of sensitive examination questions, answers, or results
  router.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  const authLimiter = createRateLimiter({
    windowMs: 60_000,
    maxRequests: options.authRateLimitMax ?? 15,
    keyPrefix: 'auth',
  });

  const attemptStartLimiter = createRateLimiter({
    windowMs: 60_000,
    maxRequests: options.attemptRateLimitMax ?? 20,
    keyPrefix: 'attempt-start',
  });

  const requireAuth =
    (requiredRole?: UserRole) =>
    async (req: AuthenticatedRequest, _res: Response, next: NextFunction): Promise<void> => {
      try {
        const header = req.headers.authorization;
        if (!header || !header.startsWith('Bearer ')) {
          throw new AppError(401, 'UNAUTHORIZED', 'Authentication bearer token is required.');
        }

        const token = header.slice('Bearer '.length).trim();
        if (!token) {
          throw new AppError(401, 'UNAUTHORIZED', 'Authentication bearer token is empty.');
        }

        const actor = await gateway.verifyBearerToken(token);
        if (requiredRole && actor.profile.role !== requiredRole) {
          throw new AppError(
            403,
            requiredRole === 'admin' ? 'FORBIDDEN_ADMIN_ONLY' : 'FORBIDDEN_STUDENT_ONLY',
            'You do not have the required role for this operation.'
          );
        }

        req.actor = actor;
        next();
      } catch (err) {
        next(err);
      }
    };

  // ==========================================================================
  // AUTHENTICATION & PROFILE ROUTES
  // ==========================================================================

  router.get('/auth/demo-accounts', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const accounts = gateway.getDemoAccounts ? await gateway.getDemoAccounts() : [];
      res.status(200).json({ data: accounts });
    } catch (err) {
      next(err);
    }
  });

  router.post(
    '/auth/signup',
    authLimiter,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const rawName =
          typeof req.body?.username === 'string'
            ? req.body.username
            : typeof req.body?.name === 'string'
              ? req.body.name
              : '';
        const username = normalizeUsername(rawName);
        const password = typeof req.body?.password === 'string' ? req.body.password : '';

        if (!username) {
          throw new AppError(422, 'VALIDATION_ERROR', 'Name is required.');
        }
        if (username.length > 80) {
          throw new AppError(422, 'VALIDATION_ERROR', 'Name must be 80 characters or fewer.');
        }
        if (password.length < MIN_PASSWORD_LENGTH) {
          throw new AppError(
            422,
            'VALIDATION_ERROR',
            `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
          );
        }

        const session = await gateway.signUpWithUsername(username, password);
        res.status(201).json({ data: session });
      } catch (err) {
        next(err);
      }
    }
  );

  router.post('/auth/login', authLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rawIdentifier =
        typeof req.body?.username === 'string' && req.body.username.trim()
          ? req.body.username
          : typeof req.body?.name === 'string' && req.body.name.trim()
            ? req.body.name
            : typeof req.body?.email === 'string'
              ? req.body.email
              : '';
      const identifier = normalizeUsername(rawIdentifier);
      const password = typeof req.body?.password === 'string' ? req.body.password : '';

      if (!identifier || !password) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Name and password are required.');
      }

      const session = await gateway.signInWithPassword(identifier, password);
      res.status(200).json({ data: session });
    } catch (err) {
      next(err);
    }
  });

  router.post(
    '/auth/password-reset',
    authLimiter,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
        if (!email || !email.includes('@')) {
          throw new AppError(400, 'VALIDATION_ERROR', 'Please enter a valid email address.');
        }

        const redirectTo =
          typeof req.body?.redirect_to === 'string' ? req.body.redirect_to : undefined;
        await gateway.requestPasswordReset(email, redirectTo);

        // Identical response regardless of whether the email exists (prevents enumeration)
        res.status(200).json({
          data: {
            message:
              'If an active account is associated with that email address, password recovery instructions have been sent.',
          },
        });
      } catch (err) {
        next(err);
      }
    }
  );

  router.get(
    '/me',
    requireAuth(),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        res.status(200).json({ data: req.actor!.profile });
      } catch (err) {
        next(err);
      }
    }
  );

  router.patch(
    '/me',
    requireAuth(),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        // Reject any attempt to smuggle role or status updates via profile endpoint
        if ('role' in (req.body ?? {}) || 'account_status' in (req.body ?? {})) {
          throw new AppError(
            403,
            'FORBIDDEN_PROFILE_MODIFICATION',
            'Role and account status cannot be modified through profile settings.'
          );
        }

        const fullName = typeof req.body?.full_name === 'string' ? req.body.full_name.trim() : '';
        if (fullName.length < 1 || fullName.length > 200) {
          throw new AppError(
            422,
            'VALIDATION_ERROR',
            'Full name must be between 1 and 200 characters.'
          );
        }

        const updated = await gateway.updateOwnFullName(req.actor!, fullName);
        res.status(200).json({ data: updated });
      } catch (err) {
        next(err);
      }
    }
  );

  // ==========================================================================
  // STUDENT EXAMINATION WORKFLOW ROUTES
  // ==========================================================================

  router.get(
    '/student/exams',
    requireAuth('student'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const exams = await gateway.studentListEligibleExams(req.actor!);
        res.status(200).json({ data: exams });
      } catch (err) {
        next(err);
      }
    }
  );

  router.post(
    '/student/exams/:examId/attempts',
    attemptStartLimiter,
    requireAuth('student'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const examId = assertValidUuid(req.params.examId, 'examId');
        const attempt = await gateway.studentStartOrResumeAttempt(req.actor!, examId);
        res.status(200).json({ data: attempt });
      } catch (err) {
        next(err);
      }
    }
  );

  router.get(
    '/student/attempts/:attemptId/questions',
    requireAuth('student'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const attemptId = assertValidUuid(req.params.attemptId, 'attemptId');
        const payload = (await gateway.studentGetAttemptQuestions(req.actor!, attemptId)) as Record<
          string,
          unknown
        >;

        if (payload && payload.ok === false && payload.code === 'ATTEMPT_DEADLINE_EXPIRED') {
          res.status(409).json({
            error: {
              code: 'ATTEMPT_DEADLINE_EXPIRED',
              message: 'The server deadline for this attempt has expired.',
              details: payload,
            },
          });
          return;
        }

        res.status(200).json({ data: payload });
      } catch (err) {
        next(err);
      }
    }
  );

  router.put(
    '/student/attempts/:attemptId/answers',
    requireAuth('student'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const attemptId = assertValidUuid(req.params.attemptId, 'attemptId');
        const questionId = assertValidUuid(req.body?.question_id, 'question_id');
        const selectedOptionId =
          req.body?.selected_option_id === null || req.body?.selected_option_id === undefined
            ? null
            : assertValidUuid(req.body.selected_option_id, 'selected_option_id');
        const answerValue =
          typeof req.body?.answer_value === 'string' ? req.body.answer_value : null;

        const saved = (await gateway.studentSaveAnswer(
          req.actor!,
          attemptId,
          questionId,
          selectedOptionId,
          answerValue
        )) as Record<string, unknown>;

        if (saved && saved.ok === false && saved.code === 'ATTEMPT_DEADLINE_EXPIRED') {
          res.status(409).json({
            error: {
              code: 'ATTEMPT_DEADLINE_EXPIRED',
              message: String(saved.message ?? 'Examination deadline has elapsed.'),
              details: saved,
            },
          });
          return;
        }

        res.status(200).json({ data: saved });
      } catch (err) {
        next(err);
      }
    }
  );

  router.post(
    '/student/attempts/:attemptId/submit',
    requireAuth('student'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const attemptId = assertValidUuid(req.params.attemptId, 'attemptId');
        const submission = await gateway.studentSubmitAttempt(req.actor!, attemptId);
        res.status(200).json({ data: submission });
      } catch (err) {
        next(err);
      }
    }
  );

  router.get(
    '/student/results',
    requireAuth('student'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const results = await gateway.studentGetReleasedResults(req.actor!);
        res.status(200).json({ data: results });
      } catch (err) {
        next(err);
      }
    }
  );

  router.get(
    '/student/attempts/:attemptId/review',
    requireAuth('student'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const attemptId = assertValidUuid(req.params.attemptId, 'attemptId');
        const review = await gateway.studentGetAttemptReview(req.actor!, attemptId);
        res.status(200).json({ data: review });
      } catch (err) {
        next(err);
      }
    }
  );

  router.post(
    '/student/attempts/:attemptId/position',
    requireAuth('student'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const attemptId = assertValidUuid(req.params.attemptId, 'attemptId');
        const questionIndex =
          typeof req.body?.question_index === 'number' && Number.isInteger(req.body.question_index)
            ? Math.max(0, req.body.question_index)
            : 0;
        const result = await gateway.studentRecordQuestionPosition(
          req.actor!,
          attemptId,
          questionIndex
        );
        res.status(200).json({ data: result });
      } catch (err) {
        next(err);
      }
    }
  );

  // ==========================================================================
  // ADMINISTRATIVE MANAGEMENT, ANALYTICS, & CSV EXPORT ROUTES
  // ==========================================================================

  router.get(
    '/admin/students',
    requireAuth('admin'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const students = await gateway.adminListStudents(req.actor!);
        res.status(200).json({ data: students });
      } catch (err) {
        next(err);
      }
    }
  );

  router.post(
    '/admin/students',
    requireAuth('admin'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
        const username =
          typeof req.body?.username === 'string' ? normalizeUsername(req.body.username) : '';
        const password = typeof req.body?.password === 'string' ? req.body.password : '';
        const fullName =
          typeof req.body?.full_name === 'string' && req.body.full_name.trim()
            ? req.body.full_name.trim()
            : username;
        const studentIdentifier =
          typeof req.body?.student_identifier === 'string'
            ? req.body.student_identifier.trim()
            : null;

        if (
          fullName.length < 1 ||
          password.length < MIN_PASSWORD_LENGTH ||
          (email.length > 0 && !email.includes('@'))
        ) {
          throw new AppError(
            422,
            'VALIDATION_ERROR',
            `Name and a password of at least ${MIN_PASSWORD_LENGTH} characters are required.`
          );
        }

        const created = await gateway.adminCreateStudentAccount(req.actor!, {
          email: email || undefined,
          username: username || fullName,
          password,
          full_name: fullName,
          student_identifier: studentIdentifier,
          account_status: req.body?.account_status ?? 'active',
        });

        res.status(201).json({ data: created });
      } catch (err) {
        next(err);
      }
    }
  );

  router.patch(
    '/admin/students/:studentId',
    requireAuth('admin'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const studentId = assertValidUuid(req.params.studentId, 'studentId');
        const fullName = typeof req.body?.full_name === 'string' ? req.body.full_name.trim() : '';
        const accountStatus = req.body?.account_status;

        if (!fullName || !['active', 'suspended', 'pending_approval'].includes(accountStatus)) {
          throw new AppError(
            422,
            'VALIDATION_ERROR',
            'Valid full_name and account_status are required.'
          );
        }

        const updated = await gateway.adminUpdateStudentProfile(req.actor!, {
          student_id: studentId,
          full_name: fullName,
          student_identifier: req.body?.student_identifier ?? null,
          account_status: accountStatus,
        });

        res.status(200).json({ data: updated });
      } catch (err) {
        next(err);
      }
    }
  );

  router.get(
    '/admin/classes',
    requireAuth('admin'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const classes = await gateway.adminListClasses(req.actor!);
        res.status(200).json({ data: classes });
      } catch (err) {
        next(err);
      }
    }
  );

  router.post(
    '/admin/classes',
    requireAuth('admin'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
        if (!name) {
          throw new AppError(422, 'VALIDATION_ERROR', 'Class name is required.');
        }
        const created = await gateway.adminCreateClass(
          req.actor!,
          name,
          req.body?.description ?? null
        );
        res.status(201).json({ data: created });
      } catch (err) {
        next(err);
      }
    }
  );

  router.put(
    '/admin/classes/:classId/members/:studentId',
    requireAuth('admin'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const classId = assertValidUuid(req.params.classId, 'classId');
        const studentId = assertValidUuid(req.params.studentId, 'studentId');
        const status = req.body?.membership_status === 'inactive' ? 'inactive' : 'active';
        const membership = await gateway.adminSetClassMembership(
          req.actor!,
          classId,
          studentId,
          status
        );
        res.status(200).json({ data: membership });
      } catch (err) {
        next(err);
      }
    }
  );

  router.get(
    '/admin/exams',
    requireAuth('admin'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const exams = await gateway.adminListExams(req.actor!);
        res.status(200).json({ data: exams });
      } catch (err) {
        next(err);
      }
    }
  );

  router.get(
    '/admin/exams/:examId',
    requireAuth('admin'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const examId = assertValidUuid(req.params.examId, 'examId');
        const exams = (await gateway.adminListExams(req.actor!)) as Array<{ id: string }>;
        const found = exams.find((e) => e.id === examId);
        if (!found) {
          throw new AppError(404, 'EXAM_NOT_FOUND', 'The requested quiz was not found.');
        }
        res.status(200).json({ data: found });
      } catch (err) {
        next(err);
      }
    }
  );

  router.post(
    '/admin/exams',
    requireAuth('admin'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
        const duration = Number(req.body?.duration_minutes);
        if (!title || !Number.isInteger(duration) || duration < 1 || duration > 720) {
          throw new AppError(
            422,
            'VALIDATION_ERROR',
            'Exam title and an integer duration_minutes between 1 and 720 are required.'
          );
        }

        const exam = await gateway.adminCreateExam(req.actor!, {
          title,
          description: req.body?.description ?? null,
          instructions: req.body?.instructions ?? null,
          duration_minutes: duration,
          passing_percentage: req.body?.passing_percentage,
          scheduled_start_at: req.body?.scheduled_start_at ?? null,
          scheduled_end_at: req.body?.scheduled_end_at ?? null,
          result_release_policy: req.body?.result_release_policy,
          allow_review: req.body?.allow_review,
          shuffle_questions: req.body?.shuffle_questions,
          shuffle_options: req.body?.shuffle_options,
          max_attempts: req.body?.max_attempts,
          retake_cooldown_minutes: req.body?.retake_cooldown_minutes,
          open_to_all: req.body?.open_to_all,
          is_open: req.body?.is_open,
        });

        res.status(201).json({ data: exam });
      } catch (err) {
        next(err);
      }
    }
  );

  router.get(
    '/admin/exams/:examId/questions',
    requireAuth('admin'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const examId = assertValidUuid(req.params.examId, 'examId');
        const questions = await gateway.adminGetExamQuestions(req.actor!, examId);
        res.status(200).json({ data: questions });
      } catch (err) {
        next(err);
      }
    }
  );

  router.post(
    '/admin/exams/:examId/questions',
    requireAuth('admin'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const examId = assertValidUuid(req.params.examId, 'examId');
        const question = await gateway.adminUpsertQuestion(req.actor!, examId, req.body);
        res.status(201).json({ data: question });
      } catch (err) {
        next(err);
      }
    }
  );

  router.post(
    '/admin/exams/:examId/publish',
    requireAuth('admin'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const examId = assertValidUuid(req.params.examId, 'examId');
        const published = await gateway.adminPublishExam(req.actor!, examId);
        res.status(200).json({ data: published });
      } catch (err) {
        next(err);
      }
    }
  );

  router.post(
    '/admin/exams/:examId/archive',
    requireAuth('admin'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const examId = assertValidUuid(req.params.examId, 'examId');
        const archived = await gateway.adminArchiveExam(req.actor!, examId);
        res.status(200).json({ data: archived });
      } catch (err) {
        next(err);
      }
    }
  );

  router.patch(
    '/admin/exams/:examId/release-settings',
    requireAuth('admin'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const examId = assertValidUuid(req.params.examId, 'examId');
        const updated = await gateway.adminUpdateReleaseSettings(req.actor!, examId, {
          result_release_policy: req.body?.result_release_policy,
          results_released_manually: req.body?.results_released_manually,
          allow_review: req.body?.allow_review,
        });
        res.status(200).json({ data: updated });
      } catch (err) {
        next(err);
      }
    }
  );

  router.patch(
    '/admin/exams/:examId/access',
    requireAuth('admin'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const examId = assertValidUuid(req.params.examId, 'examId');
        const cooldownRaw = req.body?.retake_cooldown_minutes;
        if (
          cooldownRaw !== undefined &&
          (typeof cooldownRaw !== 'number' ||
            !Number.isInteger(cooldownRaw) ||
            cooldownRaw < 0 ||
            cooldownRaw > 43200)
        ) {
          throw new AppError(
            422,
            'VALIDATION_ERROR',
            'Retake cooldown must be a whole number of minutes between 0 and 43200.'
          );
        }
        const updated = await gateway.adminUpdateExamAccess(req.actor!, examId, {
          is_open: typeof req.body?.is_open === 'boolean' ? req.body.is_open : undefined,
          open_to_all:
            typeof req.body?.open_to_all === 'boolean' ? req.body.open_to_all : undefined,
          title: typeof req.body?.title === 'string' ? req.body.title : undefined,
          retake_cooldown_minutes:
            typeof req.body?.retake_cooldown_minutes === 'number'
              ? req.body.retake_cooldown_minutes
              : undefined,
          max_attempts:
            typeof req.body?.max_attempts === 'number' ? req.body.max_attempts : undefined,
        });
        res.status(200).json({ data: updated });
      } catch (err) {
        next(err);
      }
    }
  );

  router.post(
    '/admin/exams/:examId/unlock-retake',
    requireAuth('admin'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const examId = assertValidUuid(req.params.examId, 'examId');
        const studentId = req.body?.student_id
          ? assertValidUuid(req.body.student_id, 'student_id')
          : null;
        const reason = typeof req.body?.reason === 'string' ? req.body.reason : null;

        const unlocked = await gateway.adminOverrideExamCooldown(req.actor!, examId, {
          student_id: studentId,
          reason,
        });
        res.status(200).json({ data: unlocked });
      } catch (err) {
        next(err);
      }
    }
  );

  router.post(
    '/admin/exams/:examId/assignments',
    requireAuth('admin'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const examId = assertValidUuid(req.params.examId, 'examId');
        const studentId = req.body?.student_id
          ? assertValidUuid(req.body.student_id, 'student_id')
          : null;
        const classId = req.body?.class_id ? assertValidUuid(req.body.class_id, 'class_id') : null;

        const assignment = await gateway.adminAssignExam(req.actor!, examId, {
          student_id: studentId,
          class_id: classId,
          status: req.body?.status ?? 'active',
        });
        res.status(200).json({ data: assignment });
      } catch (err) {
        next(err);
      }
    }
  );

  router.post(
    '/admin/results/:resultId/correct',
    requireAuth('admin'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const resultId = assertValidUuid(req.params.resultId, 'resultId');
        const correctedMarks = Number(req.body?.corrected_marks);
        const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';

        if (!Number.isFinite(correctedMarks)) {
          throw new AppError(422, 'VALIDATION_ERROR', 'Numeric corrected_marks is required.');
        }

        const corrected = await gateway.adminCorrectResult(
          req.actor!,
          resultId,
          correctedMarks,
          reason
        );
        res.status(200).json({ data: corrected });
      } catch (err) {
        next(err);
      }
    }
  );

  router.post(
    '/admin/results/:resultId/items/:questionId/grade',
    requireAuth('admin'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const resultId = assertValidUuid(req.params.resultId, 'resultId');
        const questionId = assertValidUuid(req.params.questionId, 'questionId');
        const marksAwarded = Number(req.body?.marks_awarded);
        const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';

        if (!Number.isFinite(marksAwarded)) {
          throw new AppError(422, 'VALIDATION_ERROR', 'Numeric marks_awarded is required.');
        }

        const updated = await gateway.adminGradeResultItem(
          req.actor!,
          resultId,
          questionId,
          marksAwarded,
          reason
        );
        res.status(200).json({ data: updated });
      } catch (err) {
        next(err);
      }
    }
  );

  router.get(
    '/admin/exams/:examId/statistics',
    requireAuth('admin'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const examId = assertValidUuid(req.params.examId, 'examId');
        const stats = await gateway.adminGetExamStatistics(req.actor!, examId);
        res.status(200).json({ data: stats });
      } catch (err) {
        next(err);
      }
    }
  );

  router.get(
    '/admin/exams/:examId/attempts',
    requireAuth('admin'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const examId = assertValidUuid(req.params.examId, 'examId');
        const attempts = await gateway.adminListExamAttempts(req.actor!, examId);
        res.status(200).json({ data: attempts });
      } catch (err) {
        next(err);
      }
    }
  );

  router.get(
    '/admin/attempts/:attemptId',
    requireAuth('admin'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const attemptId = assertValidUuid(req.params.attemptId, 'attemptId');
        const detail = await gateway.adminGetAttemptDetail(req.actor!, attemptId);
        res.status(200).json({ data: detail });
      } catch (err) {
        next(err);
      }
    }
  );

  router.get(
    '/admin/monitoring/live',
    requireAuth('admin'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const examId =
          typeof req.query.exam_id === 'string' && req.query.exam_id.trim()
            ? assertValidUuid(req.query.exam_id, 'exam_id')
            : null;
        const liveAttempts = await gateway.adminListLiveMonitoring(req.actor!, examId);
        res.status(200).json({ data: liveAttempts });
      } catch (err) {
        next(err);
      }
    }
  );

  router.get(
    '/admin/monitoring/attempts/:attemptId',
    requireAuth('admin'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const attemptId = assertValidUuid(req.params.attemptId, 'attemptId');
        const detail = await gateway.adminGetAttemptLiveStatus(req.actor!, attemptId);
        res.status(200).json({ data: detail });
      } catch (err) {
        next(err);
      }
    }
  );

  router.get(
    '/admin/exams/:examId/question-analytics',
    requireAuth('admin'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const examId = assertValidUuid(req.params.examId, 'examId');
        const analytics = await gateway.adminGetQuestionAnalytics(req.actor!, examId);
        res.status(200).json({ data: analytics });
      } catch (err) {
        next(err);
      }
    }
  );

  router.get(
    '/admin/exams/:examId/class-summary',
    requireAuth('admin'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const examId = assertValidUuid(req.params.examId, 'examId');
        const summary = await gateway.adminGetClassPerformanceSummary(req.actor!, examId);
        res.status(200).json({ data: summary });
      } catch (err) {
        next(err);
      }
    }
  );

  router.get(
    '/admin/exams/:examId/export.csv',
    requireAuth('admin'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const examId = assertValidUuid(req.params.examId, 'examId');
        const rows = await gateway.adminExportExamResultsRows(req.actor!, examId);
        const csvContent = formatExamResultsCsv(rows);

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="quizpocket-results-${examId}.csv"`
        );
        res.status(200).send(csvContent);
      } catch (err) {
        next(err);
      }
    }
  );

  router.get(
    '/admin/audit-logs',
    requireAuth('admin'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const limit = req.query.limit ? Number(req.query.limit) : 100;
        const logs = await gateway.adminListAuditLogs(req.actor!, limit);
        res.status(200).json({ data: logs });
      } catch (err) {
        next(err);
      }
    }
  );

  // ==========================================================================
  // PROTECTED SCHEDULED EXPIRY SWEEP ENDPOINT
  // ==========================================================================

  router.post(
    '/internal/cron/finalize-expired-attempts',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const configuredSecret = options.cronSecret ?? '';
        const providedSecret =
          typeof req.headers['x-cron-secret'] === 'string' ? req.headers['x-cron-secret'] : '';

        if (!configuredSecret || !constantTimeCompare(providedSecret, configuredSecret)) {
          throw new AppError(401, 'UNAUTHORIZED', 'Invalid scheduler secret.');
        }

        const result = await gateway.finalizeExpiredAttemptsSweep(200);
        res.status(200).json({ data: result });
      } catch (err) {
        next(err);
      }
    }
  );

  // Centralized non-leaking JSON error handler
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const appError = translateDatabaseError(err);
    if (appError.statusCode >= 500) {
      console.error(`[api] ${_req.method} ${_req.originalUrl} -> ${appError.code}:`, err);
    }
    res.status(appError.statusCode).json({
      error: {
        code: appError.code,
        message: appError.message,
      },
    });
  });

  return router;
}
