import React, { useEffect, useState } from 'react';
import { Clock, AlertTriangle } from 'lucide-react';

interface FloatingTimerProps {
  startedAt: string;
  deadlineAt: string;
  serverNowAtFetch: string;
  onTimeExpired: () => void;
  className?: string;
}

export function FloatingTimer({
  startedAt,
  deadlineAt,
  serverNowAtFetch,
  onTimeExpired,
  className = '',
}: FloatingTimerProps) {
  // Compute total duration from authoritative timestamps
  const startedMs = new Date(startedAt).getTime();
  const deadlineMs = new Date(deadlineAt).getTime();
  const serverNowMs = new Date(serverNowAtFetch).getTime();
  const localClientFetchTimeMs = React.useRef(Date.now()).current;
  const clockSkewMs = serverNowMs - localClientFetchTimeMs;

  const totalDurationSeconds = Math.max(1, Math.round((deadlineMs - startedMs) / 1000));

  const [secondsRemaining, setSecondsRemaining] = useState<number>(() => {
    const currentAdjustedTime = Date.now() + clockSkewMs;
    return Math.max(0, Math.round((deadlineMs - currentAdjustedTime) / 1000));
  });

  const [hasExpired, setHasExpired] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      const currentAdjustedTime = Date.now() + clockSkewMs;
      const remaining = Math.max(0, Math.round((deadlineMs - currentAdjustedTime) / 1000));
      setSecondsRemaining(remaining);

      if (remaining <= 0 && !hasExpired) {
        setHasExpired(true);
        clearInterval(interval);
        onTimeExpired();
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [deadlineMs, clockSkewMs, hasExpired, onTimeExpired]);

  const fractionRemaining = Math.max(0, Math.min(1, secondsRemaining / totalDurationSeconds));
  const percentage = Math.round(fractionRemaining * 100);

  // Thresholds:
  // Green: > 50%
  // Amber / Orange: 20% - 50%
  // Red: < 20% or under 2 minutes
  const isCritical = fractionRemaining < 0.2 || secondsRemaining <= 120;
  const isWarning = !isCritical && fractionRemaining <= 0.5;

  const timerColorClass = isCritical
    ? 'text-rose-600 dark:text-rose-400 bg-rose-500/10 border-rose-500/30'
    : isWarning
      ? 'text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/30'
      : 'text-emerald-700 dark:text-[#E7FE25] bg-emerald-500/10 dark:bg-[#E7FE25]/10 border-emerald-500/30 dark:border-[#E7FE25]/30';

  const ringStroke = isCritical
    ? '#EF4444'
    : isWarning
      ? '#F59E0B'
      : '#10B981';

  const minutes = Math.floor(secondsRemaining / 60);
  const seconds = secondsRemaining % 60;
  const formattedTime = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

  // SVG ring circumference
  const radius = 16;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - fractionRemaining * circumference;

  return (
    <div
      className={`glass-panel rounded-2xl px-3.5 py-2 flex items-center gap-3 border shadow-lg transition-all duration-300 ${timerColorClass} ${
        isCritical ? 'animate-pulse' : ''
      } ${className}`}
      role="timer"
      aria-live="polite"
      aria-label={`Time remaining: ${minutes} minutes and ${seconds} seconds`}
    >
      <div className="relative w-9 h-9 flex items-center justify-center shrink-0">
        <svg className="w-full h-full -rotate-90 transform" viewBox="0 0 40 40">
          <circle
            cx="20"
            cy="20"
            r={radius}
            className="stroke-neutral-200 dark:stroke-white/15"
            strokeWidth="3"
            fill="none"
          />
          <circle
            cx="20"
            cy="20"
            r={radius}
            stroke={ringStroke}
            strokeWidth="3.2"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap="round"
            fill="none"
            className="transition-all duration-1000 ease-linear"
          />
        </svg>
        {isCritical ? (
          <AlertTriangle className="w-4 h-4 absolute text-rose-500 shrink-0" />
        ) : (
          <Clock className="w-4 h-4 absolute opacity-80 shrink-0" />
        )}
      </div>

      <div className="flex flex-col">
        <span className="text-[10px] uppercase font-bold tracking-wider opacity-70">
          {isCritical ? 'Critical Time' : isWarning ? 'Time Warning' : 'Remaining'}
        </span>
        <span className="font-mono text-base font-bold tabular-nums tracking-tight">
          {formattedTime}
        </span>
      </div>
    </div>
  );
}
