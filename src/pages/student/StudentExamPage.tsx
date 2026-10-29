import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import confetti from 'canvas-confetti';
import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  Check,
  Clock,
  Send,
  AlertTriangle,
  RefreshCw,
  X,
  CheckCircle2,
  HelpCircle,
  Sparkles,
} from 'lucide-react';
import { apiRequest, ApiClientError } from '../../lib/api.ts';
import {
  ActiveAttemptQuestionsPayload,
  SaveAnswerResult,
  StudentAttemptQuestion,
  SubmitAttemptResult,
} from '../../types/frontend.ts';
import { FloatingTimer } from '../../components/common/FloatingTimer.tsx';
import { GlassCard } from '../../components/common/GlassCard.tsx';
import { useNotification } from '../../components/common/GlobalNotification.tsx';
import { ThemeToggle } from '../../components/ThemeToggle.tsx';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

function draftStorageKey(attemptId: string, questionId: string): string {
  return `quizpocket.draft.${attemptId}.${questionId}`;
}

function flaggedStorageKey(attemptId: string): string {
  return `quizpocket.flagged.${attemptId}`;
}

export function StudentExamPage() {
  const { attemptId } = useParams<{ attemptId: string }>();
  const navigate = useNavigate();
  const { success: notifySuccess, error: notifyError } = useNotification();

  const [payload, setPayload] = useState<ActiveAttemptQuestionsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string | null>>({});
  const [textAnswers, setTextAnswers] = useState<Record<string, string>>({});
  const [flaggedIds, setFlaggedIds] = useState<Set<string>>(new Set());

  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [failedQuestionIds, setFailedQuestionIds] = useState<Set<string>>(new Set());

  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submissionResult, setSubmissionResult] = useState<SubmitAttemptResult | null>(null);

  const debounceTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const textAnswersRef = useRef<Record<string, string>>({});
  textAnswersRef.current = textAnswers;

  // Real-time position tracking ping to server
  const sendPositionPing = useCallback(
    (index: number) => {
      if (!attemptId) return;
      apiRequest(`/student/attempts/${attemptId}/position`, {
        method: 'POST',
        body: { question_index: index },
      }).catch(() => {
        // Silent failure for position heartbeat
      });
    },
    [attemptId]
  );

  useEffect(() => {
    sendPositionPing(currentIndex);
  }, [currentIndex, sendPositionPing]);

  // Load active examination questions
  useEffect(() => {
    let active = true;

    async function fetchQuestions() {
      if (!attemptId) return;
      setLoading(true);
      setLoadError(null);
      try {
        const data = await apiRequest<ActiveAttemptQuestionsPayload>(
          `/student/attempts/${attemptId}/questions`
        );
        if (!active) return;

        setPayload(data);

        // Populate initial answers from backend state + drafts
        const initialOpts: Record<string, string | null> = {};
        const initialTexts: Record<string, string> = {};

        data.questions.forEach((q) => {
          let opt = q.saved_selected_option_id;
          let text = q.saved_answer_value ?? '';

          try {
            const rawDraft = sessionStorage.getItem(draftStorageKey(attemptId, q.id));
            if (rawDraft) {
              const draft = JSON.parse(rawDraft);
              if (draft.selectedOptionId !== undefined) opt = draft.selectedOptionId;
              if (draft.textAnswer !== undefined) text = draft.textAnswer;
            }
          } catch {
            // Ignore
          }

          initialOpts[q.id] = opt;
          initialTexts[q.id] = text;
        });

        setSelectedOptions(initialOpts);
        setTextAnswers(initialTexts);

        // Load flagged questions
        try {
          const rawFlags = sessionStorage.getItem(flaggedStorageKey(attemptId));
          if (rawFlags) {
            setFlaggedIds(new Set(JSON.parse(rawFlags)));
          }
        } catch {
          // Ignore
        }
      } catch (err: unknown) {
        if (!active) return;
        const msg = err instanceof Error ? err.message : 'Unable to load examination questions.';
        setLoadError(msg);
      } finally {
        if (active) setLoading(false);
      }
    }

    fetchQuestions();
    return () => {
      active = false;
    };
  }, [attemptId]);

  // Handle answer saving to backend
  const persistAnswer = useCallback(
    async (questionId: string, optId: string | null, textVal: string | null) => {
      if (!attemptId) return;
      setSaveState('saving');
      try {
        await apiRequest<SaveAnswerResult>(`/student/attempts/${attemptId}/answers`, {
          method: 'PUT',
          body: {
            question_id: questionId,
            selected_option_id: optId,
            answer_value: textVal,
          },
        });
        setSaveState('saved');
        setFailedQuestionIds((prev) => {
          const next = new Set(prev);
          next.delete(questionId);
          return next;
        });
      } catch (err) {
        console.error('Answer save failed:', err);
        setSaveState('error');
        setFailedQuestionIds((prev) => new Set(prev).add(questionId));
      }
    },
    [attemptId]
  );

  const handleSelectOption = useCallback(
    (questionId: string, optionId: string) => {
      const isDeselect = selectedOptions[questionId] === optionId;
      const nextOpt = isDeselect ? null : optionId;

      setSelectedOptions((prev) => ({ ...prev, [questionId]: nextOpt }));

      if (attemptId) {
        try {
          sessionStorage.setItem(
            draftStorageKey(attemptId, questionId),
            JSON.stringify({ selectedOptionId: nextOpt })
          );
        } catch {
          // Ignore
        }
      }

      persistAnswer(questionId, nextOpt, null);
    },
    [attemptId, persistAnswer, selectedOptions]
  );

  const handleTextChange = useCallback(
    (questionId: string, val: string) => {
      setTextAnswers((prev) => ({ ...prev, [questionId]: val }));

      if (attemptId) {
        try {
          sessionStorage.setItem(
            draftStorageKey(attemptId, questionId),
            JSON.stringify({ textAnswer: val })
          );
        } catch {
          // Ignore
        }
      }

      // Debounce saving text answers
      if (debounceTimersRef.current[questionId]) {
        clearTimeout(debounceTimersRef.current[questionId]);
      }

      debounceTimersRef.current[questionId] = setTimeout(() => {
        persistAnswer(questionId, null, val);
      }, 700);
    },
    [attemptId, persistAnswer]
  );

  const handleToggleFlag = useCallback(
    (questionId: string) => {
      setFlaggedIds((prev) => {
        const next = new Set(prev);
        if (next.has(questionId)) {
          next.delete(questionId);
        } else {
          next.add(questionId);
        }
        if (attemptId) {
          try {
            sessionStorage.setItem(flaggedStorageKey(attemptId), JSON.stringify(Array.from(next)));
          } catch {
            // Ignore
          }
        }
        return next;
      });
    },
    [attemptId]
  );

  // Submit attempt
  const handleSubmitAttempt = useCallback(async () => {
    if (!attemptId) return;
    setIsSubmitting(true);
    try {
      const result = await apiRequest<SubmitAttemptResult>(
        `/student/attempts/${attemptId}/submit`,
        { method: 'POST' }
      );
      setSubmissionResult(result);
      setShowSubmitModal(false);

      // Launch victory confetti
      try {
        confetti({
          particleCount: 100,
          spread: 70,
          origin: { y: 0.6 },
          colors: ['#013F32', '#E7FE25', '#15B8A6', '#FFFFFF'],
        });
      } catch {
        // Ignore
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Submission failed. Please retry.';
      notifyError(msg, 'Submission Error');
      setIsSubmitting(false);
    }
  }, [attemptId, notifyError]);

  const questions = payload?.questions ?? [];
  const currentQuestion = questions[currentIndex];

  const totalQuestions = questions.length;
  const answeredCount = questions.filter((q) => {
    if (q.question_type === 'short_answer') {
      return Boolean(textAnswers[q.id]?.trim());
    }
    return Boolean(selectedOptions[q.id]);
  }).length;
  const unansweredCount = totalQuestions - answeredCount;

  if (loading) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-[#F6F7F5] dark:bg-[#121312] p-6">
        <div className="text-center space-y-3">
          <div className="w-10 h-10 rounded-full border-3 border-[#013F32] dark:border-[#E7FE25] border-t-transparent animate-spin mx-auto" />
          <p className="text-sm font-semibold text-[#161616] dark:text-[#FDFDFD]">
            Preparing examination environment...
          </p>
        </div>
      </div>
    );
  }

  if (loadError || !payload) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-[#F6F7F5] dark:bg-[#121312] p-6">
        <GlassCard className="max-w-md text-center py-10">
          <AlertTriangle className="w-12 h-12 text-rose-500 mx-auto mb-3" />
          <h2 className="text-lg font-bold text-[#161616] dark:text-[#FDFDFD]">Unable to Load Exam</h2>
          <p className="text-xs text-neutral-500 mt-1 mb-6">{loadError}</p>
          <button
            onClick={() => navigate('/student/quizzes')}
            className="px-5 py-2.5 rounded-2xl bg-[#013F32] dark:bg-[#E7FE25] text-white dark:text-[#161616] font-semibold text-xs"
          >
            Return to Quizzes
          </button>
        </GlassCard>
      </div>
    );
  }

  // Submission Complete View
  if (submissionResult) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-[#F6F7F5] dark:bg-[#121312] p-4 sm:p-6 animate-in zoom-in-95 duration-300">
        <GlassCard className="max-w-lg w-full text-center p-8 space-y-6">
          <div className="w-16 h-16 rounded-3xl bg-[#013F32] dark:bg-[#E7FE25] text-white dark:text-[#161616] flex items-center justify-center mx-auto shadow-md">
            <CheckCircle2 className="w-8 h-8" />
          </div>

          <div>
            <span className="text-xs font-bold uppercase tracking-wider text-emerald-600 dark:text-[#E7FE25]">
              Assessment Submitted
            </span>
            <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-[#161616] dark:text-[#FDFDFD] mt-1">
              {payload.exam_title}
            </h1>
            <p className="text-xs sm:text-sm text-neutral-500 dark:text-neutral-400 mt-2">
              Your responses have been securely finalized and evaluated.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4 py-4 border-y border-neutral-200/80 dark:border-white/10">
            <div className="p-4 rounded-2xl bg-neutral-50 dark:bg-white/[0.04]">
              <span className="text-xs text-neutral-500 font-medium">Score Obtained</span>
              <div className="font-mono text-2xl font-bold text-[#161616] dark:text-[#FDFDFD] mt-1">
                {submissionResult.result?.marks_obtained ?? submissionResult.marks_obtained ?? 0} /{' '}
                {submissionResult.result?.total_marks ?? submissionResult.total_marks ?? 0}
              </div>
            </div>
            <div className="p-4 rounded-2xl bg-neutral-50 dark:bg-white/[0.04]">
              <span className="text-xs text-neutral-500 font-medium">Percentage</span>
              <div className="font-mono text-2xl font-bold text-[#161616] dark:text-[#FDFDFD] mt-1">
                {Math.round(submissionResult.result?.percentage ?? submissionResult.percentage ?? 0)}%
              </div>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-3">
            <button
              onClick={() => navigate(`/student/results/${attemptId}`)}
              className="flex-1 py-3 rounded-2xl bg-[#013F32] dark:bg-[#E7FE25] text-white dark:text-[#161616] font-bold text-sm shadow hover:opacity-90 transition"
            >
              Review Explanations
            </button>
            <button
              onClick={() => navigate('/student/home')}
              className="flex-1 py-3 rounded-2xl glass-panel text-[#161616] dark:text-[#FDFDFD] font-semibold text-sm hover:border-[#013F32] dark:hover:border-[#E7FE25] transition"
            >
              Return Home
            </button>
          </div>
        </GlassCard>
      </div>
    );
  }

  const isCurrentFlagged = currentQuestion ? flaggedIds.has(currentQuestion.id) : false;

  return (
    <div className="min-h-dvh flex flex-col bg-[#F6F7F5] dark:bg-[#121312] text-[#161616] dark:text-[#FDFDFD] relative">
      <div className="ambient-glow" aria-hidden="true" />

      {/* Floating Top Examination Bar */}
      <header className="sticky top-0 z-40 glass-nav px-4 sm:px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => {
              if (window.confirm('Leave active exam? Your answers remain saved, but the timer keeps running.')) {
                navigate('/student/quizzes');
              }
            }}
            className="p-2 rounded-xl text-neutral-500 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-200/50 dark:hover:bg-white/10 transition"
            title="Exit Exam (answers saved)"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>

          <div>
            <h1 className="font-bold text-sm sm:text-base text-[#161616] dark:text-[#FDFDFD] truncate max-w-[200px] sm:max-w-md">
              {payload.exam_title}
            </h1>
            <div className="flex items-center gap-2 text-[11px] text-neutral-500 dark:text-neutral-400">
              <span>Question {currentIndex + 1} of {totalQuestions}</span>
              <span>·</span>
              <span className="font-medium text-[#013F32] dark:text-[#E7FE25]">
                {answeredCount} Answered
              </span>
            </div>
          </div>
        </div>

        {/* Floating Timer & Actions */}
        <div className="flex items-center gap-3">
          <FloatingTimer
            startedAt={payload.started_at}
            deadlineAt={payload.deadline_at}
            serverNowAtFetch={payload.server_now}
            onTimeExpired={handleSubmitAttempt}
          />

          <ThemeToggle />

          <button
            onClick={() => setShowSubmitModal(true)}
            className="px-4 py-2 rounded-2xl bg-[#013F32] dark:bg-[#E7FE25] text-white dark:text-[#161616] font-bold text-xs sm:text-sm flex items-center gap-1.5 shadow hover:scale-[1.02] active:scale-[0.98] transition shrink-0"
          >
            <Send className="w-4 h-4" />
            <span className="hidden sm:inline">Finish & Submit</span>
          </button>
        </div>
      </header>

      {/* Examination Content Grid */}
      <div className="flex-1 max-w-7xl mx-auto w-full p-4 sm:p-6 lg:p-8 grid lg:grid-cols-[1fr_320px] gap-6 relative z-10">
        {/* Main Question & Answer Column */}
        <div className="space-y-6">
          {/* Question Surface (Prominent & Clear) */}
          <div className="exam-question-surface rounded-3xl p-6 sm:p-8 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-bold uppercase tracking-wider px-3 py-1 rounded-xl bg-[#013F32]/10 dark:bg-[#E7FE25]/15 text-[#013F32] dark:text-[#E7FE25]">
                Question {currentIndex + 1} ({currentQuestion.marks} Marks)
              </span>

              <div className="flex items-center gap-2">
                {/* Save status badge */}
                <span className="text-[11px] text-neutral-500 font-medium flex items-center gap-1">
                  {saveState === 'saving' && <RefreshCw className="w-3 h-3 animate-spin text-teal-600" />}
                  {saveState === 'saved' && <Check className="w-3 h-3 text-emerald-600" />}
                  {saveState === 'error' && <AlertTriangle className="w-3 h-3 text-rose-500" />}
                  <span className="capitalize">{saveState}</span>
                </span>

                <button
                  onClick={() => handleToggleFlag(currentQuestion.id)}
                  className={`p-2 rounded-xl text-xs font-semibold flex items-center gap-1 transition ${
                    isCurrentFlagged
                      ? 'bg-amber-500/20 text-amber-700 dark:text-amber-400'
                      : 'text-neutral-500 hover:bg-neutral-100 dark:hover:bg-white/5'
                  }`}
                  title="Mark for review"
                >
                  <Bookmark className={`w-4 h-4 ${isCurrentFlagged ? 'fill-current' : ''}`} />
                  <span className="hidden sm:inline">Review later</span>
                </button>
              </div>
            </div>

            <p className="text-base sm:text-lg font-medium text-[#161616] dark:text-[#FDFDFD] leading-relaxed select-text">
              {currentQuestion.question_text}
            </p>
          </div>

          {/* Answer Options Area (Distinct Surface) */}
          <div className="space-y-3">
            <span className="text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 pl-1">
              Select Your Answer:
            </span>

            {currentQuestion.question_type === 'short_answer' ? (
              <div className="space-y-2">
                <input
                  type="text"
                  value={textAnswers[currentQuestion.id] ?? ''}
                  onChange={(e) => handleTextChange(currentQuestion.id, e.target.value)}
                  placeholder="Type your answer here..."
                  className="w-full h-14 px-5 rounded-2xl glass-panel border border-neutral-300 dark:border-white/15 text-base font-medium text-[#161616] dark:text-[#FDFDFD] focus:outline-none focus:ring-2 focus:ring-[#013F32] dark:focus:ring-[#E7FE25]"
                />
                <p className="text-xs text-neutral-500 pl-2">
                  Answer automatically saves as you type.
                </p>
              </div>
            ) : (
              <div className="space-y-2.5">
                {currentQuestion.options.map((opt, idx) => {
                  const isSelected = selectedOptions[currentQuestion.id] === opt.id;
                  const letter = String.fromCharCode(65 + idx);

                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => handleSelectOption(currentQuestion.id, opt.id)}
                      className={`exam-option-card w-full p-4 sm:p-5 rounded-2xl flex items-center gap-4 text-left cursor-pointer transition-all ${
                        isSelected ? 'selected' : ''
                      }`}
                    >
                      <div
                        className={`w-8 h-8 rounded-xl font-bold text-xs flex items-center justify-center shrink-0 transition-colors ${
                          isSelected
                            ? 'bg-[#013F32] dark:bg-[#E7FE25] text-white dark:text-[#161616]'
                            : 'bg-neutral-100 dark:bg-white/10 text-neutral-600 dark:text-neutral-300'
                        }`}
                      >
                        {letter}
                      </div>

                      <span className="flex-1 text-sm sm:text-base font-medium text-[#161616] dark:text-[#FDFDFD] leading-snug">
                        {opt.option_text}
                      </span>

                      {isSelected && (
                        <div className="w-5 h-5 rounded-full bg-[#013F32] dark:bg-[#E7FE25] text-white dark:text-[#161616] flex items-center justify-center shrink-0">
                          <Check className="w-3 h-3 stroke-[3]" />
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Navigation Controls */}
          <div className="pt-4 flex items-center justify-between gap-4">
            <button
              onClick={() => setCurrentIndex((prev) => Math.max(0, prev - 1))}
              disabled={currentIndex === 0}
              className="px-5 py-2.5 rounded-2xl glass-panel text-xs sm:text-sm font-semibold text-neutral-700 dark:text-neutral-300 disabled:opacity-40 disabled:cursor-not-allowed hover:border-[#013F32] dark:hover:border-[#E7FE25] transition flex items-center gap-2"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Previous</span>
            </button>

            {currentIndex < totalQuestions - 1 ? (
              <button
                onClick={() => setCurrentIndex((prev) => Math.min(totalQuestions - 1, prev + 1))}
                className="px-6 py-2.5 rounded-2xl bg-[#013F32] dark:bg-[#E7FE25] text-white dark:text-[#161616] text-xs sm:text-sm font-bold shadow hover:opacity-90 transition flex items-center gap-2"
              >
                <span>Next</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            ) : (
              <button
                onClick={() => setShowSubmitModal(true)}
                className="px-6 py-2.5 rounded-2xl bg-[#013F32] dark:bg-[#E7FE25] text-white dark:text-[#161616] text-xs sm:text-sm font-bold shadow hover:opacity-90 transition flex items-center gap-2"
              >
                <span>Review & Submit</span>
                <Send className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Sidebar Question Navigation Palette */}
        <aside className="glass-panel rounded-3xl p-5 space-y-4 h-fit">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-[#161616] dark:text-[#FDFDFD]">
              Question Navigator
            </h2>
            <span className="text-xs font-semibold text-neutral-500">
              {answeredCount} / {totalQuestions}
            </span>
          </div>

          {/* Legend */}
          <div className="grid grid-cols-2 gap-2 text-[11px] text-neutral-500 dark:text-neutral-400 py-2 border-y border-neutral-200/60 dark:border-white/10">
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-md bg-[#013F32] dark:bg-[#E7FE25]" />
              <span>Current</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-md bg-emerald-500/20 text-emerald-600 border border-emerald-500/40" />
              <span>Answered</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-md bg-amber-500/30 border border-amber-500" />
              <span>Review</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-md border border-neutral-300 dark:border-white/20" />
              <span>Unanswered</span>
            </div>
          </div>

          {/* Number Grid */}
          <div className="grid grid-cols-5 gap-2 max-h-[360px] overflow-y-auto pr-1">
            {questions.map((q, idx) => {
              const isCurrent = idx === currentIndex;
              const isAnswered =
                q.question_type === 'short_answer'
                  ? Boolean(textAnswers[q.id]?.trim())
                  : Boolean(selectedOptions[q.id]);
              const isFlagged = flaggedIds.has(q.id);

              return (
                <button
                  key={q.id}
                  onClick={() => setCurrentIndex(idx)}
                  className={`relative h-10 rounded-xl font-mono text-xs font-bold transition flex items-center justify-center ${
                    isCurrent
                      ? 'bg-[#013F32] dark:bg-[#E7FE25] text-white dark:text-[#161616] shadow-md ring-2 ring-[#013F32]/30 dark:ring-[#E7FE25]/40'
                      : isFlagged
                        ? 'bg-amber-500/20 text-amber-800 dark:text-amber-300 border border-amber-500'
                        : isAnswered
                          ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30'
                          : 'bg-neutral-100 dark:bg-white/5 text-neutral-600 dark:text-neutral-400 border border-neutral-200 dark:border-white/10 hover:border-neutral-400'
                  }`}
                  aria-label={`Go to question ${idx + 1}`}
                >
                  <span>{idx + 1}</span>
                  {isFlagged && (
                    <div className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-amber-500" />
                  )}
                </button>
              );
            })}
          </div>

          <button
            onClick={() => setShowSubmitModal(true)}
            className="w-full py-2.5 rounded-2xl bg-[#013F32] dark:bg-[#E7FE25] text-white dark:text-[#161616] font-bold text-xs shadow hover:opacity-90 transition mt-2"
          >
            Submit Assessment
          </button>
        </aside>
      </div>

      {/* Submission Confirmation Modal */}
      {showSubmitModal && (
        <div
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in"
          onClick={() => setShowSubmitModal(false)}
        >
          <div
            className="glass-panel rounded-3xl max-w-md w-full p-6 sm:p-7 space-y-5 animate-in zoom-in-95"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-[#161616] dark:text-[#FDFDFD]">
                Confirm Exam Submission
              </h2>
              <button
                onClick={() => setShowSubmitModal(false)}
                className="p-1 rounded-lg text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-xs sm:text-sm text-neutral-600 dark:text-neutral-300 leading-relaxed">
              Are you sure you want to finalize your submission? Once submitted, your answers will be graded immediately according to rubric policies.
            </p>

            <div className="grid grid-cols-2 gap-3 py-3 border-y border-neutral-200/70 dark:border-white/10 text-center">
              <div className="p-3 rounded-2xl bg-emerald-500/10">
                <span className="text-xs text-neutral-500 font-medium">Answered</span>
                <div className="font-mono text-xl font-bold text-emerald-700 dark:text-[#E7FE25]">
                  {answeredCount} / {totalQuestions}
                </div>
              </div>

              <div className="p-3 rounded-2xl bg-amber-500/10">
                <span className="text-xs text-neutral-500 font-medium">Unanswered</span>
                <div className="font-mono text-xl font-bold text-amber-700 dark:text-amber-400">
                  {unansweredCount}
                </div>
              </div>
            </div>

            {unansweredCount > 0 && (
              <div className="flex items-start gap-2.5 p-3 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-800 dark:text-amber-300">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
                <span>
                  You have {unansweredCount} unanswered questions. You may return to complete them before submitting.
                </span>
              </div>
            )}

            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setShowSubmitModal(false)}
                className="flex-1 py-2.5 rounded-2xl glass-panel text-xs font-semibold text-neutral-700 dark:text-neutral-300 hover:border-neutral-400 transition"
              >
                Keep Reviewing
              </button>

              <button
                type="button"
                onClick={handleSubmitAttempt}
                disabled={isSubmitting}
                className="flex-1 py-2.5 rounded-2xl bg-[#013F32] dark:bg-[#E7FE25] text-white dark:text-[#161616] text-xs font-bold shadow hover:opacity-90 transition disabled:opacity-50"
              >
                {isSubmitting ? 'Grading...' : 'Yes, Submit Now'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
