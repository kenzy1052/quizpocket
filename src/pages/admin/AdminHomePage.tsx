import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ShieldCheck,
  Activity,
  PlusCircle,
  Users,
  Award,
  BookOpen,
  ArrowRight,
  Clock,
  Sparkles,
  BarChart3,
  AlertCircle,
  CheckCircle2,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext.tsx';
import { apiRequest } from '../../lib/api.ts';
import { ExamListItem, LiveMonitoringAttempt } from '../../types/frontend.ts';
import { GlassCard } from '../../components/common/GlassCard.tsx';

function getTimeGreeting(name: string): string {
  const hour = new Date().getHours();
  let greeting = 'Hello';
  if (hour < 12) greeting = 'Good morning';
  else if (hour < 17) greeting = 'Good afternoon';
  else greeting = 'Good evening';
  return `${greeting}, ${name || 'Administrator'}`;
}

export function AdminHomePage() {
  const { profile } = useAuth();
  const navigate = useNavigate();

  const [exams, setExams] = useState<ExamListItem[]>([]);
  const [liveAttempts, setLiveAttempts] = useState<LiveMonitoringAttempt[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    async function loadControlCenter() {
      try {
        const [examsData, liveData] = await Promise.all([
          apiRequest<ExamListItem[]>('/admin/exams'),
          apiRequest<LiveMonitoringAttempt[]>('/admin/monitoring/live').catch(() => []),
        ]);
        if (active) {
          setExams(examsData || []);
          setLiveAttempts(liveData || []);
        }
      } catch (err) {
        console.error('Failed to load admin control center data:', err);
      } finally {
        if (active) setLoading(false);
      }
    }

    loadControlCenter();
    return () => {
      active = false;
    };
  }, []);

  const activeInProgCount = liveAttempts.filter((a) => a.is_active).length;
  const publishedExams = exams.filter((e) => e.status === 'published');
  const openExams = publishedExams.filter((e) => e.is_open);

  const greeting = getTimeGreeting(profile?.full_name || profile?.username || 'kenzy');

  return (
    <div className="space-y-8 animate-in fade-in duration-300">
      {/* Hero Welcome Banner */}
      <div className="dashboard-hero rounded-3xl p-6 sm:p-10 border border-neutral-200/80 dark:border-white/10 shadow-lg relative overflow-hidden">
        <div className="relative z-10 max-w-2xl">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#013F32]/10 dark:bg-[#E7FE25]/15 text-[#013F32] dark:text-[#E7FE25] text-xs font-semibold uppercase tracking-wider mb-3">
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>Examination Control Center</span>
          </div>

          <h1 className="font-display text-2xl sm:text-4xl font-bold tracking-tight text-[#161616] dark:text-[#FDFDFD]">
            {greeting}
          </h1>

          <p className="mt-2.5 text-sm sm:text-base text-neutral-600 dark:text-neutral-300 leading-relaxed">
            Welcome to the QuizPocket operations command. Monitor active student examinations in real time, oversee quiz configurations, and maintain integrity across your institution.
          </p>

          <div className="mt-6 flex flex-wrap gap-3">
            <button
              onClick={() => navigate('/admin/monitoring')}
              className="px-5 py-2.5 rounded-2xl bg-[#013F32] hover:bg-[#025342] dark:bg-[#E7FE25] dark:hover:bg-[#d8f01c] text-white dark:text-[#161616] text-xs sm:text-sm font-bold flex items-center gap-2 shadow-md hover:shadow-lg transition-all"
            >
              <Activity className="w-4 h-4 animate-pulse" />
              <span>Launch Live Monitor ({activeInProgCount} Active)</span>
              <ArrowRight className="w-4 h-4" />
            </button>

            <button
              onClick={() => navigate('/admin/dashboard')}
              className="px-4 py-2.5 rounded-2xl glass-panel text-[#161616] dark:text-[#FDFDFD] text-xs sm:text-sm font-semibold hover:border-[#013F32] dark:hover:border-[#E7FE25] transition"
            >
              <span>Analytics Dashboard</span>
            </button>
          </div>
        </div>
      </div>

      {/* Operational KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-5">
        <GlassCard hoverEffect className="p-4 sm:p-5 cursor-pointer" onClick={() => navigate('/admin/monitoring')}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">
              Live In-Progress
            </span>
            <div className="w-8 h-8 rounded-xl bg-emerald-500/10 dark:bg-[#E7FE25]/20 text-emerald-600 dark:text-[#E7FE25] flex items-center justify-center">
              <Activity className="w-4 h-4 animate-pulse" />
            </div>
          </div>
          <div className="mt-3 font-mono text-2xl sm:text-3xl font-bold text-[#161616] dark:text-[#FDFDFD]">
            {activeInProgCount}
          </div>
          <p className="text-[11px] text-neutral-500 mt-1">Students actively taking exams</p>
        </GlassCard>

        <GlassCard hoverEffect className="p-4 sm:p-5 cursor-pointer" onClick={() => navigate('/admin/quizzes')}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">
              Published Quizzes
            </span>
            <div className="w-8 h-8 rounded-xl bg-teal-500/10 text-teal-700 dark:text-teal-300 flex items-center justify-center">
              <BookOpen className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3 font-mono text-2xl sm:text-3xl font-bold text-[#161616] dark:text-[#FDFDFD]">
            {publishedExams.length}
          </div>
          <p className="text-[11px] text-neutral-500 mt-1">{openExams.length} currently open for attempts</p>
        </GlassCard>

        <GlassCard hoverEffect className="p-4 sm:p-5 cursor-pointer" onClick={() => navigate('/admin/students')}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">
              Cohort Directory
            </span>
            <div className="w-8 h-8 rounded-xl bg-[#013F32]/10 dark:bg-[#E7FE25]/15 text-[#013F32] dark:text-[#E7FE25] flex items-center justify-center">
              <Users className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3 font-mono text-2xl sm:text-3xl font-bold text-[#161616] dark:text-[#FDFDFD]">
            Active
          </div>
          <p className="text-[11px] text-neutral-500 mt-1">Manage accounts & credentials</p>
        </GlassCard>

        <GlassCard hoverEffect className="p-4 sm:p-5 cursor-pointer" onClick={() => navigate('/admin/results')}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">
              Exports & Grades
            </span>
            <div className="w-8 h-8 rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-300 flex items-center justify-center">
              <Award className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3 font-mono text-2xl sm:text-3xl font-bold text-[#161616] dark:text-[#FDFDFD]">
            CSV
          </div>
          <p className="text-[11px] text-neutral-500 mt-1">Audit reports & formula sanitization</p>
        </GlassCard>
      </div>

      {/* Quick Operations Toolbar */}
      <div className="space-y-4">
        <h2 className="text-lg font-bold text-[#161616] dark:text-[#FDFDFD]">
          Common Administrative Actions
        </h2>

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <button
            onClick={() => navigate('/admin/quizzes')}
            className="p-5 rounded-3xl glass-card text-left flex flex-col justify-between hover:border-[#013F32] dark:hover:border-[#E7FE25]"
          >
            <div className="w-10 h-10 rounded-2xl bg-[#013F32]/10 dark:bg-[#E7FE25]/20 text-[#013F32] dark:text-[#E7FE25] flex items-center justify-center mb-3">
              <PlusCircle className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-[#161616] dark:text-[#FDFDFD]">Create New Quiz</h3>
              <p className="text-xs text-neutral-500 mt-1">Author questions, rubrics, and durations</p>
            </div>
          </button>

          <button
            onClick={() => navigate('/admin/monitoring')}
            className="p-5 rounded-3xl glass-card text-left flex flex-col justify-between hover:border-emerald-500"
          >
            <div className="w-10 h-10 rounded-2xl bg-emerald-500/10 text-emerald-600 dark:text-[#E7FE25] flex items-center justify-center mb-3">
              <Activity className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-[#161616] dark:text-[#FDFDFD]">Live Monitor Center</h3>
              <p className="text-xs text-neutral-500 mt-1">Watch student answers in real-time</p>
            </div>
          </button>

          <button
            onClick={() => navigate('/admin/students')}
            className="p-5 rounded-3xl glass-card text-left flex flex-col justify-between hover:border-[#013F32] dark:hover:border-[#E7FE25]"
          >
            <div className="w-10 h-10 rounded-2xl bg-teal-500/10 text-teal-700 dark:text-teal-300 flex items-center justify-center mb-3">
              <Users className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-[#161616] dark:text-[#FDFDFD]">Enroll Students</h3>
              <p className="text-xs text-neutral-500 mt-1">Create accounts and assign cohorts</p>
            </div>
          </button>

          <button
            onClick={() => navigate('/admin/results')}
            className="p-5 rounded-3xl glass-card text-left flex flex-col justify-between hover:border-amber-500"
          >
            <div className="w-10 h-10 rounded-2xl bg-amber-500/10 text-amber-600 dark:text-amber-300 flex items-center justify-center mb-3">
              <Award className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-[#161616] dark:text-[#FDFDFD]">Grade Management</h3>
              <p className="text-xs text-neutral-500 mt-1">Manual score adjustments & CSV export</p>
            </div>
          </button>
        </div>
      </div>

      {/* Active Running Examinations Status List */}
      <GlassCard className="p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-[#161616] dark:text-[#FDFDFD]">
              Active Institutional Quizzes
            </h2>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Published assessments available to enrolled cohorts
            </p>
          </div>

          <button
            onClick={() => navigate('/admin/quizzes')}
            className="text-xs font-semibold text-[#013F32] dark:text-[#E7FE25] hover:underline flex items-center gap-1"
          >
            <span>Manage All Quizzes</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>

        {publishedExams.length === 0 ? (
          <div className="text-center py-8 text-neutral-400 text-xs">
            No published quizzes found. Create or publish a quiz from the quiz manager.
          </div>
        ) : (
          <div className="divide-y divide-neutral-200/60 dark:divide-white/5">
            {publishedExams.map((exam) => (
              <div key={exam.id} className="py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold text-sm text-[#161616] dark:text-[#FDFDFD] truncate">
                      {exam.title}
                    </h3>
                    <span
                      className={`px-2 py-0.5 rounded-md text-[10px] font-bold uppercase ${
                        exam.is_open
                          ? 'bg-emerald-500/10 text-emerald-700 dark:text-[#E7FE25]'
                          : 'bg-rose-500/10 text-rose-700 dark:text-rose-400'
                      }`}
                    >
                      {exam.is_open ? 'Open' : 'Closed'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-neutral-500 mt-0.5">
                    <span>{exam.duration_minutes} Mins</span>
                    <span>·</span>
                    <span>Passing: {exam.passing_percentage}%</span>
                    <span>·</span>
                    <span>Retake Cooldown: {exam.retake_cooldown_minutes}m</span>
                  </div>
                </div>

                <div className="flex items-center gap-2 self-start sm:self-auto shrink-0">
                  <button
                    onClick={() => navigate(`/admin/monitoring?exam_id=${exam.id}`)}
                    className="px-3 py-1.5 rounded-xl glass-panel text-xs font-bold text-emerald-700 dark:text-[#E7FE25] hover:border-emerald-500 flex items-center gap-1"
                  >
                    <Activity className="w-3 h-3" />
                    <span>Monitor</span>
                  </button>
                  <button
                    onClick={() => navigate(`/admin/quizzes/${exam.id}`)}
                    className="px-3 py-1.5 rounded-xl glass-panel text-xs font-semibold hover:border-[#013F32] dark:hover:border-[#E7FE25]"
                  >
                    Configure
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </GlassCard>
    </div>
  );
}
