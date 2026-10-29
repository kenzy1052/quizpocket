import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { apiRequest, setApiAccessToken, setOnUnauthorizedHandler } from '../lib/api.ts';
import { Profile } from '../types/frontend.ts';

const SESSION_STORAGE_KEY = 'quizpocket.session.v1';
const REMEMBER_ME_KEY = 'quizpocket.remember_me';

interface StoredSession {
  access_token: string;
  profile: Profile;
}

interface SignInResponse {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  profile: Profile;
}

interface AuthContextValue {
  profile: Profile | null;
  isInitializing: boolean;
  sessionNotice: string | null;
  clearSessionNotice: () => void;
  signUp: (username: string, password: string) => Promise<void>;
  signIn: (username: string, password: string, rememberMe?: boolean) => Promise<void>;
  signOut: (reasonMessage?: string) => void;
  updateFullName: (fullName: string) => Promise<Profile>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function clearAttemptDraftStorage(): void {
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith('quizpocket.draft.')) {
        keysToRemove.push(k);
      }
    }
    keysToRemove.forEach((k) => sessionStorage.removeItem(k));
  } catch {
    // Ignore storage unavailability
  }
}

function saveStoredSession(data: StoredSession, rememberMe: boolean): void {
  const json = JSON.stringify(data);
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, json);
  } catch {
    // Ignore
  }

  if (rememberMe) {
    try {
      localStorage.setItem(SESSION_STORAGE_KEY, json);
      localStorage.setItem(REMEMBER_ME_KEY, 'true');
    } catch {
      // Ignore
    }
  } else {
    try {
      localStorage.removeItem(SESSION_STORAGE_KEY);
      localStorage.removeItem(REMEMBER_ME_KEY);
    } catch {
      // Ignore
    }
  }
}

function removeStoredSession(): void {
  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Ignore
  }
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
    localStorage.removeItem(REMEMBER_ME_KEY);
  } catch {
    // Ignore
  }
}

function readStoredSession(): { session: StoredSession | null; isPersistent: boolean } {
  try {
    const local = localStorage.getItem(SESSION_STORAGE_KEY);
    if (local) {
      const parsed = JSON.parse(local) as StoredSession;
      if (parsed?.access_token) return { session: parsed, isPersistent: true };
    }
  } catch {
    // Ignore
  }

  try {
    const session = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (session) {
      const parsed = JSON.parse(session) as StoredSession;
      if (parsed?.access_token) return { session: parsed, isPersistent: false };
    }
  } catch {
    // Ignore
  }

  return { session: null, isPersistent: false };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [isInitializing, setIsInitializing] = useState<boolean>(true);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);

  const persistAuthenticatedSession = useCallback((data: SignInResponse, rememberMe: boolean = true) => {
    setApiAccessToken(data.access_token);
    setProfile(data.profile);
    saveStoredSession({ access_token: data.access_token, profile: data.profile }, rememberMe);
  }, []);

  const signOut = useCallback((reasonMessage?: string) => {
    setApiAccessToken(null);
    setProfile(null);
    removeStoredSession();
    clearAttemptDraftStorage();
    if (reasonMessage) {
      setSessionNotice(reasonMessage);
    }
  }, []);

  useEffect(() => {
    setOnUnauthorizedHandler(() => {
      signOut('Your session expired or is no longer active. Please sign in again.');
    });
    return () => setOnUnauthorizedHandler(null);
  }, [signOut]);

  useEffect(() => {
    let active = true;

    async function restoreSession() {
      try {
        const { session: stored, isPersistent } = readStoredSession();
        if (!stored || !stored.access_token) {
          if (active) setIsInitializing(false);
          return;
        }

        setApiAccessToken(stored.access_token);
        const verifiedProfile = await apiRequest<Profile>('/me', { skipAuthRedirect: true });
        if (active) {
          setProfile(verifiedProfile);
          saveStoredSession(
            { access_token: stored.access_token, profile: verifiedProfile },
            isPersistent
          );
        }
      } catch {
        setApiAccessToken(null);
        removeStoredSession();
        if (active) setProfile(null);
      } finally {
        if (active) setIsInitializing(false);
      }
    }

    restoreSession();
    return () => {
      active = false;
    };
  }, []);

  const signUp = useCallback(
    async (username: string, password: string) => {
      setSessionNotice(null);
      const data = await apiRequest<SignInResponse>('/auth/signup', {
        method: 'POST',
        body: { username, password },
        skipAuthRedirect: true,
      });
      persistAuthenticatedSession(data, true);
    },
    [persistAuthenticatedSession]
  );

  const signIn = useCallback(
    async (username: string, password: string, rememberMe = true) => {
      setSessionNotice(null);
      const data = await apiRequest<SignInResponse>('/auth/login', {
        method: 'POST',
        body: { username, password },
        skipAuthRedirect: true,
      });
      persistAuthenticatedSession(data, rememberMe);
    },
    [persistAuthenticatedSession]
  );

  const refreshProfile = useCallback(async () => {
    const fresh = await apiRequest<Profile>('/me');
    setProfile(fresh);
  }, []);

  const updateFullName = useCallback(async (fullName: string): Promise<Profile> => {
    const updated = await apiRequest<Profile>('/me', {
      method: 'PATCH',
      body: { full_name: fullName },
    });
    setProfile(updated);
    const { session, isPersistent } = readStoredSession();
    if (session) {
      saveStoredSession({ ...session, profile: updated }, isPersistent);
    }
    return updated;
  }, []);

  const clearSessionNotice = useCallback(() => setSessionNotice(null), []);

  return (
    <AuthContext.Provider
      value={{
        profile,
        isInitializing,
        sessionNotice,
        clearSessionNotice,
        signUp,
        signIn,
        signOut,
        updateFullName,
        refreshProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
