import React, { useState } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
  Home,
  LayoutDashboard,
  BookOpen,
  Award,
  User,
  LogOut,
  Menu,
  X,
  ChevronRight,
} from 'lucide-react';
import { BrandMark } from '../BrandMark.tsx';
import { ThemeToggle } from '../ThemeToggle.tsx';
import { useAuth } from '../../context/AuthContext.tsx';

export function StudentLayout() {
  const { profile, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const navItems = [
    { label: 'Home', path: '/student/home', icon: Home },
    { label: 'Dashboard', path: '/student/dashboard', icon: LayoutDashboard },
    { label: 'Available Quizzes', path: '/student/quizzes', icon: BookOpen },
    { label: 'Results & Scores', path: '/student/results', icon: Award },
    { label: 'Profile Settings', path: '/student/profile', icon: User },
  ];

  function handleSignOut() {
    signOut();
    navigate('/login');
  }

  return (
    <div className="min-h-dvh flex flex-col bg-[#F6F7F5] dark:bg-[#121312] text-[#161616] dark:text-[#FDFDFD] transition-colors relative">
      {/* Ambient background glows */}
      <div className="ambient-glow" aria-hidden="true" />

      {/* Top Header Navbar */}
      <header className="sticky top-0 z-40 glass-nav px-4 sm:px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="md:hidden p-2 rounded-xl text-neutral-600 dark:text-neutral-300 hover:bg-neutral-200/50 dark:hover:bg-white/10 transition"
            aria-label="Toggle navigation menu"
          >
            {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>

          <NavLink to="/student/home" className="flex items-center gap-2.5 group">
            <BrandMark className="w-8 h-8" />
            <div className="flex flex-col">
              <span className="font-display font-bold text-base leading-tight tracking-tight text-[#013F32] dark:text-[#FDFDFD] group-hover:text-[#025342] dark:group-hover:text-[#E7FE25] transition-colors">
                QuizPocket
              </span>
              <span className="text-[10px] font-medium tracking-wider uppercase text-neutral-500 dark:text-neutral-400">
                Student Portal
              </span>
            </div>
          </NavLink>
        </div>

        {/* Right Action Cluster */}
        <div className="flex items-center gap-3">
          <ThemeToggle />

          <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-2xl glass-panel border border-neutral-200/70 dark:border-white/10">
            <div className="w-7 h-7 rounded-xl bg-[#013F32] dark:bg-[#E7FE25] text-[#FDFDFD] dark:text-[#161616] font-bold text-xs flex items-center justify-center uppercase shrink-0">
              {(profile?.full_name || profile?.username || 'S')[0]}
            </div>
            <div className="flex flex-col text-left">
              <span className="text-xs font-semibold text-[#161616] dark:text-[#FDFDFD] truncate max-w-[120px]">
                {profile?.full_name || profile?.username}
              </span>
              <span className="text-[10px] text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                Student
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={handleSignOut}
            className="min-h-[40px] px-3 rounded-xl border border-neutral-200 dark:border-white/10 hover:border-rose-400 dark:hover:border-rose-500/50 hover:bg-rose-50/50 dark:hover:bg-rose-950/30 text-neutral-600 dark:text-neutral-300 hover:text-rose-600 dark:hover:text-rose-400 flex items-center gap-1.5 text-xs font-medium transition"
            title="Sign out of QuizPocket"
          >
            <LogOut className="w-4 h-4 shrink-0" />
            <span className="hidden sm:inline">Sign Out</span>
          </button>
        </div>
      </header>

      {/* Main Container with Sidebar */}
      <div className="flex-1 flex w-full relative z-10">
        {/* Desktop Sidebar Navigation */}
        <aside className="hidden md:flex flex-col w-64 glass-sidebar p-4 shrink-0 justify-between">
          <nav className="space-y-1.5" aria-label="Student Navigation">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = location.pathname.startsWith(item.path);

              return (
                <NavLink
                  key={item.path}
                  to={item.path}
                  className={`flex items-center gap-3 px-3.5 py-2.5 rounded-2xl text-sm font-medium transition-all ${
                    isActive
                      ? 'bg-[#013F32] dark:bg-[#E7FE25] text-[#FDFDFD] dark:text-[#161616] shadow-sm font-semibold'
                      : 'text-neutral-600 dark:text-neutral-300 hover:bg-neutral-200/50 dark:hover:bg-white/5 hover:text-[#161616] dark:hover:text-[#FDFDFD]'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="flex-1">{item.label}</span>
                  {isActive && <ChevronRight className="w-3.5 h-3.5 opacity-70" />}
                </NavLink>
              );
            })}
          </nav>

          <div className="pt-4 border-t border-neutral-200/60 dark:border-white/10 text-center">
            <p className="text-[11px] text-neutral-400 dark:text-neutral-500 font-mono">
              QuizPocket · Knowledge in Your Pocket
            </p>
          </div>
        </aside>

        {/* Mobile Navigation Drawer */}
        {mobileMenuOpen && (
          <div
            className="fixed inset-0 top-16 z-30 bg-black/40 backdrop-blur-sm md:hidden animate-in fade-in"
            onClick={() => setMobileMenuOpen(false)}
          >
            <div
              className="w-72 h-full glass-panel border-r border-neutral-200 dark:border-white/10 p-5 flex flex-col justify-between"
              onClick={(e) => e.stopPropagation()}
            >
              <nav className="space-y-2">
                {navItems.map((item) => {
                  const Icon = item.icon;
                  const isActive = location.pathname.startsWith(item.path);

                  return (
                    <NavLink
                      key={item.path}
                      to={item.path}
                      onClick={() => setMobileMenuOpen(false)}
                      className={`flex items-center gap-3 px-4 py-3 rounded-2xl text-sm font-medium transition-all ${
                        isActive
                          ? 'bg-[#013F32] dark:bg-[#E7FE25] text-[#FDFDFD] dark:text-[#161616] font-semibold'
                          : 'text-neutral-600 dark:text-neutral-300 hover:bg-neutral-200/50 dark:hover:bg-white/5'
                      }`}
                    >
                      <Icon className="w-4 h-4 shrink-0" />
                      <span>{item.label}</span>
                    </NavLink>
                  );
                })}
              </nav>

              <div className="pt-4 border-t border-neutral-200/60 dark:border-white/10">
                <button
                  type="button"
                  onClick={handleSignOut}
                  className="w-full py-2.5 rounded-2xl border border-rose-300 dark:border-rose-800 text-rose-600 dark:text-rose-400 text-xs font-semibold flex items-center justify-center gap-2"
                >
                  <LogOut className="w-4 h-4" />
                  <span>Sign Out</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Dynamic Nested Page Content */}
        <main className="flex-1 min-w-0 p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto w-full">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
