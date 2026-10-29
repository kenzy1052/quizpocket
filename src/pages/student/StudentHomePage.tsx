import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Sparkles,
  Clock,
  BookOpen,
  ArrowRight,
  CheckCircle2,
  AlertCircle,
  PlayCircle,
  TrendingUp,
  Award,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext.tsx';
import { apiRequest } from '../../lib/api.ts';
import { StudentEligibleExam, StudentReleasedResult } from '../../types/frontend.ts';
import { GlassCard } from '../../components/common/GlassCard.tsx';

function getTimeGreeting(name: string): string {
  const hour = new Date().getHours();
  let greeting = 'Hello';
  if (hour < 12) {
    greeting = 'Good morning';
  } else if (hour < 17) {
    greeting = 'Good afternoon';
  } else {
    greeting = 'Good evening';
  }
  return `${greeting}, ${name || 'Student'}`;
}

export function StudentHomePage() {
  const { profile } = useAuth();
  const navigate = useNavigate();

  const [exams, setExams] = useState<StudentEligibleExam[]>([]);
  const [results, setResults] = useState<StudentReleasedResult[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    async function loadData() {
      try {
        const [examsData, resultsData] = await Promise.all([
          apiRequest<StudentEligibleExam[]>('/student/exams'),
          apiRequest<StudentReleasedResult[]>('/student/results').catch(() => []),
        ]);
        if (active) {
          setExams(examsData || []);
          setResults(resultsData || []);
        }
      } catch (err) {
        console.error('Failed to load student home data:', err);
      } finally {
        if (active) setLoading(false);
      }
    }

    loadData();
    return () => {
      active = false;
    };
  }, []);

  const activeAttemptExam = exams.find(
    (e) => e.active_attempt_id && e.availability_state === 'in_progress'
  );

  const availableExams = exams.filter(
    (e) => e.availability_state === 'available' || e.availability_state === 'in_progress'
  );

  const displayName = profile?.full_name || profile?.username || '';
  const greeting = getTimeGreeting(displayName);

  return (
    <div className="space-y-8 animate-in fade-in duration-300">
      {/* Hero Welcome Banner */}
      <div className="dashboard-hero rounded-3xl p-6 sm:p-10 border border-neutral-200/80 dark:border-white/10 shadow-lg relative overflow-hidden">
        <div className="relative z-10 max-w-2xl">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#013F32]/10 dark:bg-[#E7FE25]/15 text-[#013F32] dark:text-[#E7FE25] text-xs font-semibold uppercase tracking-wider mb-3">
            <Sparkles className="w-3.5 h-3.5" />
            <span>Student Learning Hub</span>
          </div>

          <h1 className="font-display text-2xl sm:text-4xl font-bold tracking-tight text-[#161616] dark:text-[#FDFDFD]">
            {greeting}
          </h1>

          <p className="mt-2.5 text-sm sm:text-base text-neutral-600 dark:text-neutral-300 leading-relaxed">
            Ready to challenge yourself today? Explore your assigned examinations, track your mastery, and review instant performance breakdowns.
          </p>

          <div className="mt-6 flex flex-wrap gap-3">
            <button
              onClick={() => navigate('/student/quizzes')}
              className="px-5 py-2.5 rounded-2xl bg-[#013F32] hover:bg-[#025342] dark:bg-[#E7FE25] dark:hover:bg-[#d8f01c] text-white dark:text-[#161616] text-xs sm:text-sm font-semibold flex items-center gap-2 shadow-md hover:shadow-lg transition-all"
            >
              <BookOpen className="w-4 h-4" />
              <span>Browse All Quizzes</span>
              <ArrowRight className="w-4 h-4" />
            </button>

            <button
              onClick={() => navigate('/student/dashboard')}
              className="px-4 py-2.5 rounded-2xl glass-panel text-[#161616] dark:text-[#FDFDFD] text-xs sm:text-sm font-semibold hover:border-[#013F32] dark:hover:border-[#E7FE25] transition"
            >
              <span>View Analytics</span>
            </button>
          </div>
        </div>
      </div>

      {/* Resume Active Attempt Banner (if any) */}
      {activeAttemptExam && activeAttemptExam.active_attempt_id && (
        <div className="rounded-3xl p-5 sm:p-6 bg-gradient-to-r from-emerald-500/15 via-teal-500/10 to-transparent border border-emerald-500/30 dark:border-[#E7FE25]/40 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 shadow-sm animate-pulse">
          <div className="flex items-center gap-3.5">
            <div className="w-11 h-11 rounded-2xl bg-emerald-600 dark:bg-[#E7FE25] text-white dark:text-[#161616] flex items-center justify-center shrink-0">
              <PlayCircle className="w-6 h-6" />
            </div>
            <div>
              <span className="text-xs font-bold text-emerald-800 dark:text-[#E7FE25] uppercase tracking-wider">
                Exam In Progress
              </span>
              <h2 className="text-base sm:text-lg font-bold text-[#161616] dark:text-[#FDFDFD]">
                {activeAttemptExam.title}
              </h2>
              <p className="text-xs text-neutral-600 dark:text-neutral-300">
                You have an active timer running. Complete and submit your answers before time expires.
              </p>
            </div>
          </div>

          <button
            onClick={() => navigate(`/student/exams/${activeAttemptExam.active_attempt_id}`)}
            className="w-full sm:w-auto px-6 py-2.5 rounded-2xl bg-[#013F32] dark:bg-[#E7FE25] text-white dark:text-[#161616] font-bold text-sm shadow hover:scale-[1.02] active:scale-[0.98] transition flex items-center justify-center gap-2 whitespace-nowrap shrink-0"
          >
            <span>Resume Attempt</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Available Examinations Section */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg sm:text-xl font-bold tracking-tight text-[#161616] dark:text-[#FDFDFD]">
              Assigned Examinations
            </h2>
            <p className="text-xs sm:text-sm text-neutral-500 dark:text-neutral-400">
              Curated quizzes assigned to your student cohort
            </p>
          </div>

          <button
            onClick={() => navigate('/student/quizzes')}
            className="text-xs font-semibold text-[#013F32] dark:text-[#E7FE25] hover:underline flex items-center gap-1"
          >
            <span>View all ({exams.length})</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>

        {loading ? (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3].map((n) => (
              <div key={n} className="h-44 rounded-3xl bg-neutral-200/50 dark:bg-white/5 animate-pulse" />
            ))}
          </div>
        ) : availableExams.length === 0 ? (
          <GlassCard className="text-center py-12">
            <BookOpen className="w-10 h-10 mx-auto text-neutral-400 dark:text-neutral-500 mb-3" />
            <h3 className="text-base font-semibold text-[#161616] dark:text-[#FDFDFD]">
              No pending quizzes
            </h3>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 max-w-sm mx-auto mt-1">
              You are all caught up! Check back when new exams are assigned or review your completed scores.
            </p>
          </GlassCard>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {availableExams.slice(0, 3).map((exam) => {
              const isResume = exam.availability_state === 'in_progress' && exam.active_attempt_id;

              return (
                <GlassCard key={exam.id} hoverEffect className="flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between gap-2 mb-3">
                      <span className="text-[11px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-lg bg-teal-500/10 text-teal-700 dark:text-[#E7FE25] dark:bg-[#E7FE25]/10">
                        {exam.duration_minutes} Mins
                      </span>
                      <span className="text-xs text-neutral-500 dark:text-neutral-400 font-medium">
                        Passing: {exam.passing_percentage}%
                      </span>
                    </div>

                    <h3 className="font-bold text-base text-[#161616] dark:text-[#FDFDFD] line-clamp-2">
                      {exam.title}
                    </h3>

                    {exam.description && (
                      <p className="text-xs text-neutral-600 dark:text-neutral-400 line-clamp-2 mt-1.5 leading-relaxed">
                        {exam.description}
                      </p>
                    )}
                  </div>

                  <div className="mt-5 pt-4 border-t border-neutral-200/70 dark:border-white/10 flex items-center justify-between">
                    <span className="text-xs text-neutral-500 dark:text-neutral-400">
                      Attempts: {exam.attempts_used} / {exam.max_attempts}
                    </span>

                    <button
                      onClick={() => navigate(`/student/quizzes/${exam.id}`)}
                      className={`px-3.5 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5 transition ${
                        isResume
                          ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                          : 'bg-[#013F32] dark:bg-[#E7FE25] text-white dark:text-[#161616] hover:opacity-90'
                      }`}
                    >
                      <span>{isResume ? 'Resume' : 'Start Quiz'}</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </GlassCard>
              );
            })}
          </div>
        )}
      </div>

      {/* Recent Completed Quizzes Section */}
      {results.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg sm:text-xl font-bold tracking-tight text-[#161616] dark:text-[#FDFDFD]">
                Recently Completed
              </h2>
              <p className="text-xs sm:text-sm text-neutral-500 dark:text-neutral-400">
                Latest released scores and grading reviews
              </p>
            </div>

            <button
              onClick={() => navigate('/student/results')}
              className="text-xs font-semibold text-[#013F32] dark:text-[#E7FE25] hover:underline flex items-center gap-1"
            >
              <span>View all results</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {results.slice(0, 3).map((res) => (
              <GlassCard key={res.result_id} hoverEffect className="p-4 sm:p-5 flex items-center justify-between">
                <div className="min-w-0 pr-3">
                  <h3 className="font-semibold text-sm text-[#161616] dark:text-[#FDFDFD] truncate">
                    {res.exam_title}
                  </h3>
                  <div className="flex items-center gap-2 mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                    <span>Attempt {res.attempt_number}</span>
                    <span>·</span>
                    <span className={res.passed ? 'text-emerald-600 dark:text-[#E7FE25] font-semibold' : 'text-rose-600 font-semibold'}>
                      {res.passed ? 'Passed' : 'Needs Review'}
                    </span>
                  </div>
                </div>

                <div className="text-right shrink-0">
                  <div className="font-mono text-lg font-bold text-[#161616] dark:text-[#FDFDFD]">
                    {Math.round(res.percentage ?? 0)}%
                  </div>
                  <button
                    onClick={() => navigate(`/student/results/${res.attempt_id}`)}
                    className="text-[11px] font-bold text-[#013F32] dark:text-[#E7FE25] hover:underline"
                  >
                    Review &rarr;
                  </button>
                </div>
              </GlassCard>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
