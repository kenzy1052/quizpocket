import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Award, ArrowRight, CheckCircle2, XCircle, Clock, Calendar } from 'lucide-react';
import { apiRequest } from '../../lib/api.ts';
import { StudentReleasedResult } from '../../types/frontend.ts';
import { GlassCard } from '../../components/common/GlassCard.tsx';

export function StudentResultsPage() {
  const navigate = useNavigate();
  const [results, setResults] = useState<StudentReleasedResult[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    async function loadResults() {
      try {
        const data = await apiRequest<StudentReleasedResult[]>('/student/results');
        if (active) setResults(data || []);
      } catch (err) {
        console.error('Failed to load results:', err);
      } finally {
        if (active) setLoading(false);
      }
    }

    loadResults();
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="space-y-8 animate-in fade-in duration-300">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-[#161616] dark:text-[#FDFDFD]">
            Official Examination Results
          </h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
            Review your finalized scores, question-by-question explanations, and performance metrics
          </p>
        </div>
      </div>

      {loading ? (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {[1, 2, 3].map((n) => (
            <div key={n} className="h-44 rounded-3xl bg-neutral-200/50 dark:bg-white/5 animate-pulse" />
          ))}
        </div>
      ) : results.length === 0 ? (
        <GlassCard className="text-center py-16">
          <Award className="w-12 h-12 mx-auto text-neutral-400 mb-3" />
          <h2 className="text-base font-semibold text-[#161616] dark:text-[#FDFDFD]">
            No examination results released yet
          </h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 max-w-sm mx-auto mt-1 mb-6">
            Take an active quiz from your assigned courses to see your official evaluations here.
          </p>
          <button
            onClick={() => navigate('/student/quizzes')}
            className="px-5 py-2.5 rounded-2xl bg-[#013F32] dark:bg-[#E7FE25] text-white dark:text-[#161616] text-xs font-semibold"
          >
            Go to Quizzes
          </button>
        </GlassCard>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {results.map((res) => (
            <GlassCard key={res.result_id} hoverEffect className="flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between gap-2 mb-3">
                  <span
                    className={`text-[11px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-lg flex items-center gap-1 ${
                      res.passed
                        ? 'bg-emerald-500/10 text-emerald-700 dark:text-[#E7FE25]'
                        : 'bg-rose-500/10 text-rose-700 dark:text-rose-400'
                    }`}
                  >
                    {res.passed ? (
                      <CheckCircle2 className="w-3.5 h-3.5" />
                    ) : (
                      <XCircle className="w-3.5 h-3.5" />
                    )}
                    <span>{res.passed ? 'Passed' : 'Needs Review'}</span>
                  </span>

                  <span className="text-xs font-mono text-neutral-500 dark:text-neutral-400">
                    Attempt #{res.attempt_number}
                  </span>
                </div>

                <h2 className="font-bold text-base text-[#161616] dark:text-[#FDFDFD] line-clamp-2">
                  {res.exam_title}
                </h2>

                <div className="mt-4 p-4 rounded-2xl bg-neutral-50 dark:bg-white/[0.03] flex items-center justify-between">
                  <div>
                    <span className="text-[11px] text-neutral-500 uppercase tracking-wider font-semibold">
                      Total Score
                    </span>
                    <div className="font-mono text-xl font-bold text-[#161616] dark:text-[#FDFDFD]">
                      {res.marks_obtained} / {res.total_marks}
                    </div>
                  </div>

                  <div className="text-right">
                    <span className="text-[11px] text-neutral-500 uppercase tracking-wider font-semibold">
                      Percentage
                    </span>
                    <div className="font-mono text-xl font-bold text-emerald-700 dark:text-[#E7FE25]">
                      {Math.round(res.percentage ?? 0)}%
                    </div>
                  </div>
                </div>
              </div>

              <div className="mt-5 pt-4 border-t border-neutral-200/70 dark:border-white/10 flex items-center justify-between">
                <span className="text-[11px] text-neutral-400">
                  {new Date(res.finalized_at || res.submitted_at || res.started_at).toLocaleDateString()}
                </span>

                <button
                  onClick={() => navigate(`/student/results/${res.attempt_id}`)}
                  className="px-3.5 py-1.5 rounded-xl bg-[#013F32] dark:bg-[#E7FE25] text-white dark:text-[#161616] text-xs font-bold flex items-center gap-1.5 shadow hover:opacity-90 transition"
                >
                  <span>Review Answers</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </GlassCard>
          ))}
        </div>
      )}
    </div>
  );
}
