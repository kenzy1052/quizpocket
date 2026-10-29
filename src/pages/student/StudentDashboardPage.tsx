import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Award,
  CheckCircle2,
  Clock,
  TrendingUp,
  AlertCircle,
  BarChart2,
  Calendar,
  ArrowRight,
  Filter,
} from 'lucide-react';
import { apiRequest } from '../../lib/api.ts';
import { StudentReleasedResult } from '../../types/frontend.ts';
import { GlassCard } from '../../components/common/GlassCard.tsx';

export function StudentDashboardPage() {
  const navigate = useNavigate();
  const [results, setResults] = useState<StudentReleasedResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'passed' | 'failed'>('all');

  useEffect(() => {
    let active = true;

    async function loadResults() {
      try {
        const data = await apiRequest<StudentReleasedResult[]>('/student/results');
        if (active) setResults(data || []);
      } catch (err) {
        console.error('Failed to load student results:', err);
      } finally {
        if (active) setLoading(false);
      }
    }

    loadResults();
    return () => {
      active = false;
    };
  }, []);

  const totalAttempts = results.length;
  const passedAttempts = results.filter((r) => r.passed).length;
  const passRate = totalAttempts > 0 ? Math.round((passedAttempts / totalAttempts) * 100) : 0;
  const avgPercentage =
    totalAttempts > 0
      ? Math.round(results.reduce((acc, r) => acc + (r.percentage || 0), 0) / totalAttempts)
      : 0;

  const highestScore = totalAttempts > 0 ? Math.max(...results.map((r) => r.percentage || 0)) : 0;

  const filteredResults = results.filter((r) => {
    if (filter === 'passed') return r.passed;
    if (filter === 'failed') return !r.passed;
    return true;
  });

  return (
    <div className="space-y-8 animate-in fade-in duration-300">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-[#161616] dark:text-[#FDFDFD]">
            Student Performance Dashboard
          </h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
            Comprehensive analytics, historical attempt records, and mastery trends
          </p>
        </div>

        <button
          onClick={() => navigate('/student/quizzes')}
          className="self-start sm:self-auto px-4 py-2 rounded-2xl bg-[#013F32] dark:bg-[#E7FE25] text-white dark:text-[#161616] font-semibold text-xs sm:text-sm shadow hover:opacity-90 transition flex items-center gap-1.5"
        >
          <span>Take New Exam</span>
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>

      {/* Analytics KPI Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-5">
        <GlassCard className="p-4 sm:p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
              Total Attempts
            </span>
            <div className="w-8 h-8 rounded-xl bg-teal-500/10 dark:bg-teal-500/20 text-teal-700 dark:text-teal-300 flex items-center justify-center">
              <BarChart2 className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3 font-mono text-2xl sm:text-3xl font-bold text-[#161616] dark:text-[#FDFDFD]">
            {totalAttempts}
          </div>
          <p className="text-[11px] text-neutral-500 dark:text-neutral-400 mt-1">
            Submitted & evaluated quizzes
          </p>
        </GlassCard>

        <GlassCard className="p-4 sm:p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
              Average Score
            </span>
            <div className="w-8 h-8 rounded-xl bg-[#013F32]/10 dark:bg-[#E7FE25]/20 text-[#013F32] dark:text-[#E7FE25] flex items-center justify-center">
              <TrendingUp className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3 font-mono text-2xl sm:text-3xl font-bold text-[#161616] dark:text-[#FDFDFD]">
            {avgPercentage}%
          </div>
          <p className="text-[11px] text-neutral-500 dark:text-neutral-400 mt-1">
            Across all taken examinations
          </p>
        </GlassCard>

        <GlassCard className="p-4 sm:p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
              Pass Rate
            </span>
            <div className="w-8 h-8 rounded-xl bg-emerald-500/10 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-300 flex items-center justify-center">
              <CheckCircle2 className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3 font-mono text-2xl sm:text-3xl font-bold text-[#161616] dark:text-[#FDFDFD]">
            {passRate}%
          </div>
          <p className="text-[11px] text-neutral-500 dark:text-neutral-400 mt-1">
            {passedAttempts} of {totalAttempts} met passing threshold
          </p>
        </GlassCard>

        <GlassCard className="p-4 sm:p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
              Top Score
            </span>
            <div className="w-8 h-8 rounded-xl bg-amber-500/10 dark:bg-amber-500/20 text-amber-600 dark:text-amber-300 flex items-center justify-center">
              <Award className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3 font-mono text-2xl sm:text-3xl font-bold text-[#161616] dark:text-[#FDFDFD]">
            {Math.round(highestScore)}%
          </div>
          <p className="text-[11px] text-neutral-500 dark:text-neutral-400 mt-1">
            Personal best record
          </p>
        </GlassCard>
      </div>

      {/* Performance History Section */}
      <GlassCard className="p-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div>
            <h2 className="text-lg font-bold text-[#161616] dark:text-[#FDFDFD]">
              Historical Examination Results
            </h2>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Detailed list of completed quizzes and scoring breakdowns
            </p>
          </div>

          {/* Segmented Filter Control */}
          <div className="flex items-center gap-1 p-1 bg-neutral-100 dark:bg-white/5 rounded-2xl border border-neutral-200/60 dark:border-white/10 self-start sm:self-auto">
            <button
              onClick={() => setFilter('all')}
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition ${
                filter === 'all'
                  ? 'bg-white dark:bg-[#1E211F] text-[#161616] dark:text-[#FDFDFD] shadow-sm'
                  : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white'
              }`}
            >
              All ({results.length})
            </button>
            <button
              onClick={() => setFilter('passed')}
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition ${
                filter === 'passed'
                  ? 'bg-white dark:bg-[#1E211F] text-emerald-700 dark:text-[#E7FE25] shadow-sm'
                  : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white'
              }`}
            >
              Passed ({results.filter((r) => r.passed).length})
            </button>
            <button
              onClick={() => setFilter('failed')}
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition ${
                filter === 'failed'
                  ? 'bg-white dark:bg-[#1E211F] text-rose-600 shadow-sm'
                  : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white'
              }`}
            >
              Needs Review ({results.filter((r) => !r.passed).length})
            </button>
          </div>
        </div>

        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((n) => (
              <div key={n} className="h-16 rounded-2xl bg-neutral-100 dark:bg-white/5 animate-pulse" />
            ))}
          </div>
        ) : filteredResults.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400">
              No examination records matching selected filter.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs sm:text-sm">
              <thead>
                <tr className="border-b border-neutral-200/70 dark:border-white/10 text-neutral-500 dark:text-neutral-400 font-semibold uppercase tracking-wider text-[11px]">
                  <th className="pb-3 pl-2">Quiz Title</th>
                  <th className="pb-3 text-center">Attempt</th>
                  <th className="pb-3 text-right">Score</th>
                  <th className="pb-3 text-center">Outcome</th>
                  <th className="pb-3 text-right">Date</th>
                  <th className="pb-3 text-right pr-2">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-200/50 dark:divide-white/5">
                {filteredResults.map((r) => (
                  <tr key={r.result_id} className="hover:bg-neutral-50/50 dark:hover:bg-white/[0.02] transition">
                    <td className="py-3.5 pl-2 font-medium text-[#161616] dark:text-[#FDFDFD]">
                      {r.exam_title}
                    </td>
                    <td className="py-3.5 text-center font-mono text-neutral-600 dark:text-neutral-400">
                      #{r.attempt_number}
                    </td>
                    <td className="py-3.5 text-right font-mono font-bold text-[#161616] dark:text-[#FDFDFD]">
                      {r.marks_obtained ?? 0} / {r.total_marks ?? 0}{' '}
                      <span className="text-xs font-normal text-neutral-500">
                        ({Math.round(r.percentage ?? 0)}%)
                      </span>
                    </td>
                    <td className="py-3.5 text-center">
                      <span
                        className={`inline-block px-2.5 py-0.5 rounded-lg text-xs font-semibold ${
                          r.passed
                            ? 'bg-emerald-500/10 text-emerald-700 dark:text-[#E7FE25]'
                            : 'bg-rose-500/10 text-rose-700 dark:text-rose-400'
                        }`}
                      >
                        {r.passed ? 'Passed' : 'Needs Review'}
                      </span>
                    </td>
                    <td className="py-3.5 text-right text-xs text-neutral-500 dark:text-neutral-400">
                      {new Date(r.finalized_at || r.submitted_at || r.started_at).toLocaleDateString()}
                    </td>
                    <td className="py-3.5 text-right pr-2">
                      <button
                        onClick={() => navigate(`/student/results/${r.attempt_id}`)}
                        className="px-3 py-1 rounded-xl glass-panel text-xs font-semibold hover:border-[#013F32] dark:hover:border-[#E7FE25] transition"
                      >
                        Review
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </GlassCard>
    </div>
  );
}
