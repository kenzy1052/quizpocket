import React, { useState } from 'react';
import { User, Mail, Shield, Check, Save, Calendar, LogOut } from 'lucide-react';
import { useAuth } from '../../context/AuthContext.tsx';
import { GlassCard } from '../../components/common/GlassCard.tsx';
import { useNotification } from '../../components/common/GlobalNotification.tsx';
import { ThemeToggle } from '../../components/ThemeToggle.tsx';

export function StudentProfilePage() {
  const { profile, updateFullName, signOut } = useAuth();
  const { success: notifySuccess, error: notifyError } = useNotification();

  const [fullName, setFullName] = useState(profile?.full_name || '');
  const [isSaving, setIsSaving] = useState(false);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = fullName.trim();
    if (!trimmed) {
      notifyError('Full name cannot be empty.');
      return;
    }

    setIsSaving(true);
    try {
      await updateFullName(trimmed);
      notifySuccess('Profile updated successfully.');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unable to update profile.';
      notifyError(msg);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-8 animate-in fade-in duration-300">
      <div>
        <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-[#161616] dark:text-[#FDFDFD]">
          Student Profile Settings
        </h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
          Manage your account credentials, preferences, and personal details
        </p>
      </div>

      <GlassCard className="p-6 sm:p-8 space-y-6">
        <div className="flex items-center gap-4 pb-6 border-b border-neutral-200/70 dark:border-white/10">
          <div className="w-16 h-16 rounded-3xl bg-[#013F32] dark:bg-[#E7FE25] text-white dark:text-[#161616] font-display text-2xl font-bold flex items-center justify-center uppercase shrink-0 shadow-md">
            {(profile?.full_name || profile?.username || 'S')[0]}
          </div>

          <div>
            <h2 className="text-lg font-bold text-[#161616] dark:text-[#FDFDFD]">
              {profile?.full_name || profile?.username}
            </h2>
            <div className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
              <span>@{profile?.username || 'student'}</span>
              <span>·</span>
              <span className="capitalize text-emerald-600 dark:text-[#E7FE25] font-semibold">
                {profile?.role} Account
              </span>
            </div>
          </div>
        </div>

        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-600 dark:text-neutral-300 mb-1.5">
              Display / Full Name
            </label>
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              required
              className="w-full h-12 px-4 rounded-2xl glass-panel text-sm text-[#161616] dark:text-[#FDFDFD] focus:outline-none focus:ring-2 focus:ring-[#013F32] dark:focus:ring-[#E7FE25]"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-600 dark:text-neutral-300 mb-1.5">
              Email Address
            </label>
            <input
              type="email"
              disabled
              value={profile?.email || ''}
              className="w-full h-12 px-4 rounded-2xl bg-neutral-100 dark:bg-white/5 text-neutral-500 dark:text-neutral-400 text-sm cursor-not-allowed border border-neutral-200 dark:border-white/10"
            />
            <p className="text-[11px] text-neutral-400 mt-1 pl-1">
              Email is managed by your institution administrator.
            </p>
          </div>

          {profile?.student_identifier && (
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-600 dark:text-neutral-300 mb-1.5">
                Student ID Number
              </label>
              <input
                type="text"
                disabled
                value={profile.student_identifier}
                className="w-full h-12 px-4 rounded-2xl bg-neutral-100 dark:bg-white/5 text-neutral-500 dark:text-neutral-400 text-sm cursor-not-allowed border border-neutral-200 dark:border-white/10"
              />
            </div>
          )}

          <div className="pt-4 flex items-center justify-between">
            <button
              type="submit"
              disabled={isSaving}
              className="px-6 py-2.5 rounded-2xl bg-[#013F32] dark:bg-[#E7FE25] text-white dark:text-[#161616] font-bold text-xs sm:text-sm shadow hover:opacity-90 transition flex items-center gap-2"
            >
              <Save className="w-4 h-4" />
              <span>{isSaving ? 'Saving...' : 'Save Profile'}</span>
            </button>
          </div>
        </form>

        <div className="pt-6 border-t border-neutral-200/70 dark:border-white/10 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-[#161616] dark:text-[#FDFDFD]">Appearance Theme</h3>
            <p className="text-xs text-neutral-500">Toggle between Light and Dark mode</p>
          </div>
          <ThemeToggle showLabel />
        </div>
      </GlassCard>
    </div>
  );
}
