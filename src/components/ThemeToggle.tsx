import React from 'react';
import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../context/ThemeContext.tsx';

interface ThemeToggleProps {
  showLabel?: boolean;
  className?: string;
}

export function ThemeToggle({ showLabel = false, className = '' }: ThemeToggleProps) {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      className={`min-h-[44px] min-w-[44px] px-3 rounded-xl border border-neutral-200 dark:border-white/15 bg-[#FDFDFD] dark:bg-[#1E1F1E] text-[#161616] dark:text-[#FDFDFD] hover:border-[#013F32] dark:hover:border-[#E7FE25] inline-flex items-center justify-center gap-2 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#013F32] dark:focus-visible:ring-[#E7FE25] whitespace-nowrap ${className}`}
    >
      {isDark ? (
        <Sun className="w-4 h-4 text-[#E7FE25] shrink-0" />
      ) : (
        <Moon className="w-4 h-4 text-[#013F32] shrink-0" />
      )}
      {showLabel && <span>{isDark ? 'Light' : 'Dark'}</span>}
    </button>
  );
}
