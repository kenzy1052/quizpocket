import React, { useState, useEffect, useCallback } from 'react';
import {
  Users,
  UserPlus,
  Search,
  CheckCircle2,
  XCircle,
  Loader2,
  Shield,
  RefreshCw,
  X,
} from 'lucide-react';
import { apiRequest } from '../../lib/api.ts';
import { Profile, AdminClassItem } from '../../types/frontend.ts';
import { GlassCard } from '../../components/common/GlassCard.tsx';
import { useNotification } from '../../components/common/GlobalNotification.tsx';

export function AdminStudentsPage() {
  const { notify } = useNotification();
  const [students, setStudents] = useState<Profile[]>([]);
  const [classes, setClasses] = useState<AdminClassItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Form fields for new student
  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [studentId, setStudentId] = useState('');
  const [selectedClassId, setSelectedClassId] = useState('');

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const [studentsRes, classesRes] = await Promise.all([
        apiRequest<Profile[]>('/admin/students'),
        apiRequest<AdminClassItem[]>('/admin/classes'),
      ]);
      const studentList = Array.isArray(studentsRes) ? studentsRes : [];
      const classList = Array.isArray(classesRes) ? classesRes : [];
      setStudents(studentList);
      setClasses(classList);
      if (classList.length && !selectedClassId) {
        setSelectedClassId(classList[0].id);
      }
    } catch (err: any) {
      notify({ type: 'error', message: err?.message || 'Failed to load students.' });
    } finally {
      setLoading(false);
    }
  }, [notify, selectedClassId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function handleCreateStudent(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      notify({ type: 'warning', message: 'Username and password are required.' });
      return;
    }
    if (password.length < 8) {
      notify({ type: 'warning', message: 'Password must be at least 8 characters long.' });
      return;
    }

    try {
      setSubmitting(true);
      await apiRequest('/admin/students', {
        method: 'POST',
        body: JSON.stringify({
          full_name: fullName.trim() || username.trim(),
          username: username.trim(),
          password,
          student_identifier: studentId.trim() || undefined,
          class_id: selectedClassId || undefined,
        }),
      });

      notify({
        type: 'success',
        title: 'Student Created',
        message: `Student account ${username} created successfully.`,
      });

      setIsModalOpen(false);
      setFullName('');
      setUsername('');
      setPassword('');
      setStudentId('');
      loadData();
    } catch (err: any) {
      notify({ type: 'error', title: 'Registration Failed', message: err?.message || 'Could not create student.' });
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleStatus(student: Profile) {
    const nextStatus = student.account_status === 'active' ? 'suspended' : 'active';
    try {
      await apiRequest(`/admin/students/${student.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ account_status: nextStatus }),
      });
      notify({
        type: 'info',
        message: `Student ${student.full_name || student.username} status updated to ${nextStatus}.`,
      });
      setStudents((prev) =>
        prev.map((s) => (s.id === student.id ? { ...s, account_status: nextStatus } : s))
      );
    } catch (err: any) {
      notify({ type: 'error', message: err?.message || 'Failed to update student status.' });
    }
  }

  const filteredStudents = students.filter((s) => {
    const term = search.toLowerCase();
    return (
      (s.full_name && s.full_name.toLowerCase().includes(term)) ||
      (s.username && s.username.toLowerCase().includes(term)) ||
      (s.email && s.email.toLowerCase().includes(term)) ||
      (s.student_identifier && s.student_identifier.toLowerCase().includes(term))
    );
  });

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-display font-bold text-neutral-900 dark:text-white flex items-center gap-2.5">
            <Users className="w-6 h-6 text-[#013F32] dark:text-[#E7FE25]" />
            Student Management
          </h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
            Enroll students, review account standing, assign cohorts, and monitor credentials.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={loadData}
            className="p-2.5 rounded-xl glass-card text-neutral-600 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-white transition"
            title="Refresh list"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => setIsModalOpen(true)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#013F32] dark:bg-[#E7FE25] text-white dark:text-[#161616] font-semibold text-sm hover:opacity-95 transition shadow-sm"
          >
            <UserPlus className="w-4 h-4" />
            Add New Student
          </button>
        </div>
      </div>

      {/* Search & Stats Bar */}
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-neutral-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, username, ID, or email..."
            className="w-full pl-10 pr-4 py-2.5 rounded-xl glass-card border border-neutral-200/80 dark:border-white/10 text-sm focus:outline-none focus:ring-2 focus:ring-[#013F32] dark:focus:ring-[#E7FE25]"
          />
        </div>
        <div className="flex items-center gap-2 text-xs font-semibold px-4 py-2.5 rounded-xl glass-card text-neutral-600 dark:text-neutral-300">
          <span>Total: <strong className="text-neutral-900 dark:text-white">{students.length}</strong></span>
          <span className="opacity-40">•</span>
          <span>Active: <strong className="text-emerald-600 dark:text-[#E7FE25]">{students.filter((s) => s.account_status === 'active').length}</strong></span>
        </div>
      </div>

      {/* Students Table */}
      <GlassCard className="overflow-hidden">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 space-y-3">
            <Loader2 className="w-8 h-8 animate-spin text-[#013F32] dark:text-[#E7FE25]" />
            <p className="text-sm text-neutral-500 dark:text-neutral-400 font-medium">Loading students...</p>
          </div>
        ) : filteredStudents.length === 0 ? (
          <div className="text-center py-16 space-y-3">
            <Users className="w-12 h-12 text-neutral-300 dark:text-neutral-600 mx-auto" />
            <p className="text-sm font-medium text-neutral-600 dark:text-neutral-300">
              {search ? 'No students match your search criteria.' : 'No students found.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200/60 dark:border-white/10 bg-neutral-50/50 dark:bg-white/[0.02] text-xs font-semibold text-neutral-500 uppercase tracking-wider">
                  <th className="py-3.5 px-4">Student</th>
                  <th className="py-3.5 px-4">Username / ID</th>
                  <th className="py-3.5 px-4">Role</th>
                  <th className="py-3.5 px-4">Status</th>
                  <th className="py-3.5 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-200/60 dark:divide-white/10">
                {filteredStudents.map((student) => (
                  <tr key={student.id} className="hover:bg-neutral-100/40 dark:hover:bg-white/[0.03] transition-colors">
                    <td className="py-3.5 px-4">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-xl bg-[#013F32]/10 dark:bg-[#E7FE25]/10 text-[#013F32] dark:text-[#E7FE25] font-bold text-sm flex items-center justify-center uppercase shrink-0">
                          {(student.full_name || student.username || 'S')[0]}
                        </div>
                        <div>
                          <div className="font-semibold text-neutral-900 dark:text-white">
                            {student.full_name || student.username}
                          </div>
                          <div className="text-xs text-neutral-500 dark:text-neutral-400">
                            {student.email}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="py-3.5 px-4">
                      <span className="font-mono text-xs px-2 py-0.5 rounded-md bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300">
                        @{student.username || 'unassigned'}
                      </span>
                      {student.student_identifier && (
                        <div className="text-xs text-neutral-400 mt-0.5">
                          ID: {student.student_identifier}
                        </div>
                      )}
                    </td>
                    <td className="py-3.5 px-4">
                      <span className="inline-flex items-center gap-1 text-xs font-semibold capitalize text-neutral-700 dark:text-neutral-300">
                        {student.role === 'admin' ? (
                          <Shield className="w-3.5 h-3.5 text-[#013F32] dark:text-[#E7FE25]" />
                        ) : null}
                        {student.role}
                      </span>
                    </td>
                    <td className="py-3.5 px-4">
                      <span
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${
                          student.account_status === 'active'
                            ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                            : 'bg-neutral-500/15 text-neutral-600 dark:text-neutral-400'
                        }`}
                      >
                        {student.account_status === 'active' ? (
                          <CheckCircle2 className="w-3.5 h-3.5" />
                        ) : (
                          <XCircle className="w-3.5 h-3.5" />
                        )}
                        {student.account_status}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 text-right">
                      <button
                        type="button"
                        onClick={() => toggleStatus(student)}
                        className={`text-xs font-semibold px-3 py-1.5 rounded-lg border transition ${
                          student.account_status === 'active'
                            ? 'border-neutral-300 dark:border-neutral-700 hover:bg-red-50 dark:hover:bg-red-950/20 text-red-600 dark:text-red-400'
                            : 'border-emerald-300 dark:border-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-950/20 text-emerald-600 dark:text-emerald-400'
                        }`}
                      >
                        {student.account_status === 'active' ? 'Suspend' : 'Activate'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </GlassCard>

      {/* Add Student Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-md">
            <GlassCard className="p-6 space-y-5 border-neutral-300/60 dark:border-white/20">
              <div className="flex items-center justify-between pb-2 border-b border-neutral-200/60 dark:border-white/10">
                <h3 className="font-display font-bold text-lg text-neutral-900 dark:text-white flex items-center gap-2">
                  <UserPlus className="w-5 h-5 text-[#013F32] dark:text-[#E7FE25]" />
                  Create Student Account
                </h3>
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="p-1 rounded-lg text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 transition"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <form onSubmit={handleCreateStudent} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
                    Full Name
                  </label>
                  <input
                    type="text"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="e.g. Fatima Bello"
                    className="w-full px-3.5 py-2.5 rounded-xl glass-card border border-neutral-200/80 dark:border-white/10 text-sm focus:outline-none focus:ring-2 focus:ring-[#013F32] dark:focus:ring-[#E7FE25]"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
                    Username <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="e.g. fatima_bello"
                    className="w-full px-3.5 py-2.5 rounded-xl glass-card border border-neutral-200/80 dark:border-white/10 text-sm focus:outline-none focus:ring-2 focus:ring-[#013F32] dark:focus:ring-[#E7FE25]"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
                    Initial Password <span className="text-red-500">* (min 8 chars)</span>
                  </label>
                  <input
                    type="password"
                    required
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full px-3.5 py-2.5 rounded-xl glass-card border border-neutral-200/80 dark:border-white/10 text-sm focus:outline-none focus:ring-2 focus:ring-[#013F32] dark:focus:ring-[#E7FE25]"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
                    Student ID / Matric Number (Optional)
                  </label>
                  <input
                    type="text"
                    value={studentId}
                    onChange={(e) => setStudentId(e.target.value)}
                    placeholder="e.g. HIM/2026/042"
                    className="w-full px-3.5 py-2.5 rounded-xl glass-card border border-neutral-200/80 dark:border-white/10 text-sm focus:outline-none focus:ring-2 focus:ring-[#013F32] dark:focus:ring-[#E7FE25]"
                  />
                </div>

                {classes.length > 0 && (
                  <div>
                    <label className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
                      Assign to Cohort
                    </label>
                    <select
                      value={selectedClassId}
                      onChange={(e) => setSelectedClassId(e.target.value)}
                      className="w-full px-3.5 py-2.5 rounded-xl glass-card border border-neutral-200/80 dark:border-white/10 text-sm focus:outline-none focus:ring-2 focus:ring-[#013F32] dark:focus:ring-[#E7FE25]"
                    >
                      {classes.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="flex items-center justify-end gap-3 pt-3">
                  <button
                    type="button"
                    onClick={() => setIsModalOpen(false)}
                    className="px-4 py-2 rounded-xl text-sm font-semibold text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-white/5 transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={submitting}
                    className="flex items-center gap-2 px-5 py-2 rounded-xl bg-[#013F32] dark:bg-[#E7FE25] text-white dark:text-[#161616] font-semibold text-sm hover:opacity-95 transition disabled:opacity-50"
                  >
                    {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                    Create Account
                  </button>
                </div>
              </form>
            </GlassCard>
          </div>
        </div>
      )}
    </div>
  );
}
