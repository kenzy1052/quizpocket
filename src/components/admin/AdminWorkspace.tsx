import React, { useCallback, useEffect, useState } from 'react';
import {
  ClipboardList,
  Users,
  Shield,
  User,
  LogOut,
  Plus,
  ChevronRight,
  Lock,
  Unlock,
  X,
  RefreshCw,
  LayoutDashboard,
  ArrowRight,
  Trash2,
} from 'lucide-react';
import { BrandMark } from '../BrandMark.tsx';
import { ThemeToggle } from '../ThemeToggle.tsx';
import { useAuth } from '../../context/AuthContext.tsx';
import { ApiClientError, apiRequest } from '../../lib/api.ts';
import {
  formatDateTime,
  formatMarks,
  formatReleasePolicyLabel,
} from '../../lib/format.ts';
import {
  AdminClassItem,
  AdminExamSummary,
  AuditLogRow,
  Profile,
  ResultReleasePolicy,
} from '../../types/frontend.ts';
import { ExamDetailManager } from './ExamDetailManager.tsx';

type AdminTab = 'home' | 'exams' | 'roster' | 'audit' | 'account';

export function AdminWorkspace() {
  const { profile, signOut, updateFullName } = useAuth();
  const [activeTab, setActiveTab] = useState<AdminTab>('home');

  const [exams, setExams] = useState<AdminExamSummary[]>([]);
  const [students, setStudents] = useState<Profile[]>([]);
  const [classes, setClasses] = useState<AdminClassItem[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogRow[]>([]);

  const [loading, setLoading] = useState<boolean>(true);
  const [togglingExamId, setTogglingExamId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);

  const [selectedExamId, setSelectedExamId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<
    'all' | 'open' | 'closed' | 'draft' | 'archived'
  >('all');

  // Create Quiz Modal State
  const [showCreateExamModal, setShowCreateExamModal] = useState<boolean>(false);
  const [newTitle, setNewTitle] = useState<string>('');
  const [newDesc, setNewDesc] = useState<string>('');
  const [newInstructions, setNewInstructions] = useState<string>('');
  const [newDuration, setNewDuration] = useState<string>('30');
  const [newPassingPct, setNewPassingPct] = useState<string>('50');
  const [newMaxAttempts, setNewMaxAttempts] = useState<string>('100');
  const [newCooldownMinutes, setNewCooldownMinutes] = useState<string>('180');
  const [newPolicy, setNewPolicy] = useState<ResultReleasePolicy>('immediate');
  const [creatingExam, setCreatingExam] = useState<boolean>(false);

  // Create Student & Class Modal States
  const [showCreateStudentModal, setShowCreateStudentModal] = useState<boolean>(false);
  const [stuName, setStuName] = useState<string>('');
  const [stuIdentifier, setStuIdentifier] = useState<string>('');
  const [stuPassword, setStuPassword] = useState<string>('');
  const [creatingStudent, setCreatingStudent] = useState<boolean>(false);

  const [showCreateClassModal, setShowCreateClassModal] = useState<boolean>(false);
  const [clsName, setClsName] = useState<string>('');
  const [clsDesc, setClsDesc] = useState<string>('');
  const [creatingClass, setCreatingClass] = useState<boolean>(false);

  // Account Name Update
  const [adminNameInput, setAdminNameInput] = useState<string>(profile?.full_name ?? '');
  const [savingAccount, setSavingAccount] = useState<boolean>(false);

  const loadAdminData = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      // Load each section independently so one failing endpoint never hides the rest.
      const [examsRes, studentsRes, classesRes, logsRes] = await Promise.allSettled([
        apiRequest<AdminExamSummary[]>('/admin/exams'),
        apiRequest<Profile[]>('/admin/students'),
        apiRequest<AdminClassItem[]>('/admin/classes'),
        apiRequest<AuditLogRow[]>('/admin/audit-logs?limit=80'),
      ]);

      const failures: string[] = [];
      const take = <T,>(res: PromiseSettledResult<T[]>, label: string): T[] | null => {
        if (res.status === 'fulfilled') return Array.isArray(res.value) ? res.value : [];
        const reason = res.reason;
        failures.push(
          `${label}: ${reason instanceof ApiClientError ? reason.message : 'request failed'}`
        );
        return null; // keep whatever was already on screen
      };

      const exams = take(examsRes, 'Quizzes');
      const students = take(studentsRes, 'Students');
      const classes = take(classesRes, 'Classes');
      const logs = take(logsRes, 'Audit log');
      if (exams) setExams(exams);
      if (students) setStudents(students);
      if (classes) setClasses(classes);
      if (logs) setAuditLogs(logs);

      if (failures.length > 0) {
        setErrorMsg(`Some sections could not be loaded — ${failures.join(' | ')}`);
      }
    } catch (err) {
      setErrorMsg(err instanceof ApiClientError ? err.message : 'Unable to load admin console.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAdminData();
  }, [loadAdminData]);

  useEffect(() => {
    if (profile?.full_name) {
      setAdminNameInput(profile.full_name);
    }
  }, [profile?.full_name]);

  async function handleQuickToggleOpenClose(e: React.MouseEvent, exam: AdminExamSummary) {
    e.stopPropagation();
    setTogglingExamId(exam.id);
    setErrorMsg(null);
    setFeedbackMsg(null);
    const nextOpen = exam.is_open === false;
    try {
      await apiRequest(`/admin/exams/${exam.id}/access`, {
        method: 'PATCH',
        body: { is_open: nextOpen },
      });
      setFeedbackMsg(
        nextOpen
          ? `"${exam.title}" is now OPEN for students.`
          : `"${exam.title}" is now CLOSED. Students cannot start new attempts.`
      );
      await loadAdminData();
    } catch (err) {
      setErrorMsg(
        err instanceof ApiClientError ? err.message : 'Unable to update quiz access state.'
      );
    } finally {
      setTogglingExamId(null);
    }
  }

  async function handleArchiveExam(e: React.MouseEvent, exam: AdminExamSummary) {
    e.stopPropagation();
    const confirmed = window.confirm(
      `Archive "${exam.title}"? Students will no longer see it. Existing attempts and results will be preserved.`
    );
    if (!confirmed) return;

    setTogglingExamId(exam.id);
    setErrorMsg(null);
    setFeedbackMsg(null);
    try {
      await apiRequest(`/admin/exams/${exam.id}/archive`, { method: 'POST' });
      setFeedbackMsg(`"${exam.title}" has been archived. Historical attempts remain available.`);
      await loadAdminData();
    } catch (err) {
      setErrorMsg(err instanceof ApiClientError ? err.message : 'Unable to archive this quiz.');
    } finally {
      setTogglingExamId(null);
    }
  }

  async function handleCreateExam(e: React.FormEvent) {
    e.preventDefault();
    setCreatingExam(true);
    setErrorMsg(null);
    try {
      const created = await apiRequest<{ id: string }>('/admin/exams', {
        method: 'POST',
        body: {
          title: newTitle.trim(),
          description: newDesc.trim() || null,
          instructions: newInstructions.trim() || null,
          duration_minutes: Number(newDuration),
          passing_percentage: Number(newPassingPct),
          max_attempts: Number(newMaxAttempts),
          retake_cooldown_minutes: Number(newCooldownMinutes),
          result_release_policy: newPolicy,
          allow_review: true,
          open_to_all: true,
          is_open: true,
        },
      });
      setShowCreateExamModal(false);
      setNewTitle('');
      setNewDesc('');
      setNewInstructions('');
      await loadAdminData();
      setSelectedExamId(created.id);
    } catch (err) {
      setErrorMsg(err instanceof ApiClientError ? err.message : 'Unable to create quiz.');
    } finally {
      setCreatingExam(false);
    }
  }

  async function handleCreateStudent(e: React.FormEvent) {
    e.preventDefault();
    setCreatingStudent(true);
    setErrorMsg(null);
    try {
      await apiRequest('/admin/students', {
        method: 'POST',
        body: {
          username: stuName.trim(),
          full_name: stuName.trim(),
          student_identifier: stuIdentifier.trim() || null,
          password: stuPassword,
          account_status: 'active',
        },
      });
      setShowCreateStudentModal(false);
      setStuName('');
      setStuIdentifier('');
      setStuPassword('');
      setFeedbackMsg('Student account created.');
      await loadAdminData();
    } catch (err) {
      setErrorMsg(
        err instanceof ApiClientError ? err.message : 'Unable to create student account.'
      );
    } finally {
      setCreatingStudent(false);
    }
  }

  async function handleToggleStudentAccountStatus(stu: Profile) {
    setErrorMsg(null);
    const nextStatus = stu.account_status === 'active' ? 'suspended' : 'active';
    try {
      await apiRequest(`/admin/students/${stu.id}`, {
        method: 'PATCH',
        body: {
          full_name: stu.full_name,
          student_identifier: stu.student_identifier,
          account_status: nextStatus,
        },
      });
      setFeedbackMsg(
        nextStatus === 'active'
          ? `${stu.full_name} reactivated.`
          : `${stu.full_name} suspended from active sessions.`
      );
      await loadAdminData();
    } catch (err) {
      setErrorMsg(err instanceof ApiClientError ? err.message : 'Unable to update student status.');
    }
  }

  async function handleCreateClass(e: React.FormEvent) {
    e.preventDefault();
    setCreatingClass(true);
    setErrorMsg(null);
    try {
      await apiRequest('/admin/classes', {
        method: 'POST',
        body: {
          name: clsName.trim(),
          description: clsDesc.trim() || null,
        },
      });
      setShowCreateClassModal(false);
      setClsName('');
      setClsDesc('');
      setFeedbackMsg('Class cohort created.');
      await loadAdminData();
    } catch (err) {
      setErrorMsg(err instanceof ApiClientError ? err.message : 'Unable to create class.');
    } finally {
      setCreatingClass(false);
    }
  }

  async function handleToggleClassMember(classId: string, studentId: string, isActive: boolean) {
    setErrorMsg(null);
    try {
      await apiRequest(`/admin/classes/${classId}/members/${studentId}`, {
        method: 'PUT',
        body: { membership_status: isActive ? 'inactive' : 'active' },
      });
      await loadAdminData();
    } catch (err) {
      setErrorMsg(
        err instanceof ApiClientError ? err.message : 'Unable to update class membership.'
      );
    }
  }

  async function handleSaveAdminName(e: React.FormEvent) {
    e.preventDefault();
    setSavingAccount(true);
    setErrorMsg(null);
    try {
      await updateFullName(adminNameInput);
      setFeedbackMsg('Instructor display name updated.');
    } catch (err) {
      setErrorMsg(err instanceof ApiClientError ? err.message : 'Unable to update profile.');
    } finally {
      setSavingAccount(false);
    }
  }

  const selectedExam = exams.find((e) => e.id === selectedExamId) ?? null;
  const filteredExams = exams.filter((e) => {
    if (statusFilter === 'all') return e.status !== 'archived';
    if (statusFilter === 'open') return e.status === 'published' && e.is_open !== false;
    if (statusFilter === 'closed') return e.is_open === false && e.status !== 'archived';
    if (statusFilter === 'draft') return e.status === 'draft';
    if (statusFilter === 'archived') return e.status === 'archived';
    return true;
  });

  return (
    <div className="min-h-dvh bg-[#F6F7F5] dark:bg-[#161616] text-[#161616] dark:text-[#FDFDFD] flex flex-col transition-colors">
      {/* Top 3-Zone Header */}
      <header className="sticky top-0 z-20 bg-[#FDFDFD]/95 dark:bg-[#161616]/95 backdrop-blur border-b border-neutral-200/90 dark:border-white/10">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <BrandMark className="w-9 h-9 shrink-0" />
            <div className="min-w-0">
              <span className="font-display text-sm sm:text-base font-bold tracking-tight text-[#161616] dark:text-[#FDFDFD] block leading-none truncate">
                QuizPocket
              </span>
              <span className="text-[11px] text-[#013F32] dark:text-[#E7FE25] font-semibold block mt-1">
                Admin & Quiz Console
              </span>
            </div>
          </div>

          <nav className="hidden md:flex items-center gap-1" aria-label="Admin sections">
            {(
              [
                { id: 'home', label: 'Home' },
                { id: 'exams', label: 'Quizzes' },
                { id: 'roster', label: 'Students & Classes' },
                { id: 'audit', label: 'Audit Trail' },
                { id: 'account', label: 'Account' },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setSelectedExamId(null);
                  setActiveTab(item.id);
                }}
                className={`min-h-[40px] px-4 rounded-xl text-sm font-semibold transition whitespace-nowrap ${
                  activeTab === item.id
                    ? 'bg-[#013F32] text-[#FDFDFD] dark:bg-[#E7FE25] dark:text-[#161616]'
                    : 'text-neutral-600 dark:text-neutral-400 hover:text-[#161616] dark:hover:text-[#FDFDFD] hover:bg-neutral-100 dark:hover:bg-white/5'
                }`}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div className="flex items-center gap-2 sm:gap-2.5 shrink-0">
            <div className="hidden sm:block text-right mr-1">
              <div className="text-xs font-semibold text-[#161616] dark:text-[#FDFDFD]">
                {profile?.full_name}
              </div>
              <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                Administrator
              </div>
            </div>
            <ThemeToggle />
            <button
              type="button"
              onClick={() => signOut()}
              className="min-h-[44px] px-3 rounded-xl border border-neutral-200 dark:border-white/15 bg-[#FDFDFD] dark:bg-[#1E1F1E] text-xs font-semibold text-neutral-700 dark:text-neutral-300 hover:border-[#013F32] dark:hover:border-[#E7FE25] inline-flex items-center gap-1.5 whitespace-nowrap transition"
            >
              <LogOut className="w-4 h-4" />
              <span className="hidden sm:inline">Sign Out</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 w-full max-w-6xl mx-auto px-4 sm:px-6 py-6 pb-24 md:pb-10">
        {feedbackMsg && !selectedExam && (
          <div className="mb-5 rounded-2xl bg-[#013F32]/10 dark:bg-[#E7FE25]/15 border border-[#013F32]/25 dark:border-[#E7FE25]/35 px-4 py-3 text-xs text-[#013F32] dark:text-[#E7FE25] font-medium flex items-center justify-between gap-3">
            <span>{feedbackMsg}</span>
            <button
              type="button"
              onClick={() => setFeedbackMsg(null)}
              className="font-semibold underline shrink-0"
            >
              Dismiss
            </button>
          </div>
        )}

        {errorMsg && !selectedExam && (
          <div className="mb-5 rounded-2xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800/60 px-4 py-3 text-xs text-rose-800 dark:text-rose-200">
            {errorMsg}
          </div>
        )}

        {selectedExam ? (
          <ExamDetailManager
            exam={selectedExam}
            classes={classes}
            students={students}
            onBack={() => setSelectedExamId(null)}
            onExamUpdated={loadAdminData}
          />
        ) : (
          <>
            {activeTab === 'home' && (
              <div className="space-y-7">
                <section className="dashboard-hero relative overflow-hidden rounded-[2rem] border border-[#15B8A6]/15 p-7 sm:p-10">
                  <div className="relative z-10 max-w-2xl">
                    <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[#15A997] dark:text-[#B9F4E8]">
                      Admin overview
                    </p>
                    <h1 className="mt-4 font-display text-3xl font-bold tracking-tight text-[#202A39] dark:text-white sm:text-4xl">
                      Welcome, {profile?.username || profile?.full_name || 'Admin'}.
                    </h1>
                    <p className="mt-3 max-w-xl text-sm leading-relaxed text-neutral-600 dark:text-neutral-300 sm:text-base">
                      Your courses and assessments, organized in one calm, clear workspace.
                    </p>
                    <div className="mt-6 flex flex-wrap gap-3">
                      <button
                        type="button"
                        onClick={() => setShowCreateExamModal(true)}
                        className="inline-flex min-h-12 items-center gap-2 rounded-2xl bg-[#013F32] px-5 text-sm font-semibold text-white transition hover:-translate-y-0.5"
                      >
                        Create a quiz
                        <ArrowRight className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setActiveTab('exams')}
                        className="inline-flex min-h-12 items-center gap-2 rounded-2xl border border-neutral-300 bg-white/70 px-5 text-sm font-semibold text-[#202A39] transition hover:bg-white dark:border-white/15 dark:bg-white/5 dark:text-white"
                      >
                        Manage quizzes
                      </button>
                    </div>
                  </div>
                  <div aria-hidden="true" className="pointer-events-none absolute -right-10 -bottom-28 hidden h-72 w-72 rounded-full border-[2.5rem] border-white/40 sm:block" />
                </section>

                <section aria-label="Workspace summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  {[
                    {
                      label: 'Active quizzes',
                      value: loading
                        ? '—'
                        : exams.filter(
                            (exam) => exam.status === 'published' && exam.is_open !== false
                          ).length,
                      Icon: ClipboardList,
                    },
                    {
                      label: 'Drafts',
                      value: loading ? '—' : exams.filter((exam) => exam.status === 'draft').length,
                      Icon: Plus,
                    },
                    { label: 'Students', value: loading ? '—' : students.length, Icon: Users },
                    { label: 'Classes', value: loading ? '—' : classes.length, Icon: LayoutDashboard },
                  ].map(({ label, value, Icon }) => (
                    <div
                      key={label}
                      className="rounded-2xl border border-neutral-200/80 bg-white p-5 dark:border-white/10 dark:bg-[#1E1F1E]"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-neutral-500 dark:text-neutral-400">{label}</span>
                        <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#E8FAF5] text-[#15A997] dark:bg-[#15B8A6]/15 dark:text-[#B9F4E8]">
                          <Icon className="h-4 w-4" />
                        </span>
                      </div>
                      <div className="mt-4 font-display text-3xl font-bold tracking-tight text-[#202A39] dark:text-white">
                        {value}
                      </div>
                    </div>
                  ))}
                </section>
              </div>
            )}

            {/* TAB 1: QUIZZES */}
            {activeTab === 'exams' && (
              <div className="space-y-5">
                <div className="flex flex-wrap items-end justify-between gap-4">
                  <div>
                    <h1 className="font-display text-xl sm:text-2xl font-bold tracking-tight text-[#161616] dark:text-[#FDFDFD]">
                      Quizzes
                    </h1>
                    <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
                      Open or close quizzes instantly, manage questions, grade submissions, and
                      override 3-hour retake cooldowns.
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void loadAdminData()}
                      className="min-h-[44px] px-3.5 rounded-xl border border-neutral-200 dark:border-white/15 bg-[#FDFDFD] dark:bg-[#1E1F1E] text-xs font-semibold text-neutral-700 dark:text-neutral-300 hover:border-[#013F32] dark:hover:border-[#E7FE25] inline-flex items-center gap-1.5 whitespace-nowrap transition"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                      <span>Refresh</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowCreateExamModal(true)}
                      className="min-h-[44px] px-4 rounded-xl bg-[#013F32] hover:bg-[#025342] text-[#FDFDFD] dark:bg-[#E7FE25] dark:hover:bg-[#d8ef1a] dark:text-[#161616] text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap transition"
                    >
                      <Plus className="w-4 h-4" />
                      <span>New Quiz</span>
                    </button>
                  </div>
                </div>

                {/* Filter Buttons */}
                <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
                  {(
                    [
                      { id: 'all', label: 'All' },
                      { id: 'open', label: 'Open' },
                      { id: 'closed', label: 'Closed' },
                      { id: 'draft', label: 'Drafts' },
                      { id: 'archived', label: 'Archived' },
                    ] as const
                  ).map((st) => (
                    <button
                      key={st.id}
                      type="button"
                      onClick={() => setStatusFilter(st.id)}
                      className={`min-h-[40px] px-4 rounded-xl text-xs font-semibold transition whitespace-nowrap ${
                        statusFilter === st.id
                          ? 'bg-[#013F32] text-[#FDFDFD] dark:bg-[#E7FE25] dark:text-[#161616]'
                          : 'bg-[#FDFDFD] dark:bg-[#1E1F1E] border border-neutral-200 dark:border-white/10 text-neutral-600 dark:text-neutral-300 hover:text-[#161616] dark:hover:text-[#FDFDFD]'
                      }`}
                    >
                      {st.label}
                    </button>
                  ))}
                </div>

                {loading ? (
                  <div className="bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-3xl border border-neutral-200 dark:border-white/10 p-10 text-center text-sm text-neutral-500 dark:text-neutral-400">
                    Loading quizzes...
                  </div>
                ) : filteredExams.length === 0 ? (
                  <div className="bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-3xl border border-neutral-200 dark:border-white/10 p-10 text-center text-sm text-neutral-500 dark:text-neutral-400">
                    No quizzes match the selected filter.
                  </div>
                ) : (
                  <div className="bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-3xl border border-neutral-200/90 dark:border-white/10 divide-y divide-neutral-200/70 dark:divide-white/10">
                    {filteredExams.map((exam) => {
                      const isQuizOpen = exam.status === 'published' && exam.is_open !== false;
                      const isToggling = togglingExamId === exam.id;

                      return (
                        <div
                          key={exam.id}
                          onClick={() => setSelectedExamId(exam.id)}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              setSelectedExamId(exam.id);
                            }
                          }}
                          className="w-full p-5 sm:p-6 text-left hover:bg-neutral-50 dark:hover:bg-white/[0.03] transition flex flex-col lg:flex-row lg:items-center justify-between gap-4"
                        >
                          <div className="space-y-1.5 min-w-0">
                            <div className="text-xs text-neutral-500 dark:text-neutral-400 flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span
                                className={`font-semibold ${
                                  isQuizOpen
                                    ? 'text-[#013F32] dark:text-[#E7FE25]'
                                    : exam.status === 'draft'
                                      ? 'text-amber-700 dark:text-amber-400'
                                      : 'text-rose-700 dark:text-rose-400'
                                }`}
                              >
                                {exam.status === 'draft'
                                  ? 'Draft'
                                  : isQuizOpen
                                    ? 'Open to Students'
                                    : 'Closed'}
                              </span>
                              <span>·</span>
                              <span className="font-mono tabular-nums">
                                {exam.question_count} questions
                              </span>
                              <span>·</span>
                              <span className="font-mono tabular-nums">
                                {formatMarks(exam.total_marks)} marks
                              </span>
                              <span>·</span>
                              <span className="font-mono tabular-nums">
                                {exam.duration_minutes} min
                              </span>
                              <span>·</span>
                              <span className="font-mono tabular-nums">
                                Cooldown {Math.round((exam.retake_cooldown_minutes / 60) * 10) / 10}h
                              </span>
                              <span>·</span>
                              <span>{formatReleasePolicyLabel(exam.result_release_policy)}</span>
                              <span>·</span>
                              <span className="font-mono tabular-nums text-[#013F32] dark:text-[#E7FE25] font-semibold">
                                {exam.attempt_count}{' '}
                                {exam.attempt_count === 1 ? 'attempt' : 'attempts'}
                              </span>
                            </div>

                            <h2 className="font-display text-base sm:text-lg font-bold text-[#161616] dark:text-[#FDFDFD] truncate">
                              {exam.title}
                            </h2>
                            {exam.description && (
                              <p className="text-xs sm:text-sm text-neutral-500 dark:text-neutral-400 line-clamp-2">
                                {exam.description}
                              </p>
                            )}
                          </div>

                          <div className="flex items-center gap-2.5 shrink-0">
                            {exam.status === 'published' && (
                              <button
                                type="button"
                                disabled={isToggling}
                                onClick={(e) => void handleQuickToggleOpenClose(e, exam)}
                                className={`min-h-[42px] px-3.5 rounded-xl text-xs font-semibold border inline-flex items-center gap-1.5 transition whitespace-nowrap ${
                                  exam.is_open !== false
                                    ? 'border-neutral-200 dark:border-white/15 bg-neutral-100/80 dark:bg-white/5 text-neutral-700 dark:text-neutral-200 hover:border-rose-400 hover:text-rose-700 dark:hover:text-rose-300'
                                    : 'border-[#013F32] bg-[#013F32] text-[#FDFDFD] dark:border-[#E7FE25] dark:bg-[#E7FE25] dark:text-[#161616]'
                                }`}
                              >
                                {exam.is_open !== false ? (
                                  <>
                                    <Lock className="w-3.5 h-3.5" />
                                    <span>{isToggling ? 'Closing...' : 'Close Quiz'}</span>
                                  </>
                                ) : (
                                  <>
                                    <Unlock className="w-3.5 h-3.5" />
                                    <span>{isToggling ? 'Opening...' : 'Open Quiz'}</span>
                                  </>
                                )}
                              </button>
                            )}
                            <span className="min-h-[42px] px-3 rounded-xl border border-neutral-200 dark:border-white/10 text-xs font-semibold text-[#161616] dark:text-[#FDFDFD] inline-flex items-center gap-1 whitespace-nowrap">
                              <span>Manage</span>
                              <ChevronRight className="w-4 h-4 text-neutral-400" />
                            </span>
                            {exam.status !== 'archived' && (
                              <button
                                type="button"
                                disabled={isToggling}
                                onClick={(e) => void handleArchiveExam(e, exam)}
                                title="Archive quiz and preserve its history"
                                aria-label={`Archive ${exam.title}`}
                                className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-neutral-200 px-3 text-xs font-semibold text-neutral-500 transition hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50 dark:border-white/10 dark:hover:bg-rose-950/30 dark:hover:text-rose-300"
                              >
                                <Trash2 className="h-4 w-4" />
                                <span>Archive</span>
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* TAB 2: STUDENTS & CLASSES ROSTER */}
            {activeTab === 'roster' && (
              <div className="space-y-8">
                {/* Students Section */}
                <section className="space-y-4">
                  <div className="flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <h1 className="font-display text-xl font-bold text-[#161616] dark:text-[#FDFDFD]">
                        Student Roster
                      </h1>
                      <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
                        Create student accounts or manage active quiz eligibility.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowCreateStudentModal(true)}
                      className="min-h-[44px] px-4 rounded-xl bg-[#013F32] text-[#FDFDFD] dark:bg-[#E7FE25] dark:text-[#161616] text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap"
                    >
                      <Plus className="w-4 h-4" />
                      <span>Add Student</span>
                    </button>
                  </div>

                  <div className="bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-3xl border border-neutral-200/90 dark:border-white/10 divide-y divide-neutral-200/70 dark:divide-white/10">
                    {students.length === 0 ? (
                      <div className="p-8 text-center text-sm text-neutral-500 dark:text-neutral-400">
                        No students registered yet.
                      </div>
                    ) : (
                      students.map((stu) => (
                        <div
                          key={stu.id}
                          className="p-4 sm:p-5 flex flex-wrap items-center justify-between gap-3"
                        >
                          <div>
                            <div className="text-sm font-bold text-[#161616] dark:text-[#FDFDFD]">
                              {stu.full_name}
                            </div>
                            <div className="text-xs text-neutral-500 dark:text-neutral-400 font-mono mt-0.5">
                              {stu.student_identifier ? `${stu.student_identifier} · ` : ''}
                              {stu.email.endsWith('@users.quizpocket.local')
                                ? stu.username || stu.full_name
                                : stu.email}{' '}
                              ·{' '}
                              <span
                                className={
                                  stu.account_status === 'active'
                                    ? 'text-[#013F32] dark:text-[#E7FE25] font-sans font-semibold'
                                    : 'text-rose-700 dark:text-rose-400 font-sans font-semibold'
                                }
                              >
                                {stu.account_status}
                              </span>
                            </div>
                          </div>

                          <button
                            type="button"
                            onClick={() => void handleToggleStudentAccountStatus(stu)}
                            className="min-h-[40px] px-3.5 rounded-xl border border-neutral-200 dark:border-white/15 text-xs font-semibold text-neutral-600 dark:text-neutral-300 hover:text-[#161616] dark:hover:text-[#FDFDFD] whitespace-nowrap"
                          >
                            {stu.account_status === 'active' ? 'Suspend' : 'Activate'}
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                </section>

                {/* Classes Section */}
                <section className="space-y-4">
                  <div className="flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <h2 className="font-display text-xl font-bold text-[#161616] dark:text-[#FDFDFD]">
                        Class Cohorts
                      </h2>
                      <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
                        Organize students into cohorts for targeted assessments.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowCreateClassModal(true)}
                      className="min-h-[44px] px-4 rounded-xl border border-[#013F32] dark:border-[#E7FE25] text-[#013F32] dark:text-[#E7FE25] text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap"
                    >
                      <Plus className="w-4 h-4" />
                      <span>Create Class</span>
                    </button>
                  </div>

                  <div className="bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-3xl border border-neutral-200/90 dark:border-white/10 divide-y divide-neutral-200/70 dark:divide-white/10">
                    {classes.length === 0 ? (
                      <div className="p-8 text-center text-sm text-neutral-500 dark:text-neutral-400">
                        No class cohorts created yet.
                      </div>
                    ) : (
                      classes.map((cls) => {
                        const activeMemberSet = new Set(
                          cls.members
                            .filter((m) => m.membership_status === 'active')
                            .map((m) => m.student_id)
                        );
                        return (
                          <div key={cls.id} className="p-5 space-y-3">
                            <div>
                              <h3 className="font-display text-base font-bold text-[#161616] dark:text-[#FDFDFD]">
                                {cls.name}
                              </h3>
                              {cls.description && (
                                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                                  {cls.description}
                                </p>
                              )}
                            </div>

                            <div className="flex flex-wrap gap-2 pt-1">
                              {students.map((stu) => {
                                const enrolled = activeMemberSet.has(stu.id);
                                return (
                                  <button
                                    key={stu.id}
                                    type="button"
                                    onClick={() =>
                                      void handleToggleClassMember(cls.id, stu.id, enrolled)
                                    }
                                    className={`min-h-[40px] px-3.5 rounded-xl text-xs font-semibold border transition whitespace-nowrap ${
                                      enrolled
                                        ? 'border-[#013F32] bg-[#013F32]/10 text-[#013F32] dark:border-[#E7FE25] dark:bg-[#E7FE25]/15 dark:text-[#E7FE25]'
                                        : 'border-neutral-200 dark:border-white/15 bg-[#FDFDFD] dark:bg-[#161616] text-neutral-500 dark:text-neutral-400 hover:text-[#161616] dark:hover:text-[#FDFDFD]'
                                    }`}
                                  >
                                    {stu.full_name} {enrolled ? '✓' : '+'}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </section>
              </div>
            )}

            {/* TAB 3: IMMUTABLE AUDIT LOGS */}
            {activeTab === 'audit' && (
              <div className="space-y-4">
                <div>
                  <h1 className="font-display text-xl sm:text-2xl font-bold tracking-tight text-[#161616] dark:text-[#FDFDFD]">
                    Audit Trail
                  </h1>
                  <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
                    Security log of quiz access changes, retake unlocks, submissions, and grading.
                  </p>
                </div>

                <div className="bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-3xl border border-neutral-200/90 dark:border-white/10 divide-y divide-neutral-200/70 dark:divide-white/10">
                  {auditLogs.map((log) => (
                    <div
                      key={log.id}
                      className="px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
                    >
                      <div>
                        <span className="font-mono font-semibold text-[#013F32] dark:text-[#E7FE25]">
                          {log.event_type || log.action || 'audit_event'}
                        </span>
                        <span className="mx-1.5 text-neutral-400">·</span>
                        <span className="text-neutral-600 dark:text-neutral-300">
                          {log.entity_type} ({log.actor_role})
                        </span>
                      </div>
                      <span className="font-mono tabular-nums text-neutral-400">
                        {formatDateTime(log.created_at)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* TAB 4: ADMIN ACCOUNT */}
            {activeTab === 'account' && (
              <div className="max-w-xl space-y-5">
                <div>
                  <h1 className="font-display text-xl sm:text-2xl font-bold tracking-tight text-[#161616] dark:text-[#FDFDFD]">
                    Administrator Account
                  </h1>
                  <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
                    Manage your instructor display details.
                  </p>
                </div>

                <div className="bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-3xl border border-neutral-200/90 dark:border-white/10 p-6 space-y-5">
                  <div className="text-sm pb-4 border-b border-neutral-200/70 dark:border-white/10">
                    <div className="text-xs text-neutral-500 dark:text-neutral-400">Username</div>
                    <div className="font-mono text-[#161616] dark:text-[#FDFDFD] mt-0.5">
                      {profile?.username || profile?.full_name}
                    </div>
                  </div>

                  <form onSubmit={handleSaveAdminName} className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-[#161616] dark:text-[#FDFDFD] mb-1.5">
                        Display Name
                      </label>
                      <input
                        type="text"
                        required
                        value={adminNameInput}
                        onChange={(e) => setAdminNameInput(e.target.value)}
                        className="w-full min-h-[48px] px-4 rounded-2xl border border-neutral-200 dark:border-white/15 bg-neutral-50/70 dark:bg-[#161616] text-base sm:text-sm text-[#161616] dark:text-[#FDFDFD] focus:outline-none focus:border-[#013F32] dark:focus:border-[#E7FE25]"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={savingAccount}
                      className="min-h-[46px] px-5 rounded-2xl bg-[#013F32] text-[#FDFDFD] dark:bg-[#E7FE25] dark:text-[#161616] text-sm font-semibold whitespace-nowrap"
                    >
                      {savingAccount ? 'Saving...' : 'Save Profile'}
                    </button>
                  </form>
                </div>
              </div>
            )}
          </>
        )}
      </main>

      {/* Mobile Bottom Navigation */}
      <nav
        aria-label="Mobile admin navigation"
        className="md:hidden fixed bottom-0 inset-x-0 z-20 bg-[#FDFDFD]/95 dark:bg-[#161616]/95 backdrop-blur border-t border-neutral-200 dark:border-white/10 px-2 pt-1.5 pb-[calc(0.35rem+env(safe-area-inset-bottom))]"
      >
        <div className="grid grid-cols-5 gap-1 max-w-xl mx-auto">
          {(
            [
              { id: 'home', label: 'Home', Icon: LayoutDashboard },
              { id: 'exams', label: 'Quizzes', Icon: ClipboardList },
              { id: 'roster', label: 'Roster', Icon: Users },
              { id: 'audit', label: 'Audit', Icon: Shield },
              { id: 'account', label: 'Account', Icon: User },
            ] as const
          ).map(({ id, label, Icon }) => {
            const active = activeTab === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setSelectedExamId(null);
                  setActiveTab(id);
                }}
                className={`min-h-[48px] rounded-xl flex flex-col items-center justify-center gap-0.5 text-[11px] font-semibold transition whitespace-nowrap ${
                  active
                    ? 'text-[#013F32] dark:text-[#E7FE25]'
                    : 'text-neutral-500 dark:text-neutral-400'
                }`}
              >
                <Icon className="w-5 h-5" />
                <span>{label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* Create Quiz Modal */}
      {showCreateExamModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-[#FDFDFD] dark:bg-[#1E1F1E] border border-neutral-200 dark:border-white/10 w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] sm:pb-6 max-h-[90dvh] overflow-y-auto space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg font-bold text-[#161616] dark:text-[#FDFDFD]">
                Create Quiz
              </h2>
              <button
                type="button"
                onClick={() => setShowCreateExamModal(false)}
                className="w-10 h-10 rounded-xl flex items-center justify-center text-neutral-400 hover:text-[#161616] dark:hover:text-[#FDFDFD]"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateExam} className="space-y-3.5">
              <div>
                <label className="block text-xs font-semibold text-neutral-600 dark:text-neutral-300 mb-1">
                  Quiz Title
                </label>
                <input
                  type="text"
                  required
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="e.g. HIM 105 Lecture 2"
                  className="w-full min-h-[46px] px-3.5 rounded-2xl border border-neutral-200 dark:border-white/15 bg-neutral-50/70 dark:bg-[#161616] text-base sm:text-sm text-[#161616] dark:text-[#FDFDFD]"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-neutral-600 dark:text-neutral-300 mb-1">
                  Description
                </label>
                <textarea
                  rows={2}
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  className="w-full p-3.5 rounded-2xl border border-neutral-200 dark:border-white/15 bg-neutral-50/70 dark:bg-[#161616] text-base sm:text-sm text-[#161616] dark:text-[#FDFDFD]"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-neutral-600 dark:text-neutral-300 mb-1">
                  Candidate Instructions
                </label>
                <textarea
                  rows={2}
                  value={newInstructions}
                  onChange={(e) => setNewInstructions(e.target.value)}
                  className="w-full p-3.5 rounded-2xl border border-neutral-200 dark:border-white/15 bg-neutral-50/70 dark:bg-[#161616] text-base sm:text-sm text-[#161616] dark:text-[#FDFDFD]"
                />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-neutral-600 dark:text-neutral-300 mb-1">
                    Minutes
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={720}
                    required
                    value={newDuration}
                    onChange={(e) => setNewDuration(e.target.value)}
                    className="w-full min-h-[46px] px-3 rounded-2xl border border-neutral-200 dark:border-white/15 bg-neutral-50/70 dark:bg-[#161616] text-base sm:text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-neutral-600 dark:text-neutral-300 mb-1">
                    Pass %
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    required
                    value={newPassingPct}
                    onChange={(e) => setNewPassingPct(e.target.value)}
                    className="w-full min-h-[46px] px-3 rounded-2xl border border-neutral-200 dark:border-white/15 bg-neutral-50/70 dark:bg-[#161616] text-base sm:text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-neutral-600 dark:text-neutral-300 mb-1">
                    Cooldown (min)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={10080}
                    required
                    value={newCooldownMinutes}
                    onChange={(e) => setNewCooldownMinutes(e.target.value)}
                    className="w-full min-h-[46px] px-3 rounded-2xl border border-neutral-200 dark:border-white/15 bg-neutral-50/70 dark:bg-[#161616] text-base sm:text-sm font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-neutral-600 dark:text-neutral-300 mb-1">
                    Max Attempts
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    required
                    value={newMaxAttempts}
                    onChange={(e) => setNewMaxAttempts(e.target.value)}
                    className="w-full min-h-[46px] px-3 rounded-2xl border border-neutral-200 dark:border-white/15 bg-neutral-50/70 dark:bg-[#161616] text-base sm:text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-neutral-600 dark:text-neutral-300 mb-1">
                    Result Release
                  </label>
                  <select
                    value={newPolicy}
                    onChange={(e) => setNewPolicy(e.target.value as ResultReleasePolicy)}
                    className="w-full min-h-[46px] px-3 rounded-2xl border border-neutral-200 dark:border-white/15 bg-neutral-50/70 dark:bg-[#161616] text-base sm:text-sm text-[#161616] dark:text-[#FDFDFD]"
                  >
                    <option value="immediate">Immediate</option>
                    <option value="after_window">After window</option>
                    <option value="manual">Manual release</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreateExamModal(false)}
                  className="min-h-[46px] rounded-2xl border border-neutral-200 dark:border-white/15 text-sm font-semibold text-neutral-700 dark:text-neutral-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creatingExam}
                  className="min-h-[46px] rounded-2xl bg-[#013F32] text-[#FDFDFD] dark:bg-[#E7FE25] dark:text-[#161616] text-sm font-semibold"
                >
                  {creatingExam ? 'Creating...' : 'Create Quiz'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Provision Student Modal */}
      {showCreateStudentModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-[#FDFDFD] dark:bg-[#1E1F1E] border border-neutral-200 dark:border-white/10 w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] sm:pb-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg font-bold text-[#161616] dark:text-[#FDFDFD]">
                Add Student Account
              </h2>
              <button
                type="button"
                onClick={() => setShowCreateStudentModal(false)}
                className="w-10 h-10 rounded-xl flex items-center justify-center text-neutral-400"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateStudent} className="space-y-3.5">
              <div>
                <label className="block text-xs font-semibold text-neutral-600 dark:text-neutral-300 mb-1">
                  Username
                </label>
                <input
                  type="text"
                  required
                  value={stuName}
                  onChange={(e) => setStuName(e.target.value)}
                  placeholder="Student username"
                  className="w-full min-h-[46px] px-3.5 rounded-2xl border border-neutral-200 dark:border-white/15 bg-neutral-50/70 dark:bg-[#161616] text-base sm:text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-neutral-600 dark:text-neutral-300 mb-1">
                  Student Identifier (Optional)
                </label>
                <input
                  type="text"
                  value={stuIdentifier}
                  onChange={(e) => setStuIdentifier(e.target.value)}
                  placeholder="e.g. AIM-2026-025"
                  className="w-full min-h-[46px] px-3.5 rounded-2xl border border-neutral-200 dark:border-white/15 bg-neutral-50/70 dark:bg-[#161616] text-base sm:text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-neutral-600 dark:text-neutral-300 mb-1">
                  Password (min 8 characters)
                </label>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={stuPassword}
                  onChange={(e) => setStuPassword(e.target.value)}
                  placeholder="Minimum 8 characters"
                  className="w-full min-h-[46px] px-3.5 rounded-2xl border border-neutral-200 dark:border-white/15 bg-neutral-50/70 dark:bg-[#161616] text-base sm:text-sm"
                />
              </div>

              <div className="grid grid-cols-2 gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreateStudentModal(false)}
                  className="min-h-[46px] rounded-2xl border border-neutral-200 dark:border-white/15 text-sm font-semibold text-neutral-700 dark:text-neutral-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creatingStudent}
                  className="min-h-[46px] rounded-2xl bg-[#013F32] text-[#FDFDFD] dark:bg-[#E7FE25] dark:text-[#161616] text-sm font-semibold"
                >
                  {creatingStudent ? 'Creating...' : 'Create Student'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Create Class Modal */}
      {showCreateClassModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-[#FDFDFD] dark:bg-[#1E1F1E] border border-neutral-200 dark:border-white/10 w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] sm:pb-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg font-bold text-[#161616] dark:text-[#FDFDFD]">
                Create Class Cohort
              </h2>
              <button
                type="button"
                onClick={() => setShowCreateClassModal(false)}
                className="w-10 h-10 rounded-xl flex items-center justify-center text-neutral-400"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateClass} className="space-y-3.5">
              <div>
                <label className="block text-xs font-semibold text-neutral-600 dark:text-neutral-300 mb-1">
                  Class Name
                </label>
                <input
                  type="text"
                  required
                  value={clsName}
                  onChange={(e) => setClsName(e.target.value)}
                  placeholder="e.g. AIM 105 Cohort"
                  className="w-full min-h-[46px] px-3.5 rounded-2xl border border-neutral-200 dark:border-white/15 bg-neutral-50/70 dark:bg-[#161616] text-base sm:text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-neutral-600 dark:text-neutral-300 mb-1">
                  Description
                </label>
                <textarea
                  rows={2}
                  value={clsDesc}
                  onChange={(e) => setClsDesc(e.target.value)}
                  className="w-full p-3.5 rounded-2xl border border-neutral-200 dark:border-white/15 bg-neutral-50/70 dark:bg-[#161616] text-base sm:text-sm"
                />
              </div>

              <div className="grid grid-cols-2 gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreateClassModal(false)}
                  className="min-h-[46px] rounded-2xl border border-neutral-200 dark:border-white/15 text-sm font-semibold text-neutral-700 dark:text-neutral-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creatingClass}
                  className="min-h-[46px] rounded-2xl bg-[#013F32] text-[#FDFDFD] dark:bg-[#E7FE25] dark:text-[#161616] text-sm font-semibold"
                >
                  {creatingClass ? 'Creating...' : 'Create Cohort'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
