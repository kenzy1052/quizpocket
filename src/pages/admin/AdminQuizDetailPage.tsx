import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Loader2, AlertCircle } from 'lucide-react';
import { apiRequest } from '../../lib/api.ts';
import { AdminExamSummary, AdminClassItem, Profile } from '../../types/frontend.ts';
import { ExamDetailManager } from '../../components/admin/ExamDetailManager.tsx';
import { GlassCard } from '../../components/common/GlassCard.tsx';

export function AdminQuizDetailPage() {
  const { quizId } = useParams<{ quizId: string }>();
  const navigate = useNavigate();

  const [exam, setExam] = useState<AdminExamSummary | null>(null);
  const [classes, setClasses] = useState<AdminClassItem[]>([]);
  const [students, setStudents] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!quizId) return;
    try {
      setLoading(true);
      setError(null);
      const [examsRes, classesRes, studentsRes] = await Promise.all([
        apiRequest<{ data: AdminExamSummary[] }>('/admin/exams'),
        apiRequest<{ data: AdminClassItem[] }>('/admin/classes'),
        apiRequest<{ data: Profile[] }>('/admin/students'),
      ]);

      const found = examsRes.data.find((e) => e.id === quizId);
      if (!found) {
        setError('Quiz was not found or may have been deleted.');
        return;
      }

      setExam(found);
      setClasses(classesRes.data || []);
      setStudents(studentsRes.data || []);
    } catch (err: any) {
      setError(err?.message || 'Failed to load quiz details.');
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
          <button
            type="button"
            onClick={() => navigate('/admin/quizzes')}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#013F32] text-white font-semibold text-sm hover:bg-[#025342] transition"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Quizzes
          </button>
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
        onBack={() => navigate('/admin/quizzes')}
        onExamUpdated={loadData}
      />
    </div>
  );
}
