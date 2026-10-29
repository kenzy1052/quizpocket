import React, { useState, useEffect } from 'react';
import {
  Settings,
  ShieldAlert,
  Server,
  Clock,
  RefreshCw,
  CheckCircle2,
  FileText,
  Loader2,
  Database,
} from 'lucide-react';
import { apiRequest } from '../../lib/api.ts';
import { GlassCard } from '../../components/common/GlassCard.tsx';
import { useNotification } from '../../components/common/GlobalNotification.tsx';
import { formatDateTime } from '../../lib/format.ts';

export function AdminSettingsPage() {
  const { notify } = useNotification();
  const [runningSweep, setRunningSweep] = useState(false);
  const [sweepResult, setSweepResult] = useState<string | null>(null);

  async function handleTriggerSweep() {
    try {
      setRunningSweep(true);
      const res = await apiRequest<{ finalized_count: number }>('/cron/finalize-expired', {
        method: 'POST',
      });
      setSweepResult(`Successfully finalized ${res.finalized_count ?? 0} expired attempts.`);
      notify({
        type: 'success',
        title: 'Expiry Sweep Complete',
        message: `Finalized ${res.finalized_count ?? 0} expired attempts.`,
      });
    } catch (err: any) {
      notify({ type: 'error', title: 'Sweep Failed', message: err?.message || 'Could not run sweep.' });
    } finally {
      setRunningSweep(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div>
        <h1 className="text-2xl font-display font-bold text-neutral-900 dark:text-white flex items-center gap-2.5">
          <Settings className="w-6 h-6 text-[#013F32] dark:text-[#E7FE25]" />
          Platform Settings & Engine Health
        </h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
          Monitor system heartbeat, database engines, security audit policies, and automated sweeps.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Engine Status Card */}
        <GlassCard className="p-6 space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-[#E7FE25] flex items-center justify-center">
              <Server className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-display font-bold text-base text-neutral-900 dark:text-white">
                Execution Engine & Port
              </h2>
              <span className="text-xs text-neutral-500 dark:text-neutral-400">
                Authoritative Express + PostgreSQL Architecture
              </span>
            </div>
          </div>

          <div className="space-y-2.5 text-sm pt-2">
            <div className="flex justify-between py-2 border-b border-neutral-200/50 dark:border-white/5">
              <span className="text-neutral-500 dark:text-neutral-400">Server Port</span>
              <span className="font-mono font-semibold text-neutral-900 dark:text-white">3000 (0.0.0.0)</span>
            </div>
            <div className="flex justify-between py-2 border-b border-neutral-200/50 dark:border-white/5">
              <span className="text-neutral-500 dark:text-neutral-400">Database Engine</span>
              <span className="font-mono font-semibold text-neutral-900 dark:text-white">PostgreSQL 16 (PGlite / Supabase)</span>
            </div>
            <div className="flex justify-between py-2 border-b border-neutral-200/50 dark:border-white/5">
              <span className="text-neutral-500 dark:text-neutral-400">Result Release</span>
              <span className="font-semibold text-emerald-600 dark:text-[#E7FE25]">Immediate / Explicit Policy</span>
            </div>
            <div className="flex justify-between py-2">
              <span className="text-neutral-500 dark:text-neutral-400">Clock Source</span>
              <span className="font-semibold text-neutral-900 dark:text-white">Server Authoritative (UTC)</span>
            </div>
          </div>
        </GlassCard>

        {/* Automated Attempt Expiry Sweeper */}
        <GlassCard className="p-6 space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#013F32]/10 dark:bg-[#E7FE25]/10 text-[#013F32] dark:text-[#E7FE25] flex items-center justify-center">
              <Clock className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-display font-bold text-base text-neutral-900 dark:text-white">
                Scheduled Auto-Finalization
              </h2>
              <span className="text-xs text-neutral-500 dark:text-neutral-400">
                Sweeps every 30s to finalize expired attempts
              </span>
            </div>
          </div>

          <p className="text-sm text-neutral-600 dark:text-neutral-300">
            When students close the browser or exceed time limits, the server-side cron automatically computes scores, marks fill-ins and MCQs, and finalizes records without client intervention.
          </p>

          <div className="pt-2">
            <button
              type="button"
              onClick={handleTriggerSweep}
              disabled={runningSweep}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#013F32] dark:bg-[#E7FE25] text-white dark:text-[#161616] font-semibold text-sm hover:opacity-95 transition disabled:opacity-50"
            >
              {runningSweep ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Run Manual Expiry Sweep Now
            </button>
            {sweepResult && (
              <p className="text-xs text-emerald-600 dark:text-[#E7FE25] font-semibold mt-2">
                {sweepResult}
              </p>
            )}
          </div>
        </GlassCard>
      </div>

      {/* Security Policies Overview */}
      <GlassCard className="p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400 flex items-center justify-center">
            <ShieldAlert className="w-5 h-5" />
          </div>
          <div>
            <h2 className="font-display font-bold text-base text-neutral-900 dark:text-white">
              Anti-Tamper & Answer Isolation Architecture
            </h2>
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              Zero-leak client isolation protocols
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm pt-2">
          <div className="p-4 rounded-xl bg-neutral-100/60 dark:bg-white/[0.03] space-y-1">
            <span className="font-semibold text-neutral-900 dark:text-white">Correct Answer Stripping</span>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Active student endpoints strictly scrub is_correct keys and answer keys before JSON serialization.
            </p>
          </div>
          <div className="p-4 rounded-xl bg-neutral-100/60 dark:bg-white/[0.03] space-y-1">
            <span className="font-semibold text-neutral-900 dark:text-white">Server-Enforced Timers</span>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Exam submission deadlines are computed server-side from attempt start timestamps; local clocks cannot alter durations.
            </p>
          </div>
          <div className="p-4 rounded-xl bg-neutral-100/60 dark:bg-white/[0.03] space-y-1">
            <span className="font-semibold text-neutral-900 dark:text-white">Audit Trail Logging</span>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              All manual mark modifications, cooldown resets, and quiz state mutations require authenticated actor reasons.
            </p>
          </div>
        </div>
      </GlassCard>
    </div>
  );
}
