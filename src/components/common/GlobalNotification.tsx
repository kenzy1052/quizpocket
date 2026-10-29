import React, { createContext, useContext, useState, useCallback } from 'react';
import { CheckCircle2, AlertTriangle, AlertCircle, Info, X } from 'lucide-react';

export type NotificationType = 'success' | 'warning' | 'error' | 'info';

interface NotificationItem {
  id: string;
  type: NotificationType;
  title?: string;
  message: string;
}

interface NotificationContextValue {
  notify: (params: { type: NotificationType; title?: string; message: string; durationMs?: number }) => void;
  showNotification: (params: { type: NotificationType; title?: string; message: string; durationMs?: number }) => void;
  success: (message: string, title?: string) => void;
  error: (message: string, title?: string) => void;
  warning: (message: string, title?: string) => void;
  info: (message: string, title?: string) => void;
}

const NotificationContext = createContext<NotificationContextValue | undefined>(undefined);

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);

  const removeNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const showNotification = useCallback(
    ({
      type,
      title,
      message,
      durationMs = 4500,
    }: {
      type: NotificationType;
      title?: string;
      message: string;
      durationMs?: number;
    }) => {
      const id = Math.random().toString(36).slice(2, 9);
      setNotifications((prev) => [...prev, { id, type, title, message }]);

      if (durationMs > 0) {
        setTimeout(() => {
          removeNotification(id);
        }, durationMs);
      }
    },
    [removeNotification]
  );

  const success = useCallback((message: string, title?: string) => {
    showNotification({ type: 'success', title, message });
  }, [showNotification]);

  const error = useCallback((message: string, title?: string) => {
    showNotification({ type: 'error', title, message, durationMs: 6000 });
  }, [showNotification]);

  const warning = useCallback((message: string, title?: string) => {
    showNotification({ type: 'warning', title, message });
  }, [showNotification]);

  const info = useCallback((message: string, title?: string) => {
    showNotification({ type: 'info', title, message });
  }, [showNotification]);

  return (
    <NotificationContext.Provider value={{ notify: showNotification, showNotification, success, error, warning, info }}>
      {children}
      {/* Toast container */}
      <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2.5 max-w-sm w-full pointer-events-none px-4 sm:px-0">
        {notifications.map((n) => (
          <div
            key={n.id}
            role="alert"
            className="pointer-events-auto rounded-2xl bg-white/95 dark:bg-[#1E211F]/95 backdrop-blur-xl border border-neutral-200/90 dark:border-white/10 shadow-[0_12px_36px_-6px_rgba(1,63,50,0.12)] dark:shadow-[0_12px_36px_-6px_rgba(0,0,0,0.65)] p-4 flex items-start gap-3 transition-all animate-in fade-in slide-in-from-bottom-2 duration-200"
          >
            {n.type === 'success' && <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-[#E7FE25] shrink-0 mt-0.5" />}
            {n.type === 'warning' && <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />}
            {n.type === 'error' && <AlertCircle className="w-5 h-5 text-rose-500 shrink-0 mt-0.5" />}
            {n.type === 'info' && <Info className="w-5 h-5 text-teal-600 dark:text-teal-400 shrink-0 mt-0.5" />}

            <div className="flex-1 min-w-0">
              {n.title && <p className="text-sm font-semibold text-[#161616] dark:text-[#FDFDFD]">{n.title}</p>}
              <p className="text-xs text-neutral-600 dark:text-neutral-300 leading-relaxed">{n.message}</p>
            </div>

            <button
              onClick={() => removeNotification(n.id)}
              className="p-1 rounded-lg text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-white/10 transition shrink-0"
              aria-label="Dismiss notification"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>
    </NotificationContext.Provider>
  );
}

export function useNotification(): NotificationContextValue {
  const ctx = useContext(NotificationContext);
  if (!ctx) {
    throw new Error('useNotification must be used within a NotificationProvider');
  }
  return ctx;
}
