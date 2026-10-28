/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { AuthProvider, useAuth } from './context/AuthContext.tsx';
import { ThemeProvider } from './context/ThemeContext.tsx';
import { AuthView } from './components/AuthView.tsx';
import { StudentWorkspace } from './components/student/StudentWorkspace.tsx';
import { AdminWorkspace } from './components/admin/AdminWorkspace.tsx';

function AppRouter() {
  const { profile, isInitializing } = useAuth();

  if (isInitializing) {
    return (
      <div className="min-h-dvh bg-[#F6F7F5] dark:bg-[#161616] flex items-center justify-center p-6">
        <div className="text-center space-y-3">
          <div className="w-8 h-8 rounded-full border-2 border-[#013F32] dark:border-[#E7FE25] border-t-transparent animate-spin mx-auto" />
          <p className="text-sm font-medium text-[#161616] dark:text-[#FDFDFD]">
            Loading QuizPocket...
          </p>
        </div>
      </div>
    );
  }

  if (!profile) {
    return <AuthView />;
  }

  if (profile.role === 'admin') {
    return <AdminWorkspace />;
  }

  return <StudentWorkspace />;
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AppRouter />
      </AuthProvider>
    </ThemeProvider>
  );
}
