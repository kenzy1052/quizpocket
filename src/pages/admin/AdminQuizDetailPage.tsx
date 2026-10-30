import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import { apiRequest } from '../../lib/api.ts';
import { AdminExamSummary, AdminClassItem, Profile } from '../../types/frontend.ts';
import { ExamDetailManager, ExamSubTab } from '../../components/admin/ExamDetailManager.tsx';
import { GlassCard } from '../../components/common/GlassCard.tsx';

export function AdminQuizDetailPage() {
  const { quizId, tab: routeTab } = useParams<{ quizId: string; tab?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const [exam, setExam] = useState<AdminExamSummary | null>(null);
  const [classes, setClasses] = useState<AdminClassItem[]>([]);
  const [students, setStudents] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Normalize active tab
  const activeInitialTab = useMemo<ExamSubTab>(() => {
    const raw = (routeTab || searchParams.get('tab') || '').toLowerCase().trim();
    if (raw === 'settings' || raw === 'rules' || raw === 'access' || raw === 'config') {
      return 'settings';
    }
    if (raw === 'attempts' || raw === 'results' || raw === 'monitor') {
      return 'attempts';
    }
    if (raw === 'analytics' || raw === 'stats') {
      return 'analytics';
    }
    return 'questions';
  }, [routeTab, searchParams]);

  const loadData = useCallback(async () => {
    if (!quizId) return;
    try {
      setLoading(true);
      setError(null);

      // Attempt to load direct exam details, classes, and students
      const [directExamRes, allExamsRes, classesRes, studentsRes] = await Promise.allSettled([
        apiRequest<AdminExamSummary>(`/admin/exams/${quizId}`),
        apiRequest<AdminExamSummary[]>('/admin/exams'),
        apiRequest<AdminClassItem[]>('/admin/classes'),
        apiRequest<Profile[]>('/admin/students'),
      ]);

      let found: AdminExamSummary | undefined;

      if (directExamRes.status === 'fulfilled' && directExamRes.value && directExamRes.value.id) {
        found = directExamRes.value;
      } else if (allExamsRes.status === 'fulfilled' && Array.isArray(allExamsRes.value)) {
        found = allExamsRes.value.find((e) => e.id === quizId);
      }

      if (!found) {
        setError('Quiz was not found or may have been deleted.');
        return;
      }

      setExam(found);
      setClasses(
        classesRes.status === 'fulfilled' && Array.isArray(classesRes.value) ? classesRes.value : []
      );
      setStudents(
        studentsRes.status === 'fulfilled' && Array.isArray(studentsRes.value) ? studentsRes.value : []
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load quiz details.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [quizId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-24 space-y-4">
        <Loader2 className="w-10 h-10 animate-spin text-[#013F32] dark:text-[#E7FE25]" />
        <p className="text-sm text-neutral-500 dark:text-neutral-400 font-medium">
          Loading quiz details & question manager...
        </p>
      </div>
    );
  }

  if (error || !exam) {
    return (
      <div className="max-w-2xl mx-auto py-12">
        <GlassCard className="p-8 text-center space-y-4 border-red-500/20">
          <div className="w-12 h-12 rounded-2xl bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 flex items-center justify-center mx-auto">
            <AlertCircle className="w-6 h-6" />
          </div>
          <h2 className="text-lg font-bold text-neutral-900 dark:text-white">Quiz Unavailable</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">{error || 'Quiz not found'}</p>
          <div className="flex items-center justify-center gap-3 pt-2">
            <button
              type="button"
              onClick={() => loadData()}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-neutral-300 dark:border-white/10 text-neutral-700 dark:text-neutral-200 font-semibold text-sm hover:bg-neutral-100 dark:hover:bg-white/5 transition"
            >
              <RefreshCw className="w-4 h-4" />
              Retry
            </button>
            <button
              type="button"
              onClick={() => navigate('/admin/quizzes')}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#013F32] text-white font-semibold text-sm hover:bg-[#025342] dark:bg-[#E7FE25] dark:text-[#161616] dark:hover:bg-[#d6ec1c] transition"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to Quizzes
            </button>
          </div>
        </GlassCard>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between pb-2">
        <button
          type="button"
          onClick={() => navigate('/admin/quizzes')}
          className="inline-flex items-center gap-2 text-sm font-semibold text-neutral-600 dark:text-neutral-400 hover:text-[#013F32] dark:hover:text-[#E7FE25] transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Quiz Catalog
        </button>
      </div>

      <ExamDetailManager
        exam={exam}
        classes={classes}
        students={students}
        initialTab={activeInitialTab}
        onBack={() => navigate('/admin/quizzes')}
        onExamUpdated={loadData}
      />
    </div>
  );
}
