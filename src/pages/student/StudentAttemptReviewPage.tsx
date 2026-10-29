import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  CheckCircle2,
  XCircle,
  MinusCircle,
  HelpCircle,
  Clock,
  Award,
  ChevronDown,
} from 'lucide-react';
import { apiRequest } from '../../lib/api.ts';
import { AttemptReviewPayload, ReviewQuestionItem } from '../../types/frontend.ts';
import { GlassCard } from '../../components/common/GlassCard.tsx';

function outcomeMeta(outcome: ReviewQuestionItem['outcome']) {
  switch (outcome) {
    case 'correct':
      return {
        label: 'Correct',
        textClass: 'text-emerald-700 dark:text-[#E7FE25]',
        bgClass: 'bg-emerald-500/10 border-emerald-500/30',
        Icon: CheckCircle2,
      };
    case 'partial':
      return {
        label: 'Partial Credit',
        textClass: 'text-amber-700 dark:text-amber-400',
        bgClass: 'bg-amber-500/10 border-amber-500/30',
        Icon: MinusCircle,
      };
    case 'incorrect':
      return {
        label: 'Incorrect',
        textClass: 'text-rose-700 dark:text-rose-400',
        bgClass: 'bg-rose-500/10 border-rose-500/30',
        Icon: XCircle,
      };
    case 'unanswered':
    default:
      return {
        label: 'Unanswered',
        textClass: 'text-neutral-500 dark:text-neutral-400',
        bgClass: 'bg-neutral-100 dark:bg-white/5 border-neutral-200 dark:border-white/10',
        Icon: MinusCircle,
      };
  }
}

export function StudentAttemptReviewPage() {
  const { attemptId } = useParams<{ attemptId: string }>();
  const navigate = useNavigate();

  const [review, setReview] = useState<AttemptReviewPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'missed'>('all');

  useEffect(() => {
    let active = true;

    async function fetchReview() {
      if (!attemptId) return;
      try {
        const data = await apiRequest<AttemptReviewPayload>(
          `/student/attempts/${attemptId}/review`
        );
        if (active) setReview(data);
      } catch (err) {
        console.error('Failed to load attempt review:', err);
      } finally {
        if (active) setLoading(false);
      }
    }

    fetchReview();
    return () => {
      active = false;
    };
  }, [attemptId]);

  if (loading) {
    return (
      <div className="py-20 text-center">
        <div className="w-8 h-8 rounded-full border-2 border-[#013F32] dark:border-[#E7FE25] border-t-transparent animate-spin mx-auto mb-3" />
        <p className="text-sm font-medium text-neutral-500">Loading comprehensive review...</p>
      </div>
    );
  }

  if (!review) {
    return (
      <GlassCard className="text-center py-16 max-w-md mx-auto">
        <Award className="w-12 h-12 text-rose-500 mx-auto mb-3" />
        <h2 className="text-lg font-bold text-[#161616] dark:text-[#FDFDFD]">Review Unavailable</h2>
        <p className="text-xs text-neutral-500 mt-1 mb-6">
          The instructor may not have released results for this attempt yet.
        </p>
        <button
          onClick={() => navigate('/student/results')}
          className="px-4 py-2 rounded-xl bg-[#013F32] dark:bg-[#E7FE25] text-white dark:text-[#161616] text-xs font-semibold"
        >
          Back to Results
        </button>
      </GlassCard>
    );
  }

  const displayedQuestions = review.questions.filter((q) => {
    if (filter === 'missed') return q.outcome !== 'correct';
    return true;
  });

  return (
    <div className="max-w-4xl mx-auto space-y-6 animate-in fade-in duration-300">
      {/* Header & Back Button */}
      <button
        onClick={() => navigate('/student/results')}
        className="inline-flex items-center gap-2 text-xs font-semibold text-neutral-600 dark:text-neutral-400 hover:text-[#013F32] dark:hover:text-[#E7FE25] transition"
      >
        <ArrowLeft className="w-4 h-4" />
        <span>Back to All Results</span>
      </button>

      {/* Overview Banner Card */}
      <GlassCard className="p-6 sm:p-8 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-neutral-500 mb-1.5">
              <span>Attempt #{review.attempt_number ?? 1}</span>
              <span>·</span>
              <span>{new Date(review.finalized_at || review.submitted_at || review.started_at).toLocaleDateString()}</span>
            </div>
            <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-[#161616] dark:text-[#FDFDFD]">
              {review.exam_title}
            </h1>
          </div>

          <div className="text-left sm:text-right p-4 rounded-2xl bg-neutral-50 dark:bg-white/[0.04]">
            <div className="font-mono text-3xl font-bold text-[#161616] dark:text-[#FDFDFD]">
              {review.marks_obtained} / {review.total_marks}
            </div>
            <div className="text-xs font-bold mt-1 text-emerald-700 dark:text-[#E7FE25]">
              {Math.round(review.percentage)}% — {review.passed ? 'PASSED' : 'NEEDS IMPROVEMENT'}
            </div>
          </div>
        </div>

        {/* Filter Toggle */}
        <div className="pt-4 border-t border-neutral-200/70 dark:border-white/10 flex items-center gap-2">
          <button
            onClick={() => setFilter('all')}
            className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold transition ${
              filter === 'all'
                ? 'bg-[#013F32] dark:bg-[#E7FE25] text-white dark:text-[#161616] shadow-sm'
                : 'glass-panel text-neutral-600 dark:text-neutral-300'
            }`}
          >
            All Questions ({review.questions.length})
          </button>
          <button
            onClick={() => setFilter('missed')}
            className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold transition ${
              filter === 'missed'
                ? 'bg-[#013F32] dark:bg-[#E7FE25] text-white dark:text-[#161616] shadow-sm'
                : 'glass-panel text-neutral-600 dark:text-neutral-300'
            }`}
          >
            Missed / Partial ({review.questions.filter((q) => q.outcome !== 'correct').length})
          </button>
        </div>
      </GlassCard>

      {/* Questions Review List */}
      <div className="space-y-5">
        {displayedQuestions.map((q) => {
          const { label, textClass, bgClass, Icon } = outcomeMeta(q.outcome);

          return (
            <GlassCard key={q.question_id} className="p-6 sm:p-7 space-y-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-bold uppercase tracking-wider px-2.5 py-1 rounded-lg bg-neutral-100 dark:bg-white/10 text-neutral-700 dark:text-neutral-300">
                  Question {q.display_order} ({q.marks_awarded} / {q.max_marks} Marks)
                </span>

                <span
                  className={`px-2.5 py-1 rounded-xl text-xs font-semibold border flex items-center gap-1.5 ${bgClass} ${textClass}`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{label}</span>
                </span>
              </div>

              <h2 className="text-base font-semibold text-[#161616] dark:text-[#FDFDFD] leading-relaxed">
                {q.question_text}
              </h2>

              {/* Options breakdown */}
              {q.options && q.options.length > 0 && (
                <div className="space-y-2 pt-2">
                  {q.options.map((opt, idx) => {
                    const isPicked = opt.id === q.selected_option_id;
                    const isCorrect = opt.id === q.correct_option_id;
                    const letter = String.fromCharCode(65 + idx);

                    let cardClass =
                      'border-neutral-200 dark:border-white/10 bg-neutral-50/50 dark:bg-white/[0.02]';
                    if (isCorrect) {
                      cardClass =
                        'border-emerald-500/50 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200';
                    } else if (isPicked && !isCorrect) {
                      cardClass =
                        'border-rose-500/50 bg-rose-500/10 text-rose-900 dark:text-rose-200';
                    }

                    return (
                      <div
                        key={opt.id}
                        className={`p-3.5 rounded-2xl border text-sm flex items-center justify-between gap-3 ${cardClass}`}
                      >
                        <div className="flex items-center gap-3">
                          <span className="w-6 h-6 rounded-lg bg-neutral-200 dark:bg-white/10 text-xs font-bold flex items-center justify-center shrink-0">
                            {letter}
                          </span>
                          <span className="font-medium">{opt.option_text}</span>
                        </div>

                        <div className="flex items-center gap-2 text-xs font-bold shrink-0">
                          {isCorrect && (
                            <span className="text-emerald-700 dark:text-[#E7FE25] flex items-center gap-1">
                              <CheckCircle2 className="w-4 h-4" />
                              <span>Correct</span>
                            </span>
                          )}
                          {isPicked && !isCorrect && (
                            <span className="text-rose-600 flex items-center gap-1">
                              <XCircle className="w-4 h-4" />
                              <span>Your Answer</span>
                            </span>
                          )}
                          {isPicked && isCorrect && (
                            <span className="text-emerald-700 dark:text-[#E7FE25] text-[11px]">
                              (Your Pick)
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Explanation note */}
              {q.explanation && (
                <div className="p-4 rounded-2xl bg-[#013F32]/5 dark:bg-[#E7FE25]/5 border border-[#013F32]/10 dark:border-[#E7FE25]/15 mt-3 space-y-1">
                  <span className="text-xs font-bold text-[#013F32] dark:text-[#E7FE25] uppercase tracking-wider flex items-center gap-1">
                    <HelpCircle className="w-3.5 h-3.5" />
                    <span>Explanation</span>
                  </span>
                  <p className="text-xs text-neutral-600 dark:text-neutral-300 leading-relaxed">
                    {q.explanation}
                  </p>
                </div>
              )}
            </GlassCard>
          );
        })}
      </div>
    </div>
  );
}
