import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, Check, Eye, EyeOff } from 'lucide-react';
import { BrandMark } from './BrandMark.tsx';
import { ThemeToggle } from './ThemeToggle.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { ApiClientError } from '../lib/api.ts';

const MIN_PASSWORD_CHARS = 8;
const PEEK_DURATION_MS = 900;

function findInsertedCharIndex(
  prev: string,
  next: string,
  selectionStart: number | null
): number | null {
  if (next.length !== prev.length + 1) {
    return null;
  }
  if (selectionStart !== null && selectionStart >= 1 && selectionStart <= next.length) {
    return selectionStart - 1;
  }
  for (let i = 0; i < prev.length; i += 1) {
    if (prev[i] !== next[i]) {
      return i;
    }
  }
  return next.length - 1;
}

interface PeekPasswordInputProps {
  id: string;
  value: string;
  onChange: (nextValue: string) => void;
  autoComplete?: string;
  placeholder?: string;
}

function PeekPasswordInput({
  id,
  value,
  onChange,
  autoComplete = 'off',
  placeholder = 'Enter your password',
}: PeekPasswordInputProps) {
  const [showFullPassword, setShowFullPassword] = useState(false);
  const [revealedIndex, setRevealedIndex] = useState<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  function syncOverlayScroll() {
    if (inputRef.current && overlayRef.current) {
      overlayRef.current.scrollLeft = inputRef.current.scrollLeft;
    }
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const nextValue = e.target.value;
    const caret = e.target.selectionStart;

    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    const insertedIdx = findInsertedCharIndex(value, nextValue, caret);
    if (!showFullPassword && insertedIdx !== null) {
      setRevealedIndex(insertedIdx);
      timerRef.current = window.setTimeout(() => {
        setRevealedIndex(null);
        timerRef.current = null;
      }, PEEK_DURATION_MS);
    } else {
      setRevealedIndex(null);
    }

    onChange(nextValue);
    window.requestAnimationFrame(syncOverlayScroll);
  }

  function handleToggleFullVisibility() {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setRevealedIndex(null);
    setShowFullPassword((prev) => !prev);
  }

  return (
    <div className="relative">
      {!showFullPassword && value.length > 0 && (
        <div
          ref={overlayRef}
          aria-hidden="true"
          className="pointer-events-none select-none absolute inset-0 h-12 pl-4 pr-12 flex items-center overflow-hidden whitespace-pre font-mono text-base tracking-normal text-[#161616] dark:text-[#FDFDFD]"
        >
          {Array.from(value).map((char, idx) =>
            idx === revealedIndex ? (
              <span
                key={idx}
                className="text-[#013F32] dark:text-[#E7FE25] font-semibold"
              >
                {char}
              </span>
            ) : (
              <span key={idx}>•</span>
            )
          )}
        </div>
      )}

      <input
        ref={inputRef}
        id={id}
        type="text"
        inputMode="text"
        autoComplete={autoComplete}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        required
        value={value}
        onChange={handleChange}
        onScroll={syncOverlayScroll}
        onKeyUp={syncOverlayScroll}
        onClick={syncOverlayScroll}
        placeholder={placeholder}
        className={`w-full h-12 pl-4 pr-12 rounded-2xl border border-neutral-200 dark:border-white/15 bg-neutral-50/70 dark:bg-[#161616] font-mono text-base tracking-normal placeholder:font-sans placeholder:text-neutral-400 dark:placeholder:text-neutral-500 focus:outline-none focus:bg-[#FDFDFD] dark:focus:bg-[#161616] focus:border-[#013F32] dark:focus:border-[#E7FE25] focus:ring-2 focus:ring-[#013F32]/15 dark:focus:ring-[#E7FE25]/20 transition ${
          showFullPassword
            ? 'text-[#161616] dark:text-[#FDFDFD]'
            : value.length > 0
              ? 'text-transparent caret-[#013F32] dark:caret-[#E7FE25] selection:bg-[#013F32]/20 dark:selection:bg-[#E7FE25]/25 selection:text-transparent'
              : 'text-[#161616] dark:text-[#FDFDFD] caret-[#013F32] dark:caret-[#E7FE25]'
        }`}
      />

      <button
        type="button"
        onClick={handleToggleFullVisibility}
        aria-label={showFullPassword ? 'Hide password' : 'Show password'}
        title={showFullPassword ? 'Hide password' : 'Show password'}
        className="absolute right-1 top-1/2 -translate-y-1/2 w-11 h-11 rounded-xl flex items-center justify-center text-neutral-500 dark:text-neutral-400 hover:text-[#161616] dark:hover:text-[#FDFDFD] hover:bg-neutral-200/50 dark:hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#013F32] dark:focus-visible:ring-[#E7FE25] transition"
      >
        {showFullPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  );
}

export function AuthView() {
  const { signUp, signIn, sessionNotice, clearSessionNotice } = useAuth();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const usernameInputRef = useRef<HTMLInputElement | null>(null);

  const hasTypedPassword = password.length > 0;
  const meetsMinLength = password.length >= MIN_PASSWORD_CHARS;
  const lengthProgressPct = Math.min(100, Math.round((password.length / MIN_PASSWORD_CHARS) * 100));

  function switchMode(nextMode: 'login' | 'signup') {
    setMode(nextMode);
    setErrorMsg(null);
    clearSessionNotice();
    window.requestAnimationFrame(() => {
      usernameInputRef.current?.focus();
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    clearSessionNotice();

    const trimmedUsername = username.trim();
    if (!trimmedUsername) {
      setErrorMsg('Please enter your username.');
      return;
    }

    if (password.length < MIN_PASSWORD_CHARS) {
      setErrorMsg(`Password must be at least ${MIN_PASSWORD_CHARS} characters.`);
      return;
    }

    setIsSubmitting(true);
    try {
      if (mode === 'signup') {
        await signUp(trimmedUsername, password);
      } else {
        await signIn(trimmedUsername, password);
      }
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrorMsg(err.message);
      } else {
        setErrorMsg(
          mode === 'signup'
            ? 'Unable to create account right now. Please try again.'
            : 'Unable to sign in right now. Please try again.'
        );
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="min-h-dvh relative bg-[#F6F7F5] dark:bg-[#161616] text-[#161616] dark:text-[#FDFDFD] flex items-center justify-center p-4 sm:p-6 transition-colors">
      <div className="fixed top-4 right-4 sm:top-6 sm:right-6 z-20">
        <ThemeToggle showLabel />
      </div>

      <main className="relative z-10 w-full max-w-5xl grid md:grid-cols-[minmax(0,1fr)_420px] gap-8 lg:gap-16 items-center">
        <section className="hidden md:block max-w-xl">
          <BrandMark className="w-16 h-16 mb-8" />
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[#013F32] dark:text-[#E7FE25]">
            Learning, with room to think
          </p>
          <h2 className="mt-5 font-display text-5xl lg:text-6xl font-bold tracking-tight leading-[1.08] text-[#202A39] dark:text-[#FDFDFD]">
            A calmer way
            <br />
            to make progress.
          </h2>
          <p className="mt-6 max-w-md text-lg leading-relaxed text-neutral-600 dark:text-neutral-300">
            Find your quizzes, focus on what matters, and see how far you have come.
          </p>
          <div className="mt-8 flex flex-wrap gap-2">
            {['Focused quizzes', 'Clear progress', 'Built for confidence'].map((label) => (
              <span
                key={label}
                className="rounded-full border border-[#15B8A6]/20 bg-white/70 px-4 py-2 text-sm font-medium text-[#202A39] dark:border-white/10 dark:bg-white/5 dark:text-neutral-200"
              >
                {label}
              </span>
            ))}
          </div>
        </section>
        <div className="rounded-[28px] bg-[#FDFDFD] dark:bg-[#1E1F1E] border border-neutral-200/90 dark:border-white/10 shadow-[0_24px_64px_-24px_rgba(22,22,22,0.10)] dark:shadow-[0_28px_70px_-24px_rgba(0,0,0,0.75)] p-7 sm:p-9">
          <div className="flex flex-col items-center text-center mb-7">
            <BrandMark className="w-14 h-14 mb-5 shadow-xs" />

            <h1 className="font-display text-2xl sm:text-[26px] leading-[1.18] tracking-tight">
              <span className="block font-normal text-neutral-400 dark:text-neutral-500">
                Welcome
              </span>
              <span className="block font-bold text-[#161616] dark:text-[#FDFDFD] mt-0.5">
                to QuizPocket
              </span>
            </h1>

            <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-2.5">
              {mode === 'login'
                ? 'Sign in with your username and password'
                : 'Enter a username and password to create your account'}
            </p>
          </div>

          {sessionNotice && (
            <div className="mb-4 rounded-2xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60 px-4 py-3 text-xs sm:text-sm text-amber-900 dark:text-amber-200">
              {sessionNotice}
            </div>
          )}

          {errorMsg && (
            <div
              role="alert"
              className="mb-4 rounded-2xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800/60 px-4 py-3 text-xs sm:text-sm text-rose-800 dark:text-rose-200"
            >
              {errorMsg}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="qp-username"
                className="block text-xs font-semibold uppercase tracking-wider text-neutral-600 dark:text-neutral-300 mb-1.5"
              >
                Username
              </label>
              <input
                ref={usernameInputRef}
                id="qp-username"
                type="text"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                required
                maxLength={80}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Enter your username"
                className="w-full h-12 px-4 rounded-2xl border border-neutral-200 dark:border-white/15 bg-neutral-50/70 dark:bg-[#161616] text-base text-[#161616] dark:text-[#FDFDFD] placeholder:text-neutral-400 dark:placeholder:text-neutral-500 focus:outline-none focus:bg-[#FDFDFD] dark:focus:bg-[#161616] focus:border-[#013F32] dark:focus:border-[#E7FE25] focus:ring-2 focus:ring-[#013F32]/15 dark:focus:ring-[#E7FE25]/20 transition"
              />
            </div>

            <div>
              <label
                htmlFor="qp-password"
                className="block text-xs font-semibold uppercase tracking-wider text-neutral-600 dark:text-neutral-300 mb-1.5"
              >
                Password
              </label>
              <PeekPasswordInput
                id="qp-password"
                value={password}
                onChange={setPassword}
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                placeholder="Enter your password"
              />

              {hasTypedPassword && (
                <div className="mt-2.5 space-y-1.5" aria-live="polite">
                  <div className="h-1.5 w-full rounded-full bg-neutral-200 dark:bg-white/10 overflow-hidden">
                    <div
                      className={`h-full transition-all duration-200 ${
                        meetsMinLength
                          ? 'bg-[#013F32] dark:bg-[#E7FE25]'
                          : 'bg-neutral-500 dark:bg-neutral-400'
                      }`}
                      style={{ width: `${lengthProgressPct}%` }}
                    />
                  </div>
                  <div
                    className={`flex items-center gap-1.5 text-xs font-medium ${
                      meetsMinLength
                        ? 'text-[#013F32] dark:text-[#E7FE25]'
                        : 'text-neutral-600 dark:text-neutral-400'
                    }`}
                  >
                    {meetsMinLength ? (
                      <Check className="w-3.5 h-3.5 shrink-0" />
                    ) : (
                      <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    )}
                    <span className="tabular-nums">
                      {meetsMinLength
                        ? `At least 8 characters (${password.length})`
                        : `At least 8 characters (${password.length}/${MIN_PASSWORD_CHARS})`}
                    </span>
                  </div>
                </div>
              )}
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full min-h-[50px] mt-2 rounded-2xl bg-[#013F32] hover:bg-[#025342] dark:bg-[#E7FE25] dark:hover:bg-[#d8ef1a] active:scale-[0.99] text-[#FDFDFD] dark:text-[#161616] font-semibold text-sm flex items-center justify-center gap-2 transition disabled:opacity-60 whitespace-nowrap"
            >
              <span>
                {isSubmitting
                  ? mode === 'signup'
                    ? 'Creating account...'
                    : 'Signing in...'
                  : mode === 'signup'
                    ? 'Create Account'
                    : 'Sign In'}
              </span>
              {!isSubmitting && <ArrowRight className="w-4 h-4" />}
            </button>
          </form>

          <div className="flex items-center gap-3 my-5" aria-hidden="true">
            <div className="h-px flex-1 bg-neutral-200 dark:bg-white/10" />
            <span className="text-xs font-medium text-neutral-400 dark:text-neutral-500">or</span>
            <div className="h-px flex-1 bg-neutral-200 dark:bg-white/10" />
          </div>

          <button
            type="button"
            onClick={() => switchMode(mode === 'login' ? 'signup' : 'login')}
            className="w-full min-h-[48px] rounded-2xl border border-neutral-200 dark:border-white/15 bg-neutral-50/80 dark:bg-white/[0.04] hover:bg-neutral-100 dark:hover:bg-white/[0.08] text-[#161616] dark:text-[#FDFDFD] text-sm font-semibold transition whitespace-nowrap"
          >
            {mode === 'login' ? 'Create Account' : 'Sign In'}
          </button>
        </div>
      </main>
    </div>
  );
}
