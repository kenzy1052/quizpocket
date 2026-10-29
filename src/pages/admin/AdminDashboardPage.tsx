import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  BarChart3,
  TrendingUp,
  CheckCircle2,
  Users,
  Award,
  AlertCircle,
  HelpCircle,
  ArrowRight,
  Filter,
} from 'lucide-react';
import { apiRequest } from '../../lib/api.ts';
import {
  ExamListItem,
  ExamStatistics,
  QuestionAnalyticsRow,
  ClassPerformanceRow,
} from '../../types/frontend.ts';
import { GlassCard } from '../../components/common/GlassCard.tsx';

export function AdminDashboardPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedExamId = searchParams.get('exam_id') || '';

  const [exams, setExams] = useState<ExamListItem[]>([]);
  const [stats, setStats] = useState<ExamStatistics | null>(null);
  const [questionAnalytics, setQuestionAnalytics] = useState<QuestionAnalyticsRow[]>([]);
  const [classSummary, setClassSummary] = useState<ClassPerformanceRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Load available exams
  useEffect(() => {
    let active = true;

    async function loadExams() {
      try {
        const data = await apiRequest<ExamListItem[]>('/admin/exams');
        if (!active) return;
        setExams(data || []);
        if (data && data.length > 0 && !selectedExamId) {
          setSearchParams({ exam_id: data[0].id });
        }
      } catch (err) {
        console.error('Failed to load exams list for dashboard:', err);
      } finally {
        if (active) setLoading(false);
      }
    }

    loadExams();
    return () => {
      active = false;
    };
  }, [selectedExamId, setSearchParams]);

  // Load stats for chosen exam
  useEffect(() => {
    if (!selectedExamId) return;
    let active = true;

    async function loadStats() {
      try {
        const [statsData, qData, cData] = await Promise.all([
          apiRequest<ExamStatistics>(`/admin/exams/${selectedExamId}/statistics`).catch(() => null),
          apiRequest<QuestionAnalyticsRow[]>(`/admin/exams/${selectedExamId}/question-analytics`).catch(() => []),
          apiRequest<ClassPerformanceRow[]>(`/admin/exams/${selectedExamId}/class-summary`).catch(() => []),
        ]);
        if (active) {
          setStats(statsData);
          setQuestionAnalytics(qData || []);
          setClassSummary(cData || []);
        }
      } catch (err) {
        console.error('Failed to load exam statistics:', err);
      }
    }

    loadStats();
    return () => {
      active = false;
    };
  }, [selectedExamId]);

  return (
    <div className="space-y-8 animate-in fade-in duration-300">
      {/* Header & Exam Selector */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-[#161616] dark:text-[#FDFDFD]">
            Institutional Analytics Dashboard
          </h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
            Data-focused metrics, question difficulty distributions, and cohort pass rates
          </p>
        </div>

        {/* Dropdown to switch exam */}
        <select
          value={selectedExamId}
          onChange={(e) => setSearchParams({ exam_id: e.target.value })}
          className="h-11 px-4 rounded-2xl glass-panel text-sm font-semibold text-[#161616] dark:text-[#FDFDFD] focus:outline-none focus:ring-2 focus:ring-[#013F32] dark:focus:ring-[#E7FE25] self-start sm:self-auto"
        >
          {exams.map((ex) => (
            <option key={ex.id} value={ex.id}>
              {ex.title}
            </option>
          ))}
        </select>
      </div>

      {/* KPI Cards */}
      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-5">
          <GlassCard className="p-4 sm:p-5">
            <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">
              Average Score
            </span>
            <div className="mt-2 font-mono text-2xl sm:text-3xl font-bold text-[#161616] dark:text-[#FDFDFD]">
              {stats.average_marks ?? stats.average_score ?? 0} <span className="text-sm font-normal text-neutral-400">/ {stats.total_marks}</span>
            </div>
            <div className="text-xs font-bold text-emerald-700 dark:text-[#E7FE25] mt-1">
              {stats.average_percentage}% Average
            </div>
          </GlassCard>

          <GlassCard className="p-4 sm:p-5">
            <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">
              Pass Rate
            </span>
            <div className="mt-2 font-mono text-2xl sm:text-3xl font-bold text-[#161616] dark:text-[#FDFDFD]">
              {stats.pass_rate_percentage ?? stats.pass_rate ?? 0}%
            </div>
            <p className="text-[11px] text-neutral-500 mt-1">Threshold: {stats.passing_percentage}%</p>
          </GlassCard>

          <GlassCard className="p-4 sm:p-5">
            <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">
              Completion Rate
            </span>
            <div className="mt-2 font-mono text-2xl sm:text-3xl font-bold text-[#161616] dark:text-[#FDFDFD]">
              {stats.completion_rate_percentage ?? stats.completion_rate ?? 0}%
            </div>
            <p className="text-[11px] text-neutral-500 mt-1">
              {stats.completed_attempts ?? ((stats.submitted_count ?? 0) + (stats.auto_submitted_count ?? 0))} of {stats.assigned_students_count || stats.total_attempts || 0}
            </p>
          </GlassCard>

          <GlassCard className="p-4 sm:p-5">
            <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">
              Score Range
            </span>
            <div className="mt-2 font-mono text-2xl sm:text-3xl font-bold text-[#161616] dark:text-[#FDFDFD]">
              {stats.lowest_marks ?? stats.lowest_score ?? 0} - {stats.highest_marks ?? stats.highest_score ?? 0}
            </div>
            <p className="text-[11px] text-neutral-500 mt-1">Min / Max achieved marks</p>
          </GlassCard>
        </div>
      )}

      {/* Cohort Class Performance Breakdown */}
      {classSummary.length > 0 && (
        <GlassCard className="p-6">
          <h2 className="text-lg font-bold text-[#161616] dark:text-[#FDFDFD] mb-4">
            Cohort Class Performance
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs sm:text-sm">
              <thead>
                <tr className="border-b border-neutral-200/70 dark:border-white/10 text-neutral-500 uppercase tracking-wider text-[11px]">
                  <th className="pb-3 pl-2">Cohort Name</th>
                  <th className="pb-3 text-center">Active Students</th>
                  <th className="pb-3 text-center">Completed Attempts</th>
                  <th className="pb-3 text-right">Average %</th>
                  <th className="pb-3 text-right pr-2">Pass Rate %</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-200/50 dark:divide-white/5">
                {classSummary.map((c) => (
                  <tr key={c.class_id}>
                    <td className="py-3 pl-2 font-medium text-[#161616] dark:text-[#FDFDFD]">
                      {c.class_name}
                    </td>
                    <td className="py-3 text-center font-mono">{c.active_students}</td>
                    <td className="py-3 text-center font-mono">{c.completed_attempts}</td>
                    <td className="py-3 text-right font-mono font-bold text-emerald-700 dark:text-[#E7FE25]">
                      {Math.round(c.average_percentage)}%
                    </td>
                    <td className="py-3 text-right pr-2 font-mono font-bold">
                      {Math.round(c.pass_rate_percentage)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </GlassCard>
      )}

      {/* Question Difficulty & Analytics */}
      <GlassCard className="p-6">
        <h2 className="text-lg font-bold text-[#161616] dark:text-[#FDFDFD] mb-4">
          Question Difficulty Analytics
        </h2>

        {questionAnalytics.length === 0 ? (
          <p className="text-xs text-neutral-500">No question evaluations recorded yet for this exam.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs sm:text-sm">
              <thead>
                <tr className="border-b border-neutral-200/70 dark:border-white/10 text-neutral-500 uppercase tracking-wider text-[11px]">
                  <th className="pb-3 pl-2">#</th>
                  <th className="pb-3">Question Prompt</th>
                  <th className="pb-3 text-center">Evaluated</th>
                  <th className="pb-3 text-center">Correct %</th>
                  <th className="pb-3 text-center">Avg Marks</th>
                  <th className="pb-3 text-right pr-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-200/50 dark:divide-white/5">
                {questionAnalytics.map((qa) => (
                  <tr key={qa.question_id}>
                    <td className="py-3 pl-2 font-mono text-neutral-400">Q{qa.display_order}</td>
                    <td className="py-3 font-medium text-[#161616] dark:text-[#FDFDFD] max-w-xs truncate">
                      {qa.question_text}
                    </td>
                    <td className="py-3 text-center font-mono">{qa.total_evaluated}</td>
                    <td className="py-3 text-center font-mono font-bold text-[#161616] dark:text-[#FDFDFD]">
                      {Math.round(qa.correct_percentage)}%
                    </td>
                    <td className="py-3 text-center font-mono">
                      {qa.average_marks_awarded} / {qa.marks}
                    </td>
                    <td className="py-3 text-right pr-2">
                      {qa.commonly_missed ? (
                        <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-rose-500/10 text-rose-700 dark:text-rose-400">
                          Commonly Missed
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-emerald-500/10 text-emerald-700 dark:text-[#E7FE25]">
                          High Mastery
                        </span>
                      )}
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
