import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  Check,
  Clock,
  Grid,
  AlertTriangle,
  RefreshCw,
  Send,
  X,
} from 'lucide-react';
import { ThemeToggle } from '../ThemeToggle.tsx';
import { ApiClientError, apiRequest } from '../../lib/api.ts';
import {
  formatCountdown,
  formatMarks,
  formatQuestionTypeLabel,
} from '../../lib/format.ts';
import {
  ActiveAttemptQuestionsPayload,
  SaveAnswerResult,
  StudentAttemptQuestion,
  SubmitAttemptResult,
} from '../../types/frontend.ts';

interface ExamRunnerProps {
  attemptId: string;
  onSubmitted: (submission: SubmitAttemptResult, examTitle: string) => void;
  onExitToDashboard: () => void;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

function draftStorageKey(attemptId: string, questionId: string): string {
  return `quizpocket.draft.${attemptId}.${questionId}`;
}

function flaggedStorageKey(attemptId: string): string {
  return `quizpocket.flagged.${attemptId}`;
}

export function ExamRunner({ attemptId, onSubmitted, onExitToDashboard }: ExamRunnerProps) {
  const [payload, setPayload] = useState<ActiveAttemptQuestionsPayload | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string | null>>({});
  const [textAnswers, setTextAnswers] = useState<Record<string, string>>({});
  const [flaggedIds, setFlaggedIds] = useState<Set<string>>(new Set());

  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [failedQuestionIds, setFailedQuestionIds] = useState<Set<string>>(new Set());

  const [serverOffsetMs, setServerOffsetMs] = useState<number>(0);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);

  const [showNavigatorSheet, setShowNavigatorSheet] = useState<boolean>(false);
  const [showSubmitModal, setShowSubmitModal] = useState<boolean>(false);
  const [isSubmittingAttempt, setIsSubmittingAttempt] = useState<boolean>(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const debounceTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const textAnswersRef = useRef<Record<string, string>>({});
  textAnswersRef.current = textAnswers;

  const finalizeOnExpiryTriggeredRef = useRef<boolean>(false);

  const handleServerDeadlineExpired = useCallback(
    async (knownTitle: string) => {
      if (finalizeOnExpiryTriggeredRef.current) return;
      finalizeOnExpiryTriggeredRef.current = true;

      try {
        const res = await apiRequest<SubmitAttemptResult>(
          `/student/attempts/${attemptId}/submit`,
          { method: 'POST' }
        );
        onSubmitted(res, knownTitle);
      } catch {
        onExitToDashboard();
      }
    },
    [attemptId, onExitToDashboard, onSubmitted]
  );

  useEffect(() => {
    let active = true;

    async function loadAttempt() {
      setLoading(true);
      setLoadError(null);
      try {
        const data = await apiRequest<ActiveAttemptQuestionsPayload>(
          `/student/attempts/${attemptId}/questions`
        );
        if (!active) return;

        const offset = new Date(data.server_now).getTime() - Date.now();
        setServerOffsetMs(Number.isFinite(offset) ? offset : 0);

        const initSelected: Record<string, string | null> = {};
        const initText: Record<string, string> = {};

        for (const q of data.questions) {
          initSelected[q.id] = q.saved_selected_option_id ?? null;
          let restoredText = q.saved_answer_value ?? '';
          if (q.question_type === 'fill_in_blank' || q.question_type === 'short_answer') {
            try {
              const localDraft = sessionStorage.getItem(draftStorageKey(attemptId, q.id));
              if (localDraft !== null && localDraft !== restoredText) {
                restoredText = localDraft;
              }
            } catch {
              // Ignore storage read errors
            }
          }
          initText[q.id] = restoredText;
        }

        try {
          const savedFlags = sessionStorage.getItem(flaggedStorageKey(attemptId));
          if (savedFlags) {
            const arr = JSON.parse(savedFlags) as string[];
            if (Array.isArray(arr)) {
              setFlaggedIds(new Set(arr));
            }
          }
        } catch {
          // Ignore
        }

        setSelectedOptions(initSelected);
        setTextAnswers(initText);
        setPayload(data);
      } catch (err) {
        if (!active) return;
        if (err instanceof ApiClientError && err.code === 'ATTEMPT_DEADLINE_EXPIRED') {
          await handleServerDeadlineExpired('Quiz');
          return;
        }
        setLoadError(
          err instanceof ApiClientError
            ? err.message
            : 'Unable to load quiz questions. Please retry.'
        );
      } finally {
        if (active) setLoading(false);
      }
    }

    loadAttempt();
    return () => {
      active = false;
      Object.values(debounceTimersRef.current).forEach(clearTimeout);
    };
  }, [attemptId, handleServerDeadlineExpired]);

  // Authoritative server-synced countdown tick
  useEffect(() => {
    if (!payload) return;
    const deadlineMs = new Date(payload.deadline_at).getTime();

    const updateClock = () => {
      const estimatedServerNow = Date.now() + serverOffsetMs;
      const diffSec = Math.max(0, Math.ceil((deadlineMs - estimatedServerNow) / 1000));
      setRemainingSeconds(diffSec);
      if (diffSec <= 0) {
        void handleServerDeadlineExpired(payload.exam_title);
      }
    };

    updateClock();
    const interval = setInterval(updateClock, 1000);
    return () => clearInterval(interval);
  }, [payload, serverOffsetMs, handleServerDeadlineExpired]);

  const persistAnswerToServer = useCallback(
    async (
      question: StudentAttemptQuestion,
      selectedOptionId: string | null,
      answerValue: string | null
    ) => {
      setSaveState('saving');
      try {
        const res = await apiRequest<SaveAnswerResult>(
          `/student/attempts/${attemptId}/answers`,
          {
            method: 'PUT',
            body: {
              question_id: question.id,
              selected_option_id: selectedOptionId,
              answer_value: answerValue,
            },
          }
        );

        const freshOffset = new Date(res.server_now).getTime() - Date.now();
        if (Number.isFinite(freshOffset)) {
          setServerOffsetMs(freshOffset);
        }

        if (question.question_type === 'fill_in_blank' || question.question_type === 'short_answer') {
          try {
            sessionStorage.removeItem(draftStorageKey(attemptId, question.id));
          } catch {
            // Ignore
          }
        }

        setFailedQuestionIds((prev) => {
          if (!prev.has(question.id)) return prev;
          const next = new Set(prev);
          next.delete(question.id);
          return next;
        });
        setSaveState('saved');
      } catch (err) {
        if (err instanceof ApiClientError && err.code === 'ATTEMPT_DEADLINE_EXPIRED') {
          await handleServerDeadlineExpired(payload?.exam_title ?? 'Quiz');
          return;
        }
        setFailedQuestionIds((prev) => new Set(prev).add(question.id));
        setSaveState('error');
      }
    },
    [attemptId, handleServerDeadlineExpired, payload?.exam_title]
  );

  const flushPendingTextSave = useCallback(
    async (question: StudentAttemptQuestion | undefined) => {
      if (!question) return;
      if (question.question_type !== 'fill_in_blank' && question.question_type !== 'short_answer') {
        return;
      }
      const pendingTimer = debounceTimersRef.current[question.id];
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        delete debounceTimersRef.current[question.id];
        const latestVal = textAnswersRef.current[question.id] ?? '';
        await persistAnswerToServer(question, null, latestVal);
      }
    },
    [persistAnswerToServer]
  );

  const handleOptionSelect = useCallback(
    (question: StudentAttemptQuestion, optionId: string | null) => {
      setSelectedOptions((prev) => ({ ...prev, [question.id]: optionId }));
      void persistAnswerToServer(question, optionId, null);
    },
    [persistAnswerToServer]
  );

  const handleTextChange = useCallback(
    (question: StudentAttemptQuestion, value: string) => {
      setTextAnswers((prev) => ({ ...prev, [question.id]: value }));
      try {
        sessionStorage.setItem(draftStorageKey(attemptId, question.id), value);
      } catch {
        // Ignore
      }

      if (debounceTimersRef.current[question.id]) {
        clearTimeout(debounceTimersRef.current[question.id]);
      }

      setSaveState('saving');
      debounceTimersRef.current[question.id] = setTimeout(() => {
        delete debounceTimersRef.current[question.id];
        void persistAnswerToServer(question, null, value);
      }, 500);
    },
    [attemptId, persistAnswerToServer]
  );

  const toggleFlagQuestion = useCallback(
    (questionId: string) => {
      setFlaggedIds((prev) => {
        const next = new Set(prev);
        if (next.has(questionId)) {
          next.delete(questionId);
        } else {
          next.add(questionId);
        }
        try {
          sessionStorage.setItem(flaggedStorageKey(attemptId), JSON.stringify(Array.from(next)));
        } catch {
          // Ignore
        }
        return next;
      });
    },
    [attemptId]
  );

  const isQuestionAnswered = useCallback(
    (q: StudentAttemptQuestion): boolean => {
      if (q.question_type === 'multiple_choice' || q.question_type === 'true_false') {
        return Boolean(selectedOptions[q.id]);
      }
      return Boolean((textAnswers[q.id] ?? '').trim());
    },
    [selectedOptions, textAnswers]
  );

  const answeredCount = useMemo(() => {
    if (!payload) return 0;
    return payload.questions.filter(isQuestionAnswered).length;
  }, [payload, isQuestionAnswered]);

  const handleRetryFailedSaves = useCallback(async () => {
    if (!payload) return;
    for (const qId of Array.from(failedQuestionIds)) {
      const q = payload.questions.find((item) => item.id === qId);
      if (!q) continue;
      if (q.question_type === 'multiple_choice' || q.question_type === 'true_false') {
        await persistAnswerToServer(q, selectedOptions[q.id] ?? null, null);
      } else {
        await persistAnswerToServer(q, null, textAnswers[q.id] ?? '');
      }
    }
  }, [failedQuestionIds, payload, persistAnswerToServer, selectedOptions, textAnswers]);

  const navigateToIndex = useCallback(
    async (targetIdx: number) => {
      if (!payload) return;
      const currentQ = payload.questions[currentIndex];
      await flushPendingTextSave(currentQ);
      setCurrentIndex(Math.max(0, Math.min(payload.questions.length - 1, targetIdx)));
      setShowNavigatorSheet(false);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    [currentIndex, flushPendingTextSave, payload]
  );

  const openSubmitDialog = useCallback(async () => {
    if (!payload) return;
    await flushPendingTextSave(payload.questions[currentIndex]);
    setSubmitError(null);
    setShowSubmitModal(true);
  }, [currentIndex, flushPendingTextSave, payload]);

  const confirmFinalSubmission = useCallback(async () => {
    if (!payload) return;
    setIsSubmittingAttempt(true);
    setSubmitError(null);

    try {
      await flushPendingTextSave(payload.questions[currentIndex]);
      if (failedQuestionIds.size > 0) {
        await handleRetryFailedSaves();
      }

      const submission = await apiRequest<SubmitAttemptResult>(
        `/student/attempts/${attemptId}/submit`,
        { method: 'POST' }
      );

      try {
        sessionStorage.removeItem(flaggedStorageKey(attemptId));
      } catch {
        // Ignore
      }

      onSubmitted(submission, payload.exam_title);
    } catch (err) {
      setSubmitError(
        err instanceof ApiClientError
          ? err.message
          : 'Submission could not be completed. Verify your connection and try again.'
      );
    } finally {
      setIsSubmittingAttempt(false);
    }
  }, [
    attemptId,
    currentIndex,
    failedQuestionIds.size,
    flushPendingTextSave,
    handleRetryFailedSaves,
    onSubmitted,
    payload,
  ]);

  if (loading) {
    return (
      <div className="min-h-dvh bg-[#F6F7F5] dark:bg-[#161616] flex items-center justify-center p-6">
        <div className="text-center space-y-2.5">
          <div className="w-8 h-8 rounded-full border-2 border-[#013F32] dark:border-[#E7FE25] border-t-transparent animate-spin mx-auto" />
          <p className="text-sm font-medium text-[#161616] dark:text-[#FDFDFD]">
            Loading quiz session...
          </p>
        </div>
      </div>
    );
  }

  if (loadError || !payload || payload.questions.length === 0) {
    return (
      <div className="min-h-dvh bg-[#F6F7F5] dark:bg-[#161616] flex items-center justify-center p-4">
        <div className="bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-3xl border border-neutral-200 dark:border-white/10 max-w-md w-full p-6 space-y-4">
          <h2 className="font-display text-lg font-bold text-[#161616] dark:text-[#FDFDFD]">
            Unable to Open Quiz
          </h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-300">
            {loadError ?? 'No questions found.'}
          </p>
          <button
            type="button"
            onClick={onExitToDashboard}
            className="w-full min-h-[46px] rounded-2xl bg-[#013F32] text-[#FDFDFD] dark:bg-[#E7FE25] dark:text-[#161616] text-sm font-semibold"
          >
            Return to Quizzes
          </button>
        </div>
      </div>
    );
  }

  const totalQuestions = payload.questions.length;
  const activeQuestion = payload.questions[currentIndex];
  const isFlagged = flaggedIds.has(activeQuestion.id);
  const unansweredCount = totalQuestions - answeredCount;

  const totalDurationSeconds = Math.max(60, payload.duration_minutes * 60);
  const timerRemainingPct =
    remainingSeconds !== null
      ? Math.max(4, Math.min(100, Math.round((remainingSeconds / totalDurationSeconds) * 100)))
      : 100;

  const isLowTime = remainingSeconds !== null && remainingSeconds <= 300;
  const isCriticalTime = remainingSeconds !== null && remainingSeconds <= 60;

  const hasSections = useMemo(() => {
    if (!payload) return false;
    const hasMcq = payload.questions.some((q) => q.question_type === 'multiple_choice');
    const hasShort = payload.questions.some((q) => q.question_type === 'short_answer');
    return hasMcq && hasShort;
  }, [payload]);

  const activeSectionBadge = useMemo(() => {
    if (!hasSections || !activeQuestion) return null;
    if (activeQuestion.question_type === 'short_answer') {
      return {
        label: 'Section B · Short Answer',
        subtext: '3 Marks each · Manual Instructor Evaluation',
        className:
          'bg-amber-500/10 text-amber-800 dark:text-amber-300 border border-amber-500/30',
      };
    }
    return {
      label: 'Section A · Multiple Choice',
      subtext: '1 Mark each · Immediate Objective Scoring',
      className:
        'bg-[#013F32]/10 text-[#013F32] dark:bg-[#E7FE25]/15 dark:text-[#E7FE25] border border-[#013F32]/25 dark:border-[#E7FE25]/30',
    };
  }, [hasSections, activeQuestion]);

  return (
    <div className="min-h-dvh bg-[#F6F7F5] dark:bg-[#161616] text-[#161616] dark:text-[#FDFDFD] flex flex-col transition-colors">
      {/* Compact Sticky Quiz Header */}
      <header className="sticky top-0 z-30 bg-[#FDFDFD]/95 dark:bg-[#161616]/95 backdrop-blur border-b border-neutral-200/90 dark:border-white/10">
        <div className="max-w-6xl mx-auto px-4 h-15 flex items-center justify-between gap-3">
          <div className="min-w-0 flex items-center gap-2.5">
            <button
              type="button"
              onClick={onExitToDashboard}
              title="Exit to dashboard (timer continues)"
              className="w-10 h-10 -ml-2 rounded-xl flex items-center justify-center text-neutral-500 dark:text-neutral-400 hover:text-[#161616] dark:hover:text-[#FDFDFD] hover:bg-neutral-100 dark:hover:bg-white/5 shrink-0 transition"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div className="min-w-0">
              <div className="font-display text-xs sm:text-sm font-bold text-[#161616] dark:text-[#FDFDFD] truncate">
                {payload.exam_title}
              </div>
              <div className="text-xs text-neutral-500 dark:text-neutral-400 flex items-center gap-1.5">
                {saveState === 'saving' && <span>Saving...</span>}
                {saveState === 'saved' && failedQuestionIds.size === 0 && (
                  <span className="text-[#013F32] dark:text-[#E7FE25] font-medium">Saved</span>
                )}
                {saveState === 'idle' && failedQuestionIds.size === 0 && (
                  <span>
                    {answeredCount}/{totalQuestions} answered
                  </span>
                )}
                {failedQuestionIds.size > 0 && (
                  <button
                    type="button"
                    onClick={handleRetryFailedSaves}
                    className="text-rose-700 dark:text-rose-400 font-medium underline inline-flex items-center gap-1"
                  >
                    <RefreshCw className="w-3 h-3" />
                    Retry save
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <ThemeToggle />
            <button
              type="button"
              onClick={openSubmitDialog}
              className="hidden sm:inline-flex min-h-[44px] px-4 rounded-xl bg-[#013F32] hover:bg-[#025342] text-[#FDFDFD] dark:bg-[#E7FE25] dark:hover:bg-[#d8ef1a] dark:text-[#161616] text-xs font-semibold items-center gap-1.5 transition whitespace-nowrap"
            >
              <Send className="w-3.5 h-3.5" />
              <span>Submit Quiz</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Focused Question Workspace */}
      <main className="flex-1 w-full max-w-6xl mx-auto px-4 py-5 sm:py-7 pb-28 md:pb-10">
        {/* Mobile Quick Question Jump Pane */}
        <div className="md:hidden mb-4 bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-2xl border border-neutral-200/90 dark:border-white/10 p-3">
          <div className="flex items-center justify-between mb-2 px-0.5">
            <span className="font-display text-xs font-bold text-[#161616] dark:text-[#FDFDFD]">
              Jump to Question
            </span>
            <button
              type="button"
              onClick={() => setShowNavigatorSheet(true)}
              className="text-xs font-semibold text-[#013F32] dark:text-[#E7FE25] inline-flex items-center gap-1"
            >
              <Grid className="w-3.5 h-3.5" />
              <span>View Grid ({answeredCount}/{totalQuestions})</span>
            </button>
          </div>
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
            {payload.questions.map((q, idx) => {
              const answered = isQuestionAnswered(q);
              const flagged = flaggedIds.has(q.id);
              const current = idx === currentIndex;
              return (
                <button
                  key={q.id}
                  type="button"
                  onClick={() => void navigateToIndex(idx)}
                  className={`min-w-[38px] h-9 px-2 rounded-xl font-mono tabular-nums text-xs font-semibold relative shrink-0 flex items-center justify-center transition ${
                    current
                      ? 'bg-[#013F32] text-[#FDFDFD] dark:bg-[#E7FE25] dark:text-[#161616]'
                      : answered
                        ? 'bg-[#013F32]/10 dark:bg-[#E7FE25]/15 text-[#013F32] dark:text-[#E7FE25] border border-[#013F32]/30 dark:border-[#E7FE25]/35'
                        : 'bg-neutral-100 dark:bg-[#161616] text-neutral-600 dark:text-neutral-400 border border-neutral-200 dark:border-white/10'
                  }`}
                >
                  {idx + 1}
                  {flagged && (
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500 absolute top-1 right-1" />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-start">
          {/* Active Question Card */}
          <section className="md:col-span-8 bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-3xl border border-neutral-200/90 dark:border-white/10 p-5 sm:p-8">
            {/* Capsule Countdown Timer Bar */}
            <div
              className="h-10 w-full rounded-full bg-neutral-200/75 dark:bg-[#161616] border border-neutral-200 dark:border-white/10 relative overflow-hidden flex items-center justify-between px-4 mb-6"
              aria-live="polite"
            >
              <div
                className={`absolute inset-y-0 left-0 transition-all duration-500 ${
                  isCriticalTime
                    ? 'bg-rose-500/25'
                    : isLowTime
                      ? 'bg-amber-500/25'
                      : 'bg-[#013F32]/15 dark:bg-[#E7FE25]/20'
                }`}
                style={{ width: `${timerRemainingPct}%` }}
              />
              <span
                className={`relative z-10 font-mono tabular-nums text-xs sm:text-sm font-bold ${
                  isCriticalTime
                    ? 'text-rose-700 dark:text-rose-400'
                    : isLowTime
                      ? 'text-amber-700 dark:text-amber-400'
                      : 'text-[#161616] dark:text-[#FDFDFD]'
                }`}
              >
                {remainingSeconds !== null ? formatCountdown(remainingSeconds) : '--:--'} remaining
              </span>
              <Clock
                className={`relative z-10 w-4 h-4 shrink-0 ${
                  isCriticalTime
                    ? 'text-rose-700 dark:text-rose-400'
                    : isLowTime
                      ? 'text-amber-700 dark:text-amber-400'
                      : 'text-[#013F32] dark:text-[#E7FE25]'
                }`}
              />
            </div>

            {/* Question Counter & Dashed Divider */}
            <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-dashed border-neutral-200 dark:border-white/15">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-display text-lg sm:text-xl font-bold text-[#161616] dark:text-[#FDFDFD]">
                    Question {String(currentIndex + 1).padStart(2, '0')}{' '}
                    <span className="text-neutral-400 dark:text-neutral-500 font-normal text-sm sm:text-base">
                      / {String(totalQuestions).padStart(2, '0')}
                    </span>
                  </span>
                  {activeSectionBadge && (
                    <span
                      className={`text-[11px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full ${activeSectionBadge.className}`}
                    >
                      {activeSectionBadge.label}
                    </span>
                  )}
                </div>
                <div className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 flex flex-wrap items-center gap-1.5">
                  <span>{formatQuestionTypeLabel(activeQuestion.question_type)}</span>
                  <span>·</span>
                  <span className="font-mono tabular-nums">
                    {formatMarks(activeQuestion.marks)}{' '}
                    {Number(activeQuestion.marks) === 1 ? 'mark' : 'marks'}
                  </span>
                  {activeSectionBadge && (
                    <>
                      <span>·</span>
                      <span>{activeSectionBadge.subtext}</span>
                    </>
                  )}
                </div>
              </div>

              <button
                type="button"
                onClick={() => toggleFlagQuestion(activeQuestion.id)}
                className={`min-h-[44px] px-3.5 rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 transition whitespace-nowrap ${
                  isFlagged
                    ? 'bg-[#E7FE25] text-[#161616] border border-[#013F32]/20'
                    : 'border border-neutral-200 dark:border-white/15 text-neutral-600 dark:text-neutral-300 hover:border-[#013F32] dark:hover:border-[#E7FE25]'
                }`}
              >
                <Bookmark className={`w-4 h-4 ${isFlagged ? 'fill-current' : ''}`} />
                <span>{isFlagged ? 'Flagged' : 'Flag'}</span>
              </button>
            </div>

            {/* Question Prompt */}
            <h1 className="text-base sm:text-lg font-semibold text-[#161616] dark:text-[#FDFDFD] leading-relaxed mt-5 mb-6">
              {activeQuestion.question_text}
            </h1>

            {/* Option-based Input (MCQ / True-False) */}
            {(activeQuestion.question_type === 'multiple_choice' ||
              activeQuestion.question_type === 'true_false') && (
              <div className="space-y-3" role="radiogroup" aria-label="Answer options">
                {activeQuestion.options.map((opt, idx) => {
                  const selected = selectedOptions[activeQuestion.id] === opt.id;
                  const letter = String.fromCharCode(65 + idx);
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => handleOptionSelect(activeQuestion, opt.id)}
                      className={`w-full min-h-[58px] px-4 py-3.5 rounded-2xl border text-left flex items-center justify-between gap-3.5 transition ${
                        selected
                          ? 'border-[#013F32] bg-[#013F32]/[0.06] dark:border-[#E7FE25] dark:bg-[#E7FE25]/[0.09] ring-1 ring-[#013F32] dark:ring-[#E7FE25]'
                          : 'border-neutral-200 dark:border-white/12 bg-[#FDFDFD] dark:bg-[#161616] hover:border-[#013F32]/45 dark:hover:border-[#E7FE25]/45'
                      }`}
                    >
                      <div className="flex items-start gap-3 min-w-0">
                        <span
                          className={`font-mono text-xs font-bold mt-0.5 shrink-0 ${
                            selected
                              ? 'text-[#013F32] dark:text-[#E7FE25]'
                              : 'text-neutral-400 dark:text-neutral-500'
                          }`}
                        >
                          {letter}.
                        </span>
                        <span className="text-sm sm:text-base font-medium text-[#161616] dark:text-[#FDFDFD] leading-snug">
                          {opt.option_text}
                        </span>
                      </div>

                      <span
                        className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 transition ${
                          selected
                            ? 'bg-[#013F32] text-[#E7FE25] dark:bg-[#E7FE25] dark:text-[#161616]'
                            : 'border-2 border-neutral-300 dark:border-white/25'
                        }`}
                      >
                        {selected && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                      </span>
                    </button>
                  );
                })}

                {selectedOptions[activeQuestion.id] && (
                  <div className="pt-1">
                    <button
                      type="button"
                      onClick={() => handleOptionSelect(activeQuestion, null)}
                      className="min-h-[44px] px-2 text-xs font-medium text-neutral-500 dark:text-neutral-400 hover:text-[#161616] dark:hover:text-[#FDFDFD]"
                    >
                      Clear selected option
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Fill-in-the-Blank Input */}
            {activeQuestion.question_type === 'fill_in_blank' && (
              <div className="space-y-2.5">
                <label
                  htmlFor={`fib-${activeQuestion.id}`}
                  className="block text-xs font-medium text-neutral-500 dark:text-neutral-400"
                >
                  Type the missing term or acronym below (case-insensitive):
                </label>
                <input
                  id={`fib-${activeQuestion.id}`}
                  type="text"
                  autoComplete="off"
                  maxLength={300}
                  value={textAnswers[activeQuestion.id] ?? ''}
                  onChange={(e) => handleTextChange(activeQuestion, e.target.value)}
                  onBlur={() => void flushPendingTextSave(activeQuestion)}
                  placeholder="Enter your answer..."
                  className="w-full min-h-[54px] px-4 rounded-2xl border border-neutral-200 dark:border-white/15 bg-neutral-50/70 dark:bg-[#161616] text-base text-[#161616] dark:text-[#FDFDFD] placeholder:text-neutral-400 focus:outline-none focus:border-[#013F32] dark:focus:border-[#E7FE25] focus:ring-2 focus:ring-[#013F32]/15 dark:focus:ring-[#E7FE25]/20"
                />
              </div>
            )}

            {/* Short-Answer Input */}
            {activeQuestion.question_type === 'short_answer' && (
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <label
                    htmlFor={`sa-${activeQuestion.id}`}
                    className="block text-xs font-medium text-neutral-500 dark:text-neutral-400"
                  >
                    Write a clear, structured response addressing all required points:
                  </label>
                  <span className="text-xs font-mono tabular-nums text-neutral-400">
                    {(textAnswers[activeQuestion.id] ?? '').length}/4000
                  </span>
                </div>
                <textarea
                  id={`sa-${activeQuestion.id}`}
                  rows={7}
                  maxLength={4000}
                  value={textAnswers[activeQuestion.id] ?? ''}
                  onChange={(e) => handleTextChange(activeQuestion, e.target.value)}
                  onBlur={() => void flushPendingTextSave(activeQuestion)}
                  placeholder="Type your response here..."
                  className="w-full p-4 rounded-2xl border border-neutral-200 dark:border-white/15 bg-neutral-50/70 dark:bg-[#161616] text-base sm:text-sm leading-relaxed text-[#161616] dark:text-[#FDFDFD] placeholder:text-neutral-400 focus:outline-none focus:border-[#013F32] dark:focus:border-[#E7FE25] focus:ring-2 focus:ring-[#013F32]/15 dark:focus:ring-[#E7FE25]/20 resize-y"
                />
              </div>
            )}

            {/* Desktop / Tablet In-Card Prev / Next Bar */}
            <div className="hidden md:flex items-center justify-between pt-8 mt-8 border-t border-neutral-200/70 dark:border-white/10">
              <button
                type="button"
                disabled={currentIndex === 0}
                onClick={() => void navigateToIndex(currentIndex - 1)}
                className="min-h-[46px] px-5 rounded-2xl border border-neutral-200 dark:border-white/15 text-sm font-semibold text-[#161616] dark:text-[#FDFDFD] hover:bg-neutral-100 dark:hover:bg-white/5 inline-flex items-center gap-2 disabled:opacity-40 whitespace-nowrap transition"
              >
                <ArrowLeft className="w-4 h-4" />
                <span>Previous</span>
              </button>

              {currentIndex < totalQuestions - 1 ? (
                <button
                  type="button"
                  onClick={() => void navigateToIndex(currentIndex + 1)}
                  className="min-h-[46px] px-6 rounded-2xl bg-[#013F32] hover:bg-[#025342] text-[#FDFDFD] dark:bg-[#E7FE25] dark:hover:bg-[#d8ef1a] dark:text-[#161616] text-sm font-semibold inline-flex items-center gap-2 whitespace-nowrap transition"
                >
                  <span>Next Question</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={openSubmitDialog}
                  className="min-h-[46px] px-6 rounded-2xl bg-[#013F32] hover:bg-[#025342] text-[#FDFDFD] dark:bg-[#E7FE25] dark:hover:bg-[#d8ef1a] dark:text-[#161616] text-sm font-semibold inline-flex items-center gap-2 whitespace-nowrap transition"
                >
                  <Send className="w-4 h-4" />
                  <span>Submit Quiz</span>
                </button>
              )}
            </div>
          </section>

          {/* Question Navigator Pane (Tablet & Desktop) */}
          <aside className="hidden md:block md:col-span-4 bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-3xl border border-neutral-200/90 dark:border-white/10 p-5 lg:p-6 sticky top-20">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-sm font-bold text-[#161616] dark:text-[#FDFDFD]">
                Question Navigator
              </h2>
              <span className="text-xs font-mono tabular-nums text-neutral-500 dark:text-neutral-400">
                {answeredCount}/{totalQuestions} answered
              </span>
            </div>

            {hasSections ? (
              <div className="space-y-4">
                <div>
                  <div className="flex items-center justify-between text-xs font-bold text-[#013F32] dark:text-[#E7FE25] mb-2 px-0.5">
                    <span>Section A: Objective (MCQ)</span>
                    <span className="font-mono text-[11px] text-neutral-400 font-normal">
                      Q1–Q{payload.questions.filter((q) => q.question_type !== 'short_answer').length} · 1 mark
                    </span>
                  </div>
                  <div className="grid grid-cols-5 gap-1.5">
                    {payload.questions.map((q, idx) => {
                      if (q.question_type === 'short_answer') return null;
                      const answered = isQuestionAnswered(q);
                      const flagged = flaggedIds.has(q.id);
                      const current = idx === currentIndex;
                      return (
                        <button
                          key={q.id}
                          type="button"
                          onClick={() => void navigateToIndex(idx)}
                          title={`Jump to Question ${idx + 1}`}
                          className={`min-h-[38px] rounded-xl font-mono tabular-nums text-xs font-semibold relative transition flex items-center justify-center ${
                            current
                              ? 'bg-[#013F32] text-[#FDFDFD] dark:bg-[#E7FE25] dark:text-[#161616] ring-2 ring-[#013F32]/40 dark:ring-[#E7FE25]/40'
                              : answered
                                ? 'bg-[#013F32]/10 dark:bg-[#E7FE25]/15 text-[#013F32] dark:text-[#E7FE25] border border-[#013F32]/30 dark:border-[#E7FE25]/35'
                                : 'bg-neutral-100/80 dark:bg-[#161616] text-neutral-600 dark:text-neutral-400 border border-neutral-200 dark:border-white/10 hover:border-neutral-400'
                          }`}
                        >
                          {idx + 1}
                          {flagged && (
                            <span
                              className="w-1.5 h-1.5 rounded-full bg-amber-500 absolute top-1 right-1"
                              aria-label="Flagged"
                            />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="pt-3 border-t border-neutral-200/70 dark:border-white/10">
                  <div className="flex items-center justify-between text-xs font-bold text-amber-700 dark:text-amber-400 mb-2 px-0.5">
                    <span>Section B: Short Answer</span>
                    <span className="font-mono text-[11px] text-neutral-400 font-normal">
                      5 Qs · 3 marks each
                    </span>
                  </div>
                  <div className="grid grid-cols-5 gap-1.5">
                    {payload.questions.map((q, idx) => {
                      if (q.question_type !== 'short_answer') return null;
                      const answered = isQuestionAnswered(q);
                      const flagged = flaggedIds.has(q.id);
                      const current = idx === currentIndex;
                      return (
                        <button
                          key={q.id}
                          type="button"
                          onClick={() => void navigateToIndex(idx)}
                          title={`Jump to Question ${idx + 1}`}
                          className={`min-h-[38px] rounded-xl font-mono tabular-nums text-xs font-semibold relative transition flex items-center justify-center ${
                            current
                              ? 'bg-[#013F32] text-[#FDFDFD] dark:bg-[#E7FE25] dark:text-[#161616] ring-2 ring-[#013F32]/40 dark:ring-[#E7FE25]/40'
                              : answered
                                ? 'bg-amber-500/15 text-amber-800 dark:text-amber-300 border border-amber-500/35'
                                : 'bg-neutral-100/80 dark:bg-[#161616] text-neutral-600 dark:text-neutral-400 border border-neutral-200 dark:border-white/10 hover:border-neutral-400'
                          }`}
                        >
                          {idx + 1}
                          {flagged && (
                            <span
                              className="w-1.5 h-1.5 rounded-full bg-amber-500 absolute top-1 right-1"
                              aria-label="Flagged"
                            />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-5 gap-2">
                {payload.questions.map((q, idx) => {
                  const answered = isQuestionAnswered(q);
                  const flagged = flaggedIds.has(q.id);
                  const current = idx === currentIndex;
                  return (
                    <button
                      key={q.id}
                      type="button"
                      onClick={() => void navigateToIndex(idx)}
                      title={`Jump to Question ${idx + 1}`}
                      className={`min-h-[42px] rounded-xl font-mono tabular-nums text-xs font-semibold relative transition flex items-center justify-center ${
                        current
                          ? 'bg-[#013F32] text-[#FDFDFD] dark:bg-[#E7FE25] dark:text-[#161616] ring-2 ring-[#013F32]/40 dark:ring-[#E7FE25]/40'
                          : answered
                            ? 'bg-[#013F32]/10 dark:bg-[#E7FE25]/15 text-[#013F32] dark:text-[#E7FE25] border border-[#013F32]/30 dark:border-[#E7FE25]/35'
                            : 'bg-neutral-100/80 dark:bg-[#161616] text-neutral-600 dark:text-neutral-400 border border-neutral-200 dark:border-white/10 hover:border-neutral-400'
                      }`}
                    >
                      {idx + 1}
                      {flagged && (
                        <span
                          className="w-2 h-2 rounded-full bg-amber-500 absolute top-1.5 right-1.5"
                          aria-label="Flagged"
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            <div className="mt-5 pt-4 border-t border-neutral-200/70 dark:border-white/10 text-xs text-neutral-500 dark:text-neutral-400 space-y-1.5">
              <div className="flex items-center justify-between">
                <span>Answered</span>
                <span className="font-mono tabular-nums font-semibold text-[#161616] dark:text-[#FDFDFD]">
                  {answeredCount}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span>Unanswered</span>
                <span className="font-mono tabular-nums font-semibold text-[#161616] dark:text-[#FDFDFD]">
                  {unansweredCount}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span>Flagged</span>
                <span className="font-mono tabular-nums font-semibold text-amber-600 dark:text-amber-400">
                  {flaggedIds.size}
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={openSubmitDialog}
              className="w-full min-h-[48px] mt-5 rounded-2xl bg-[#013F32] hover:bg-[#025342] text-[#FDFDFD] dark:bg-[#E7FE25] dark:hover:bg-[#d8ef1a] dark:text-[#161616] text-sm font-semibold flex items-center justify-center gap-2 transition whitespace-nowrap"
            >
              <Send className="w-4 h-4" />
              <span>Finish & Submit Quiz</span>
            </button>
          </aside>
        </div>
      </main>

      {/* Mobile Sticky Bottom Control Bar */}
      <nav
        aria-label="Question navigation"
        className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-[#FDFDFD]/95 dark:bg-[#161616]/95 backdrop-blur border-t border-neutral-200 dark:border-white/10 px-3 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]"
      >
        <div className="max-w-lg mx-auto grid grid-cols-3 gap-2">
          <button
            type="button"
            disabled={currentIndex === 0}
            onClick={() => void navigateToIndex(currentIndex - 1)}
            className="min-h-[48px] rounded-2xl border border-neutral-200 dark:border-white/15 text-xs font-semibold text-[#161616] dark:text-[#FDFDFD] flex items-center justify-center gap-1.5 disabled:opacity-40 whitespace-nowrap"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Previous</span>
          </button>

          <button
            type="button"
            onClick={() => setShowNavigatorSheet(true)}
            className="min-h-[48px] rounded-2xl border border-neutral-200 dark:border-white/15 bg-neutral-100/80 dark:bg-[#1E1F1E] text-xs font-semibold text-[#161616] dark:text-[#FDFDFD] flex items-center justify-center gap-1.5 font-mono tabular-nums whitespace-nowrap"
          >
            <Grid className="w-4 h-4 text-[#013F32] dark:text-[#E7FE25]" />
            <span>
              {answeredCount}/{totalQuestions}
            </span>
          </button>

          {currentIndex < totalQuestions - 1 ? (
            <button
              type="button"
              onClick={() => void navigateToIndex(currentIndex + 1)}
              className="min-h-[48px] rounded-2xl bg-[#013F32] text-[#FDFDFD] dark:bg-[#E7FE25] dark:text-[#161616] text-xs font-semibold flex items-center justify-center gap-1.5 whitespace-nowrap"
            >
              <span>Next</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          ) : (
            <button
              type="button"
              onClick={openSubmitDialog}
              className="min-h-[48px] rounded-2xl bg-[#013F32] text-[#FDFDFD] dark:bg-[#E7FE25] dark:text-[#161616] text-xs font-semibold flex items-center justify-center gap-1.5 whitespace-nowrap"
            >
              <Send className="w-3.5 h-3.5" />
              <span>Submit</span>
            </button>
          )}
        </div>
      </nav>

      {/* Mobile Question Navigator Bottom Sheet */}
      {showNavigatorSheet && (
        <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-xs flex items-end md:hidden">
          <div className="bg-[#FDFDFD] dark:bg-[#1E1F1E] border-t border-neutral-200 dark:border-white/10 w-full rounded-t-3xl p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] max-h-[82dvh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3 border-b border-neutral-200/70 dark:border-white/10">
              <div>
                <h2 className="font-display text-base font-bold text-[#161616] dark:text-[#FDFDFD]">
                  Questions
                </h2>
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                  {answeredCount} of {totalQuestions} answered · {flaggedIds.size} flagged
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowNavigatorSheet(false)}
                className="w-11 h-11 rounded-xl flex items-center justify-center text-neutral-500 hover:bg-neutral-100 dark:hover:bg-white/5"
                aria-label="Close navigator"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-5 gap-2.5 my-4">
              {payload.questions.map((q, idx) => {
                const answered = isQuestionAnswered(q);
                const flagged = flaggedIds.has(q.id);
                const current = idx === currentIndex;
                return (
                  <button
                    key={q.id}
                    type="button"
                    onClick={() => void navigateToIndex(idx)}
                    className={`min-h-[48px] rounded-xl font-mono tabular-nums text-sm font-semibold relative flex items-center justify-center ${
                      current
                        ? 'bg-[#013F32] text-[#FDFDFD] dark:bg-[#E7FE25] dark:text-[#161616]'
                        : answered
                          ? 'bg-[#013F32]/10 dark:bg-[#E7FE25]/15 text-[#013F32] dark:text-[#E7FE25] border border-[#013F32]/30 dark:border-[#E7FE25]/35'
                          : 'bg-neutral-100 dark:bg-[#161616] text-neutral-600 dark:text-neutral-400 border border-neutral-200 dark:border-white/10'
                    }`}
                  >
                    {idx + 1}
                    {flagged && (
                      <span className="w-2 h-2 rounded-full bg-amber-500 absolute top-1.5 right-1.5" />
                    )}
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              onClick={() => {
                setShowNavigatorSheet(false);
                void openSubmitDialog();
              }}
              className="w-full min-h-[48px] rounded-2xl bg-[#013F32] text-[#FDFDFD] dark:bg-[#E7FE25] dark:text-[#161616] text-sm font-semibold flex items-center justify-center gap-2 whitespace-nowrap"
            >
              <Send className="w-4 h-4" />
              <span>Review & Submit Quiz</span>
            </button>
          </div>
        </div>
      )}

      {/* Submission Confirmation Sheet / Modal */}
      {showSubmitModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-[#FDFDFD] dark:bg-[#1E1F1E] border border-neutral-200 dark:border-white/10 w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] sm:pb-6 space-y-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-display text-lg font-bold text-[#161616] dark:text-[#FDFDFD]">
                  Submit Quiz?
                </h2>
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                  Once submitted, your answers are graded immediately and a 3-hour retake cooldown
                  begins.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowSubmitModal(false)}
                disabled={isSubmittingAttempt}
                className="w-10 h-10 -mr-2 -mt-1 rounded-xl flex items-center justify-center text-neutral-400 hover:text-[#161616] dark:hover:text-[#FDFDFD]"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="rounded-2xl bg-neutral-100/80 dark:bg-[#161616] border border-neutral-200/80 dark:border-white/10 p-4 space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-neutral-600 dark:text-neutral-400">Answered questions</span>
                <span className="font-mono tabular-nums font-semibold text-[#161616] dark:text-[#FDFDFD]">
                  {answeredCount} / {totalQuestions}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-neutral-600 dark:text-neutral-400">Flagged for review</span>
                <span className="font-mono tabular-nums font-semibold text-[#161616] dark:text-[#FDFDFD]">
                  {flaggedIds.size}
                </span>
              </div>
              {remainingSeconds !== null && (
                <div className="flex items-center justify-between">
                  <span className="text-neutral-600 dark:text-neutral-400">Time remaining</span>
                  <span className="font-mono tabular-nums font-semibold text-[#013F32] dark:text-[#E7FE25]">
                    {formatCountdown(remainingSeconds)}
                  </span>
                </div>
              )}
            </div>

            {hasSections && (
              <div className="rounded-2xl bg-[#013F32]/[0.05] dark:bg-[#E7FE25]/[0.08] border border-[#013F32]/20 dark:border-[#E7FE25]/25 p-3.5 space-y-1.5 text-xs">
                <div className="font-bold text-[#013F32] dark:text-[#E7FE25]">
                  Exam Scoring Protocol
                </div>
                <p className="text-neutral-600 dark:text-neutral-300">
                  • <strong>Section A (MCQs 1–35):</strong> Auto-evaluated immediately upon submission (35 marks total).
                </p>
                <p className="text-neutral-600 dark:text-neutral-300">
                  • <strong>Section B (Short Answer 36–40):</strong> Sent to instructor for evaluation (15 marks total). Final score (out of 50) is released following instructor review.
                </p>
              </div>
            )}

            {unansweredCount > 0 && (
              <div className="rounded-2xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60 p-3.5 flex items-start gap-2.5 text-xs text-amber-900 dark:text-amber-200">
                <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                <span>
                  You still have{' '}
                  <strong className="font-mono tabular-nums">{unansweredCount}</strong> unanswered{' '}
                  {unansweredCount === 1 ? 'question' : 'questions'}. Unanswered items receive 0
                  marks.
                </span>
              </div>
            )}

            {submitError && (
              <div className="rounded-2xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800/60 p-3.5 text-xs text-rose-800 dark:text-rose-200">
                {submitError}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 pt-1">
              <button
                type="button"
                disabled={isSubmittingAttempt}
                onClick={() => setShowSubmitModal(false)}
                className="min-h-[48px] rounded-2xl border border-neutral-200 dark:border-white/15 text-sm font-semibold text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-white/5 whitespace-nowrap"
              >
                Keep Reviewing
              </button>
              <button
                type="button"
                disabled={isSubmittingAttempt}
                onClick={() => void confirmFinalSubmission()}
                className="min-h-[48px] rounded-2xl bg-[#013F32] hover:bg-[#025342] text-[#FDFDFD] dark:bg-[#E7FE25] dark:hover:bg-[#d8ef1a] dark:text-[#161616] text-sm font-semibold disabled:opacity-60 whitespace-nowrap transition"
              >
                {isSubmittingAttempt ? 'Submitting...' : 'Confirm Submit'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
