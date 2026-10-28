import crypto from 'crypto';

export const SYNTHETIC_EMAIL_DOMAIN = 'users.quizpocket.local';
export const MIN_PASSWORD_LENGTH = 8;

export function normalizeUsername(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/**
 * Deterministically maps a username/name into an internal RFC-valid email address
 * for Supabase `auth.users` storage without requiring an email from the user.
 */
export function usernameToSyntheticEmail(rawUsername: string): string {
  const normalized = normalizeUsername(rawUsername);
  const lower = normalized.toLowerCase();

  if (lower.includes('@')) {
    return lower;
  }

  // Keep clean alphanumeric handles readable (e.g. kenzy -> kenzy@users.quizpocket.local)
  if (/^[a-z0-9._-]+$/.test(lower) && lower.length <= 48) {
    return `${lower}@${SYNTHETIC_EMAIL_DOMAIN}`;
  }

  const slug =
    lower
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 36) || 'user';
  const digest = crypto.createHash('sha256').update(lower).digest('hex').slice(0, 8);
  return `${slug}-${digest}@${SYNTHETIC_EMAIL_DOMAIN}`;
}

export function isSyntheticEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return email.toLowerCase().endsWith(`@${SYNTHETIC_EMAIL_DOMAIN}`);
}
