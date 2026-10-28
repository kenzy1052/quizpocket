-- ============================================================================
-- Migration 0001: Extensions, Domain Enums, and Core Time Helpers
-- Project: QuizPocket — Online Examination & Assessment Platform
-- ============================================================================

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
EXCEPTION
  WHEN OTHERS THEN
    -- Core PostgreSQL 13+ provides gen_random_uuid() natively even when
    -- extension installation privileges are restricted.
    NULL;
END
$$;

DO $$ BEGIN
  CREATE TYPE public.user_role AS ENUM ('student', 'admin');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.account_status AS ENUM ('active', 'suspended', 'pending_approval');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.membership_status AS ENUM ('active', 'inactive');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.exam_status AS ENUM ('draft', 'published', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.result_release_policy AS ENUM ('immediate', 'after_window', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.question_type AS ENUM ('multiple_choice', 'true_false');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.assignment_status AS ENUM ('active', 'revoked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.attempt_status AS ENUM ('in_progress', 'submitted', 'auto_submitted', 'voided');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Authoritative UTC server timestamp helper. Never accepts client clock input.
CREATE OR REPLACE FUNCTION public.utc_now()
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT timezone('utc', now());
$$;

-- Standard updated_at maintenance trigger function
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := public.utc_now();
  RETURN NEW;
END;
$$;
