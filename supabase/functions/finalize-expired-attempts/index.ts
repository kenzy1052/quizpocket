// Supabase Edge Function: finalize-expired-attempts
// Invoked by Supabase Cron / Scheduled Webhook to finalize expired in-progress attempts
// without depending on a student's browser remaining open.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' } }),
      { status: 405, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const cronSecret = Deno.env.get('CRON_SECRET') ?? '';
  const authHeader = req.headers.get('x-cron-secret') ?? '';

  if (!cronSecret || !constantTimeEquals(authHeader, cronSecret)) {
    return new Response(
      JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Invalid scheduler credentials.' } }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !serviceRoleKey) {
    return new Response(
      JSON.stringify({ error: { code: 'MISCONFIGURED', message: 'Server configuration incomplete.' } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await supabaseAdmin.rpc('finalize_expired_attempts', {
    p_batch_limit: 200,
  });

  if (error) {
    console.error('Expiry sweep failed:', error.message);
    return new Response(
      JSON.stringify({ error: { code: 'SWEEP_FAILED', message: 'Failed to finalize expired attempts.' } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
