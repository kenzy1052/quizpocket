import * as dotenv from 'dotenv';

dotenv.config();

export interface BackendEnvConfig {
  port: number;
  supabaseUrl: string | null;
  supabasePublicKey: string | null;
  supabaseServiceRoleKey: string | null;
  cronSecret: string | null;
  isSupabaseConfigured: boolean;
}

/**
 * Validates and resolves backend environment configuration.
 * Supports both modern Supabase publishable keys (VITE_SUPABASE_PUBLISHABLE_KEY)
 * and legacy anonymous keys (VITE_SUPABASE_ANON_KEY), while ensuring secret
 * service-role credentials are never placed into public VITE_* variables.
 */
export function loadBackendEnv(env: NodeJS.ProcessEnv = process.env): BackendEnvConfig {
  const supabaseUrl = env.VITE_SUPABASE_URL?.trim() || env.SUPABASE_URL?.trim() || null;
  const publishableKey = env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() || null;
  let anonKey = env.VITE_SUPABASE_ANON_KEY?.trim() || env.SUPABASE_ANON_KEY?.trim() || null;
  let serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim() || null;

  // Auto-heal truncated/split Supabase JWTs if header was detached into anon key
  if (serviceRoleKey && serviceRoleKey.split('.').length === 2) {
    const jwtHeader =
      anonKey && anonKey.split('.').length === 1 && anonKey.startsWith('ey')
        ? anonKey
        : 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
    serviceRoleKey = `${jwtHeader}.${serviceRoleKey}`;
  }

  // If anonKey was only a header fragment, reconstruct using serviceRoleKey
  if (anonKey && anonKey.split('.').length === 1 && serviceRoleKey && serviceRoleKey.split('.').length === 3) {
    anonKey = serviceRoleKey;
  }

  const publicKey =
    serviceRoleKey && serviceRoleKey.split('.').length === 3
      ? serviceRoleKey
      : (publishableKey || anonKey);
  const cronSecret = env.CRON_SECRET?.trim() || null;

  // Guard against accidental exposure of service-role or secret keys in VITE_* vars
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('VITE_') || !value) continue;
    if (
      key.toUpperCase().includes('SERVICE_ROLE') ||
      key.toUpperCase().includes('SECRET') ||
      value.startsWith('sb_secret_')
    ) {
      throw new Error(
        `SECURITY_CONFIGURATION_ERROR: Privileged credential detected in public client variable ${key}. Move secrets to server-only variables.`
      );
    }
  }

  // AI Studio environment mandates port 3000. Port 8080 is reserved by container runtime.
  const parsedPort = Number(env.APP_PORT || env.QUIZPOCKET_PORT || 3000);
  const port = parsedPort === 8080 ? 3000 : (Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 3000);

  return {
    port,
    supabaseUrl,
    supabasePublicKey: publicKey,
    supabaseServiceRoleKey: serviceRoleKey,
    cronSecret,
    isSupabaseConfigured: Boolean(supabaseUrl && publicKey),
  };
}
