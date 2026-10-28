// Supabase Edge Function: admin-create-student
// Allows an authenticated active administrator to provision a controlled student
// Auth account + profile without enabling unrestricted public self-registration.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

interface CreateStudentBody {
  username?: string;
  email?: string;
  password?: string;
  full_name?: string;
  student_identifier?: string;
}

function toSyntheticEmail(rawName: string): string {
  const lower = rawName.trim().toLowerCase();
  if (lower.includes('@')) return lower;
  if (/^[a-z0-9._-]+$/.test(lower) && lower.length <= 48) {
    return `${lower}@users.quizpocket.local`;
  }
  const slug =
    lower
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 36) || 'student';
  return `${slug}-${crypto.randomUUID().slice(0, 8)}@users.quizpocket.local`;
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' } }),
      { status: 405, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return new Response(
      JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Missing bearer token.' } }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return new Response(
      JSON.stringify({ error: { code: 'MISCONFIGURED', message: 'Server configuration incomplete.' } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // 1. Verify caller identity and active administrator status using caller-scoped JWT
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: isAdmin, error: roleError } = await callerClient.rpc('is_active_admin');
  if (roleError || isAdmin !== true) {
    return new Response(
      JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Active administrator privileges required.' } }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let body: CreateStudentBody;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: { code: 'INVALID_JSON', message: 'Invalid JSON request body.' } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const username = (body.username ?? body.full_name ?? '').trim();
  const fullName = (body.full_name ?? username).trim();
  const email = (body.email ?? '').trim().toLowerCase() || toSyntheticEmail(username);
  const password = body.password ?? '';
  const studentIdentifier = body.student_identifier?.trim() || null;

  if (fullName.length < 1 || password.length < 8) {
    return new Response(
      JSON.stringify({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Name and a password of at least 8 characters are required.',
        },
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: createdAuth, error: createError } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { username, full_name: fullName },
  });

  if (createError || !createdAuth.user) {
    return new Response(
      JSON.stringify({
        error: {
          code: 'ACCOUNT_CREATION_FAILED',
          message: 'Unable to create student account. Verify that the name is not already registered.',
        },
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // 2. Finalize profile metadata & audit log under the authenticated administrator's session
  const { data: profile, error: profileError } = await callerClient.rpc(
    'admin_configure_student_profile',
    {
      p_student_id: createdAuth.user.id,
      p_full_name: fullName,
      p_student_identifier: studentIdentifier,
      p_account_status: 'active',
    }
  );

  if (profileError) {
    await adminClient.auth.admin.deleteUser(createdAuth.user.id);
    return new Response(
      JSON.stringify({
        error: {
          code: 'PROFILE_SETUP_FAILED',
          message: 'Unable to configure student profile (check student identifier uniqueness).',
        },
      }),
      { status: 409, headers: { 'Content-Type': 'application/json' } }
    );
  }

  return new Response(JSON.stringify({ data: profile }), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
});
