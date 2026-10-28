import { createClient, SupabaseClient } from '@supabase/supabase-js';

let browserClient: SupabaseClient | null = null;

/**
 * Browser-safe Supabase client initializer for Phase 2 frontend integration.
 * Uses ONLY the public project URL and publishable/anonymous key.
 * Access control and answer-key protection are enforced on the database via RLS and RPCs.
 */
export function getSupabaseBrowserClient(): SupabaseClient {
  if (browserClient) {
    return browserClient;
  }

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
  const supabasePublicKey =
    import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ||
    import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

  if (!supabaseUrl || !supabasePublicKey) {
    throw new Error(
      'Missing Supabase public configuration (VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY).'
    );
  }

  browserClient = createClient(supabaseUrl, supabasePublicKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });

  return browserClient;
}
