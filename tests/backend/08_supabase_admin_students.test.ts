import { afterEach, describe, expect, it, vi } from 'vitest';
import { SupabaseBackendGateway } from '../../src/backend/db/supabaseGateway.ts';
import type { AuthenticatedActor } from '../../src/backend/types/domain.ts';

describe('Supabase admin student listing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('queries the profiles schema and includes suspended students for admin management', async () => {
    const requestUrls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      requestUrls.push(input instanceof Request ? input.url : String(input));
      return new Response('[]', {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Range': '0-0/*',
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const gateway = new SupabaseBackendGateway({
      port: 3000,
      supabaseUrl: 'https://quizpocket-test.supabase.co',
      supabasePublicKey: 'test-publishable-key',
      supabaseServiceRoleKey: null,
      cronSecret: null,
      isSupabaseConfigured: true,
    });
    const actor: AuthenticatedActor = {
      uid: '00000000-0000-0000-0000-000000000001',
      email: 'admin@example.test',
      accessToken: 'test-access-token',
      profile: {
        id: '00000000-0000-0000-0000-000000000001',
        institution_id: '00000000-0000-0000-0000-000000000002',
        email: 'admin@example.test',
        full_name: 'Test Admin',
        student_identifier: null,
        role: 'admin',
        account_status: 'active',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    };

    await expect(gateway.adminListStudents(actor)).resolves.toEqual([]);
    expect(requestUrls).toHaveLength(1);

    const profileRequest = new URL(requestUrls[0]);
    expect(profileRequest.pathname).toBe('/rest/v1/profiles');
    expect(profileRequest.searchParams.get('role')).toBe('eq.student');
    expect(profileRequest.searchParams.has('is_active')).toBe(false);
  });
});
