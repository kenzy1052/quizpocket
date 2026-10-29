/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext.tsx';
import { ThemeProvider } from './context/ThemeContext.tsx';
import { NotificationProvider } from './components/common/GlobalNotification.tsx';
import { AuthView } from './components/AuthView.tsx';

// Layouts
import { StudentLayout } from './components/layout/StudentLayout.tsx';
import { AdminLayout } from './components/layout/AdminLayout.tsx';

// Student Pages
import { StudentHomePage } from './pages/student/StudentHomePage.tsx';
import { StudentDashboardPage } from './pages/student/StudentDashboardPage.tsx';
import { StudentQuizzesPage } from './pages/student/StudentQuizzesPage.tsx';
import { StudentQuizDetailPage } from './pages/student/StudentQuizDetailPage.tsx';
import { StudentExamPage } from './pages/student/StudentExamPage.tsx';
import { StudentResultsPage } from './pages/student/StudentResultsPage.tsx';
import { StudentAttemptReviewPage } from './pages/student/StudentAttemptReviewPage.tsx';
import { StudentProfilePage } from './pages/student/StudentProfilePage.tsx';

// Admin Pages
import { AdminHomePage } from './pages/admin/AdminHomePage.tsx';
import { AdminDashboardPage } from './pages/admin/AdminDashboardPage.tsx';
import { AdminLiveMonitoringPage } from './pages/admin/AdminLiveMonitoringPage.tsx';
import { AdminAttemptMonitorPage } from './pages/admin/AdminAttemptMonitorPage.tsx';
import { AdminQuizzesPage } from './pages/admin/AdminQuizzesPage.tsx';
import { AdminQuizDetailPage } from './pages/admin/AdminQuizDetailPage.tsx';
import { AdminStudentsPage } from './pages/admin/AdminStudentsPage.tsx';
import { AdminResultsPage } from './pages/admin/AdminResultsPage.tsx';
import { AdminSettingsPage } from './pages/admin/AdminSettingsPage.tsx';

function RootRedirect() {
  const { profile, isInitializing } = useAuth();

  if (isInitializing) {
    return (
      <div className="min-h-dvh bg-[#F6F7F5] dark:bg-[#121312] flex items-center justify-center p-6">
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
    return <Navigate to="/login" replace />;
  }

  if (profile.role === 'admin') {
    return <Navigate to="/admin/home" replace />;
  }

  return <Navigate to="/student/home" replace />;
}

function PublicAuthRoute() {
  const { profile, isInitializing } = useAuth();

  if (isInitializing) {
    return null;
  }

  if (profile) {
    return <Navigate to={profile.role === 'admin' ? '/admin/home' : '/student/home'} replace />;
  }

  return <AuthView />;
}

function ProtectedStudentRoute({ children }: { children: React.ReactNode }) {
  const { profile, isInitializing } = useAuth();
  const location = useLocation();

  if (isInitializing) {
    return (
      <div className="min-h-dvh bg-[#F6F7F5] dark:bg-[#121312] flex items-center justify-center p-6">
        <div className="text-center space-y-3">
          <div className="w-8 h-8 rounded-full border-2 border-[#013F32] dark:border-[#E7FE25] border-t-transparent animate-spin mx-auto" />
          <p className="text-sm font-medium text-[#161616] dark:text-[#FDFDFD]">
            Authenticating student session...
          </p>
        </div>
      </div>
    );
  }

  if (!profile) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
}

function ProtectedAdminRoute({ children }: { children: React.ReactNode }) {
  const { profile, isInitializing } = useAuth();
  const location = useLocation();

  if (isInitializing) {
    return (
      <div className="min-h-dvh bg-[#F6F7F5] dark:bg-[#121312] flex items-center justify-center p-6">
        <div className="text-center space-y-3">
          <div className="w-8 h-8 rounded-full border-2 border-[#013F32] dark:border-[#E7FE25] border-t-transparent animate-spin mx-auto" />
          <p className="text-sm font-medium text-[#161616] dark:text-[#FDFDFD]">
            Verifying administrative access...
          </p>
        </div>
      </div>
    );
  }

  if (!profile) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (profile.role !== 'admin') {
    return <Navigate to="/student/home" replace />;
  }

  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      {/* Root redirect */}
      <Route path="/" element={<RootRedirect />} />

      {/* Public Authentication */}
      <Route path="/login" element={<PublicAuthRoute />} />
      <Route path="/signup" element={<PublicAuthRoute />} />

      {/* Student Protected Portal */}
      <Route
        path="/student"
        element={
          <ProtectedStudentRoute>
            <StudentLayout />
          </ProtectedStudentRoute>
        }
      >
        <Route index element={<Navigate to="/student/home" replace />} />
        <Route path="home" element={<StudentHomePage />} />
        <Route path="dashboard" element={<StudentDashboardPage />} />
        <Route path="quizzes" element={<StudentQuizzesPage />} />
        <Route path="quizzes/:quizId" element={<StudentQuizDetailPage />} />
        <Route path="exams/:attemptId" element={<StudentExamPage />} />
        <Route path="results" element={<StudentResultsPage />} />
        <Route path="results/:attemptId" element={<StudentAttemptReviewPage />} />
        <Route path="profile" element={<StudentProfilePage />} />
      </Route>

      {/* Administrator Protected Portal */}
      <Route
        path="/admin"
        element={
          <ProtectedAdminRoute>
            <AdminLayout />
          </ProtectedAdminRoute>
        }
      >
        <Route index element={<Navigate to="/admin/home" replace />} />
        <Route path="home" element={<AdminHomePage />} />
        <Route path="dashboard" element={<AdminDashboardPage />} />
        <Route path="monitoring" element={<AdminLiveMonitoringPage />} />
        <Route path="monitoring/:attemptId" element={<AdminAttemptMonitorPage />} />
        <Route path="quizzes" element={<AdminQuizzesPage />} />
        <Route path="quizzes/:quizId" element={<AdminQuizDetailPage />} />
        <Route path="students" element={<AdminStudentsPage />} />
        <Route path="results" element={<AdminResultsPage />} />
        <Route path="analytics" element={<AdminDashboardPage />} />
        <Route path="settings" element={<AdminSettingsPage />} />
      </Route>

      {/* Fallback route */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <NotificationProvider>
        <AuthProvider>
          <BrowserRouter>
            <AppRoutes />
          </BrowserRouter>
        </AuthProvider>
      </NotificationProvider>
    </ThemeProvider>
  );
}
