import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Activity,
  Clock,
  User,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Radio,
  FileQuestion,
  Shield,
  Eye,
} from 'lucide-react';
import { apiRequest } from '../../lib/api.ts';
import { LiveMonitoringAttemptDetail } from '../../types/frontend.ts';
import { GlassCard } from '../../components/common/GlassCard.tsx';

function formatRemaining(seconds: number): string {
  if (seconds <= 0) return 'Expired';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

export function AdminAttemptMonitorPage() {
  const { attemptId } = useParams<{ attemptId: string }>();
  const navigate = useNavigate();

  const [detail, setDetail] = useState<LiveMonitoringAttemptDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchAttemptStatus = useCallback(async (isBackground = false) => {
    if (!attemptId) return;
    if (!isBackground) setIsRefreshing(true);
    try {
      const data = await apiRequest<LiveMonitoringAttemptDetail>(
        `/admin/monitoring/attempts/${attemptId}`
      );
      setDetail(data);
    } catch (err) {
      console.error('Failed to load live attempt detail:', err);
    } finally {
      if (!isBackground) setIsRefreshing(false);
      setLoading(false);
    }
  }, [attemptId]);

  useEffect(() => {
    fetchAttemptStatus(false);
  }, [fetchAttemptStatus]);

  // Live Auto-Refresh every 3 seconds
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      fetchAttemptStatus(true);
    }, 3000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchAttemptStatus]);

  if (loading) {
    return (
      <div className="py-20 text-center">
        <div className="w-8 h-8 rounded-full border-2 border-[#013F32] dark:border-[#E7FE25] border-t-transparent animate-spin mx-auto mb-3" />
        <p className="text-sm font-semibold text-neutral-500">Connecting to student telemetry session...</p>
      </div>
    );
  }

  if (!detail) {
    return (
      <GlassCard className="text-center py-16 max-w-md mx-auto">
        <AlertTriangle className="w-12 h-12 text-rose-500 mx-auto mb-3" />
        <h2 className="text-lg font-bold text-[#161616] dark:text-[#FDFDFD]">Attempt Not Found</h2>
        <p className="text-xs text-neutral-500 mt-1 mb-6">
          The requested examination attempt was not found or is in another institution.
        </p>
        <button
          onClick={() => navigate('/admin/monitoring')}
          className="px-4 py-2 rounded-xl bg-[#013F32] dark:bg-[#E7FE25] text-white dark:text-[#161616] text-xs font-semibold"
        >
          Return to Monitor
        </button>
      </GlassCard>
    );
  }

  const answeredQuestionsCount = detail.questions.filter((q) => q.is_answered).length;
  const totalQuestions = detail.questions.length;
  const pct = totalQuestions > 0 ? Math.round((answeredQuestionsCount / totalQuestions) * 100) : 0;
  const isActive = detail.status === 'in_progress' && detail.seconds_remaining > 0;

  return (
    <div className="max-w-5xl mx-auto space-y-6 animate-in fade-in duration-300">
      {/* Header & Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <button
          onClick={() => navigate('/admin/monitoring')}
          className="inline-flex items-center gap-2 text-xs font-semibold text-neutral-600 dark:text-neutral-400 hover:text-[#013F32] dark:hover:text-[#E7FE25] transition"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Live Monitor</span>
        </button>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 border transition ${
              autoRefresh
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-[#E7FE25]'
                : 'glass-panel text-neutral-500'
            }`}
          >
            <Radio className={`w-3.5 h-3.5 ${autoRefresh ? 'animate-pulse text-emerald-500 dark:text-[#E7FE25]' : ''}`} />
            <span>{autoRefresh ? 'Live Polling (3s)' : 'Paused'}</span>
          </button>

          <button
            onClick={() => fetchAttemptStatus(false)}
            disabled={isRefreshing}
            className="p-2 rounded-xl glass-panel text-neutral-600 dark:text-neutral-300 hover:border-[#013F32] dark:hover:border-[#E7FE25]"
            title="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Main Student Header Card */}
      <GlassCard className="p-6 sm:p-8 space-y-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 pb-6 border-b border-neutral-200/70 dark:border-white/10">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-2xl bg-[#013F32] dark:bg-[#E7FE25] text-white dark:text-[#161616] font-display text-xl font-bold flex items-center justify-center uppercase shrink-0 shadow-md">
              {detail.student_name[0]}
            </div>

            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-display text-xl sm:text-2xl font-bold tracking-tight text-[#161616] dark:text-[#FDFDFD]">
                  {detail.student_name}
                </h1>
                {isActive ? (
                  <span className="px-2.5 py-0.5 rounded-md text-[10px] font-bold bg-emerald-500/10 text-emerald-700 dark:text-[#E7FE25] border border-emerald-500/30 animate-pulse">
                    LIVE
                  </span>
                ) : (
                  <span className="px-2.5 py-0.5 rounded-md text-[10px] font-bold bg-neutral-200 dark:bg-white/10 text-neutral-600 dark:text-neutral-400">
                    {detail.status.toUpperCase()}
                  </span>
                )}
              </div>

              <p className="text-xs text-neutral-600 dark:text-neutral-400 mt-0.5 font-medium">
                {detail.exam_title} · Attempt #{detail.attempt_number}
              </p>

              <div className="flex items-center gap-3 text-xs text-neutral-400 mt-1">
                <span>Started: {new Date(detail.started_at).toLocaleTimeString()}</span>
                <span>·</span>
                <span>Last Telemetry Sync: {new Date(detail.last_activity_at).toLocaleTimeString()}</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="p-4 rounded-2xl bg-neutral-50 dark:bg-white/[0.04] text-right">
              <span className="text-[10px] uppercase font-bold tracking-wider text-neutral-500">
                {isActive ? 'Time Remaining' : 'Status'}
              </span>
              <div className="font-mono text-xl sm:text-2xl font-bold text-[#161616] dark:text-[#FDFDFD] mt-0.5">
                {isActive ? formatRemaining(detail.seconds_remaining) : detail.status.toUpperCase()}
              </div>
            </div>
          </div>
        </div>

        {/* Overall Progress Bar */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-neutral-600 dark:text-neutral-300">
              Exam Progress ({answeredQuestionsCount} of {totalQuestions} answered)
            </span>
            <span className="font-mono font-bold text-[#013F32] dark:text-[#E7FE25] text-sm">
              {pct}% Completed
            </span>
          </div>

          <div className="h-3 w-full rounded-full bg-neutral-200 dark:bg-white/10 overflow-hidden">
            <div
              className="h-full bg-[#013F32] dark:bg-[#E7FE25] transition-all duration-500 rounded-full"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>

        {/* Security & Integrity Banner */}
        <div className="p-4 rounded-2xl bg-teal-500/10 border border-teal-500/20 flex items-center gap-3 text-xs text-teal-800 dark:text-teal-300">
          <Shield className="w-5 h-5 shrink-0 text-teal-600" />
          <span>
            <strong>Exam Integrity Guard:</strong> Individual student answer values and correct options are hidden from administrators during active exam taking to prevent disclosure leaks.
          </span>
        </div>
      </GlassCard>

      {/* Real-Time Question Matrix Grid */}
      <GlassCard className="p-6 sm:p-8 space-y-6">
        <div>
          <h2 className="text-lg font-bold text-[#161616] dark:text-[#FDFDFD]">
            Live Question-by-Question Status Matrix
          </h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Real-time map showing which questions have confirmed saved answers and the question currently on the student&apos;s screen
          </p>
        </div>

        {/* Legend */}
        <div className="flex flex-wrap items-center gap-4 text-xs text-neutral-600 dark:text-neutral-400 py-3 border-y border-neutral-200/60 dark:border-white/10">
          <div className="flex items-center gap-1.5">
            <div className="w-4 h-4 rounded-lg bg-emerald-500/20 border border-emerald-500 text-emerald-700 flex items-center justify-center font-bold text-[10px]">
              ✓
            </div>
            <span>Answer Saved</span>
          </div>

          <div className="flex items-center gap-1.5">
            <div className="w-4 h-4 rounded-lg bg-[#013F32] dark:bg-[#E7FE25] text-white dark:text-[#161616] flex items-center justify-center font-bold text-[10px] animate-pulse">
              ●
            </div>
            <span>Currently Viewing</span>
          </div>

          <div className="flex items-center gap-1.5">
            <div className="w-4 h-4 rounded-lg border border-neutral-300 dark:border-white/20 bg-neutral-100 dark:bg-white/5" />
            <span>Unanswered</span>
          </div>
        </div>

        {/* Matrix Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-8 gap-3">
          {detail.questions.map((q) => {
            return (
              <div
                key={q.question_id}
                className={`p-3 rounded-2xl border text-center transition-all ${
                  q.is_current
                    ? 'ring-2 ring-[#013F32] dark:ring-[#E7FE25] bg-[#013F32]/10 dark:bg-[#E7FE25]/15 border-[#013F32] dark:border-[#E7FE25]'
                    : q.is_answered
                      ? 'bg-emerald-500/10 border-emerald-500/30'
                      : 'bg-neutral-50 dark:bg-white/[0.02] border-neutral-200 dark:border-white/10'
                }`}
              >
                <div className="flex items-center justify-between text-[11px] font-mono text-neutral-400 mb-1">
                  <span>Q{q.display_order}</span>
                  {q.is_current && (
                    <span className="w-2 h-2 rounded-full bg-[#013F32] dark:bg-[#E7FE25] animate-ping" />
                  )}
                </div>

                <div className="my-1">
                  {q.is_answered ? (
                    <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700 dark:text-[#E7FE25]">
                      <CheckCircle2 className="w-4 h-4" />
                      <span>Saved</span>
                    </span>
                  ) : (
                    <span className="text-xs text-neutral-400 font-medium">Pending</span>
                  )}
                </div>

                <div className="text-[10px] text-neutral-400 mt-1">
                  {q.marks} {q.marks === 1 ? 'mark' : 'marks'}
                </div>
              </div>
            );
          })}
        </div>
      </GlassCard>
    </div>
  );
}
