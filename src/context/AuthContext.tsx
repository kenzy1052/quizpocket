import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { apiRequest, setApiAccessToken, setOnUnauthorizedHandler } from '../lib/api.ts';
import { Profile } from '../types/frontend.ts';

const SESSION_STORAGE_KEY = 'quizpocket.session.v1';

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
  signIn: (username: string, password: string) => Promise<void>;
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

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [isInitializing, setIsInitializing] = useState<boolean>(true);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);

  const persistAuthenticatedSession = useCallback((data: SignInResponse) => {
    setApiAccessToken(data.access_token);
    setProfile(data.profile);

    try {
      sessionStorage.setItem(
        SESSION_STORAGE_KEY,
        JSON.stringify({ access_token: data.access_token, profile: data.profile })
      );
    } catch {
      // Ignore storage quota issues
    }
  }, []);

  const signOut = useCallback((reasonMessage?: string) => {
    setApiAccessToken(null);
    setProfile(null);
    try {
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // Ignore storage error
    }
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
        const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
        if (!raw) {
          if (active) setIsInitializing(false);
          return;
        }
        const parsed = JSON.parse(raw) as StoredSession;
        if (!parsed?.access_token) {
          sessionStorage.removeItem(SESSION_STORAGE_KEY);
          if (active) setIsInitializing(false);
          return;
        }

        setApiAccessToken(parsed.access_token);
        const verifiedProfile = await apiRequest<Profile>('/me', { skipAuthRedirect: true });
        if (active) {
          setProfile(verifiedProfile);
          sessionStorage.setItem(
            SESSION_STORAGE_KEY,
            JSON.stringify({ access_token: parsed.access_token, profile: verifiedProfile })
          );
        }
      } catch {
        setApiAccessToken(null);
        try {
          sessionStorage.removeItem(SESSION_STORAGE_KEY);
        } catch {
          // Ignore
        }
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
      persistAuthenticatedSession(data);
    },
    [persistAuthenticatedSession]
  );

  const signIn = useCallback(
    async (username: string, password: string) => {
      setSessionNotice(null);
      const data = await apiRequest<SignInResponse>('/auth/login', {
        method: 'POST',
        body: { username, password },
        skipAuthRedirect: true,
      });
      persistAuthenticatedSession(data);
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
    try {
      const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as StoredSession;
        sessionStorage.setItem(
          SESSION_STORAGE_KEY,
          JSON.stringify({ ...parsed, profile: updated })
        );
      }
    } catch {
      // Ignore
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
