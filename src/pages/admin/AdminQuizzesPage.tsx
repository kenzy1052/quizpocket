import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FileQuestion,
  Plus,
  Search,
  Lock,
  Unlock,
  Archive,
  Send,
  Clock,
  ArrowRight,
  Settings,
  HelpCircle,
  Hourglass,
  X,
} from 'lucide-react';
import { apiRequest } from '../../lib/api.ts';
import { ExamListItem, CreateExamInput } from '../../types/frontend.ts';
import { GlassCard } from '../../components/common/GlassCard.tsx';
import { useNotification } from '../../components/common/GlobalNotification.tsx';

export function AdminQuizzesPage() {
  const navigate = useNavigate();
  const { success: notifySuccess, error: notifyError } = useNotification();

  const [exams, setExams] = useState<ExamListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDuration, setNewDuration] = useState(30);
  const [newPassPct, setNewPassPct] = useState(70);
  const [newCooldown, setNewCooldown] = useState(180);
  const [isCreating, setIsCreating] = useState(false);

  // Cooldown override modal
  const [overrideExam, setOverrideExam] = useState<ExamListItem | null>(null);
  const [overrideReason, setOverrideReason] = useState('Instructor permission granted');
  const [isOverriding, setIsOverriding] = useState(false);

  async function loadExams() {
    try {
      const data = await apiRequest<ExamListItem[]>('/admin/exams');
      setExams(data || []);
    } catch (err) {
      console.error('Failed to load exams:', err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadExams();
  }, []);

  async function handleToggleOpen(exam: ExamListItem) {
    const nextState = !exam.is_open;
    try {
      await apiRequest(`/admin/exams/${exam.id}/access`, {
        method: 'PATCH',
        body: { is_open: nextState },
      });
      notifySuccess(`Quiz marked as ${nextState ? 'OPEN' : 'CLOSED'}.`);
      loadExams();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unable to update status.';
      notifyError(msg);
    }
  }

  async function handlePublish(examId: string) {
    try {
      await apiRequest(`/admin/exams/${examId}/publish`, { method: 'POST' });
      notifySuccess('Quiz published to cohorts successfully.');
      loadExams();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unable to publish quiz.';
      notifyError(msg);
    }
  }

  async function handleArchive(examId: string) {
    if (!window.confirm('Archive this quiz? Existing student attempts remain preserved.')) return;
    try {
      await apiRequest(`/admin/exams/${examId}/archive`, { method: 'POST' });
      notifySuccess('Quiz archived.');
      loadExams();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unable to archive quiz.';
      notifyError(msg);
    }
  }

  async function handleCreateExam(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim()) return;

    setIsCreating(true);
    try {
      const created = await apiRequest<{ id: string }>('/admin/exams', {
        method: 'POST',
        body: {
          title: newTitle.trim(),
          duration_minutes: Number(newDuration),
          passing_percentage: Number(newPassPct),
          retake_cooldown_minutes: Number(newCooldown),
          is_open: true,
          open_to_all: true,
        },
      });
      notifySuccess('Quiz created successfully.');
      setShowCreateModal(false);
      setNewTitle('');
      loadExams();
      navigate(`/admin/quizzes/${created.id}/questions`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unable to create quiz.';
      notifyError(msg);
    } finally {
      setIsCreating(false);
    }
  }

  async function handleExecuteCooldownOverride(e: React.FormEvent) {
    e.preventDefault();
    if (!overrideExam) return;
    setIsOverriding(true);
    try {
      await apiRequest(`/admin/exams/${overrideExam.id}/unlock-retake`, {
        method: 'POST',
        body: { reason: overrideReason },
      });
      notifySuccess('Cooldown override granted! Students in cooldown can now immediately retake.');
      setOverrideExam(null);
      loadExams();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unable to grant cooldown override.';
      notifyError(msg);
    } finally {
      setIsOverriding(false);
    }
  }

  const filteredExams = exams.filter((e) =>
    e.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="space-y-8 animate-in fade-in duration-300">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-[#161616] dark:text-[#FDFDFD]">
            Quiz & Examination Management
          </h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
            Author assessments, control access states, manage retake cooldowns, and edit question banks
          </p>
        </div>

        <button
          onClick={() => setShowCreateModal(true)}
          className="px-5 py-2.5 rounded-2xl bg-[#013F32] dark:bg-[#E7FE25] text-white dark:text-[#161616] font-bold text-xs sm:text-sm flex items-center gap-2 shadow hover:opacity-90 transition self-start sm:self-auto"
        >
          <Plus className="w-4 h-4" />
          <span>Create New Quiz</span>
        </button>
      </div>

      {/* Search Bar */}
      <div className="relative max-w-md">
        <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-400" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Filter quizzes by title..."
          className="w-full h-11 pl-10 pr-4 rounded-2xl glass-panel text-sm text-[#161616] dark:text-[#FDFDFD] placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-[#013F32] dark:focus:ring-[#E7FE25]"
        />
      </div>

      {/* Quizzes List */}
      {loading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((n) => (
            <div key={n} className="h-28 rounded-3xl bg-neutral-200/50 dark:bg-white/5 animate-pulse" />
          ))}
        </div>
      ) : filteredExams.length === 0 ? (
        <GlassCard className="text-center py-16">
          <FileQuestion className="w-12 h-12 mx-auto text-neutral-400 mb-3" />
          <h2 className="text-base font-semibold text-[#161616] dark:text-[#FDFDFD]">
            No quizzes found
          </h2>
          <p className="text-xs text-neutral-500 max-w-sm mx-auto mt-1 mb-6">
            Get started by creating your first examination.
          </p>
          <button
            onClick={() => setShowCreateModal(true)}
            className="px-4 py-2 rounded-xl bg-[#013F32] dark:bg-[#E7FE25] text-white dark:text-[#161616] text-xs font-semibold"
          >
            Create Quiz
          </button>
        </GlassCard>
      ) : (
        <div className="space-y-4">
          {filteredExams.map((exam) => {
            const isDraft = exam.status === 'draft';
            const isArchived = exam.status === 'archived';

            return (
              <GlassCard key={exam.id} hoverEffect className="p-5 sm:p-6">
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className={`px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider ${
                          isArchived
                            ? 'bg-neutral-200 dark:bg-white/10 text-neutral-500'
                            : isDraft
                              ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
                              : 'bg-emerald-500/10 text-emerald-700 dark:text-[#E7FE25]'
                        }`}
                      >
                        {exam.status}
                      </span>

                      {!isArchived && (
                        <button
                          onClick={() => handleToggleOpen(exam)}
                          className={`px-2.5 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 border transition ${
                            exam.is_open
                              ? 'bg-emerald-500/10 text-emerald-700 dark:text-[#E7FE25] border-emerald-500/20'
                              : 'bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/20'
                          }`}
                          title="Click to toggle open/closed access"
                        >
                          {exam.is_open ? <Unlock className="w-3 h-3" /> : <Lock className="w-3 h-3" />}
                          <span>{exam.is_open ? 'Open' : 'Closed'}</span>
                        </button>
                      )}
                    </div>

                    <h2
                      onClick={() => navigate(`/admin/quizzes/${exam.id}`)}
                      className="font-bold text-base sm:text-lg text-[#161616] dark:text-[#FDFDFD] truncate cursor-pointer hover:text-[#013F32] dark:hover:text-[#E7FE25] transition-colors"
                      title="Manage quiz"
                    >
                      {exam.title}
                    </h2>

                    <div className="flex flex-wrap items-center gap-3 text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                      <span>{exam.duration_minutes} Mins</span>
                      <span>·</span>
                      <span>Passing: {exam.passing_percentage}%</span>
                      <span>·</span>
                      <span>Cooldown: {exam.retake_cooldown_minutes}m</span>
                      <span>·</span>
                      <span>Max Attempts: {exam.max_attempts}</span>
                    </div>
                  </div>

                  {/* Actions cluster */}
                  <div className="flex flex-wrap items-center gap-2 shrink-0 pt-3 lg:pt-0 border-t lg:border-t-0 border-neutral-200/60 dark:border-white/10">
                    <button
                      onClick={() => navigate(`/admin/quizzes/${exam.id}/questions`)}
                      className="px-3.5 py-2 rounded-xl glass-panel text-xs font-semibold text-[#013F32] dark:text-[#E7FE25] hover:border-[#013F32] dark:hover:border-[#E7FE25]"
                    >
                      Questions
                    </button>

                    <button
                      onClick={() => navigate(`/admin/quizzes/${exam.id}/settings`)}
                      className="px-3.5 py-2 rounded-xl glass-panel text-xs font-semibold hover:border-neutral-400"
                    >
                      Settings
                    </button>

                    <button
                      onClick={() => navigate(`/admin/quizzes/${exam.id}/attempts`)}
                      className="px-3.5 py-2 rounded-xl glass-panel text-xs font-semibold text-emerald-700 dark:text-emerald-400 hover:border-emerald-500"
                    >
                      Results
                    </button>

                    <button
                      onClick={() => setOverrideExam(exam)}
                      className="px-3.5 py-2 rounded-xl glass-panel text-xs font-semibold text-amber-700 dark:text-amber-400 hover:border-amber-500 flex items-center gap-1"
                      title="Override retake cooldown"
                    >
                      <Hourglass className="w-3 h-3" />
                      <span>Cooldown</span>
                    </button>

                    {isDraft && (
                      <button
                        onClick={() => handlePublish(exam.id)}
                        className="px-3.5 py-2 rounded-xl bg-[#013F32] dark:bg-[#E7FE25] text-white dark:text-[#161616] text-xs font-bold"
                      >
                        Publish
                      </button>
                    )}

                    {!isArchived && (
                      <button
                        onClick={() => handleArchive(exam.id)}
                        className="p-2 rounded-xl glass-panel text-neutral-400 hover:text-rose-600 hover:border-rose-400 transition"
                        title="Archive quiz"
                      >
                        <Archive className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              </GlassCard>
            );
          })}
        </div>
      )}

      {/* Create Quiz Modal */}
      {showCreateModal && (
        <div
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in"
          onClick={() => setShowCreateModal(false)}
        >
          <div
            className="glass-panel rounded-3xl max-w-lg w-full p-6 sm:p-7 space-y-5 animate-in zoom-in-95"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-[#161616] dark:text-[#FDFDFD]">
                Create New Examination
              </h2>
              <button
                onClick={() => setShowCreateModal(false)}
                className="p-1 rounded-lg text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateExam} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-600 dark:text-neutral-300 mb-1.5">
                  Quiz Title
                </label>
                <input
                  type="text"
                  required
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="e.g. HIM 105 Lecture 2 Assessment"
                  className="w-full h-11 px-4 rounded-2xl glass-panel text-sm text-[#161616] dark:text-[#FDFDFD] focus:outline-none focus:ring-2 focus:ring-[#013F32] dark:focus:ring-[#E7FE25]"
                />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-600 dark:text-neutral-300 mb-1.5">
                    Duration (Min)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={360}
                    required
                    value={newDuration}
                    onChange={(e) => setNewDuration(Number(e.target.value))}
                    className="w-full h-11 px-3 rounded-2xl glass-panel text-sm font-mono text-[#161616] dark:text-[#FDFDFD]"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-600 dark:text-neutral-300 mb-1.5">
                    Pass %
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    required
                    value={newPassPct}
                    onChange={(e) => setNewPassPct(Number(e.target.value))}
                    className="w-full h-11 px-3 rounded-2xl glass-panel text-sm font-mono text-[#161616] dark:text-[#FDFDFD]"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-600 dark:text-neutral-300 mb-1.5">
                    Cooldown (Min)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={1440}
                    required
                    value={newCooldown}
                    onChange={(e) => setNewCooldown(Number(e.target.value))}
                    className="w-full h-11 px-3 rounded-2xl glass-panel text-sm font-mono text-[#161616] dark:text-[#FDFDFD]"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-3">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 rounded-2xl glass-panel text-xs font-semibold text-neutral-600 dark:text-neutral-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isCreating}
                  className="px-5 py-2 rounded-2xl bg-[#013F32] dark:bg-[#E7FE25] text-white dark:text-[#161616] text-xs font-bold shadow hover:opacity-90 transition disabled:opacity-50"
                >
                  {isCreating ? 'Creating...' : 'Create & Add Questions'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Cooldown Override Modal */}
      {overrideExam && (
        <div
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in"
          onClick={() => setOverrideExam(null)}
        >
          <div
            className="glass-panel rounded-3xl max-w-md w-full p-6 space-y-4 animate-in zoom-in-95"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-[#161616] dark:text-[#FDFDFD]">
                Override Retake Cooldown
              </h2>
              <button
                onClick={() => setOverrideExam(null)}
                className="p-1 rounded-lg text-neutral-400 hover:text-neutral-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-xs text-neutral-600 dark:text-neutral-300 leading-relaxed">
              Granting an override for <strong>{overrideExam.title}</strong> allows all students currently waiting in retake cooldown to immediately begin their next attempt.
            </p>

            <form onSubmit={handleExecuteCooldownOverride} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-600 dark:text-neutral-300 mb-1.5">
                  Administrative Reason
                </label>
                <input
                  type="text"
                  required
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                  className="w-full h-11 px-4 rounded-2xl glass-panel text-sm text-[#161616] dark:text-[#FDFDFD]"
                />
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setOverrideExam(null)}
                  className="px-4 py-2 rounded-2xl glass-panel text-xs font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isOverriding}
                  className="px-5 py-2 rounded-2xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold shadow"
                >
                  {isOverriding ? 'Unlocking...' : 'Unlock Now'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
