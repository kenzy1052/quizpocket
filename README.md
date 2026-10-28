# QuizPocket — Knowledge in Your Pocket

QuizPocket is a controlled online examination and academic assessment platform built for teachers and administrators to author, schedule, assign, monitor, and automatically grade timed objective examinations for students.

> **Current Phase**: **Phase 1 Complete (Backend Architecture, PostgreSQL Schema, RLS, Examination Engine, Analytics, CSV Exports, & Security Test Suite)**.  
> Per the Backend-First implementation plan, the visual iPhone-first frontend will be built in **Phase 2** on top of this verified backend foundation.

---

## Technology Stack

- **Database & Security**: Supabase PostgreSQL, Row Level Security (RLS), PL/pgSQL transactional RPCs, triggers, and partial unique indexes (`supabase/migrations/`).
- **Authentication**: Supabase Auth (email/password with controlled student provisioning and server-verified JWTs).
- **Server-Side Execution**:
  - Supabase PostgreSQL `SECURITY DEFINER` functions (with locked `search_path = public, pg_temp`).
  - Supabase Edge Functions (`supabase/functions/finalize-expired-attempts`, `supabase/functions/admin-create-student`).
  - Express + `@supabase/supabase-js` trusted backend router (`server.ts` / `src/backend/`).
- **Automated Testing**: `vitest`, `@electric-sql/pglite` (real compiled PostgreSQL 16 engine executing all SQL migrations and RLS roles), and `supertest`.

---

## Prerequisites

- **Node.js** 20+ and **npm**
- **Supabase CLI** (`npx supabase ...`) when linking or pushing migrations to a local Docker stack or hosted Supabase project
- A **Supabase Project** (required when connecting to live cloud infrastructure)

---

## Installation & Environment Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Create your local `.env` file from the template**:
   ```bash
   cp .env.example .env
   ```

3. **Configure environment variables in `.env`** (never commit `.env` to Git):
   - **Public client configuration** (safe for browser use **only** because RLS and least-privilege grants are enforced on every table):
     - `VITE_SUPABASE_URL` — Your Supabase Project URL (`https://<project-ref>.supabase.co`).
     - `VITE_SUPABASE_PUBLISHABLE_KEY` — Your Supabase publishable key (`sb_publishable_...`), **or** `VITE_SUPABASE_ANON_KEY` if your project uses legacy anon keys.
   - **Trusted server-only secrets** (**NEVER** prefix with `VITE_` or place in browser code):
     - `SUPABASE_SERVICE_ROLE_KEY` — Used strictly by the server/Edge Functions for privileged Auth user provisioning and scheduled expiry sweeps.
     - `CRON_SECRET` — High-entropy shared secret authenticating scheduled expiry sweep calls (`openssl rand -hex 32`).

---

## Applying & Verifying Supabase Migrations

All database schema changes live in version control under `supabase/migrations/`:

1. `20261025000100_extensions_and_enums.sql` — Extensions, enums, and authoritative UTC clock helper.
2. `20261025000200_core_schema_tables_and_triggers.sql` — Normalized tables, constraints, partial indexes, total-marks sync, and controlled-editing triggers.
3. `20261025000300_rls_policies_and_grants.sql` — RLS activation, explicit policies, answer-key isolation, and least-privilege grants.
4. `20261025000400_exam_engine_rpcs.sql` — Transactional server-side examination engine RPCs.
5. `20261025000500_analytics_admin_and_exports.sql` — Examination statistics, question analytics, class summaries, and formula-sanitized CSV export RPCs.
6. `20261025000600_scheduled_auto_submit.sql` — `pg_cron` automatic expiry job registration (when `pg_cron` is enabled).

### Local Supabase CLI Stack
```bash
npx supabase start
npx supabase db push
```

### Hosted Supabase Project
Before pushing to an existing project, inspect the target database to confirm there are no conflicting tables:
```bash
npx supabase link --project-ref <your-project-ref>
npx supabase migration list
npx supabase db push
```

### Verifying Schema & RLS Activation
Run in the Supabase SQL Editor:
```sql
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;
```
Every table in `public` must show `rowsecurity = true`.

### Creating the Initial Administrator Account
Public registration cannot create administrator accounts. To bootstrap your first teacher/administrator:
1. Create the teacher's user account in **Supabase Dashboard -> Authentication -> Users -> Add User** (copy the generated `UUID`).
2. Run in the **Supabase SQL Editor** (runs with privileged owner permissions):
   ```sql
   SELECT * FROM public.bootstrap_initial_admin(
     '<TEACHER_AUTH_USER_UUID>'::uuid,
     'Teacher Full Name'
   );
   ```

---

## Running Locally & Running Automated Tests

- **Run the automated PostgreSQL + RLS + API test suite** (executes all 6 `.sql` migration files against an isolated real PostgreSQL 16 engine—no cloud credentials required):
  ```bash
  npm test
  ```
- **Run TypeScript verification**:
  ```bash
  npm run lint
  ```
- **Start the local development server** (port `3000`):
  ```bash
  npm run dev
  ```

---

## Safe Deployment Checklist

1. Disable open public email sign-up in **Supabase Dashboard -> Authentication -> Providers -> Email** if you want strictly administrator-created student accounts.
2. Enable the **`pg_cron`** extension in **Supabase Dashboard -> Integrations -> Cron** so `quizpocket-finalize-expired-attempts` runs every minute inside PostgreSQL (or schedule `supabase/functions/finalize-expired-attempts` / `POST /api/internal/cron/finalize-expired-attempts` with `x-cron-secret`).
3. Set `SUPABASE_SERVICE_ROLE_KEY` and `CRON_SECRET` only in your server or Supabase Edge Function secrets (`npx supabase secrets set CRON_SECRET=...`).
4. Deploy the repository to Netlify using the included `netlify.toml`. It builds the Vite frontend, publishes `dist/`, packages the Express API as a Netlify Function, and rewrites `/api/*` requests to that function. Deploy from the Git integration or Netlify CLI; uploading only the `dist/` folder does not deploy API functions.
5. In Netlify environment variables, provide `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` for the frontend build and API function. Add `SUPABASE_SERVICE_ROLE_KEY` and `CRON_SECRET` for the Functions runtime only; never use a `VITE_` prefix for either secret.

### Netlify API deployment

The browser calls same-origin `/api/...` routes. `netlify/functions/api.ts` adapts the existing Express router to a Netlify Function, and the `/api/*` rewrite in `netlify.toml` routes sign-up, login, quiz, and admin requests to it. The function uses the hosted Supabase gateway directly and does not initialize the local PGlite/demo seed path.

---

## Known Limitations (Reported Honestly)

- **Remote Supabase Project Not Connected Yet**: No live `VITE_SUPABASE_URL` or Supabase keys were provided in this workspace, so migrations have **not** been pushed to a remote cloud Supabase instance yet. All SQL migrations, RLS policies, triggers, and RPCs have been executed and verified locally against a real embedded PostgreSQL 16 engine (`PGlite`).
- **Online-First MVP**: Controlled examinations require active server connectivity to start attempts, validate answer saves against server deadlines, and submit scores. Offline practice quizzes and local IndexedDB draft reconciliation are deferred to a later phase.
- **Question Types**: Phase 1 supports single-answer `multiple_choice` and `true_false` objective questions. Manual-grading essay questions and multi-select questions can be added in future migrations without redesigning core tables.
- **In-Memory HTTP Rate Limiting**: `src/backend/middleware/rateLimit.ts` uses per-instance sliding windows suitable for single-node deployments; horizontally scaled deployments should pair this with Supabase Auth rate limits or Redis/Cloud Armor.
