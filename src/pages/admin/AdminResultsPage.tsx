import React, { useState, useEffect, useCallback } from 'react';
import {
  Award,
  Download,
  Search,
  Filter,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  ChevronRight,
  RefreshCw,
} from 'lucide-react';
import { apiRequest, downloadExamResultsCsv } from '../../lib/api.ts';
import { AdminExamSummary, AdminAttemptSummaryRow } from '../../types/frontend.ts';
import { GlassCard } from '../../components/common/GlassCard.tsx';
import { useNotification } from '../../components/common/GlobalNotification.tsx';
import { formatDateTime, formatMarks } from '../../lib/format.ts';

export function AdminResultsPage() {
  const { notify } = useNotification();
  const [exams, setExams] = useState<AdminExamSummary[]>([]);
  const [selectedExamId, setSelectedExamId] = useState<string>('');
  const [attempts, setAttempts] = useState<AdminAttemptSummaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingAttempts, setLoadingAttempts] = useState(false);
  const [search, setSearch] = useState('');
  const [exporting, setExporting] = useState(false);

  const loadExams = useCallback(async () => {
    try {
      setLoading(true);
      const res = await apiRequest<{ data: AdminExamSummary[] }>('/admin/exams');
      const list = res.data || [];
      setExams(list);
      if (list.length > 0 && !selectedExamId) {
        setSelectedExamId(list[0].id);
      }
    } catch (err: any) {
      notify({ type: 'error', message: err?.message || 'Failed to load quizzes.' });
    } finally {
      setLoading(false);
    }
  }, [notify, selectedExamId]);

  const loadAttempts = useCallback(async (examId: string) => {
    if (!examId) return;
    try {
      setLoadingAttempts(true);
      const res = await apiRequest<{ data: AdminAttemptSummaryRow[] }>(
        `/admin/exams/${examId}/attempts`
      );
      setAttempts(res.data || []);
    } catch (err: any) {
      notify({ type: 'error', message: err?.message || 'Failed to load examination attempts.' });
    } finally {
      setLoadingAttempts(false);
    }
  }, [notify]);

  useEffect(() => {
    loadExams();
  }, [loadExams]);

  useEffect(() => {
    if (selectedExamId) {
      loadAttempts(selectedExamId);
    }
  }, [selectedExamId, loadAttempts]);

  async function handleExportCsv() {
    if (!selectedExamId) return;
    const currentExam = exams.find((e) => e.id === selectedExamId);
    try {
      setExporting(true);
      await downloadExamResultsCsv(
        selectedExamId,
        `${(currentExam?.title || 'quiz').replace(/[^a-z0-9]/gi, '_').toLowerCase()}_results.csv`
      );
      notify({ type: 'success', title: 'Export Ready', message: 'CSV file downloaded successfully.' });
    } catch (err: any) {
      notify({ type: 'error', title: 'Export Failed', message: err?.message || 'Failed to download CSV.' });
    } finally {
      setExporting(false);
    }
  }

  const selectedExam = exams.find((e) => e.id === selectedExamId);

  const filteredAttempts = attempts.filter((att) => {
    const term = search.toLowerCase();
    return (
      (att.student_name && att.student_name.toLowerCase().includes(term)) ||
      (att.student_email && att.student_email.toLowerCase().includes(term)) ||
      (att.student_identifier && att.student_identifier.toLowerCase().includes(term))
    );
  });

  const totalSubmitted = attempts.filter((a) => a.status === 'submitted' || a.status === 'auto_submitted').length;
  const passedCount = attempts.filter((a) => a.percentage !== null && a.percentage >= (selectedExam?.passing_percentage ?? 50)).length;
  const passRate = totalSubmitted > 0 ? Math.round((passedCount / totalSubmitted) * 100) : 0;
  const avgScore = totalSubmitted > 0
    ? Math.round(attempts.reduce((acc, curr) => acc + (curr.percentage || 0), 0) / totalSubmitted)
    : 0;

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-display font-bold text-neutral-900 dark:text-white flex items-center gap-2.5">
            <Award className="w-6 h-6 text-[#013F32] dark:text-[#E7FE25]" />
            Results & CSV Export
          </h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
            Authoritative grade records, score breakdowns, and CSV export.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => selectedExamId && loadAttempts(selectedExamId)}
            className="p-2.5 rounded-xl glass-card text-neutral-600 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-white transition"
            title="Refresh attempts"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={handleExportCsv}
            disabled={exporting || attempts.length === 0}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#013F32] dark:bg-[#E7FE25] text-white dark:text-[#161616] font-semibold text-sm hover:opacity-95 transition shadow-sm disabled:opacity-50"
          >
            {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            Export Gradebook CSV
          </button>
        </div>
      </div>

      {/* Quiz Selector & Filter Bar */}
      <div className="flex flex-col sm:flex-row gap-4 items-stretch sm:items-center">
        <div className="sm:w-72">
          <label className="block text-xs font-semibold text-neutral-500 dark:text-neutral-400 mb-1">
            Select Examination
          </label>
          <select
            value={selectedExamId}
            onChange={(e) => setSelectedExamId(e.target.value)}
            className="w-full px-3.5 py-2.5 rounded-xl glass-card border border-neutral-200/80 dark:border-white/10 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-[#013F32] dark:focus:ring-[#E7FE25]"
          >
            {exams.map((ex) => (
              <option key={ex.id} value={ex.id}>
                {ex.title} ({ex.question_count} Qs)
              </option>
            ))}
          </select>
        </div>

        <div className="flex-1 sm:pt-5">
          <div className="relative">
            <Search className="w-4 h-4 text-neutral-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by student name or matric number..."
              className="w-full pl-10 pr-4 py-2.5 rounded-xl glass-card border border-neutral-200/80 dark:border-white/10 text-sm focus:outline-none focus:ring-2 focus:ring-[#013F32] dark:focus:ring-[#E7FE25]"
            />
          </div>
        </div>
      </div>

      {/* Aggregate Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <GlassCard className="p-4">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Total Attempts</span>
          <div className="text-2xl font-bold font-display text-neutral-900 dark:text-white mt-1">
            {attempts.length}
          </div>
        </GlassCard>

        <GlassCard className="p-4">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Pass Rate</span>
          <div className="text-2xl font-bold font-display text-emerald-600 dark:text-[#E7FE25] mt-1">
            {passRate}%
          </div>
        </GlassCard>

        <GlassCard className="p-4">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Average Score</span>
          <div className="text-2xl font-bold font-display text-neutral-900 dark:text-white mt-1">
            {avgScore}%
          </div>
        </GlassCard>

        <GlassCard className="p-4">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Passing Threshold</span>
          <div className="text-2xl font-bold font-display text-neutral-900 dark:text-white mt-1">
            {selectedExam?.passing_percentage ?? 50}%
          </div>
        </GlassCard>
      </div>

      {/* Attempts Table */}
      <GlassCard className="overflow-hidden">
        {loading || loadingAttempts ? (
          <div className="flex flex-col items-center justify-center py-20 space-y-3">
            <Loader2 className="w-8 h-8 animate-spin text-[#013F32] dark:text-[#E7FE25]" />
            <p className="text-sm text-neutral-500 dark:text-neutral-400 font-medium">Loading examination results...</p>
          </div>
        ) : filteredAttempts.length === 0 ? (
          <div className="text-center py-16 space-y-3">
            <Award className="w-12 h-12 text-neutral-300 dark:text-neutral-600 mx-auto" />
            <p className="text-sm font-medium text-neutral-600 dark:text-neutral-300">
              No examination attempts recorded for this quiz yet.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200/60 dark:border-white/10 bg-neutral-50/50 dark:bg-white/[0.02] text-xs font-semibold text-neutral-500 uppercase tracking-wider">
                  <th className="py-3.5 px-4">Student</th>
                  <th className="py-3.5 px-4">Attempt #</th>
                  <th className="py-3.5 px-4">Status</th>
                  <th className="py-3.5 px-4">Score</th>
                  <th className="py-3.5 px-4">Outcome</th>
                  <th className="py-3.5 px-4">Submitted At</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-200/60 dark:divide-white/10">
                {filteredAttempts.map((att) => {
                  const pass = (att.percentage ?? 0) >= (selectedExam?.passing_percentage ?? 50);
                  return (
                    <tr key={att.attempt_id} className="hover:bg-neutral-100/40 dark:hover:bg-white/[0.03] transition-colors">
                      <td className="py-3.5 px-4">
                        <div className="font-semibold text-neutral-900 dark:text-white">
                          {att.student_name || 'Anonymous Student'}
                        </div>
                        <div className="text-xs text-neutral-500 dark:text-neutral-400">
                          {att.student_email || att.student_identifier || att.student_id}
                        </div>
                      </td>
                      <td className="py-3.5 px-4">
                        <span className="font-mono text-xs px-2 py-0.5 rounded-md bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300">
                          #{att.attempt_number}
                        </span>
                      </td>
                      <td className="py-3.5 px-4">
                        <span className="inline-flex items-center gap-1 text-xs font-medium capitalize text-neutral-600 dark:text-neutral-300">
                          {att.status}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 font-mono">
                        {att.marks_obtained !== null ? (
                          <span className="font-bold text-neutral-900 dark:text-white">
                            {formatMarks(att.marks_obtained)} / {formatMarks(att.total_marks ?? 0)}
                          </span>
                        ) : (
                          <span className="text-neutral-400 italic">In progress</span>
                        )}
                      </td>
                      <td className="py-3.5 px-4">
                        {att.percentage !== null ? (
                          <span
                            className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold ${
                              pass
                                ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                                : 'bg-red-500/15 text-red-700 dark:text-red-400'
                            }`}
                          >
                            {pass ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                            {att.percentage}%
                          </span>
                        ) : (
                          <span className="text-neutral-400 text-xs">—</span>
                        )}
                      </td>
                      <td className="py-3.5 px-4 text-xs text-neutral-500 dark:text-neutral-400">
                        {att.submitted_at ? formatDateTime(att.submitted_at) : 'Active'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </GlassCard>
    </div>
  );
}
