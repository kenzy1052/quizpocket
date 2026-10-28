import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  Award,
  User,
  LogOut,
  Clock,
  Play,
  Eye,
  CheckCircle2,
  Lock,
  X,
  RefreshCw,
  LayoutDashboard,
  ArrowRight,
  Sparkles,
} from 'lucide-react';
import { BrandMark } from '../BrandMark.tsx';
import { ThemeToggle } from '../ThemeToggle.tsx';
import { useAuth } from '../../context/AuthContext.tsx';
import { ApiClientError, apiRequest } from '../../lib/api.ts';
import {
  formatDateTime,
  formatDurationSeconds,
  formatMarks,
  formatReleasePolicyLabel,
  splitCountdownParts,
} from '../../lib/format.ts';
import {
  StartOrResumeAttemptResult,
  StudentEligibleExam,
  StudentReleasedResultRow,
  SubmitAttemptResult,
} from '../../types/frontend.ts';
import { ExamRunner } from './ExamRunner.tsx';
import { AttemptReviewView } from './AttemptReviewView.tsx';

type StudentTab = 'home' | 'exams' | 'results' | 'profile';

export function StudentWorkspace() {
  const { profile, signOut, updateFullName } = useAuth();
  const [activeTab, setActiveTab] = useState<StudentTab>('home');

  const [exams, setExams] = useState<StudentEligibleExam[]>([]);
  const [results, setResults] = useState<StudentReleasedResultRow[]>([]);
  const [loadingData, setLoadingData] = useState<boolean>(true);
  const [dataError, setDataError] = useState<string | null>(null);

  // Server clock offset & live 1s ticker for 3-hour retake cooldowns
  const [serverOffsetMs, setServerOffsetMs] = useState<number>(0);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const autoRefreshedCooldownIdsRef = useRef<Set<string>>(new Set());

  // Pre-exam instructions modal & direct launch state
  const [selectedExamForStart, setSelectedExamForStart] = useState<StudentEligibleExam | null>(
    null
  );
  const [startingExamId, setStartingExamId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  // Active exam runner & review states
  const [activeAttemptId, setActiveAttemptId] = useState<string | null>(null);
  const [reviewAttemptId, setReviewAttemptId] = useState<string | null>(null);
  const [recentSubmission, setRecentSubmission] = useState<{
    examTitle: string;
    data: SubmitAttemptResult;
  } | null>(null);

  // Profile form state
  const [fullNameInput, setFullNameInput] = useState<string>(profile?.full_name ?? '');
  const [savingProfile, setSavingProfile] = useState<boolean>(false);
  const [profileSavedMsg, setProfileSavedMsg] = useState<string | null>(null);
  const [profileErrMsg, setProfileErrMsg] = useState<string | null>(null);

  const loadStudentDashboard = useCallback(async () => {
    setLoadingData(true);
    setDataError(null);
    try {
      const [examsRes, resultsRes] = await Promise.all([
        apiRequest<StudentEligibleExam[]>('/student/exams'),
        apiRequest<StudentReleasedResultRow[]>('/student/results'),
      ]);
      const list = Array.isArray(examsRes) ? examsRes : [];
      if (list.length > 0 && list[0].server_now) {
        const offset = new Date(list[0].server_now).getTime() - Date.now();
        if (Number.isFinite(offset)) {
          setServerOffsetMs(offset);
        }
      }
      setExams(list);
      setResults(Array.isArray(resultsRes) ? resultsRes : []);
    } catch (err) {
      setDataError(
        err instanceof ApiClientError ? err.message : 'Unable to load your quizzes.'
      );
    } finally {
      setLoadingData(false);
    }
  }, []);

  useEffect(() => {
    void loadStudentDashboard();
  }, [loadStudentDashboard]);

  // Live 1-second ticker whenever at least one quiz is in cooldown
  useEffect(() => {
    const hasCooldown = exams.some(
      (e) => e.availability_state === 'cooldown' && e.next_eligible_attempt_at
    );
    if (!hasCooldown) return;

    const timer = window.setInterval(() => {
      const current = Date.now();
      setNowMs(current);

      const estimatedServerNow = current + serverOffsetMs;
      for (const exam of exams) {
        if (exam.availability_state === 'cooldown' && exam.next_eligible_attempt_at) {
          const unlockKey = `${exam.id}:${exam.next_eligible_attempt_at}`;
          const targetMs = new Date(exam.next_eligible_attempt_at).getTime();
          if (
            Number.isFinite(targetMs) &&
            estimatedServerNow >= targetMs &&
            !autoRefreshedCooldownIdsRef.current.has(unlockKey)
          ) {
            autoRefreshedCooldownIdsRef.current.add(unlockKey);
            void loadStudentDashboard();
            break;
          }
        }
      }
    }, 1000);

    return () => window.clearInterval(timer);
  }, [exams, serverOffsetMs, loadStudentDashboard]);

  useEffect(() => {
    if (profile?.full_name) {
      setFullNameInput(profile.full_name);
    }
  }, [profile?.full_name]);

  async function handleConfirmStartOrResume(exam: StudentEligibleExam) {
    setStartingExamId(exam.id);
    setStartError(null);
    setDataError(null);
    try {
      const started = await apiRequest<StartOrResumeAttemptResult>(
        `/student/exams/${exam.id}/attempts`,
        { method: 'POST' }
      );
      setSelectedExamForStart(null);
      setRecentSubmission(null);
      setActiveAttemptId(started.attempt_id);
    } catch (err) {
      const msg =
        err instanceof ApiClientError ? err.message : 'Unable to start quiz attempt right now.';
      setStartError(msg);
      if (!selectedExamForStart) {
        setDataError(msg);
      }
      await loadStudentDashboard();
    } finally {
      setStartingExamId(null);
    }
  }

  async function handleProfileSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSavingProfile(true);
    setProfileSavedMsg(null);
    setProfileErrMsg(null);
    try {
      await updateFullName(fullNameInput);
      setProfileSavedMsg('Your display name has been updated.');
    } catch (err) {
      setProfileErrMsg(
        err instanceof ApiClientError ? err.message : 'Unable to update your profile.'
      );
    } finally {
      setSavingProfile(false);
    }
  }

  if (activeAttemptId) {
    return (
      <ExamRunner
        attemptId={activeAttemptId}
        onSubmitted={(submission, examTitle) => {
          setActiveAttemptId(null);
          setRecentSubmission({ examTitle, data: submission });
          setActiveTab('results');
          if (submission.result_released && submission.allow_review) {
            setReviewAttemptId(submission.attempt_id);
          }
          void loadStudentDashboard();
        }}
        onExitToDashboard={() => {
          setActiveAttemptId(null);
          void loadStudentDashboard();
        }}
      />
    );
  }

  function getCooldownRemainingSeconds(exam: StudentEligibleExam): number {
    if (!exam.next_eligible_attempt_at) return 0;
    const targetMs = new Date(exam.next_eligible_attempt_at).getTime();
    if (!Number.isFinite(targetMs)) return 0;
    return Math.max(0, Math.ceil((targetMs - (nowMs + serverOffsetMs)) / 1000));
  }

  function renderAvailabilityLabel(exam: StudentEligibleExam) {
    if (exam.is_open === false) {
      return (
        <span className="text-rose-700 dark:text-rose-400 font-semibold">
          Closed by Instructor
        </span>
      );
    }
    switch (exam.availability_state) {
      case 'in_progress':
        return (
          <span className="text-[#013F32] dark:text-[#E7FE25] font-semibold">
            Attempt in progress
          </span>
        );
      case 'available':
        return (
          <span className="text-[#013F32] dark:text-[#E7FE25] font-semibold">
            Open · Ready to start
          </span>
        );
      case 'upcoming':
        return (
          <span className="text-neutral-600 dark:text-neutral-400">
            Opens {formatDateTime(exam.scheduled_start_at)}
          </span>
        );
      case 'cooldown':
        return (
          <span className="text-amber-700 dark:text-amber-400 font-semibold">
            3-hour retake cooldown active
          </span>
        );
      case 'attempts_exhausted':
        return (
          <span className="text-neutral-500 dark:text-neutral-400">
            Maximum attempts completed
          </span>
        );
      case 'closed':
        return (
          <span className="text-rose-700 dark:text-rose-400 font-semibold">
            Closed
          </span>
        );
    }
  }

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
              <span className="text-[11px] text-neutral-500 dark:text-neutral-400 block mt-1">
                Student Workspace
              </span>
            </div>
          </div>

          {/* Desktop Navigation */}
          <nav className="hidden md:flex items-center gap-1" aria-label="Student sections">
            {(
              [
                { id: 'home', label: 'Home' },
                { id: 'exams', label: 'Quizzes' },
                { id: 'results', label: 'Results & Review' },
                { id: 'profile', label: 'Account' },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setReviewAttemptId(null);
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
              <div className="text-[11px] font-mono text-neutral-500 dark:text-neutral-400">
                {profile?.username || profile?.student_identifier || 'Student'}
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
        {reviewAttemptId ? (
          <AttemptReviewView
            attemptId={reviewAttemptId}
            onBack={() => setReviewAttemptId(null)}
          />
        ) : (
          <>
            {activeTab === 'home' && (
              <div className="space-y-7">
                <section className="dashboard-hero relative overflow-hidden rounded-[2rem] border border-[#15B8A6]/15 p-7 sm:p-10">
                  <div className="relative z-10 max-w-2xl">
                    <div className="inline-flex items-center gap-2 rounded-full bg-white/75 px-3 py-1.5 text-xs font-semibold text-[#15A997] dark:bg-white/10 dark:text-[#B9F4E8]">
                      <Sparkles className="h-3.5 w-3.5" />
                      Your learning space
                    </div>
                    <h1 className="mt-5 font-display text-3xl font-bold tracking-tight text-[#202A39] dark:text-white sm:text-4xl">
                      Welcome back, {profile?.username || profile?.full_name || 'Learner'}.
                    </h1>
                    <p className="mt-3 max-w-xl text-sm leading-relaxed text-neutral-600 dark:text-neutral-300 sm:text-base">
                      Your next step is ready when you are. Pick a quiz, take your time, and keep
                      building confidence.
                    </p>
                    <button
                      type="button"
                      onClick={() => setActiveTab('exams')}
                      className="mt-6 inline-flex min-h-12 items-center gap-2 rounded-2xl bg-[#013F32] px-5 text-sm font-semibold text-white transition hover:-translate-y-0.5"
                    >
                      Explore quizzes
                      <ArrowRight className="h-4 w-4" />
                    </button>
                  </div>
                  <div aria-hidden="true" className="pointer-events-none absolute -right-10 -bottom-28 hidden h-72 w-72 rounded-full border-[2.5rem] border-white/40 sm:block" />
                </section>

                <section aria-label="Learning summary" className="grid gap-4 sm:grid-cols-3">
                  {[
                    { label: 'Your quizzes', value: loadingData ? '—' : exams.length, Icon: BookOpen },
                    { label: 'Quizzes completed', value: loadingData ? '—' : results.length, Icon: CheckCircle2 },
                    {
                      label: 'Results released',
                      value: loadingData
                        ? '—'
                        : results.filter((result) => result.percentage !== null).length,
                      Icon: Award,
                    },
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

                <section className="rounded-2xl border border-neutral-200/80 bg-white p-5 sm:p-6 dark:border-white/10 dark:bg-[#1E1F1E]">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 className="font-display text-lg font-bold text-[#202A39] dark:text-white">
                        Your quizzes
                      </h2>
                      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                        Clear details, one easy place to begin.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setActiveTab('exams')}
                      className="inline-flex min-h-10 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold text-[#15A997] hover:bg-[#E8FAF5] dark:text-[#B9F4E8] dark:hover:bg-white/5"
                    >
                      View all
                      <ArrowRight className="h-4 w-4" />
                    </button>
                  </div>
                  {loadingData ? (
                    <p className="mt-5 text-sm text-neutral-500 dark:text-neutral-400">Loading your quizzes...</p>
                  ) : exams.length ? (
                    <div className="mt-5 grid gap-3 md:grid-cols-2">
                      {exams.slice(0, 2).map((exam) => (
                        <button
                          key={exam.id}
                          type="button"
                          onClick={() => {
                            setStartError(null);
                            setSelectedExamForStart(exam);
                          }}
                          className="group rounded-2xl border border-neutral-200/80 p-4 text-left transition hover:border-[#15B8A6]/50 hover:bg-[#F4FBF9] dark:border-white/10 dark:hover:bg-white/[0.03]"
                        >
                          <span className="text-xs font-medium text-[#15A997] dark:text-[#B9F4E8]">
                            {exam.duration_minutes} min <span aria-hidden="true">·</span> {formatMarks(exam.total_marks)} marks
                          </span>
                          <span className="mt-2 block font-display font-bold text-[#202A39] dark:text-white">
                            {exam.title}
                          </span>
                          <span className="mt-1 block line-clamp-2 text-sm text-neutral-500 dark:text-neutral-400">
                            {exam.description || 'Open this quiz to review the details and get started.'}
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-5 rounded-xl bg-[#F4F8F7] p-4 text-sm text-neutral-500 dark:bg-white/5 dark:text-neutral-400">
                      No quizzes have been assigned yet. Check back soon.
                    </p>
                  )}
                </section>
              </div>
            )}

            {/* Post-Submission Confirmation Card */}
            {recentSubmission && (
              <div className="mb-6 bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-3xl border border-[#013F32]/25 dark:border-[#E7FE25]/30 p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2 text-[#013F32] dark:text-[#E7FE25] text-xs font-semibold">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Quiz Submitted</span>
                  </div>
                  <h2 className="font-display text-base sm:text-lg font-bold text-[#161616] dark:text-[#FDFDFD]">
                    {recentSubmission.examTitle}
                  </h2>
                  {recentSubmission.data.result_released && recentSubmission.data.result ? (
                    <p className="text-sm text-neutral-600 dark:text-neutral-300">
                      Score:{' '}
                      <strong className="font-mono tabular-nums text-[#161616] dark:text-[#FDFDFD]">
                        {formatMarks(recentSubmission.data.result.marks_obtained)} /{' '}
                        {formatMarks(recentSubmission.data.result.total_marks)} (
                        {Number(recentSubmission.data.result.percentage).toFixed(1)}%)
                      </strong>{' '}
                      ·{' '}
                      <span
                        className={
                          recentSubmission.data.result.passed
                            ? 'text-[#013F32] dark:text-[#E7FE25] font-semibold'
                            : 'text-rose-700 dark:text-rose-400 font-semibold'
                        }
                      >
                        {recentSubmission.data.result.passed ? 'Passed' : 'Not Passed'}
                      </span>
                    </p>
                  ) : (
                    <p className="text-sm text-neutral-600 dark:text-neutral-300">
                      Your submission has been recorded. Scores will appear once released by your
                      instructor.
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {recentSubmission.data.result_released &&
                    recentSubmission.data.allow_review && (
                      <button
                        type="button"
                        onClick={() => setReviewAttemptId(recentSubmission.data.attempt_id)}
                        className="min-h-[44px] px-4 rounded-xl bg-[#013F32] text-[#FDFDFD] dark:bg-[#E7FE25] dark:text-[#161616] text-xs font-semibold whitespace-nowrap"
                      >
                        Review Answers
                      </button>
                    )}
                  <button
                    type="button"
                    onClick={() => setRecentSubmission(null)}
                    className="min-h-[44px] px-3 rounded-xl text-xs font-medium text-neutral-500 hover:text-[#161616] dark:hover:text-[#FDFDFD]"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}

            {dataError && (
              <div className="mb-6 rounded-2xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800/60 p-4 flex items-center justify-between gap-3 text-sm text-rose-800 dark:text-rose-200">
                <span>{dataError}</span>
                <button
                  type="button"
                  onClick={() => void loadStudentDashboard()}
                  className="min-h-[40px] px-3 rounded-xl bg-[#FDFDFD] dark:bg-[#1E1F1E] border border-rose-200 dark:border-rose-700 text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Retry</span>
                </button>
              </div>
            )}

            {/* TAB 1: AVAILABLE QUIZZES */}
            {activeTab === 'exams' && (
              <div className="space-y-5">
                <div className="flex items-end justify-between gap-4">
                  <div>
                    <h1 className="font-display text-xl sm:text-2xl font-bold tracking-tight text-[#161616] dark:text-[#FDFDFD]">
                      Available Quizzes
                    </h1>
                    <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
                      Start an open quiz below. Completed quizzes enter a 3-hour cooldown unless
                      reopened by your instructor.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void loadStudentDashboard()}
                    className="min-h-[44px] px-3.5 rounded-xl border border-neutral-200 dark:border-white/15 bg-[#FDFDFD] dark:bg-[#1E1F1E] text-xs font-semibold text-neutral-700 dark:text-neutral-300 hover:border-[#013F32] dark:hover:border-[#E7FE25] inline-flex items-center gap-1.5 whitespace-nowrap transition"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${loadingData ? 'animate-spin' : ''}`} />
                    <span>Refresh</span>
                  </button>
                </div>

                {loadingData ? (
                  <div className="bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-3xl border border-neutral-200/90 dark:border-white/10 p-10 text-center text-sm text-neutral-500 dark:text-neutral-400">
                    Loading available quizzes...
                  </div>
                ) : exams.length === 0 ? (
                  <div className="bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-3xl border border-neutral-200/90 dark:border-white/10 p-10 text-center space-y-2">
                    <BookOpen className="w-7 h-7 text-neutral-400 mx-auto" />
                    <h2 className="font-display text-base font-bold text-[#161616] dark:text-[#FDFDFD]">
                      No Open Quizzes Right Now
                    </h2>
                    <p className="text-sm text-neutral-500 dark:text-neutral-400 max-w-md mx-auto">
                      Check back when your instructor opens a quiz session.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {exams.map((exam) => {
                      const canLaunch =
                        exam.is_open !== false &&
                        (exam.availability_state === 'available' ||
                          exam.availability_state === 'in_progress');
                      const isCooldown = exam.availability_state === 'cooldown';
                      const cooldownSec = isCooldown ? getCooldownRemainingSeconds(exam) : 0;
                      const cdParts = splitCountdownParts(cooldownSec);
                      const isLaunchingThis = startingExamId === exam.id;

                      const latestReviewableResult = results.find(
                        (r) => r.exam_id === exam.id && r.result_released && r.allow_review
                      );

                      return (
                        <div
                          key={exam.id}
                          className="bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-3xl border border-neutral-200/90 dark:border-white/10 p-5 sm:p-7 flex flex-col lg:flex-row lg:items-center justify-between gap-6"
                        >
                          <div className="space-y-2.5 max-w-2xl">
                            <div className="text-xs text-neutral-500 dark:text-neutral-400 flex flex-wrap items-center gap-x-2 gap-y-1">
                              {renderAvailabilityLabel(exam)}
                              <span>·</span>
                              <span className="font-mono tabular-nums">
                                {exam.duration_minutes} min
                              </span>
                              <span>·</span>
                              <span className="font-mono tabular-nums">
                                {formatMarks(exam.total_marks)} marks
                              </span>
                              <span>·</span>
                              <span className="font-mono tabular-nums">
                                Pass {formatMarks(exam.passing_percentage)}%
                              </span>
                              {exam.attempts_used > 0 && (
                                <>
                                  <span>·</span>
                                  <span className="font-mono tabular-nums">
                                    Completed {exam.attempts_used}{' '}
                                    {exam.attempts_used === 1 ? 'time' : 'times'}
                                  </span>
                                </>
                              )}
                            </div>

                            <h2 className="font-display text-lg sm:text-xl font-bold text-[#161616] dark:text-[#FDFDFD] leading-snug flex flex-wrap items-center gap-2">
                              {exam.title}
                              {exam.attempts_used === 0 &&
                                exam.created_at &&
                                Date.now() - new Date(exam.created_at).getTime() <
                                  14 * 24 * 60 * 60 * 1000 && (
                                  <span className="text-[10px] font-bold uppercase tracking-wider rounded-full bg-[#E7FE25] text-[#013F32] px-2 py-0.5">
                                    New
                                  </span>
                                )}
                            </h2>

                            {exam.description && (
                              <p className="text-sm text-neutral-600 dark:text-neutral-300 leading-relaxed">
                                {exam.description}
                              </p>
                            )}

                            {isCooldown && cooldownSec > 0 && (
                              <div className="pt-2 space-y-2">
                                <div className="inline-flex items-center gap-2 rounded-2xl bg-[#013F32] text-[#FDFDFD] px-4 py-3">
                                  <Clock className="w-4 h-4 text-[#E7FE25] shrink-0 mr-1" />
                                  <div className="flex items-center gap-1.5 font-mono tabular-nums">
                                    <span className="px-2 py-1 rounded-lg bg-black/30 text-[#E7FE25] text-sm font-semibold">
                                      {cdParts.hours}h
                                    </span>
                                    <span className="text-[#FDFDFD]/60">:</span>
                                    <span className="px-2 py-1 rounded-lg bg-black/30 text-[#E7FE25] text-sm font-semibold">
                                      {cdParts.minutes}m
                                    </span>
                                    <span className="text-[#FDFDFD]/60">:</span>
                                    <span className="px-2 py-1 rounded-lg bg-black/30 text-[#E7FE25] text-sm font-semibold">
                                      {cdParts.seconds}s
                                    </span>
                                  </div>
                                </div>
                                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                                  Quiz reopens automatically at{' '}
                                  {formatDateTime(exam.next_eligible_attempt_at)} or immediately if
                                  unlocked by your instructor.
                                </p>
                              </div>
                            )}
                          </div>

                          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 shrink-0">
                            {latestReviewableResult && (
                              <button
                                type="button"
                                onClick={() => setReviewAttemptId(latestReviewableResult.attempt_id)}
                                className="w-full sm:w-auto min-h-[48px] px-5 rounded-2xl border border-[#013F32] dark:border-[#E7FE25] text-[#013F32] dark:text-[#E7FE25] hover:bg-[#013F32]/5 dark:hover:bg-[#E7FE25]/10 text-xs sm:text-sm font-semibold inline-flex items-center justify-center gap-2 transition whitespace-nowrap"
                              >
                                <Eye className="w-4 h-4" />
                                <span>
                                  Score ({formatMarks(latestReviewableResult.marks_obtained)}/
                                  {formatMarks(latestReviewableResult.total_marks)}) & Review
                                </span>
                              </button>
                            )}
                            {canLaunch ? (
                              <>
                                <button
                                  type="button"
                                  disabled={isLaunchingThis}
                                  onClick={() => {
                                    if (exam.availability_state === 'in_progress') {
                                      void handleConfirmStartOrResume(exam);
                                    } else {
                                      setStartError(null);
                                      setSelectedExamForStart(exam);
                                    }
                                  }}
                                  className="w-full sm:w-auto min-h-[50px] px-6 rounded-2xl bg-[#013F32] hover:bg-[#025342] text-[#FDFDFD] dark:bg-[#E7FE25] dark:hover:bg-[#d8ef1a] dark:text-[#161616] text-sm font-semibold inline-flex items-center justify-center gap-2 transition whitespace-nowrap disabled:opacity-60"
                                >
                                  <Play className="w-4 h-4 fill-current" />
                                  <span>
                                    {isLaunchingThis
                                      ? 'Starting...'
                                      : exam.availability_state === 'in_progress'
                                        ? 'Resume Quiz'
                                        : exam.attempts_used > 0
                                          ? 'Retake Quiz'
                                          : 'Start Quiz'}
                                  </span>
                                </button>
                              </>
                            ) : (
                              <div className="min-h-[48px] px-5 rounded-2xl border border-neutral-200 dark:border-white/10 bg-neutral-100/80 dark:bg-white/[0.04] text-neutral-500 dark:text-neutral-400 text-xs font-semibold inline-flex items-center justify-center gap-2 whitespace-nowrap">
                                <Lock className="w-4 h-4" />
                                <span>
                                  {exam.is_open === false
                                    ? 'Closed by Instructor'
                                    : isCooldown
                                      ? 'Locked for 3h Cooldown'
                                      : 'Unavailable'}
                                </span>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* TAB 2: RELEASED RESULTS & REVIEW */}
            {activeTab === 'results' && (
              <div className="space-y-5">
                <div>
                  <h1 className="font-display text-xl sm:text-2xl font-bold tracking-tight text-[#161616] dark:text-[#FDFDFD]">
                    Quiz Results
                  </h1>
                  <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
                    Submitted attempts and official scores.
                  </p>
                </div>

                {loadingData ? (
                  <div className="bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-3xl border border-neutral-200/90 dark:border-white/10 p-10 text-center text-sm text-neutral-500 dark:text-neutral-400">
                    Loading results...
                  </div>
                ) : results.length === 0 ? (
                  <div className="bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-3xl border border-neutral-200/90 dark:border-white/10 p-10 text-center space-y-2">
                    <Award className="w-7 h-7 text-neutral-400 mx-auto" />
                    <h2 className="font-display text-base font-bold text-[#161616] dark:text-[#FDFDFD]">
                      No Submitted Attempts Yet
                    </h2>
                    <p className="text-sm text-neutral-500 dark:text-neutral-400 max-w-md mx-auto">
                      Complete a quiz to view your score breakdown and answer review here.
                    </p>
                  </div>
                ) : (
                  <div className="bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-3xl border border-neutral-200/90 dark:border-white/10 divide-y divide-neutral-200/70 dark:divide-white/10">
                    {results.map((r) => (
                      <div
                        key={r.attempt_id}
                        className="p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                      >
                        <div className="space-y-1.5">
                          <div className="text-xs text-neutral-500 dark:text-neutral-400 flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="font-mono tabular-nums font-semibold text-[#161616] dark:text-[#FDFDFD]">
                              Attempt #{r.attempt_number}
                            </span>
                            <span>·</span>
                            <span>Submitted {formatDateTime(r.submitted_at)}</span>
                            <span>·</span>
                            <span className="font-mono tabular-nums">
                              Duration {formatDurationSeconds(r.time_taken_seconds)}
                            </span>
                          </div>

                          <h2 className="font-display text-base font-bold text-[#161616] dark:text-[#FDFDFD]">
                            {r.exam_title}
                          </h2>

                          {r.result_released ? (
                            <div className="text-sm">
                              <span className="font-mono tabular-nums font-bold text-[#161616] dark:text-[#FDFDFD]">
                                {formatMarks(r.marks_obtained)} / {formatMarks(r.total_marks)} marks
                              </span>
                              <span className="mx-1.5 text-neutral-400">·</span>
                              <span className="font-mono tabular-nums font-semibold text-[#013F32] dark:text-[#E7FE25]">
                                {Number(r.percentage ?? 0).toFixed(1)}%
                              </span>
                              <span className="mx-1.5 text-neutral-400">·</span>
                              <span
                                className={
                                  r.passed
                                    ? 'text-[#013F32] dark:text-[#E7FE25] font-semibold'
                                    : 'text-rose-700 dark:text-rose-400 font-semibold'
                                }
                              >
                                {r.passed ? 'Passed' : 'Below Passing Threshold'}
                              </span>
                            </div>
                          ) : (
                            <p className="text-xs text-amber-700 dark:text-amber-400">
                              Submitted — Official marks are pending instructor release.
                            </p>
                          )}
                        </div>

                        {r.result_released && r.allow_review && (
                          <button
                            type="button"
                            onClick={() => setReviewAttemptId(r.attempt_id)}
                            className="min-h-[44px] px-4 rounded-xl border border-neutral-200 dark:border-white/15 hover:border-[#013F32] dark:hover:border-[#E7FE25] text-xs font-semibold text-[#013F32] dark:text-[#E7FE25] inline-flex items-center justify-center gap-1.5 shrink-0 whitespace-nowrap transition"
                          >
                            <Eye className="w-4 h-4" />
                            <span>Review Answers</span>
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* TAB 3: STUDENT PROFILE */}
            {activeTab === 'profile' && (
              <div className="max-w-xl space-y-5">
                <div>
                  <h1 className="font-display text-xl sm:text-2xl font-bold tracking-tight text-[#161616] dark:text-[#FDFDFD]">
                    Student Account
                  </h1>
                  <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
                    Manage how your name appears on quiz submissions.
                  </p>
                </div>

                <div className="bg-[#FDFDFD] dark:bg-[#1E1F1E] rounded-3xl border border-neutral-200/90 dark:border-white/10 p-6 space-y-5">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pb-5 border-b border-neutral-200/70 dark:border-white/10 text-sm">
                    <div>
                      <div className="text-xs text-neutral-500 dark:text-neutral-400">Username</div>
                      <div className="font-mono text-[#161616] dark:text-[#FDFDFD] mt-0.5 break-all">
                        {profile?.username || profile?.full_name}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-neutral-500 dark:text-neutral-400">
                        Student Identifier
                      </div>
                      <div className="font-mono text-[#161616] dark:text-[#FDFDFD] mt-0.5">
                        {profile?.student_identifier ?? 'Active Candidate'}
                      </div>
                    </div>
                  </div>

                  {profileSavedMsg && (
                    <div className="rounded-2xl bg-[#013F32]/10 dark:bg-[#E7FE25]/15 border border-[#013F32]/25 dark:border-[#E7FE25]/30 px-4 py-3 text-xs text-[#013F32] dark:text-[#E7FE25] font-medium">
                      {profileSavedMsg}
                    </div>
                  )}

                  {profileErrMsg && (
                    <div className="rounded-2xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800/60 px-4 py-3 text-xs text-rose-800 dark:text-rose-200">
                      {profileErrMsg}
                    </div>
                  )}

                  <form onSubmit={handleProfileSubmit} className="space-y-4">
                    <div>
                      <label
                        htmlFor="student-fullname"
                        className="block text-sm font-medium text-[#161616] dark:text-[#FDFDFD] mb-1.5"
                      >
                        Display Name
                      </label>
                      <input
                        id="student-fullname"
                        type="text"
                        required
                        maxLength={200}
                        value={fullNameInput}
                        onChange={(e) => setFullNameInput(e.target.value)}
                        className="w-full min-h-[48px] px-4 rounded-2xl border border-neutral-200 dark:border-white/15 bg-neutral-50/70 dark:bg-[#161616] text-base sm:text-sm text-[#161616] dark:text-[#FDFDFD] focus:outline-none focus:border-[#013F32] dark:focus:border-[#E7FE25]"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={savingProfile}
                      className="min-h-[46px] px-5 rounded-2xl bg-[#013F32] hover:bg-[#025342] text-[#FDFDFD] dark:bg-[#E7FE25] dark:hover:bg-[#d8ef1a] dark:text-[#161616] text-sm font-semibold disabled:opacity-60 whitespace-nowrap transition"
                    >
                      {savingProfile ? 'Saving...' : 'Save Changes'}
                    </button>
                  </form>
                </div>
              </div>
            )}
          </>
        )}
      </main>

      {/* Mobile Bottom Tab Bar */}
      {!reviewAttemptId && (
        <nav
          aria-label="Mobile navigation"
          className="md:hidden fixed bottom-0 inset-x-0 z-20 bg-[#FDFDFD]/95 dark:bg-[#161616]/95 backdrop-blur border-t border-neutral-200 dark:border-white/10 px-2 pt-1.5 pb-[calc(0.35rem+env(safe-area-inset-bottom))]"
        >
          <div className="grid grid-cols-4 gap-1 max-w-md mx-auto">
            {(
              [
                { id: 'home', label: 'Home', Icon: LayoutDashboard },
                { id: 'exams', label: 'Quizzes', Icon: BookOpen },
                { id: 'results', label: 'Results', Icon: Award },
                { id: 'profile', label: 'Account', Icon: User },
              ] as const
            ).map(({ id, label, Icon }) => {
              const active = activeTab === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setActiveTab(id)}
                  className={`min-h-[48px] rounded-xl flex flex-col items-center justify-center gap-0.5 text-xs font-semibold transition whitespace-nowrap ${
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
      )}

      {/* Pre-Quiz Briefing & Instant Start Sheet */}
      {selectedExamForStart && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-[#FDFDFD] dark:bg-[#1E1F1E] border border-neutral-200 dark:border-white/10 w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] sm:pb-6 space-y-5 max-h-[90dvh] overflow-y-auto">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-[#013F32] dark:text-[#E7FE25]">
                  Quiz Briefing
                </p>
                <h2 className="font-display text-lg font-bold text-[#161616] dark:text-[#FDFDFD] mt-1">
                  {selectedExamForStart.title}
                </h2>
              </div>
              <button
                type="button"
                disabled={startingExamId !== null}
                onClick={() => setSelectedExamForStart(null)}
                className="w-10 h-10 -mr-2 -mt-1 rounded-xl flex items-center justify-center text-neutral-400 hover:text-[#161616] dark:hover:text-[#FDFDFD]"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3 rounded-2xl bg-neutral-100/80 dark:bg-[#161616] border border-neutral-200/80 dark:border-white/10 p-4 text-xs">
              <div>
                <span className="text-neutral-500 dark:text-neutral-400 block">Time Limit</span>
                <span className="font-mono tabular-nums font-bold text-sm text-[#161616] dark:text-[#FDFDFD] mt-0.5 flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 text-[#013F32] dark:text-[#E7FE25]" />
                  {selectedExamForStart.duration_minutes} minutes
                </span>
              </div>
              <div>
                <span className="text-neutral-500 dark:text-neutral-400 block">Total Marks</span>
                <span className="font-mono tabular-nums font-bold text-sm text-[#161616] dark:text-[#FDFDFD] mt-0.5 block">
                  {formatMarks(selectedExamForStart.total_marks)} marks (Pass{' '}
                  {formatMarks(selectedExamForStart.passing_percentage)}%)
                </span>
              </div>
              <div>
                <span className="text-neutral-500 dark:text-neutral-400 block">
                  Retake Cooldown
                </span>
                <span className="font-mono tabular-nums font-semibold text-[#161616] dark:text-[#FDFDFD] mt-0.5 block">
                  {selectedExamForStart.retake_cooldown_minutes >= 60
                    ? `${Math.round((selectedExamForStart.retake_cooldown_minutes / 60) * 10) / 10} hours after finish`
                    : `${selectedExamForStart.retake_cooldown_minutes} min`}
                </span>
              </div>
              <div>
                <span className="text-neutral-500 dark:text-neutral-400 block">Result Policy</span>
                <span className="font-semibold text-[#161616] dark:text-[#FDFDFD] mt-0.5 block">
                  {formatReleasePolicyLabel(selectedExamForStart.result_release_policy)}
                </span>
              </div>
            </div>

            {selectedExamForStart.instructions && (
              <div className="space-y-1.5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                  Instructions
                </h3>
                <p className="text-sm text-neutral-700 dark:text-neutral-300 leading-relaxed whitespace-pre-wrap">
                  {selectedExamForStart.instructions}
                </p>
              </div>
            )}

            <p className="text-xs text-neutral-500 dark:text-neutral-400 leading-relaxed">
              Once started, the timer runs continuously. After submitting or when time expires, the
              quiz locks for 3 hours unless reopened by your instructor.
            </p>

            {startError && (
              <div className="rounded-2xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800/60 p-3.5 text-xs text-rose-800 dark:text-rose-200">
                {startError}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 pt-1">
              <button
                type="button"
                disabled={startingExamId !== null}
                onClick={() => setSelectedExamForStart(null)}
                className="min-h-[48px] rounded-2xl border border-neutral-200 dark:border-white/15 text-sm font-semibold text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-white/5 whitespace-nowrap"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={startingExamId !== null}
                onClick={() => void handleConfirmStartOrResume(selectedExamForStart)}
                className="min-h-[48px] rounded-2xl bg-[#013F32] hover:bg-[#025342] text-[#FDFDFD] dark:bg-[#E7FE25] dark:hover:bg-[#d8ef1a] dark:text-[#161616] text-sm font-semibold disabled:opacity-60 whitespace-nowrap transition"
              >
                {startingExamId !== null ? 'Starting...' : 'Start Quiz Now'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
