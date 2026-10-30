import React, { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft,
  Download,
  Plus,
  Edit3,
  Check,
  X,
  Lock,
  Unlock,
  RotateCcw,
  Send,
  Archive,
  Eye,
} from 'lucide-react';
import { ApiClientError, apiRequest, downloadExamResultsCsv } from '../../lib/api.ts';
import {
  formatDateTime,
  formatDurationSeconds,
  formatMarks,
  formatQuestionTypeLabel,
  formatReleasePolicyLabel,
} from '../../lib/format.ts';
import {
  AdminAttemptDetailPayload,
  AdminAttemptSummaryRow,
  AdminClassItem,
  AdminExamSummary,
  AdminQuestionItem,
  ClassPerformanceRow,
  ExamStatisticsPayload,
  Profile,
  QuestionAnalyticsRow,
  QuestionType,
  ResultReleasePolicy,
} from '../../types/frontend.ts';

export type ExamSubTab = 'questions' | 'attempts' | 'analytics' | 'settings';

interface ExamDetailManagerProps {
  exam: AdminExamSummary;
  classes: AdminClassItem[];
  students: Profile[];
  onBack: () => void;
  onExamUpdated: () => Promise<void>;
  initialTab?: ExamSubTab;
}

interface OptionDraft {
  option_text: string;
  is_correct: boolean;
}

export function ExamDetailManager({
  exam,
  classes,
  students,
  onBack,
  onExamUpdated,
  initialTab,
}: ExamDetailManagerProps) {
  const [subTab, setSubTab] = useState<ExamSubTab>(() => {
    if (initialTab && ['questions', 'attempts', 'analytics', 'settings'].includes(initialTab)) {
      return initialTab;
    }
    return 'questions';
  });

  useEffect(() => {
    if (initialTab && ['questions', 'attempts', 'analytics', 'settings'].includes(initialTab)) {
      setSubTab(initialTab);
    }
  }, [initialTab]);

  const [questions, setQuestions] = useState<AdminQuestionItem[]>([]);
  const [stats, setStats] = useState<ExamStatisticsPayload | null>(null);
  const [attempts, setAttempts] = useState<AdminAttemptSummaryRow[]>([]);
  const [questionAnalytics, setQuestionAnalytics] = useState<QuestionAnalyticsRow[]>([]);
  const [classSummary, setClassSummary] = useState<ClassPerformanceRow[]>([]);

  const [loading, setLoading] = useState<boolean>(true);
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [exportingCsv, setExportingCsv] = useState<boolean>(false);
  const [updatingAccess, setUpdatingAccess] = useState<boolean>(false);
  const [unlockingTarget, setUnlockingTarget] = useState<string | null>(null);

  // Retake cooldown control (minutes). Kept locally so it reflects saves immediately.
  const [cooldownMinutes, setCooldownMinutes] = useState<number>(exam.retake_cooldown_minutes);
  const [cooldownDraft, setCooldownDraft] = useState<string>(String(exam.retake_cooldown_minutes));
  useEffect(() => {
    setCooldownMinutes(exam.retake_cooldown_minutes);
    setCooldownDraft(String(exam.retake_cooldown_minutes));
  }, [exam.retake_cooldown_minutes]);

  // Inline Title Edit
  const [editingTitle, setEditingTitle] = useState<boolean>(false);
  const [titleDraft, setTitleDraft] = useState<string>(exam.title);

  // Question editor modal state
  const [showQuestionModal, setShowQuestionModal] = useState<boolean>(false);
  const [editingQuestionId, setEditingQuestionId] = useState<string | null>(null);
  const [qText, setQText] = useState<string>('');
  const [qType, setQType] = useState<QuestionType>('multiple_choice');
  const [qMarks, setQMarks] = useState<string>('1');
  const [qExplanation, setQExplanation] = useState<string>('');
  const [qOptions, setQOptions] = useState<OptionDraft[]>([
    { option_text: '', is_correct: true },
    { option_text: '', is_correct: false },
    { option_text: '', is_correct: false },
    { option_text: '', is_correct: false },
  ]);
  const [qAcceptedAnswersText, setQAcceptedAnswersText] = useState<string>('');
  const [qRubricLinesText, setQRubricLinesText] = useState<string>('');
  const [savingQuestion, setSavingQuestion] = useState<boolean>(false);

  // Selected attempt detail & item grading state
  const [selectedAttemptDetail, setSelectedAttemptDetail] =
    useState<AdminAttemptDetailPayload | null>(null);
  const [loadingAttemptDetail, setLoadingAttemptDetail] = useState<boolean>(false);
  const [gradingQuestionId, setGradingQuestionId] = useState<string | null>(null);
  const [gradeMarksInput, setGradeMarksInput] = useState<string>('');
  const [gradeReasonInput, setGradeReasonInput] = useState<string>('');
  const [savingGrade, setSavingGrade] = useState<boolean>(false);

  const loadExamWorkspace = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      // Independent loads: a failure in one analytics endpoint must not hide the others.
      const [qRes, statsRes, attRes, qaRes, clsRes] = await Promise.allSettled([
        apiRequest<AdminQuestionItem[]>(`/admin/exams/${exam.id}/questions`),
        apiRequest<ExamStatisticsPayload>(`/admin/exams/${exam.id}/statistics`),
        apiRequest<AdminAttemptSummaryRow[]>(`/admin/exams/${exam.id}/attempts`),
        apiRequest<QuestionAnalyticsRow[]>(`/admin/exams/${exam.id}/question-analytics`),
        apiRequest<ClassPerformanceRow[]>(`/admin/exams/${exam.id}/class-summary`),
      ]);

      const failures: string[] = [];
      const note = (label: string, res: PromiseRejectedResult) => {
        const reason = res.reason;
        failures.push(
          `${label}: ${reason instanceof ApiClientError ? reason.message : 'request failed'}`
        );
      };

      if (qRes.status === 'fulfilled') setQuestions(Array.isArray(qRes.value) ? qRes.value : []);
      else note('Questions', qRes);

      if (statsRes.status === 'fulfilled') setStats(statsRes.value);
      else note('Statistics', statsRes);

      if (attRes.status === 'fulfilled') setAttempts(Array.isArray(attRes.value) ? attRes.value : []);
      else note('Student attempts', attRes);

      if (qaRes.status === 'fulfilled')
        setQuestionAnalytics(Array.isArray(qaRes.value) ? qaRes.value : []);
      else note('Question analytics', qaRes);

      if (clsRes.status === 'fulfilled')
        setClassSummary(Array.isArray(clsRes.value) ? clsRes.value : []);
      else note('Class summary', clsRes);

      if (failures.length > 0) {
        setErrorMsg(`Some sections could not be loaded — ${failures.join(' | ')}`);
      }
    } catch (err) {
      setErrorMsg(
        err instanceof ApiClientError ? err.message : 'Unable to load quiz details.'
      );
    } finally {
      setLoading(false);
    }
  }, [exam.id]);

  useEffect(() => {
    void loadExamWorkspace();
  }, [loadExamWorkspace]);

  useEffect(() => {
    setTitleDraft(exam.title);
  }, [exam.title]);

  async function handleUpdateExamAccess(patch: {
    is_open?: boolean;
    open_to_all?: boolean;
    title?: string;
    retake_cooldown_minutes?: number;
    max_attempts?: number;
  }) {
    setUpdatingAccess(true);
    setErrorMsg(null);
    setFeedbackMsg(null);
    try {
      await apiRequest(`/admin/exams/${exam.id}/access`, {
        method: 'PATCH',
        body: patch,
      });
      if (patch.retake_cooldown_minutes !== undefined) {
        setCooldownMinutes(patch.retake_cooldown_minutes);
        setCooldownDraft(String(patch.retake_cooldown_minutes));
      }
      if (patch.title !== undefined) {
        setEditingTitle(false);
        setFeedbackMsg('Quiz title updated.');
      } else if (patch.is_open !== undefined) {
        setFeedbackMsg(
          patch.is_open
            ? 'Quiz is now OPEN to students.'
            : 'Quiz is now CLOSED. Students cannot start new attempts.'
        );
      } else {
        setFeedbackMsg('Quiz access and cooldown rules updated.');
      }
      await Promise.all([loadExamWorkspace(), onExamUpdated()]);
    } catch (err) {
      setErrorMsg(err instanceof ApiClientError ? err.message : 'Unable to update quiz access.');
    } finally {
      setUpdatingAccess(false);
    }
  }

  async function handleUnlockRetake(studentId: string | null, studentLabel?: string) {
    setUnlockingTarget(studentId ?? 'all');
    setErrorMsg(null);
    setFeedbackMsg(null);
    try {
      await apiRequest(`/admin/exams/${exam.id}/unlock-retake`, {
        method: 'POST',
        body: {
          student_id: studentId,
          reason: studentId
            ? `Admin unlocked retake for ${studentLabel ?? 'student'}`
            : 'Admin unlocked 3-hour retake cooldown for all students',
        },
      });
      setFeedbackMsg(
        studentId
          ? `3-hour cooldown overridden — ${studentLabel ?? 'Student'} can retake the quiz immediately.`
          : '3-hour cooldown overridden for ALL students on this quiz.'
      );
      await Promise.all([loadExamWorkspace(), onExamUpdated()]);
    } catch (err) {
      setErrorMsg(err instanceof ApiClientError ? err.message : 'Unable to unlock retake.');
    } finally {
      setUnlockingTarget(null);
    }
  }

  function openNewQuestionEditor() {
    setEditingQuestionId(null);
    setQText('');
    setQType('multiple_choice');
    setQMarks('1');
    setQExplanation('');
    setQOptions([
      { option_text: '', is_correct: true },
      { option_text: '', is_correct: false },
      { option_text: '', is_correct: false },
      { option_text: '', is_correct: false },
    ]);
    setQAcceptedAnswersText('');
    setQRubricLinesText('');
    setShowQuestionModal(true);
  }

  function openEditQuestionEditor(q: AdminQuestionItem) {
    setEditingQuestionId(q.id);
    setQText(q.question_text);
    setQType(q.question_type);
    setQMarks(String(q.marks));
    setQExplanation(q.explanation ?? '');

    if (q.question_type === 'multiple_choice' || q.question_type === 'true_false') {
      setQOptions(
        q.options.map((o) => ({ option_text: o.option_text, is_correct: o.is_correct }))
      );
    } else {
      setQOptions([
        { option_text: 'True', is_correct: true },
        { option_text: 'False', is_correct: false },
      ]);
    }

    setQAcceptedAnswersText((q.accepted_answers ?? []).join(', '));

    const rawRubric = q.rubric_keywords;
    const groups = Array.isArray(rawRubric)
      ? rawRubric
      : rawRubric && typeof rawRubric === 'object' && Array.isArray(rawRubric.groups)
        ? rawRubric.groups
        : [];
    setQRubricLinesText(
      groups.map((grp) => (Array.isArray(grp) ? grp.join(', ') : String(grp))).join('\n')
    );
    setShowQuestionModal(true);
  }

  function handleQuestionTypeSwitch(nextType: QuestionType) {
    setQType(nextType);
    if (nextType === 'true_false') {
      setQOptions([
        { option_text: 'True', is_correct: true },
        { option_text: 'False', is_correct: false },
      ]);
    } else if (nextType === 'multiple_choice' && qOptions.length < 3) {
      setQOptions([
        { option_text: '', is_correct: true },
        { option_text: '', is_correct: false },
        { option_text: '', is_correct: false },
        { option_text: '', is_correct: false },
      ]);
    } else if (nextType === 'short_answer' && qMarks === '1') {
      setQMarks('5');
    }
  }

  async function handleSaveQuestion(e: React.FormEvent) {
    e.preventDefault();
    setSavingQuestion(true);
    setErrorMsg(null);
    setFeedbackMsg(null);

    try {
      const parsedMarks = Number(qMarks);
      const acceptedAnswers =
        qType === 'fill_in_blank'
          ? qAcceptedAnswersText
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : [];

      const rubricGroups =
        qType === 'short_answer'
          ? qRubricLinesText
              .split('\n')
              .map((line) =>
                line
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean)
              )
              .filter((grp) => grp.length > 0)
          : [];

      await apiRequest(`/admin/exams/${exam.id}/questions`, {
        method: 'POST',
        body: {
          question_id: editingQuestionId,
          question_text: qText.trim(),
          question_type: qType,
          marks: parsedMarks,
          explanation: qExplanation.trim() || null,
          options:
            qType === 'multiple_choice' || qType === 'true_false'
              ? qOptions.map((o, idx) => ({
                  option_text: o.option_text.trim(),
                  display_order: idx + 1,
                  is_correct: o.is_correct,
                }))
              : [],
          accepted_answers: acceptedAnswers,
          rubric_keywords:
            qType === 'short_answer' && rubricGroups.length > 0
              ? { required_matches: rubricGroups.length, groups: rubricGroups }
              : [],
        },
      });

      setShowQuestionModal(false);
      setFeedbackMsg(editingQuestionId ? 'Question updated.' : 'Question added to quiz.');
      await Promise.all([loadExamWorkspace(), onExamUpdated()]);
    } catch (err) {
      setErrorMsg(err instanceof ApiClientError ? err.message : 'Unable to save question.');
    } finally {
      setSavingQuestion(false);
    }
  }

  async function handlePublishExam() {
    setErrorMsg(null);
    setFeedbackMsg(null);
    try {
      await apiRequest(`/admin/exams/${exam.id}/publish`, { method: 'POST' });
      setFeedbackMsg('Quiz published and open to students.');
      await Promise.all([loadExamWorkspace(), onExamUpdated()]);
    } catch (err) {
      setErrorMsg(err instanceof ApiClientError ? err.message : 'Unable to publish quiz.');
    }
  }

  async function handleArchiveExam() {
    setErrorMsg(null);
    setFeedbackMsg(null);
    try {
      await apiRequest(`/admin/exams/${exam.id}/archive`, { method: 'POST' });
      setFeedbackMsg('Quiz archived.');
      await Promise.all([loadExamWorkspace(), onExamUpdated()]);
    } catch (err) {
      setErrorMsg(err instanceof ApiClientError ? err.message : 'Unable to archive quiz.');
    }
  }

  async function handleReleaseSettingsUpdate(patch: {
    result_release_policy?: ResultReleasePolicy;
    results_released_manually?: boolean;
    allow_review?: boolean;
  }) {
    setErrorMsg(null);
    setFeedbackMsg(null);
    try {
      await apiRequest(`/admin/exams/${exam.id}/release-settings`, {
        method: 'PATCH',
        body: patch,
      });
      setFeedbackMsg('Result release settings updated.');
      await onExamUpdated();
    } catch (err) {
      setErrorMsg(err instanceof ApiClientError ? err.message : 'Unable to update settings.');
    }
  }

  async function handleToggleClassAssignment(classId: string, currentlyAssigned: boolean) {
    setErrorMsg(null);
    setFeedbackMsg(null);
    try {
      await apiRequest(`/admin/exams/${exam.id}/assignments`, {
        method: 'POST',
        body: {
          class_id: classId,
          status: currentlyAssigned ? 'revoked' : 'active',
        },
      });
      setFeedbackMsg(
        currentlyAssigned ? 'Class assignment revoked.' : 'Class cohort assigned to quiz.'
      );
      await Promise.all([loadExamWorkspace(), onExamUpdated()]);
    } catch (err) {
      setErrorMsg(err instanceof ApiClientError ? err.message : 'Unable to update assignment.');
    }
  }

  async function handleToggleStudentAssignment(studentId: string, currentlyAssigned: boolean) {
    setErrorMsg(null);
    setFeedbackMsg(null);
    try {
      await apiRequest(`/admin/exams/${exam.id}/assignments`, {
        method: 'POST',
        body: {
          student_id: studentId,
          status: currentlyAssigned ? 'revoked' : 'active',
        },
      });
      setFeedbackMsg(
        currentlyAssigned ? 'Direct student assignment revoked.' : 'Student assigned directly.'
      );
      await Promise.all([loadExamWorkspace(), onExamUpdated()]);
    } catch (err) {
      setErrorMsg(err instanceof ApiClientError ? err.message : 'Unable to update assignment.');
    }
  }

  async function openAttemptInspection(attemptId: string) {
    setLoadingAttemptDetail(true);
    setErrorMsg(null);
    setGradingQuestionId(null);
    try {
      const detail = await apiRequest<AdminAttemptDetailPayload>(`/admin/attempts/${attemptId}`);
      setSelectedAttemptDetail(detail);
    } catch (err) {
      setErrorMsg(err instanceof ApiClientError ? err.message : 'Unable to load attempt details.');
    } finally {
      setLoadingAttemptDetail(false);
    }
  }

  async function handleSaveItemGrade(e: React.FormEvent, resultId: string, questionId: string) {
    e.preventDefault();
    setSavingGrade(true);
    setErrorMsg(null);
    try {
      await apiRequest(`/admin/results/${resultId}/items/${questionId}/grade`, {
        method: 'POST',
        body: {
          marks_awarded: Number(gradeMarksInput),
          reason: gradeReasonInput.trim(),
        },
      });
      setGradingQuestionId(null);
      setGradeMarksInput('');
      setGradeReasonInput('');
      if (selectedAttemptDetail) {
        const refreshed = await apiRequest<AdminAttemptDetailPayload>(
          `/admin/attempts/${selectedAttemptDetail.attempt_id}`
        );
        setSelectedAttemptDetail(refreshed);
      }
      await loadExamWorkspace();
      setFeedbackMsg('Item marks updated and logged.');
    } catch (err) {
      setErrorMsg(err instanceof ApiClientError ? err.message : 'Unable to save item grade.');
    } finally {
      setSavingGrade(false);
    }
  }

  async function handleCsvExport() {
    setExportingCsv(true);
    setErrorMsg(null);
    try {
      await downloadExamResultsCsv(exam.id, exam.title);
    } catch (err) {
      setErrorMsg(err instanceof ApiClientError ? err.message : 'CSV export failed.');
    } finally {
      setExportingCsv(false);
    }
  }

  const isLockedByAttempts = exam.attempt_count > 0;
  const isQuizOpen = exam.is_open !== false;
  const activeClassIds = new Set(
    exam.assignments.filter((a) => a.class_id).map((a) => a.class_id as string)
  );
  const activeStudentIds = new Set(
    exam.assignments.filter((a) => a.student_id).map((a) => a.student_id as string)
  );

  return (
    <div className="space-y-6">
      {/* Top Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          className="min-h-[44px] px-3 -ml-3 rounded-xl text-sm font-semibold text-[#013F32] dark:text-[#E7FE25] hover:bg-[#FDFDFD] dark:hover:bg-white/5 inline-flex items-center gap-2 whitespace-nowrap transition"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>All Quizzes</span>
        </button>

        <div className="flex flex-wrap items-center gap-2">
          {exam.status === 'draft' && (
            <button
              type="button"
              onClick={() => void handlePublishExam()}
              className="min-h-[44px] px-4 rounded-xl bg-[#013F32] text-[#FDFDFD] dark:bg-[#E7FE25] dark:text-[#161616] text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              <Send className="w-3.5 h-3.5" />
              <span>Publish Quiz</span>
            </button>
          )}

          {exam.status === 'published' && (
            <button
              type="button"
              disabled={updatingAccess}
              onClick={() => void handleUpdateExamAccess({ is_open: !isQuizOpen })}
              className={`min-h-[44px] px-4 rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 border transition whitespace-nowrap ${
                isQuizOpen
                  ? 'border-neutral-200 dark:border-white/15 bg-[#FDFDFD] dark:bg-[#1E1F1E] text-neutral-700 dark:text-neutral-200 hover:border-rose-400 hover:text-rose-700 dark:hover:text-rose-300'
                  : 'border-[#013F32] bg-[#013F32] text-[#FDFDFD] dark:border-[#E7FE25] dark:bg-[#E7FE25] dark:text-[#161616]'
              }`}
            >
              {isQuizOpen ? (
                <>
                  <Lock className="w-3.5 h-3.5" />
                  <span>Close Quiz</span>
                </>
              ) : (
                <>
                  <Unlock className="w-3.5 h-3.5" />
                  <span>Open Quiz</span>
                </>
              )}
            </button>
          )}

          {exam.status === 'published' && exam.attempt_count > 0 && (
            <button
              type="button"
              disabled={unlockingTarget !== null}
              onClick={() => void handleUnlockRetake(null)}
              className="min-h-[44px] px-4 rounded-xl bg-[#013F32] hover:bg-[#025342] text-[#FDFDFD] dark:bg-[#E7FE25] dark:hover:bg-[#d8ef1a] dark:text-[#161616] text-xs font-semibold inline-flex items-center gap-1.5 transition whitespace-nowrap"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>
                {unlockingTarget === 'all' ? 'Unlocking...' : 'Unlock All Retakes'}
              </span>
            </button>
          )}

          {exam.status !== 'archived' && (
            <button
              type="button"
              onClick={() => void handleArchiveExam()}
              className="min-h-[44px] px-3.5 rounded-xl border border-neutral-200 dark:border-white/15 bg-[#FDFDFD] dark:bg-[#1E1F1E] text-xs font-semibold text-neutral-600 dark:text-neutral-300 inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              <Archive className="w-3.5 h-3.5" />
              <span>Archive</span>
            </button>
          )}

          <button
            type="button"
            disabled={exportingCsv}
            onClick={() => void handleCsvExport()}
            className="min-h-[44px] px-3.5 rounded-xl border border-neutral-200 dark:border-white/15 bg-[#FDFDFD] dark:bg-[#1E1F1E] text-xs font-semibold text-[#161616] dark:text-[#FDFDFD] inline-flex items-center gap-1.5 whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5 text-[#013F32] dark:text-[#E7FE25]" />
            <span>{exportingCsv ? 'Exporting...' : 'Export CSV'}</span>
          </button>
        </div>
      </div>

      {/* Quiz Header Summary */}
      <section className="bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-3xl border border-neutral-200/90 dark:border-white/10 p-5 sm:p-6 space-y-4">
        <div>
          <div className="text-xs text-neutral-500 dark:text-neutral-400 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span
              className={`font-semibold ${
                exam.status === 'published' && isQuizOpen
                  ? 'text-[#013F32] dark:text-[#E7FE25]'
                  : 'text-rose-700 dark:text-rose-400'
              }`}
            >
              {exam.status === 'published'
                ? isQuizOpen
                  ? 'Open to Students'
                  : 'Closed by Instructor'
                : exam.status}
            </span>
            <span>·</span>
            <span className="font-mono tabular-nums">{exam.duration_minutes} min</span>
            <span>·</span>
            <span className="font-mono tabular-nums">{formatMarks(exam.total_marks)} marks</span>
            <span>·</span>
            <span className="font-mono tabular-nums">
              Pass {formatMarks(exam.passing_percentage)}%
            </span>
            <span>·</span>
            <span className="font-mono tabular-nums">
              Retake cooldown {Math.round((exam.retake_cooldown_minutes / 60) * 10) / 10}h
            </span>
            <span>·</span>
            <span>{formatReleasePolicyLabel(exam.result_release_policy)}</span>
          </div>

          {editingTitle ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (titleDraft.trim()) {
                  void handleUpdateExamAccess({ title: titleDraft.trim() });
                }
              }}
              className="mt-2 flex flex-wrap items-center gap-2"
            >
              <input
                type="text"
                required
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                className="flex-1 min-w-[240px] min-h-[44px] px-3.5 rounded-xl border border-neutral-300 dark:border-white/20 bg-neutral-50 dark:bg-[#161616] text-base sm:text-sm font-semibold"
              />
              <button
                type="submit"
                disabled={updatingAccess}
                className="min-h-[44px] px-4 rounded-xl bg-[#013F32] text-[#FDFDFD] dark:bg-[#E7FE25] dark:text-[#161616] text-xs font-semibold whitespace-nowrap"
              >
                Save Title
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditingTitle(false);
                  setTitleDraft(exam.title);
                }}
                className="min-h-[44px] px-3 rounded-xl text-xs font-semibold text-neutral-500"
              >
                Cancel
              </button>
            </form>
          ) : (
            <div className="flex items-start justify-between gap-3 mt-1.5">
              <h1 className="font-display text-xl sm:text-2xl font-bold text-[#161616] dark:text-[#FDFDFD]">
                {exam.title}
              </h1>
              <button
                type="button"
                onClick={() => setEditingTitle(true)}
                className="min-h-[38px] px-3 rounded-xl border border-neutral-200 dark:border-white/15 text-xs font-semibold text-neutral-600 dark:text-neutral-300 hover:border-[#013F32] dark:hover:border-[#E7FE25] inline-flex items-center gap-1.5 shrink-0 whitespace-nowrap"
              >
                <Edit3 className="w-3.5 h-3.5" />
                <span>Rename</span>
              </button>
            </div>
          )}

          {exam.description && (
            <p className="text-sm text-neutral-600 dark:text-neutral-300 mt-1.5 leading-relaxed">
              {exam.description}
            </p>
          )}
        </div>

        {/* Sub-Navigation */}
        <div className="pt-2 border-t border-neutral-200/70 dark:border-white/10 flex overflow-x-auto gap-1.5 -mx-1 px-1">
          {(
            [
              { id: 'questions', label: `Questions (${questions.length})` },
              { id: 'attempts', label: `Attempts & Retakes (${attempts.length})` },
              { id: 'analytics', label: 'Analytics' },
              { id: 'settings', label: 'Access & Rules' },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                setSelectedAttemptDetail(null);
                setSubTab(t.id);
              }}
              className={`min-h-[42px] px-4 rounded-xl text-xs font-semibold transition whitespace-nowrap ${
                subTab === t.id
                  ? 'bg-[#013F32] text-[#FDFDFD] dark:bg-[#E7FE25] dark:text-[#161616]'
                  : 'text-neutral-600 dark:text-neutral-400 hover:text-[#161616] dark:hover:text-[#FDFDFD] hover:bg-neutral-100 dark:hover:bg-white/5'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </section>

      {feedbackMsg && (
        <div className="rounded-2xl bg-[#013F32]/10 dark:bg-[#E7FE25]/15 border border-[#013F32]/25 dark:border-[#E7FE25]/35 px-4 py-3 text-xs text-[#013F32] dark:text-[#E7FE25] font-medium flex items-center justify-between gap-3">
          <span>{feedbackMsg}</span>
          <button
            type="button"
            onClick={() => setFeedbackMsg(null)}
            className="underline font-semibold shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {errorMsg && (
        <div className="rounded-2xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800/60 px-4 py-3 text-xs text-rose-800 dark:text-rose-200">
          {errorMsg}
        </div>
      )}

      {loading ? (
        <div className="bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-3xl border border-neutral-200 dark:border-white/10 p-10 text-center text-sm text-neutral-500 dark:text-neutral-400">
          Loading quiz workspace...
        </div>
      ) : (
        <>
          {/* SUB-TAB 1: QUESTIONS & ANSWER KEYS */}
          {subTab === 'questions' && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                {isLockedByAttempts ? (
                  <div className="text-xs text-neutral-600 dark:text-neutral-300 flex items-center gap-2">
                    <Lock className="w-4 h-4 text-[#013F32] dark:text-[#E7FE25] shrink-0" />
                    <span>
                      Scoring and answer keys are locked because student attempts exist (
                      <strong className="font-mono tabular-nums">{exam.attempt_count}</strong>{' '}
                      recorded).
                    </span>
                  </div>
                ) : (
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">
                    Author multiple-choice, true/false, fill-in-the-blank, and short-answer items.
                  </p>
                )}

                {!isLockedByAttempts && (
                  <button
                    type="button"
                    onClick={openNewQuestionEditor}
                    className="min-h-[44px] px-4 rounded-xl bg-[#013F32] text-[#FDFDFD] dark:bg-[#E7FE25] dark:text-[#161616] text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Add Question</span>
                  </button>
                )}
              </div>

              {questions.length === 0 ? (
                <div className="bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-3xl border border-neutral-200 dark:border-white/10 p-10 text-center text-sm text-neutral-500 dark:text-neutral-400">
                  No questions added yet. Add at least one question before publishing.
                </div>
              ) : (
                <div className="bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-3xl border border-neutral-200/90 dark:border-white/10 divide-y divide-neutral-200/70 dark:divide-white/10">
                  {questions.map((q) => (
                    <div key={q.id} className="p-5 sm:p-6 space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-xs text-neutral-500 dark:text-neutral-400">
                          <span className="font-mono tabular-nums font-bold text-[#013F32] dark:text-[#E7FE25]">
                            Q{q.display_order}
                          </span>
                          <span className="mx-1.5">·</span>
                          <span>{formatQuestionTypeLabel(q.question_type)}</span>
                          <span className="mx-1.5">·</span>
                          <span className="font-mono tabular-nums font-semibold text-[#161616] dark:text-[#FDFDFD]">
                            {formatMarks(q.marks)} {Number(q.marks) === 1 ? 'mark' : 'marks'}
                          </span>
                        </div>

                        {!isLockedByAttempts && (
                          <button
                            type="button"
                            onClick={() => openEditQuestionEditor(q)}
                            className="min-h-[38px] px-3 rounded-xl border border-neutral-200 dark:border-white/15 text-xs font-semibold text-neutral-600 dark:text-neutral-300 hover:text-[#161616] dark:hover:text-[#FDFDFD] inline-flex items-center gap-1.5 whitespace-nowrap"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                            <span>Edit</span>
                          </button>
                        )}
                      </div>

                      <p className="text-sm sm:text-base font-semibold text-[#161616] dark:text-[#FDFDFD] leading-snug">
                        {q.question_text}
                      </p>

                      {(q.question_type === 'multiple_choice' ||
                        q.question_type === 'true_false') && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                          {q.options.map((opt, idx) => (
                            <div
                              key={opt.id}
                              className={`rounded-xl px-3.5 py-2.5 border flex items-center justify-between gap-2 ${
                                opt.is_correct
                                  ? 'border-[#013F32]/40 dark:border-[#E7FE25]/45 bg-[#013F32]/[0.06] dark:bg-[#E7FE25]/[0.09] text-[#161616] dark:text-[#FDFDFD] font-medium'
                                  : 'border-neutral-200/80 dark:border-white/10 bg-neutral-50/50 dark:bg-[#161616] text-neutral-600 dark:text-neutral-400'
                              }`}
                            >
                              <span>
                                <strong className="font-mono mr-1.5">
                                  {String.fromCharCode(65 + idx)}.
                                </strong>
                                {opt.option_text}
                              </span>
                              {opt.is_correct && (
                                <Check className="w-3.5 h-3.5 text-[#013F32] dark:text-[#E7FE25] shrink-0" />
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {q.question_type === 'fill_in_blank' && (
                        <div className="text-xs text-neutral-600 dark:text-neutral-300">
                          <span className="font-semibold text-[#161616] dark:text-[#FDFDFD]">
                            Accepted Answers:{' '}
                          </span>
                          <span className="font-mono text-[#013F32] dark:text-[#E7FE25]">
                            {(q.accepted_answers ?? []).join(' | ')}
                          </span>
                        </div>
                      )}

                      {q.explanation && (
                        <p className="text-xs text-neutral-500 dark:text-neutral-400 leading-relaxed">
                          <span className="font-semibold text-neutral-700 dark:text-neutral-300">
                            Note / Answer Key:{' '}
                          </span>
                          {q.explanation}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* SUB-TAB 2: STUDENT ATTEMPTS, RETAKE UNLOCKS & ITEM GRADING */}
          {subTab === 'attempts' && (
            <div className="space-y-4">
              {loadingAttemptDetail ? (
                <div className="bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-3xl border border-neutral-200 dark:border-white/10 p-10 text-center text-sm text-neutral-500 dark:text-neutral-400">
                  Loading candidate submission...
                </div>
              ) : selectedAttemptDetail ? (
                <div className="space-y-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => setSelectedAttemptDetail(null)}
                      className="min-h-[44px] px-3 -ml-3 rounded-xl text-xs font-semibold text-[#013F32] dark:text-[#E7FE25] hover:bg-[#FDFDFD] dark:hover:bg-white/5 inline-flex items-center gap-1.5 whitespace-nowrap"
                    >
                      <ArrowLeft className="w-4 h-4" />
                      <span>Back to Attempt List</span>
                    </button>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        disabled={unlockingTarget !== null}
                        onClick={() =>
                          void handleUnlockRetake(
                            selectedAttemptDetail.student.id,
                            selectedAttemptDetail.student.full_name
                          )
                        }
                        className="min-h-[40px] px-3.5 rounded-xl bg-[#013F32] text-[#FDFDFD] dark:bg-[#E7FE25] dark:text-[#161616] text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap"
                      >
                        <Unlock className="w-3.5 h-3.5" />
                        <span>Unlock Student Retake</span>
                      </button>
                      {selectedAttemptDetail.result && (
                        <div className="text-sm font-mono tabular-nums font-bold text-[#161616] dark:text-[#FDFDFD]">
                          Total: {formatMarks(selectedAttemptDetail.result.marks_obtained)} /{' '}
                          {formatMarks(selectedAttemptDetail.result.total_marks)} (
                          {Number(selectedAttemptDetail.result.percentage).toFixed(1)}%)
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-3xl border border-neutral-200/90 dark:border-white/10 p-5 flex flex-wrap items-center justify-between gap-4 text-xs text-neutral-600 dark:text-neutral-300">
                    <div>
                      <div className="text-base font-bold text-[#161616] dark:text-[#FDFDFD]">
                        {selectedAttemptDetail.student.full_name}
                      </div>
                      <div className="font-mono mt-0.5">
                        {selectedAttemptDetail.student.student_identifier ??
                          selectedAttemptDetail.student.email}{' '}
                        · Attempt #{selectedAttemptDetail.attempt_number}
                      </div>
                    </div>
                    <div className="text-right">
                      <div>Status: {selectedAttemptDetail.status}</div>
                      <div className="mt-0.5">
                        Submitted: {formatDateTime(selectedAttemptDetail.submitted_at)}
                      </div>
                    </div>
                  </div>

                  <div className="bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-3xl border border-neutral-200/90 dark:border-white/10 divide-y divide-neutral-200/70 dark:divide-white/10">
                    {selectedAttemptDetail.questions.map((q) => {
                      const isGradingThis = gradingQuestionId === q.question_id;
                      const pickedOption = q.options.find((o) => o.id === q.selected_option_id);
                      const correctOption = q.options.find((o) => o.is_correct);

                      return (
                        <div key={q.question_id} className="p-5 sm:p-6 space-y-3">
                          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                            <div className="text-neutral-500 dark:text-neutral-400">
                              <span className="font-mono tabular-nums font-bold text-[#013F32] dark:text-[#E7FE25]">
                                Q{q.display_order}
                              </span>
                              <span className="mx-1.5">·</span>
                              <span>{formatQuestionTypeLabel(q.question_type)}</span>
                            </div>

                            <div className="flex items-center gap-3">
                              <span className="font-mono tabular-nums font-semibold text-[#161616] dark:text-[#FDFDFD]">
                                {formatMarks(q.marks_awarded ?? 0)} / {formatMarks(q.marks)} marks
                              </span>
                              {selectedAttemptDetail.result && !isGradingThis && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setGradingQuestionId(q.question_id);
                                    setGradeMarksInput(String(q.marks_awarded ?? 0));
                                    setGradeReasonInput('');
                                  }}
                                  className="min-h-[36px] px-3 rounded-xl border border-neutral-200 dark:border-white/15 hover:border-[#013F32] dark:hover:border-[#E7FE25] text-xs font-semibold text-[#013F32] dark:text-[#E7FE25] whitespace-nowrap"
                                >
                                  Grade / Adjust
                                </button>
                              )}
                            </div>
                          </div>

                          <p className="text-sm font-semibold text-[#161616] dark:text-[#FDFDFD]">
                            {q.question_text}
                          </p>

                          {(q.question_type === 'multiple_choice' ||
                            q.question_type === 'true_false') && (
                            <div className="text-xs space-y-1 text-neutral-600 dark:text-neutral-300">
                              <div>
                                <span className="font-medium text-neutral-500">
                                  Student Selection:{' '}
                                </span>
                                <span className="font-semibold text-[#161616] dark:text-[#FDFDFD]">
                                  {pickedOption ? pickedOption.option_text : 'Unanswered'}
                                </span>
                              </div>
                              <div>
                                <span className="font-medium text-neutral-500">
                                  Correct Option:{' '}
                                </span>
                                <span className="font-semibold text-[#013F32] dark:text-[#E7FE25]">
                                  {correctOption?.option_text}
                                </span>
                              </div>
                            </div>
                          )}

                          {(q.question_type === 'fill_in_blank' ||
                            q.question_type === 'short_answer') && (
                            <div className="space-y-2 text-xs">
                              <div className="rounded-2xl bg-neutral-100/80 dark:bg-[#161616] border border-neutral-200/80 dark:border-white/10 p-3.5 text-[#161616] dark:text-[#FDFDFD] whitespace-pre-wrap">
                                <span className="block text-[11px] font-semibold text-neutral-500 dark:text-neutral-400 mb-1">
                                  Candidate Response
                                </span>
                                {q.submitted_text || 'Unanswered'}
                              </div>
                              {q.explanation && (
                                <div className="text-neutral-500 dark:text-neutral-400">
                                  <strong className="text-neutral-700 dark:text-neutral-300">
                                    Reference Key:{' '}
                                  </strong>
                                  {q.explanation}
                                </div>
                              )}
                            </div>
                          )}

                          {isGradingThis && selectedAttemptDetail.result && (
                            <form
                              onSubmit={(e) =>
                                void handleSaveItemGrade(
                                  e,
                                  selectedAttemptDetail.result!.id,
                                  q.question_id
                                )
                              }
                              className="rounded-2xl bg-neutral-100/80 dark:bg-[#161616] border border-neutral-200 dark:border-white/15 p-4 space-y-3"
                            >
                              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                <div>
                                  <label className="block text-xs font-semibold text-[#161616] dark:text-[#FDFDFD] mb-1">
                                    Marks (0 – {formatMarks(q.marks)})
                                  </label>
                                  <input
                                    type="number"
                                    step="0.25"
                                    min={0}
                                    max={Number(q.marks)}
                                    required
                                    value={gradeMarksInput}
                                    onChange={(e) => setGradeMarksInput(e.target.value)}
                                    className="w-full min-h-[44px] px-3 rounded-xl border border-neutral-300 dark:border-white/20 bg-[#FDFDFD] dark:bg-[#1E1F1E] text-base sm:text-sm font-mono"
                                  />
                                </div>
                                <div className="sm:col-span-2">
                                  <label className="block text-xs font-semibold text-[#161616] dark:text-[#FDFDFD] mb-1">
                                    Grading Note (Required)
                                  </label>
                                  <input
                                    type="text"
                                    required
                                    minLength={3}
                                    placeholder="e.g. Full credit for listing all 6 HIM domains"
                                    value={gradeReasonInput}
                                    onChange={(e) => setGradeReasonInput(e.target.value)}
                                    className="w-full min-h-[44px] px-3 rounded-xl border border-neutral-300 dark:border-white/20 bg-[#FDFDFD] dark:bg-[#1E1F1E] text-base sm:text-sm"
                                  />
                                </div>
                              </div>
                              <div className="flex items-center justify-end gap-2">
                                <button
                                  type="button"
                                  onClick={() => setGradingQuestionId(null)}
                                  className="min-h-[40px] px-3 rounded-xl text-xs font-semibold text-neutral-600 dark:text-neutral-300"
                                >
                                  Cancel
                                </button>
                                <button
                                  type="submit"
                                  disabled={savingGrade}
                                  className="min-h-[40px] px-4 rounded-xl bg-[#013F32] text-[#FDFDFD] dark:bg-[#E7FE25] dark:text-[#161616] text-xs font-semibold whitespace-nowrap"
                                >
                                  {savingGrade ? 'Saving...' : 'Save Item Marks'}
                                </button>
                              </div>
                            </form>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : attempts.length === 0 ? (
                <div className="bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-3xl border border-neutral-200 dark:border-white/10 p-10 text-center text-sm text-neutral-500 dark:text-neutral-400">
                  No student attempts have been started for this quiz yet.
                </div>
              ) : (
                <div className="bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-3xl border border-neutral-200/90 dark:border-white/10 divide-y divide-neutral-200/70 dark:divide-white/10">
                  {attempts.map((a) => (
                    <div
                      key={a.attempt_id}
                      className="p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
                    >
                      <div className="space-y-1">
                        <div className="text-sm font-bold text-[#161616] dark:text-[#FDFDFD]">
                          {a.student_name}{' '}
                          <span className="font-mono font-normal text-xs text-neutral-500 dark:text-neutral-400">
                            (
                            {a.student_identifier ??
                              (a.student_email.endsWith('@users.quizpocket.local')
                                ? a.student_name
                                : a.student_email)}
                            )
                          </span>
                        </div>
                        <div className="text-xs text-neutral-500 dark:text-neutral-400 flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="font-mono tabular-nums">
                            Attempt #{a.attempt_number}
                          </span>
                          <span>·</span>
                          <span className="capitalize">{a.status.replace('_', ' ')}</span>
                          <span>·</span>
                          <span>Duration {formatDurationSeconds(a.time_taken_seconds)}</span>
                          {a.marks_obtained !== null && (
                            <>
                              <span>·</span>
                              <span className="font-mono tabular-nums font-bold text-[#161616] dark:text-[#FDFDFD]">
                                {formatMarks(a.marks_obtained)}/{formatMarks(a.total_marks)} (
                                {Number(a.percentage ?? 0).toFixed(1)}%)
                              </span>
                            </>
                          )}
                          {a.in_cooldown && (
                            <>
                              <span>·</span>
                              <span className="text-amber-700 dark:text-amber-400 font-semibold">
                                Locked until {formatDateTime(a.cooldown_until)}
                              </span>
                            </>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        {a.status !== 'in_progress' && (
                          <button
                            type="button"
                            disabled={unlockingTarget !== null}
                            onClick={() => void handleUnlockRetake(a.student_id, a.student_name)}
                            className={`min-h-[42px] px-3.5 rounded-xl text-xs font-semibold inline-flex items-center justify-center gap-1.5 transition whitespace-nowrap ${
                              a.in_cooldown
                                ? 'bg-[#013F32] text-[#FDFDFD] dark:bg-[#E7FE25] dark:text-[#161616]'
                                : 'border border-neutral-200 dark:border-white/15 text-neutral-600 dark:text-neutral-300 hover:border-[#013F32] dark:hover:border-[#E7FE25]'
                            }`}
                          >
                            <Unlock className="w-3.5 h-3.5" />
                            <span>
                              {unlockingTarget === a.student_id
                                ? 'Unlocking...'
                                : 'Unlock Retake'}
                            </span>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void openAttemptInspection(a.attempt_id)}
                          className="min-h-[42px] px-4 rounded-xl border border-neutral-200 dark:border-white/15 hover:border-[#013F32] dark:hover:border-[#E7FE25] text-xs font-semibold text-[#013F32] dark:text-[#E7FE25] inline-flex items-center justify-center gap-1.5 shrink-0 whitespace-nowrap transition"
                        >
                          <Eye className="w-4 h-4" />
                          <span>Inspect & Grade</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* SUB-TAB 3: ANALYTICS */}
          {subTab === 'analytics' && stats && (
            <div className="space-y-6">
              {/* 4-Card KPI Strip */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-3xl border border-neutral-200/90 dark:border-white/10 p-5">
                  <div className="text-xs text-neutral-500 dark:text-neutral-400">Completion</div>
                  <div className="text-2xl font-bold font-mono tabular-nums text-[#161616] dark:text-[#FDFDFD] mt-1">
                    {stats.completed_attempts} / {stats.assigned_students_count}
                  </div>
                  <div className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 font-mono tabular-nums">
                    {Number(stats.completion_rate_percentage).toFixed(0)}% completion rate
                  </div>
                </div>

                <div className="bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-3xl border border-neutral-200/90 dark:border-white/10 p-5">
                  <div className="text-xs text-neutral-500 dark:text-neutral-400">Average Score</div>
                  <div className="text-2xl font-bold font-mono tabular-nums text-[#013F32] dark:text-[#E7FE25] mt-1">
                    {Number(stats.average_percentage).toFixed(1)}%
                  </div>
                  <div className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 font-mono tabular-nums">
                    {formatMarks(stats.average_marks)} / {formatMarks(stats.total_marks)} marks
                  </div>
                </div>

                <div className="bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-3xl border border-neutral-200/90 dark:border-white/10 p-5">
                  <div className="text-xs text-neutral-500 dark:text-neutral-400">Pass Rate</div>
                  <div className="text-2xl font-bold font-mono tabular-nums text-[#013F32] dark:text-[#E7FE25] mt-1">
                    {Number(stats.pass_rate_percentage).toFixed(1)}%
                  </div>
                  <div className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 font-mono tabular-nums">
                    {stats.pass_count} passed · {stats.fail_count} below threshold
                  </div>
                </div>

                <div className="bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-3xl border border-neutral-200/90 dark:border-white/10 p-5">
                  <div className="text-xs text-neutral-500 dark:text-neutral-400">Score Range</div>
                  <div className="text-2xl font-bold font-mono tabular-nums text-[#161616] dark:text-[#FDFDFD] mt-1">
                    {formatMarks(stats.lowest_marks)} – {formatMarks(stats.highest_marks)}
                  </div>
                  <div className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 font-mono tabular-nums">
                    Out of {formatMarks(stats.total_marks)} marks
                  </div>
                </div>
              </div>

              {/* Class Performance Summary */}
              {classSummary.length > 0 && (
                <section className="bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-3xl border border-neutral-200/90 dark:border-white/10 overflow-hidden">
                  <div className="px-5 py-4 border-b border-neutral-200/70 dark:border-white/10">
                    <h2 className="font-display text-sm font-bold text-[#161616] dark:text-[#FDFDFD]">
                      Class Cohort Performance
                    </h2>
                  </div>
                  <div className="divide-y divide-neutral-200/70 dark:divide-white/10">
                    {classSummary.map((c) => (
                      <div
                        key={c.class_id}
                        className="px-5 py-3.5 flex flex-wrap items-center justify-between gap-3 text-sm"
                      >
                        <div>
                          <div className="font-semibold text-[#161616] dark:text-[#FDFDFD]">
                            {c.class_name}
                          </div>
                          <div className="text-xs text-neutral-500 dark:text-neutral-400 font-mono tabular-nums">
                            {c.active_students} enrolled · {c.completed_attempts} completed attempts
                          </div>
                        </div>
                        <div className="text-xs font-mono tabular-nums">
                          <span className="font-semibold text-[#013F32] dark:text-[#E7FE25]">
                            Avg {Number(c.average_percentage).toFixed(1)}%
                          </span>
                          <span className="mx-2 text-neutral-400">·</span>
                          <span className="font-semibold text-[#161616] dark:text-[#FDFDFD]">
                            Pass {Number(c.pass_rate_percentage).toFixed(1)}%
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Question-Level Item Accuracy */}
              <section className="bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-3xl border border-neutral-200/90 dark:border-white/10 overflow-hidden">
                <div className="px-5 py-4 border-b border-neutral-200/70 dark:border-white/10">
                  <h2 className="font-display text-sm font-bold text-[#161616] dark:text-[#FDFDFD]">
                    Item-Level Question Analysis
                  </h2>
                </div>
                <div className="divide-y divide-neutral-200/70 dark:divide-white/10">
                  {questionAnalytics.map((qa) => (
                    <div key={qa.question_id} className="px-5 py-4 space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <div className="text-neutral-500 dark:text-neutral-400">
                          <span className="font-mono tabular-nums font-bold text-[#161616] dark:text-[#FDFDFD]">
                            Q{qa.display_order}
                          </span>
                          <span className="mx-1.5">·</span>
                          <span>{formatQuestionTypeLabel(qa.question_type)}</span>
                          {qa.commonly_missed && (
                            <>
                              <span className="mx-1.5">·</span>
                              <span className="text-rose-700 dark:text-rose-400 font-semibold">
                                Commonly missed
                              </span>
                            </>
                          )}
                        </div>
                        <div className="font-mono tabular-nums font-semibold text-[#013F32] dark:text-[#E7FE25]">
                          {Number(qa.correct_percentage).toFixed(0)}% score rate (Avg{' '}
                          {formatMarks(qa.average_marks_awarded)}/{formatMarks(qa.marks)})
                        </div>
                      </div>
                      <p className="text-sm text-[#161616] dark:text-[#FDFDFD] line-clamp-2">
                        {qa.question_text}
                      </p>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          )}

          {/* SUB-TAB 4: ACCESS, COOLDOWN & RELEASE RULES */}
          {subTab === 'settings' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
              {/* Access & Cooldown Controls */}
              <section className="bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-3xl border border-neutral-200/90 dark:border-white/10 p-6 space-y-5">
                <h2 className="font-display text-base font-bold text-[#161616] dark:text-[#FDFDFD]">
                  Quiz Access & 3-Hour Cooldown
                </h2>

                <div className="flex items-center justify-between gap-4 pb-4 border-b border-neutral-200/70 dark:border-white/10">
                  <div>
                    <div className="text-sm font-semibold text-[#161616] dark:text-[#FDFDFD]">
                      Quiz Availability
                    </div>
                    <div className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                      {isQuizOpen
                        ? 'Quiz is open — eligible students can start attempts.'
                        : 'Quiz is closed — students cannot start new attempts.'}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={updatingAccess}
                    onClick={() => void handleUpdateExamAccess({ is_open: !isQuizOpen })}
                    className={`min-h-[44px] px-4 rounded-xl text-xs font-semibold border whitespace-nowrap transition ${
                      isQuizOpen
                        ? 'border-[#013F32] bg-[#013F32] text-[#FDFDFD] dark:border-[#E7FE25] dark:bg-[#E7FE25] dark:text-[#161616]'
                        : 'border-neutral-200 dark:border-white/15 text-neutral-600 dark:text-neutral-300'
                    }`}
                  >
                    {isQuizOpen ? 'Open' : 'Closed'}
                  </button>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-neutral-600 dark:text-neutral-300 mb-1.5">
                    Post-Completion Retake Cooldown
                  </label>
                  <select
                    value={[0, 15, 30, 60, 120, 180, 360, 720, 1440].includes(cooldownMinutes) ? cooldownMinutes : 'custom'}
                    disabled={updatingAccess}
                    onChange={(e) => {
                      if (e.target.value === 'custom') return;
                      void handleUpdateExamAccess({
                        retake_cooldown_minutes: Number(e.target.value),
                      });
                    }}
                    className="w-full min-h-[46px] px-3.5 rounded-2xl border border-neutral-200 dark:border-white/15 bg-neutral-50/70 dark:bg-[#161616] text-base sm:text-sm text-[#161616] dark:text-[#FDFDFD]"
                  >
                    <option value={180}>3 hours (180 minutes — Default)</option>
                    <option value={360}>6 hours</option>
                    <option value={720}>12 hours</option>
                    <option value={1440}>24 hours</option>
                    <option value={120}>2 hours</option>
                    <option value={60}>1 hour (60 minutes)</option>
                    <option value={30}>30 minutes</option>
                    <option value={15}>15 minutes</option>
                    <option value={0}>No cooldown (Immediate retake)</option>
                    <option value="custom">Custom ({cooldownMinutes} minutes)</option>
                  </select>
                  <div className="mt-3 flex items-center gap-2">
                    <input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={43200}
                      step={1}
                      value={cooldownDraft}
                      disabled={updatingAccess}
                      onChange={(e) => setCooldownDraft(e.target.value)}
                      aria-label="Custom retake cooldown in minutes"
                      className="flex-1 min-h-[46px] px-3.5 rounded-2xl border border-neutral-200 dark:border-white/15 bg-neutral-50/70 dark:bg-[#161616] text-base sm:text-sm text-[#161616] dark:text-[#FDFDFD]"
                    />
                    <span className="text-xs text-neutral-500 dark:text-neutral-400">minutes</span>
                    <button
                      type="button"
                      disabled={
                        updatingAccess ||
                        cooldownDraft.trim() === '' ||
                        !Number.isInteger(Number(cooldownDraft)) ||
                        Number(cooldownDraft) < 0 ||
                        Number(cooldownDraft) > 43200 ||
                        Number(cooldownDraft) === cooldownMinutes
                      }
                      onClick={() =>
                        void handleUpdateExamAccess({
                          retake_cooldown_minutes: Number(cooldownDraft),
                        })
                      }
                      className="min-h-[46px] px-4 rounded-xl bg-[#013F32] text-[#FDFDFD] dark:bg-[#E7FE25] dark:text-[#161616] text-xs font-semibold whitespace-nowrap disabled:opacity-40"
                    >
                      {updatingAccess ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                  <p className="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400">
                    0 to 43200 minutes (30 days). Applies to future retakes; use Unlock Retake to skip a running cooldown now.
                  </p>
                </div>

                <div className="flex items-center justify-between gap-4 pt-2 border-t border-neutral-200/70 dark:border-white/10">
                  <div>
                    <div className="text-sm font-semibold text-[#161616] dark:text-[#FDFDFD]">
                      Audience Visibility
                    </div>
                    <div className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                      {exam.open_to_all !== false
                        ? 'All registered students can access this quiz.'
                        : 'Restricted to assigned classes and students below.'}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={updatingAccess}
                    onClick={() =>
                      void handleUpdateExamAccess({ open_to_all: exam.open_to_all === false })
                    }
                    className={`min-h-[44px] px-4 rounded-xl text-xs font-semibold border whitespace-nowrap transition ${
                      exam.open_to_all !== false
                        ? 'border-[#013F32] bg-[#013F32]/10 text-[#013F32] dark:border-[#E7FE25] dark:bg-[#E7FE25]/15 dark:text-[#E7FE25]'
                        : 'border-neutral-200 dark:border-white/15 text-neutral-600 dark:text-neutral-300'
                    }`}
                  >
                    {exam.open_to_all !== false ? 'All Students' : 'Assigned Only'}
                  </button>
                </div>

                <div className="pt-3 border-t border-neutral-200/70 dark:border-white/10 space-y-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                    Result Release & Review
                  </h3>

                  <select
                    value={exam.result_release_policy}
                    onChange={(e) =>
                      void handleReleaseSettingsUpdate({
                        result_release_policy: e.target.value as ResultReleasePolicy,
                      })
                    }
                    className="w-full min-h-[46px] px-3.5 rounded-2xl border border-neutral-200 dark:border-white/15 bg-neutral-50/70 dark:bg-[#161616] text-base sm:text-sm text-[#161616] dark:text-[#FDFDFD]"
                  >
                    <option value="immediate">Immediate upon submission</option>
                    <option value="after_window">After scheduled closing window</option>
                    <option value="manual">Manual release by instructor</option>
                  </select>

                  {exam.result_release_policy === 'manual' && (
                    <div className="flex items-center justify-between pt-2">
                      <span className="text-xs text-neutral-600 dark:text-neutral-300">
                        {exam.results_released_manually
                          ? 'Scores are currently visible.'
                          : 'Scores are currently hidden.'}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          void handleReleaseSettingsUpdate({
                            results_released_manually: !exam.results_released_manually,
                          })
                        }
                        className="min-h-[40px] px-4 rounded-xl bg-[#013F32] text-[#FDFDFD] dark:bg-[#E7FE25] dark:text-[#161616] text-xs font-semibold whitespace-nowrap"
                      >
                        {exam.results_released_manually ? 'Hide Results' : 'Release Results'}
                      </button>
                    </div>
                  )}

                  <div className="flex items-center justify-between pt-2">
                    <span className="text-xs text-neutral-600 dark:text-neutral-300">
                      Allow post-submission answer review
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        void handleReleaseSettingsUpdate({ allow_review: !exam.allow_review })
                      }
                      className={`min-h-[40px] px-3.5 rounded-xl text-xs font-semibold border whitespace-nowrap ${
                        exam.allow_review
                          ? 'border-[#013F32] bg-[#013F32]/10 text-[#013F32] dark:border-[#E7FE25] dark:bg-[#E7FE25]/15 dark:text-[#E7FE25]'
                          : 'border-neutral-200 dark:border-white/15 text-neutral-600 dark:text-neutral-300'
                      }`}
                    >
                      {exam.allow_review ? 'Enabled' : 'Disabled'}
                    </button>
                  </div>
                </div>
              </section>

              {/* Class & Direct Student Assignments */}
              <section className="bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-3xl border border-neutral-200/90 dark:border-white/10 p-6 space-y-5">
                <div>
                  <h2 className="font-display text-base font-bold text-[#161616] dark:text-[#FDFDFD]">
                    Class & Student Assignments
                  </h2>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                    Used when Audience Visibility is set to Assigned Only.
                  </p>
                </div>

                {classes.length === 0 ? (
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">
                    No classes created yet.
                  </p>
                ) : (
                  <div className="divide-y divide-neutral-200/70 dark:divide-white/10 border-t border-b border-neutral-200/70 dark:border-white/10">
                    {classes.map((cls) => {
                      const assigned = activeClassIds.has(cls.id);
                      return (
                        <div
                          key={cls.id}
                          className="py-3 flex items-center justify-between gap-3 text-sm"
                        >
                          <div>
                            <div className="font-semibold text-[#161616] dark:text-[#FDFDFD]">
                              {cls.name}
                            </div>
                            <div className="text-xs text-neutral-500 dark:text-neutral-400 font-mono tabular-nums">
                              {cls.members.filter((m) => m.membership_status === 'active').length}{' '}
                              active students
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => void handleToggleClassAssignment(cls.id, assigned)}
                            className={`min-h-[40px] px-3.5 rounded-xl text-xs font-semibold border whitespace-nowrap ${
                              assigned
                                ? 'border-[#013F32] bg-[#013F32]/10 text-[#013F32] dark:border-[#E7FE25] dark:bg-[#E7FE25]/15 dark:text-[#E7FE25]'
                                : 'border-neutral-200 dark:border-white/15 text-[#161616] dark:text-[#FDFDFD]'
                            }`}
                          >
                            {assigned ? 'Assigned ✓' : 'Assign Class'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}

                {students.length > 0 && (
                  <div className="space-y-2 pt-1">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                      Direct Student Assignments
                    </h3>
                    <div className="divide-y divide-neutral-200/70 dark:divide-white/10">
                      {students.map((stu) => {
                        const assigned = activeStudentIds.has(stu.id);
                        return (
                          <div
                            key={stu.id}
                            className="py-2.5 flex items-center justify-between gap-3 text-xs"
                          >
                            <div>
                              <span className="font-semibold text-[#161616] dark:text-[#FDFDFD]">
                                {stu.full_name}
                              </span>
                              <span className="text-neutral-400 ml-1.5 font-mono">
                                {stu.student_identifier ?? stu.username ?? stu.email}
                              </span>
                            </div>
                            <button
                              type="button"
                              onClick={() => void handleToggleStudentAssignment(stu.id, assigned)}
                              className={`min-h-[38px] px-3 rounded-xl font-semibold border whitespace-nowrap ${
                                assigned
                                  ? 'border-[#013F32] bg-[#013F32]/10 text-[#013F32] dark:border-[#E7FE25] dark:bg-[#E7FE25]/15 dark:text-[#E7FE25]'
                                  : 'border-neutral-200 dark:border-white/15 text-neutral-600 dark:text-neutral-300'
                              }`}
                            >
                              {assigned ? 'Direct Assigned' : 'Assign Direct'}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </section>
            </div>
          )}
        </>
      )}

      {/* Question Editor Modal */}
      {showQuestionModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-[#FDFDFD] dark:bg-[#1E1F1E] border border-neutral-200 dark:border-white/10 w-full sm:max-w-xl rounded-t-3xl sm:rounded-3xl p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] sm:pb-6 max-h-[92dvh] overflow-y-auto space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg font-bold text-[#161616] dark:text-[#FDFDFD]">
                {editingQuestionId ? 'Edit Question' : 'Add Question'}
              </h2>
              <button
                type="button"
                onClick={() => setShowQuestionModal(false)}
                className="w-10 h-10 rounded-xl flex items-center justify-center text-neutral-400 hover:text-[#161616] dark:hover:text-[#FDFDFD]"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveQuestion} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-neutral-600 dark:text-neutral-300 mb-1">
                    Question Type
                  </label>
                  <select
                    value={qType}
                    onChange={(e) => handleQuestionTypeSwitch(e.target.value as QuestionType)}
                    className="w-full min-h-[46px] px-3.5 rounded-2xl border border-neutral-200 dark:border-white/15 bg-neutral-50/70 dark:bg-[#161616] text-base sm:text-sm"
                  >
                    <option value="multiple_choice">Multiple Choice</option>
                    <option value="true_false">True or False</option>
                    <option value="fill_in_blank">Fill in the Blank</option>
                    <option value="short_answer">Short Answer</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-neutral-600 dark:text-neutral-300 mb-1">
                    Marks
                  </label>
                  <input
                    type="number"
                    min={0.5}
                    max={100}
                    step="0.5"
                    required
                    value={qMarks}
                    onChange={(e) => setQMarks(e.target.value)}
                    className="w-full min-h-[46px] px-3.5 rounded-2xl border border-neutral-200 dark:border-white/15 bg-neutral-50/70 dark:bg-[#161616] text-base sm:text-sm font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-neutral-600 dark:text-neutral-300 mb-1">
                  Question Prompt
                </label>
                <textarea
                  rows={3}
                  required
                  value={qText}
                  onChange={(e) => setQText(e.target.value)}
                  placeholder="Enter the quiz question..."
                  className="w-full p-3.5 rounded-2xl border border-neutral-200 dark:border-white/15 bg-neutral-50/70 dark:bg-[#161616] text-base sm:text-sm"
                />
              </div>

              {(qType === 'multiple_choice' || qType === 'true_false') && (
                <div className="space-y-2">
                  <label className="block text-xs font-semibold text-neutral-600 dark:text-neutral-300">
                    Answer Options (Click check button for the correct answer)
                  </label>
                  {qOptions.map((opt, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          setQOptions((prev) =>
                            prev.map((item, i) => ({ ...item, is_correct: i === idx }))
                          )
                        }
                        className={`w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 ${
                          opt.is_correct
                            ? 'bg-[#013F32] border-[#013F32] text-[#E7FE25] dark:bg-[#E7FE25] dark:border-[#E7FE25] dark:text-[#161616]'
                            : 'border-neutral-300 dark:border-white/20 text-neutral-400'
                        }`}
                        aria-label={`Mark option ${idx + 1} correct`}
                      >
                        <Check className="w-4 h-4" />
                      </button>
                      <input
                        type="text"
                        required
                        readOnly={qType === 'true_false'}
                        value={opt.option_text}
                        onChange={(e) =>
                          setQOptions((prev) =>
                            prev.map((item, i) =>
                              i === idx ? { ...item, option_text: e.target.value } : item
                            )
                          )
                        }
                        placeholder={`Option ${String.fromCharCode(65 + idx)}`}
                        className="flex-1 min-h-[44px] px-3.5 rounded-2xl border border-neutral-200 dark:border-white/15 bg-neutral-50/70 dark:bg-[#161616] text-base sm:text-sm"
                      />
                    </div>
                  ))}
                </div>
              )}

              {qType === 'fill_in_blank' && (
                <div>
                  <label className="block text-xs font-semibold text-neutral-600 dark:text-neutral-300 mb-1">
                    Accepted Answers (comma-separated, case-insensitive)
                  </label>
                  <input
                    type="text"
                    required
                    value={qAcceptedAnswersText}
                    onChange={(e) => setQAcceptedAnswersText(e.target.value)}
                    placeholder="e.g. ICD-10, ICD 10, ICD10"
                    className="w-full min-h-[46px] px-3.5 rounded-2xl border border-neutral-200 dark:border-white/15 bg-neutral-50/70 dark:bg-[#161616] text-base sm:text-sm"
                  />
                </div>
              )}

              {qType === 'short_answer' && (
                <div>
                  <label className="block text-xs font-semibold text-neutral-600 dark:text-neutral-300 mb-1">
                    Concept Rubric Groups (optional — one required concept per line, synonyms
                    comma-separated)
                  </label>
                  <textarea
                    rows={4}
                    value={qRubricLinesText}
                    onChange={(e) => setQRubricLinesText(e.target.value)}
                    placeholder={'quality\ncost, efficiency\nholistic, integrated'}
                    className="w-full p-3.5 rounded-2xl border border-neutral-200 dark:border-white/15 bg-neutral-50/70 dark:bg-[#161616] text-base sm:text-sm font-mono"
                  />
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-neutral-600 dark:text-neutral-300 mb-1">
                  Explanatory Note / Model Answer (shown in post-quiz review)
                </label>
                <textarea
                  rows={2}
                  value={qExplanation}
                  onChange={(e) => setQExplanation(e.target.value)}
                  placeholder="Optional explanation or grading reference..."
                  className="w-full p-3.5 rounded-2xl border border-neutral-200 dark:border-white/15 bg-neutral-50/70 dark:bg-[#161616] text-base sm:text-sm"
                />
              </div>

              <div className="grid grid-cols-2 gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowQuestionModal(false)}
                  className="min-h-[46px] rounded-2xl border border-neutral-200 dark:border-white/15 text-sm font-semibold text-neutral-700 dark:text-neutral-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingQuestion}
                  className="min-h-[46px] rounded-2xl bg-[#013F32] text-[#FDFDFD] dark:bg-[#E7FE25] dark:text-[#161616] text-sm font-semibold disabled:opacity-60"
                >
                  {savingQuestion ? 'Saving...' : 'Save Question'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
