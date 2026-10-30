import React, { useEffect, useState } from 'react';
import { ArrowLeft, CheckCircle2, XCircle, MinusCircle, Clock } from 'lucide-react';
import { ApiClientError, apiRequest } from '../../lib/api.ts';
import {
  formatDateTime,
  formatMarks,
  formatQuestionTypeLabel,
} from '../../lib/format.ts';
import { AttemptReviewPayload, ReviewQuestionItem } from '../../types/frontend.ts';

interface AttemptReviewViewProps {
  attemptId: string;
  onBack: () => void;
}

function outcomeMeta(outcome: ReviewQuestionItem['outcome']) {
  switch (outcome) {
    case 'correct':
      return {
        label: 'Correct',
        textClass: 'text-[#013F32] dark:text-[#E7FE25]',
        Icon: CheckCircle2,
      };
    case 'partial':
      return {
        label: 'Partial Credit',
        textClass: 'text-amber-700 dark:text-amber-400',
        Icon: MinusCircle,
      };
    case 'incorrect':
      return {
        label: 'Incorrect',
        textClass: 'text-rose-700 dark:text-rose-400',
        Icon: XCircle,
      };
    case 'unanswered':
      return {
        label: 'Unanswered',
        textClass: 'text-neutral-500 dark:text-neutral-400',
        Icon: MinusCircle,
      };
  }
}

export function AttemptReviewView({ attemptId, onBack }: AttemptReviewViewProps) {
  const [review, setReview] = useState<AttemptReviewPayload | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'missed'>('all');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setErrorMsg(null);
    apiRequest<AttemptReviewPayload>(`/student/attempts/${attemptId}/review`)
      .then((data) => {
        if (active) setReview(data);
      })
      .catch((err) => {
        if (active) {
          setErrorMsg(
            err instanceof ApiClientError ? err.message : 'Unable to load quiz review.'
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [attemptId]);

  if (loading) {
    return (
      <div className="py-16 text-center space-y-2.5">
        <div className="w-7 h-7 rounded-full border-2 border-[#013F32] dark:border-[#E7FE25] border-t-transparent animate-spin mx-auto" />
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Loading detailed answer review...
        </p>
      </div>
    );
  }

  if (errorMsg || !review) {
    return (
      <div className="bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-3xl border border-neutral-200 dark:border-white/10 p-6 space-y-4">
        <h2 className="font-display text-lg font-bold text-[#161616] dark:text-[#FDFDFD]">
          Review Unavailable
        </h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-300">
          {errorMsg ?? 'Review record not found.'}
        </p>
        <button
          type="button"
          onClick={onBack}
          className="min-h-[44px] px-5 rounded-2xl bg-[#013F32] text-[#FDFDFD] dark:bg-[#E7FE25] dark:text-[#161616] text-sm font-semibold"
        >
          Back to Results
        </button>
      </div>
    );
  }

  const sectionAQuestions = review.questions.filter((q) => q.question_type !== 'short_answer');
  const sectionBQuestions = review.questions.filter((q) => q.question_type === 'short_answer');
  const hasSections = sectionAQuestions.length > 0 && sectionBQuestions.length > 0;

  const sectionAScore = sectionAQuestions.reduce(
    (sum, q) => sum + (Number(q.marks_awarded) || 0),
    0
  );
  const sectionAMax = sectionAQuestions.reduce(
    (sum, q) => sum + (Number(q.max_marks) || 0),
    0
  );

  const sectionBScore = sectionBQuestions.reduce(
    (sum, q) => sum + (Number(q.marks_awarded) || 0),
    0
  );
  const sectionBMax = sectionBQuestions.reduce(
    (sum, q) => sum + (Number(q.max_marks) || 0),
    0
  );

  const isSectionBPending =
    sectionBQuestions.length > 0 &&
    sectionBQuestions.some((q) => q.outcome === 'partial' && Number(q.marks_awarded) === 0);

  const displayedQuestions =
    filter === 'missed'
      ? review.questions.filter((q) => q.outcome !== 'correct')
      : review.questions;

  const correctCount = review.questions.filter((q) => q.outcome === 'correct').length;
  const incorrectCount = review.questions.filter(
    (q) => q.outcome === 'incorrect' || (q.outcome === 'partial' && Number(q.marks_awarded) > 0)
  ).length;
  const unansweredCount = review.questions.filter((q) => q.outcome === 'unanswered').length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          className="min-h-[44px] px-3 -ml-3 rounded-xl text-sm font-semibold text-[#013F32] dark:text-[#E7FE25] hover:bg-[#FDFDFD] dark:hover:bg-white/5 inline-flex items-center gap-2 whitespace-nowrap transition"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Results</span>
        </button>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          Submitted {formatDateTime(review.submitted_at)}
        </span>
      </div>

      {/* Overall Score & Summary Card */}
      <section className="bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-3xl border border-neutral-200/90 dark:border-white/10 p-5 sm:p-7">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-[#013F32] dark:text-[#E7FE25]">
              Quiz Score & Answer Review
            </p>
            <h1 className="font-display text-xl sm:text-2xl font-bold text-[#161616] dark:text-[#FDFDFD] mt-1">
              {review.exam_title}
            </h1>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-500 dark:text-neutral-400 mt-2">
              <span>
                Correct:{' '}
                <strong className="font-mono tabular-nums text-[#013F32] dark:text-[#E7FE25]">
                  {correctCount}
                </strong>
              </span>
              <span>
                Incorrect:{' '}
                <strong className="font-mono tabular-nums text-rose-700 dark:text-rose-400">
                  {incorrectCount}
                </strong>
              </span>
              <span>
                Unanswered:{' '}
                <strong className="font-mono tabular-nums text-[#161616] dark:text-[#FDFDFD]">
                  {unansweredCount}
                </strong>
              </span>
            </div>
          </div>

          <div className="flex items-baseline gap-4 sm:text-right">
            <div>
              <div className="text-2xl sm:text-3xl font-bold font-mono tabular-nums text-[#161616] dark:text-[#FDFDFD]">
                {formatMarks(review.marks_obtained)} / {formatMarks(review.total_marks)}
              </div>
              <div className="text-xs font-medium mt-0.5">
                <span className="font-mono tabular-nums font-semibold text-[#013F32] dark:text-[#E7FE25]">
                  {Number(review.percentage).toFixed(1)}%
                </span>
                <span className="mx-1.5 text-neutral-400">·</span>
                <span
                  className={
                    review.passed
                      ? 'text-[#013F32] dark:text-[#E7FE25] font-semibold'
                      : 'text-rose-700 dark:text-rose-400 font-semibold'
                  }
                >
                  {review.passed ? 'Passed' : 'Below Passing Threshold'}
                </span>
              </div>
            </div>
          </div>
        </div>

        {hasSections && (
          <div className="mt-5 pt-4 border-t border-neutral-200/70 dark:border-white/10 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div className="rounded-2xl bg-[#013F32]/[0.05] dark:bg-[#E7FE25]/[0.08] border border-[#013F32]/20 dark:border-[#E7FE25]/25 p-3.5 space-y-1">
              <div className="font-bold text-[#013F32] dark:text-[#E7FE25]">
                Section A: Objective Score (MCQ)
              </div>
              <div className="font-mono text-base font-bold text-[#161616] dark:text-[#FDFDFD]">
                {formatMarks(sectionAScore)} / {formatMarks(sectionAMax)} marks
              </div>
              <div className="text-neutral-500 dark:text-neutral-400">
                Auto-graded immediately ({sectionAMax > 0 ? Math.round((sectionAScore / sectionAMax) * 100) : 0}%)
              </div>
            </div>

            <div className="rounded-2xl bg-amber-500/[0.08] dark:bg-amber-500/[0.12] border border-amber-500/25 p-3.5 space-y-1">
              <div className="font-bold text-amber-800 dark:text-amber-300">
                Section B: Short Answer Review
              </div>
              {isSectionBPending ? (
                <>
                  <div className="text-amber-700 dark:text-amber-400 font-semibold">
                    Submitted for Instructor Review
                  </div>
                  <div className="text-neutral-500 dark:text-neutral-400">
                    5 questions (15 marks). Final score will be released after admin grading.
                  </div>
                </>
              ) : (
                <>
                  <div className="font-mono text-base font-bold text-[#161616] dark:text-[#FDFDFD]">
                    {formatMarks(sectionBScore)} / {formatMarks(sectionBMax)} marks
                  </div>
                  <div className="text-[#013F32] dark:text-[#E7FE25] font-medium">
                    Instructor Review Completed
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        <div className="mt-5 pt-4 border-t border-neutral-200/70 dark:border-white/10 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setFilter('all')}
            className={`min-h-[40px] px-4 rounded-xl text-xs font-semibold transition whitespace-nowrap ${
              filter === 'all'
                ? 'bg-[#013F32] text-[#FDFDFD] dark:bg-[#E7FE25] dark:text-[#161616]'
                : 'bg-neutral-100 dark:bg-white/5 text-neutral-600 dark:text-neutral-300 hover:text-[#161616] dark:hover:text-[#FDFDFD]'
            }`}
          >
            All Questions ({review.questions.length})
          </button>
          <button
            type="button"
            onClick={() => setFilter('missed')}
            className={`min-h-[40px] px-4 rounded-xl text-xs font-semibold transition whitespace-nowrap ${
              filter === 'missed'
                ? 'bg-[#013F32] text-[#FDFDFD] dark:bg-[#E7FE25] dark:text-[#161616]'
                : 'bg-neutral-100 dark:bg-white/5 text-neutral-600 dark:text-neutral-300 hover:text-[#161616] dark:hover:text-[#FDFDFD]'
            }`}
          >
            Needs Review ({review.questions.filter((q) => q.outcome !== 'correct').length})
          </button>
        </div>
      </section>

      {/* Question-by-Question Review List */}
      <section className="bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-3xl border border-neutral-200/90 dark:border-white/10 divide-y divide-neutral-200/70 dark:divide-white/10">
        {displayedQuestions.length === 0 ? (
          <div className="p-8 text-center text-sm text-neutral-500 dark:text-neutral-400">
            Every question in this attempt was answered with full marks.
          </div>
        ) : (
          displayedQuestions.map((q) => {
            const isPendingReview =
              q.question_type === 'short_answer' &&
              q.outcome === 'partial' &&
              Number(q.marks_awarded) === 0;

            const meta = outcomeMeta(q.outcome);
            const label = isPendingReview ? 'Pending Review' : meta.label;
            const textClass = isPendingReview
              ? 'text-amber-700 dark:text-amber-400'
              : meta.textClass;
            const Icon = isPendingReview ? Clock : meta.Icon;

            return (
              <article key={q.question_id} className="p-5 sm:p-7 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="text-neutral-500 dark:text-neutral-400">
                    <span className="font-mono tabular-nums font-semibold text-[#161616] dark:text-[#FDFDFD]">
                      Question {q.display_order}
                    </span>
                    {hasSections && (
                      <span className="mx-1.5 font-semibold text-neutral-400">
                        {q.question_type === 'short_answer' ? '· Section B' : '· Section A'}
                      </span>
                    )}
                    <span className="mx-1.5">·</span>
                    <span>{formatQuestionTypeLabel(q.question_type)}</span>
                  </div>
                  <div className={`font-semibold inline-flex items-center gap-1.5 ${textClass}`}>
                    <Icon className="w-4 h-4" />
                    <span>{label}</span>
                    <span className="text-neutral-400">·</span>
                    <span className="font-mono tabular-nums text-[#161616] dark:text-[#FDFDFD]">
                      {formatMarks(q.marks_awarded)} / {formatMarks(q.max_marks)} marks
                    </span>
                  </div>
                </div>

                <h2 className="text-base font-semibold text-[#161616] dark:text-[#FDFDFD] leading-snug">
                  {q.question_text}
                </h2>

                {(q.question_type === 'multiple_choice' || q.question_type === 'true_false') && (
                  <div className="space-y-2">
                    {q.options.map((opt, idx) => {
                      const isStudentPick = opt.id === q.selected_option_id;
                      const isCorrectOpt = opt.is_correct;
                      const letter = String.fromCharCode(65 + idx);

                      let rowStyle =
                        'border-neutral-200 dark:border-white/10 bg-[#FDFDFD] dark:bg-[#161616] text-neutral-700 dark:text-neutral-300';
                      if (isCorrectOpt) {
                        rowStyle =
                          'border-[#013F32]/40 dark:border-[#E7FE25]/45 bg-[#013F32]/[0.06] dark:bg-[#E7FE25]/[0.08] text-[#161616] dark:text-[#FDFDFD]';
                      } else if (isStudentPick && !isCorrectOpt) {
                        rowStyle =
                          'border-rose-300 dark:border-rose-700/70 bg-rose-50/70 dark:bg-rose-950/35 text-rose-950 dark:text-rose-200';
                      }

                      return (
                        <div
                          key={opt.id}
                          className={`rounded-2xl border px-4 py-3 text-sm flex items-start justify-between gap-3 ${rowStyle}`}
                        >
                          <div className="flex items-start gap-2.5">
                            <span className="font-mono text-xs font-semibold mt-0.5">
                              {letter}.
                            </span>
                            <span>{opt.option_text}</span>
                          </div>
                          <div className="text-xs font-semibold shrink-0 whitespace-nowrap">
                            {isCorrectOpt && isStudentPick && (
                              <span className="text-[#013F32] dark:text-[#E7FE25]">
                                Your answer · Correct
                              </span>
                            )}
                            {isCorrectOpt && !isStudentPick && (
                              <span className="text-[#013F32] dark:text-[#E7FE25]">
                                Correct answer
                              </span>
                            )}
                            {!isCorrectOpt && isStudentPick && (
                              <span className="text-rose-700 dark:text-rose-400">
                                Your selection
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {(q.question_type === 'fill_in_blank' || q.question_type === 'short_answer') && (
                  <div className="space-y-3 text-sm">
                    <div className="rounded-2xl bg-neutral-100/80 dark:bg-[#161616] border border-neutral-200/80 dark:border-white/10 p-3.5">
                      <div className="text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-1">
                        Your Response
                      </div>
                      <div className="text-[#161616] dark:text-[#FDFDFD] whitespace-pre-wrap">
                        {q.submitted_text ? q.submitted_text : 'No response submitted.'}
                      </div>
                    </div>

                    {q.question_type === 'fill_in_blank' && q.accepted_answers?.length > 0 && (
                      <div className="rounded-2xl bg-[#013F32]/[0.06] dark:bg-[#E7FE25]/[0.08] border border-[#013F32]/30 dark:border-[#E7FE25]/35 p-3.5">
                        <div className="text-xs font-semibold text-[#013F32] dark:text-[#E7FE25] mb-1">
                          Correct Answer
                        </div>
                        <div className="font-semibold text-[#161616] dark:text-[#FDFDFD]">
                          {q.accepted_answers[0]}
                        </div>
                      </div>
                    )}

                    {isPendingReview && (
                      <div className="rounded-2xl bg-amber-500/[0.08] dark:bg-amber-500/[0.12] border border-amber-500/25 p-3.5 text-xs text-amber-900 dark:text-amber-200 flex items-center gap-2.5">
                        <Clock className="w-4 h-4 shrink-0 text-amber-600 dark:text-amber-400" />
                        <span>
                          This written response has been submitted to your instructor for evaluation (up to 3 marks).
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {q.explanation && (
                  <div className="rounded-2xl bg-[#013F32]/[0.04] dark:bg-white/[0.04] border border-neutral-200/90 dark:border-white/12 p-4 text-xs sm:text-sm text-[#161616] dark:text-neutral-200 leading-relaxed">
                    <span className="font-semibold text-[#013F32] dark:text-[#E7FE25]">
                      Explanation:{' '}
                    </span>
                    {q.explanation}
                  </div>
                )}
              </article>
            );
          })
        )}
      </section>
    </div>
  );
}
