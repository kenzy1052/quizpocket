import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Activity,
  Search,
  Filter,
  RefreshCw,
  Clock,
  User,
  ArrowRight,
  Eye,
  CheckCircle2,
  AlertTriangle,
  Radio,
  FileQuestion,
} from 'lucide-react';
import { apiRequest } from '../../lib/api.ts';
import { LiveMonitoringAttempt, ExamListItem } from '../../types/frontend.ts';
import { GlassCard } from '../../components/common/GlassCard.tsx';

function formatRemainingSeconds(sec: number): string {
  if (sec <= 0) return 'Expired';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

export function AdminLiveMonitoringPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const examIdParam = searchParams.get('exam_id') || '';

  const [attempts, setAttempts] = useState<LiveMonitoringAttempt[]>([]);
  const [exams, setExams] = useState<ExamListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'submitted'>('active');

  const fetchMonitoringData = useCallback(async (isBackground = false) => {
    if (!isBackground) setIsRefreshing(true);
    try {
      const query = examIdParam ? `?exam_id=${encodeURIComponent(examIdParam)}` : '';
      const [attemptsData, examsData] = await Promise.all([
        apiRequest<LiveMonitoringAttempt[]>(`/admin/monitoring/live${query}`),
        apiRequest<ExamListItem[]>('/admin/exams'),
      ]);
      setAttempts(attemptsData || []);
      setExams(examsData || []);
    } catch (err) {
      console.error('Failed to fetch live monitoring attempts:', err);
    } finally {
      if (!isBackground) setIsRefreshing(false);
      setLoading(false);
    }
  }, [examIdParam]);

  // Initial load
  useEffect(() => {
    fetchMonitoringData(false);
  }, [fetchMonitoringData]);

  // Live Auto-Refresh Interval (every 4 seconds)
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      fetchMonitoringData(true);
    }, 4000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchMonitoringData]);

  const filteredAttempts = attempts.filter((att) => {
    const matchesSearch =
      att.student_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      att.exam_title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (att.student_identifier && att.student_identifier.toLowerCase().includes(searchQuery.toLowerCase()));

    if (!matchesSearch) return false;

    if (statusFilter === 'active') return att.is_active;
    if (statusFilter === 'submitted') return !att.is_active;
    return true;
  });

  const activeCount = attempts.filter((a) => a.is_active).length;

  return (
    <div className="space-y-8 animate-in fade-in duration-300">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-[#161616] dark:text-[#FDFDFD]">
              Live Examination Monitor
            </h1>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-700 dark:text-[#E7FE25] dark:bg-[#E7FE25]/15 text-xs font-bold uppercase tracking-wider animate-pulse">
              <span className="w-2 h-2 rounded-full bg-emerald-500 dark:bg-[#E7FE25]" />
              <span>Real-Time ({activeCount} Active)</span>
            </span>
          </div>
          <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
            Observe student question navigation, progress completion, and countdown deadlines as they happen
          </p>
        </div>

        {/* Toolbar Controls */}
        <div className="flex items-center gap-2.5 self-start sm:self-auto">
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 border transition ${
              autoRefresh
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-[#E7FE25]'
                : 'glass-panel text-neutral-500'
            }`}
          >
            <Radio className={`w-3.5 h-3.5 ${autoRefresh ? 'animate-pulse text-emerald-500 dark:text-[#E7FE25]' : ''}`} />
            <span>{autoRefresh ? 'Live Polling Active' : 'Polling Paused'}</span>
          </button>

          <button
            onClick={() => fetchMonitoringData(false)}
            disabled={isRefreshing}
            className="p-2 rounded-xl glass-panel text-neutral-600 dark:text-neutral-300 hover:border-[#013F32] dark:hover:border-[#E7FE25] transition"
            title="Refresh Now"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by student name or exam title..."
            className="w-full h-11 pl-10 pr-4 rounded-2xl glass-panel text-sm text-[#161616] dark:text-[#FDFDFD] placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-[#013F32] dark:focus:ring-[#E7FE25]"
          />
        </div>

        {/* Exam filter dropdown */}
        <select
          value={examIdParam}
          onChange={(e) => {
            const val = e.target.value;
            setSearchParams(val ? { exam_id: val } : {});
          }}
          className="h-11 px-3.5 rounded-2xl glass-panel text-xs sm:text-sm font-semibold text-[#161616] dark:text-[#FDFDFD] focus:outline-none focus:ring-2 focus:ring-[#013F32] dark:focus:ring-[#E7FE25]"
        >
          <option value="">All Examinations ({exams.length})</option>
          {exams.map((ex) => (
            <option key={ex.id} value={ex.id}>
              {ex.title}
            </option>
          ))}
        </select>

        {/* Status segmented tabs */}
        <div className="flex items-center gap-1 p-1 bg-neutral-100 dark:bg-white/5 rounded-2xl border border-neutral-200/60 dark:border-white/10 shrink-0">
          <button
            onClick={() => setStatusFilter('active')}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition ${
              statusFilter === 'active'
                ? 'bg-white dark:bg-[#1E211F] text-emerald-700 dark:text-[#E7FE25] shadow-sm'
                : 'text-neutral-500 hover:text-neutral-900 dark:hover:text-white'
            }`}
          >
            Active ({activeCount})
          </button>
          <button
            onClick={() => setStatusFilter('submitted')}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition ${
              statusFilter === 'submitted'
                ? 'bg-white dark:bg-[#1E211F] text-neutral-800 dark:text-neutral-200 shadow-sm'
                : 'text-neutral-500 hover:text-neutral-900 dark:hover:text-white'
            }`}
          >
            Completed
          </button>
          <button
            onClick={() => setStatusFilter('all')}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition ${
              statusFilter === 'all'
                ? 'bg-white dark:bg-[#1E211F] text-[#161616] dark:text-[#FDFDFD] shadow-sm'
                : 'text-neutral-500 hover:text-neutral-900 dark:hover:text-white'
            }`}
          >
            All ({attempts.length})
          </button>
        </div>
      </div>

      {/* Monitoring List */}
      {loading ? (
        <div className="space-y-4">
          {[1, 2, 3, 4].map((n) => (
            <div key={n} className="h-24 rounded-3xl bg-neutral-200/50 dark:bg-white/5 animate-pulse" />
          ))}
        </div>
      ) : filteredAttempts.length === 0 ? (
        <GlassCard className="text-center py-16">
          <Activity className="w-12 h-12 mx-auto text-neutral-400 mb-3" />
          <h2 className="text-base font-semibold text-[#161616] dark:text-[#FDFDFD]">
            No examination attempts found
          </h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 max-w-sm mx-auto mt-1">
            {statusFilter === 'active'
              ? 'There are currently no students actively taking examinations matching your search.'
              : 'No examination records match your current filter.'}
          </p>
        </GlassCard>
      ) : (
        <div className="space-y-4">
          {filteredAttempts.map((att) => {
            const pct =
              att.total_questions > 0
                ? Math.round((att.answered_questions / att.total_questions) * 100)
                : 0;

            const isLowTime = att.is_active && att.seconds_remaining <= 180;

            return (
              <GlassCard
                key={att.attempt_id}
                hoverEffect
                className="p-5 sm:p-6 transition-all"
              >
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-5">
                  {/* Student & Exam Info */}
                  <div className="flex items-start gap-4 min-w-0">
                    <div className="w-12 h-12 rounded-2xl bg-[#013F32] dark:bg-[#E7FE25] text-white dark:text-[#161616] font-display text-lg font-bold flex items-center justify-center shrink-0 uppercase shadow-sm">
                      {att.student_name[0]}
                    </div>

                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="font-bold text-base text-[#161616] dark:text-[#FDFDFD] truncate">
                          {att.student_name}
                        </h3>
                        {att.is_active ? (
                          <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-emerald-500/10 text-emerald-700 dark:text-[#E7FE25] border border-emerald-500/20 animate-pulse">
                            IN PROGRESS
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-neutral-200 dark:bg-white/10 text-neutral-600 dark:text-neutral-400">
                            {att.status.toUpperCase()}
                          </span>
                        )}
                      </div>

                      <p className="text-xs text-neutral-600 dark:text-neutral-300 font-medium truncate mt-0.5">
                        {att.exam_title} · Attempt #{att.attempt_number}
                      </p>

                      <div className="flex items-center gap-3 text-xs text-neutral-400 mt-1">
                        <span>Started: {new Date(att.started_at).toLocaleTimeString()}</span>
                        <span>·</span>
                        <span>Last Active: {new Date(att.last_activity_at).toLocaleTimeString()}</span>
                      </div>
                    </div>
                  </div>

                  {/* Progress & Current Question Telemetry */}
                  <div className="flex-1 max-w-md w-full space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-neutral-600 dark:text-neutral-300">
                        Answer Progress ({att.answered_questions} / {att.total_questions})
                      </span>
                      <span className="font-mono font-bold text-[#013F32] dark:text-[#E7FE25]">
                        {pct}%
                      </span>
                    </div>

                    {/* Progress Bar */}
                    <div className="h-2 w-full rounded-full bg-neutral-200 dark:bg-white/10 overflow-hidden">
                      <div
                        className="h-full bg-[#013F32] dark:bg-[#E7FE25] transition-all duration-500 rounded-full"
                        style={{ width: `${pct}%` }}
                      />
                    </div>

                    <div className="flex items-center justify-between text-[11px] text-neutral-400">
                      <span>Currently Viewing: Question {att.current_question_index + 1}</span>
                      <span className="capitalize">{att.status}</span>
                    </div>
                  </div>

                  {/* Time Remaining & Individual Monitor Button */}
                  <div className="flex items-center justify-between lg:justify-end gap-4 shrink-0 pt-3 lg:pt-0 border-t lg:border-t-0 border-neutral-200/60 dark:border-white/10">
                    <div className="text-left lg:text-right">
                      <span className="text-[10px] uppercase font-bold tracking-wider text-neutral-400">
                        {att.is_active ? 'Time Left' : 'Submitted'}
                      </span>
                      <div
                        className={`font-mono text-base font-bold tabular-nums ${
                          isLowTime
                            ? 'text-rose-600 dark:text-rose-400 animate-pulse'
                            : 'text-[#161616] dark:text-[#FDFDFD]'
                        }`}
                      >
                        {att.is_active ? formatRemainingSeconds(att.seconds_remaining) : 'Completed'}
                      </div>
                    </div>

                    <button
                      onClick={() => navigate(`/admin/monitoring/${att.attempt_id}`)}
                      className="px-4 py-2 rounded-2xl bg-[#013F32] dark:bg-[#E7FE25] text-white dark:text-[#161616] font-bold text-xs flex items-center gap-1.5 shadow hover:scale-[1.02] active:scale-[0.98] transition"
                    >
                      <Eye className="w-3.5 h-3.5" />
                      <span>Live Grid</span>
                    </button>
                  </div>
                </div>
              </GlassCard>
            );
          })}
        </div>
      )}
    </div>
  );
}
