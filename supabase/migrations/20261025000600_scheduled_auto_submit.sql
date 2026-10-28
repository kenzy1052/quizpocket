-- ============================================================================
-- Migration 0006: Scheduled Automatic Submission (pg_cron when supported)
-- Project: QuizPocket — Online Examination & Assessment Platform
-- ============================================================================

-- On hosted Supabase projects with pg_cron enabled (Dashboard -> Integrations -> Cron),
-- register an idempotent every-minute sweep for expired in_progress attempts.
-- In environments without pg_cron (e.g., lightweight local PostgreSQL), this block
-- degrades gracefully and relies on the Edge Function / server scheduler + lazy guards.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;

    IF EXISTS (
      SELECT 1 FROM pg_namespace WHERE nspname = 'cron'
    ) THEN
      PERFORM cron.schedule(
        'quizpocket-finalize-expired-attempts',
        '* * * * *',
        $job$SELECT public.finalize_expired_attempts(200);$job$
      );
    END IF;
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    -- Non-fatal when pg_cron privileges are unavailable in local test runners.
    NULL;
END
$$;
