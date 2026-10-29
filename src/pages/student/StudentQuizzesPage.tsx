import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BookOpen,
  Clock,
  Search,
  Filter,
  ArrowRight,
  PlayCircle,
  CheckCircle2,
  Lock,
  Hourglass,
} from 'lucide-react';
import { apiRequest } from '../../lib/api.ts';
import { StudentEligibleExam, StartOrResumeAttemptResult } from '../../types/frontend.ts';
import { GlassCard } from '../../components/common/GlassCard.tsx';
import { useNotification } from '../../components/common/GlobalNotification.tsx';

export function StudentQuizzesPage() {
  const navigate = useNavigate();
  const { error: notifyError } = useNotification();

  const [exams, setExams] = useState<StudentEligibleExam[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [startingExamId, setStartingExamId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function loadExams() {
      try {
        const data = await apiRequest<StudentEligibleExam[]>('/student/exams');
        if (active) setExams(data || []);
      } catch (err) {
        console.error('Failed to load eligible exams:', err);
      } finally {
        if (active) setLoading(false);
      }
    }

    loadExams();
    return () => {
      active = false;
    };
  }, []);

  async function handleStartOrResumeExam(exam: StudentEligibleExam) {
    if (exam.active_attempt_id) {
      navigate(`/student/exams/${exam.active_attempt_id}`);
      return;
    }

    setStartingExamId(exam.id);
    try {
      const res = await apiRequest<StartOrResumeAttemptResult>(
        `/student/exams/${exam.id}/attempts`,
        { method: 'POST' }
      );
      navigate(`/student/exams/${res.attempt_id}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unable to start examination attempt.';
      notifyError(msg, 'Start Exam Failed');
    } finally {
      setStartingExamId(null);
    }
  }

  const filteredExams = exams.filter((exam) => {
    const matchesSearch =
      exam.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (exam.description && exam.description.toLowerCase().includes(searchQuery.toLowerCase()));

    if (!matchesSearch) return false;

    if (statusFilter === 'available') {
      return exam.availability_state === 'available';
    }
    if (statusFilter === 'in_progress') {
      return exam.availability_state === 'in_progress';
    }
    if (statusFilter === 'cooldown') {
      return exam.availability_state === 'cooldown';
    }
    return true;
  });

  return (
    <div className="space-y-8 animate-in fade-in duration-300">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-[#161616] dark:text-[#FDFDFD]">
            Available Quizzes & Examinations
          </h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
            Browse all assessments assigned to your cohort, review rules, and begin attempts
          </p>
        </div>
      </div>

      {/* Search & Filter Toolbar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search quizzes by title or keywords..."
            className="w-full h-11 pl-10 pr-4 rounded-2xl glass-panel text-sm text-[#161616] dark:text-[#FDFDFD] placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-[#013F32] dark:focus:ring-[#E7FE25]"
          />
        </div>

        <div className="flex items-center gap-1.5 p-1 bg-neutral-100 dark:bg-white/5 rounded-2xl border border-neutral-200/60 dark:border-white/10 shrink-0">
          <button
            onClick={() => setStatusFilter('all')}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition ${
              statusFilter === 'all'
                ? 'bg-white dark:bg-[#1E211F] text-[#161616] dark:text-[#FDFDFD] shadow-sm'
                : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white'
            }`}
          >
            All ({exams.length})
          </button>
          <button
            onClick={() => setStatusFilter('available')}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition ${
              statusFilter === 'available'
                ? 'bg-white dark:bg-[#1E211F] text-emerald-700 dark:text-[#E7FE25] shadow-sm'
                : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white'
            }`}
          >
            Available
          </button>
          <button
            onClick={() => setStatusFilter('in_progress')}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition ${
              statusFilter === 'in_progress'
                ? 'bg-white dark:bg-[#1E211F] text-teal-700 dark:text-teal-300 shadow-sm'
                : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white'
            }`}
          >
            In Progress
          </button>
        </div>
      </div>

      {/* Quizzes Grid */}
      {loading ? (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <div key={n} className="h-56 rounded-3xl bg-neutral-200/50 dark:bg-white/5 animate-pulse" />
          ))}
        </div>
      ) : filteredExams.length === 0 ? (
        <GlassCard className="text-center py-16">
          <BookOpen className="w-12 h-12 mx-auto text-neutral-400 mb-3" />
          <h2 className="text-base font-semibold text-[#161616] dark:text-[#FDFDFD]">
            No quizzes match your filters
          </h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 max-w-sm mx-auto mt-1">
            Try adjusting your search terms or clearing the filter.
          </p>
        </GlassCard>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredExams.map((exam) => {
            const isResume = exam.availability_state === 'in_progress' && exam.active_attempt_id;
            const isCooldown = exam.availability_state === 'cooldown';
            const isExhausted = exam.availability_state === 'attempts_exhausted';
            const isClosed = exam.availability_state === 'closed';
            const isStarting = startingExamId === exam.id;

            return (
              <GlassCard key={exam.id} hoverEffect className="flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between gap-2 mb-3">
                    <span className="text-[11px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-lg bg-teal-500/10 text-teal-700 dark:text-[#E7FE25] dark:bg-[#E7FE25]/10 flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      <span>{exam.duration_minutes} Mins</span>
                    </span>

                    {isResume ? (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-700 dark:text-[#E7FE25] animate-pulse">
                        Active Attempt
                      </span>
                    ) : isCooldown ? (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-700 dark:text-amber-400 flex items-center gap-1">
                        <Hourglass className="w-3 h-3" />
                        <span>Cooldown</span>
                      </span>
                    ) : isExhausted ? (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-neutral-200 dark:bg-white/10 text-neutral-600 dark:text-neutral-400">
                        Max Attempts Met
                      </span>
                    ) : isClosed ? (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-rose-500/10 text-rose-700 dark:text-rose-400 flex items-center gap-1">
                        <Lock className="w-3 h-3" />
                        <span>Closed</span>
                      </span>
                    ) : (
                      <span className="text-xs text-neutral-500 font-medium">
                        Pass: {exam.passing_percentage}%
                      </span>
                    )}
                  </div>

                  <h2 className="font-bold text-base text-[#161616] dark:text-[#FDFDFD] line-clamp-2">
                    {exam.title}
                  </h2>

                  {exam.description && (
                    <p className="text-xs text-neutral-600 dark:text-neutral-400 line-clamp-2 mt-2 leading-relaxed">
                      {exam.description}
                    </p>
                  )}
                </div>

                <div className="mt-6 pt-4 border-t border-neutral-200/70 dark:border-white/10 flex items-center justify-between gap-3">
                  <div className="text-xs text-neutral-500 dark:text-neutral-400">
                    <span className="font-semibold text-[#161616] dark:text-[#FDFDFD]">
                      {exam.attempts_used}
                    </span>{' '}
                    / {exam.max_attempts} attempts
                  </div>

                  {isClosed || isExhausted ? (
                    <button
                      disabled
                      className="px-3.5 py-1.5 rounded-xl text-xs font-semibold bg-neutral-200 dark:bg-white/10 text-neutral-400 cursor-not-allowed"
                    >
                      {isClosed ? 'Exam Closed' : 'Exhausted'}
                    </button>
                  ) : isCooldown ? (
                    <button
                      onClick={() => navigate(`/student/quizzes/${exam.id}`)}
                      className="px-3.5 py-1.5 rounded-xl text-xs font-semibold glass-panel text-amber-700 dark:text-amber-400 hover:border-amber-500"
                    >
                      View Cooldown
                    </button>
                  ) : (
                    <button
                      onClick={() => handleStartOrResumeExam(exam)}
                      disabled={isStarting}
                      className={`px-4 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5 shadow-sm transition ${
                        isResume
                          ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                          : 'bg-[#013F32] dark:bg-[#E7FE25] text-white dark:text-[#161616] hover:opacity-90'
                      }`}
                    >
                      <span>
                        {isStarting
                          ? 'Starting...'
                          : isResume
                            ? 'Resume'
                            : 'Start Exam'}
                      </span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </GlassCard>
            );
          })}
        </div>
      )}
    </div>
  );
}
