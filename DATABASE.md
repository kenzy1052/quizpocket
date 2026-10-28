# QuizPocket Database Architecture (`DATABASE.md`)

All schema objects live in version-controlled SQL migrations under `supabase/migrations/`.

---

## 1. Entity Overview & Relationships

| Table | Primary Key | Key Foreign Keys & Uniqueness | Purpose |
| :--- | :--- | :--- | :--- |
| `institutions` | `id (uuid)` | `UNIQUE (slug)` | Scopes users, classes, exams, and student identifiers per institution (seeded with a default institution for single-teacher MVP). |
| `profiles` | `id (uuid)` | `id -> auth.users(id) ON DELETE CASCADE`, `institution_id -> institutions(id)`, `UNIQUE (institution_id, lower(student_identifier))` | Application user profile, role (`student` \| `admin`), and `account_status` (`active` \| `suspended` \| `pending_approval`). |
| `classes` | `id (uuid)` | `institution_id -> institutions(id)`, `created_by -> profiles(id)`, `UNIQUE (institution_id, lower(name))` | Academic cohorts / student groups managed by administrators. |
| `class_memberships` | `id (uuid)` | `class_id -> classes(id)`, `student_id -> profiles(id)`, `UNIQUE (class_id, student_id)` | Enrolls students into classes (`active` \| `inactive`). |
| `exams` | `id (uuid)` | `institution_id -> institutions(id)`, `created_by -> profiles(id)` | Examination metadata, timing, availability window, `total_marks` snapshot, retake rules, and release policy. |
| `exam_questions` | `id (uuid)` | `exam_id -> exams(id) ON DELETE CASCADE`, `UNIQUE (exam_id, display_order)` | Objective questions (`multiple_choice`, `true_false`), marks, negative marks, and private `explanation`. |
| `question_options` | `id (uuid)` | `question_id -> exam_questions(id) ON DELETE CASCADE`, `UNIQUE (question_id, display_order)`, partial `UNIQUE (question_id) WHERE is_correct = true` | Candidate options and protected `is_correct` flag. |
| `exam_assignments` | `id (uuid)` | `exam_id -> exams(id)`, `student_id -> profiles(id)` XOR `class_id -> classes(id)` | Grants explicit student or class eligibility for an examination. |
| `exam_attempts` | `id (uuid)` | `exam_id -> exams(id)`, `student_id -> profiles(id)`, `UNIQUE (exam_id, student_id, attempt_number)`, partial `UNIQUE (exam_id, student_id) WHERE status = 'in_progress'` | Server-timed individual examination sessions (`started_at`, `deadline_at`, `submitted_at`). |
| `student_answers` | `id (uuid)` | `attempt_id -> exam_attempts(id)`, `question_id -> exam_questions(id)`, `selected_option_id -> question_options(id)`, `UNIQUE (attempt_id, question_id)` | Latest validated answer per question with monotonic `revision` counter. |
| `results` | `id (uuid)` | `attempt_id -> exam_attempts(id) UNIQUE`, `student_id -> profiles(id)`, `exam_id -> exams(id)` | Immutable finalized score, percentage, pass/fail status, and `marking_version`. |
| `result_items` | `id (uuid)` | `result_id -> results(id)`, `question_id -> exam_questions(id)`, `UNIQUE (result_id, question_id)` | Per-question grading snapshot (`correct`, `incorrect`, `unanswered`, `marks_awarded`, `correct_option_id`). |
| `audit_logs` | `id (uuid)` | `institution_id -> institutions(id)`, `actor_id -> profiles(id)` | Append-only audit log protected by an immutability trigger preventing `UPDATE` and `DELETE`. |

---

## 2. Total Marks Consistency Decision

`exams.total_marks` is stored on `public.exams` as a **trigger-synchronized validated snapshot**:
- Whenever rows in `public.exam_questions` are inserted, updated, or deleted (prior to any student attempts), `trg_recalculate_exam_total_marks` automatically recomputes `SUM(exam_questions.marks)` and updates `exams.total_marks`.
- `admin_publish_exam` refuses to publish if `total_marks <= 0` or if any question lacks valid options or a single correct option.
- Once any student attempt exists (`EXISTS (SELECT 1 FROM exam_attempts WHERE exam_id = ...)`), triggers on `exams`, `exam_questions`, and `question_options` lock `marks`, `negative_marks`, `duration_minutes`, `passing_percentage`, options, and `is_correct` so historical scores never change meaning silently.
- Finalized `results.total_marks` also captures the exact `total_marks` used during grading.

---

## 3. Row Level Security (RLS) Matrix

RLS is enabled on **all 13 tables**, and `anon` has **zero** table privileges.

| Table | Read (`SELECT`) | Insert / Update / Delete | Server RPC Requirement |
| :--- | :--- | :--- | :--- |
| `institutions` | Active member of institution | Denied to clients | Seeded / service-role managed |
| `profiles` | Active user (own row) or active admin (same institution) | Student may `UPDATE (full_name)` on own active row (guarded by column grant + trigger); admin manages via `admin_configure_student_profile` | `bootstrap_initial_admin` (`service_role` only), `admin_configure_student_profile` |
| `classes` | Active admin (all in institution); active student (enrolled classes only) | Active admin (same institution) | `admin_create_class` |
| `class_memberships` | Active admin (institution); active student (own active rows) | Active admin (same institution) | `admin_set_class_membership` |
| `exams` | Active admin (institution); active student (assigned & `published` only) | Active admin (subject to attempt-lock trigger) | `admin_create_exam`, `admin_publish_exam`, `admin_archive_exam` |
| `exam_questions` | **Admin only** (`0` rows for students) | Active admin (locked once attempts exist) | `admin_upsert_question_with_options`, `student_get_attempt_questions` |
| `question_options` | **Admin only** (`0` rows for students) | Active admin (locked once attempts exist) | `admin_upsert_question_with_options`, `student_get_attempt_questions` |
| `exam_assignments` | Active admin (institution); active student (own or active class assignments) | Active admin | `admin_assign_exam` |
| `exam_attempts` | Active admin (institution); active student (own rows) | **Denied via direct table access** | `student_start_or_resume_attempt`, `student_submit_attempt`, `finalize_expired_attempts` |
| `student_answers` | Active admin (institution); active student (own attempts) | **Denied via direct table access** | `student_save_answer` |
| `results` | Active admin (institution); active student (**own rows ONLY when `is_result_released_for_exam(exam_id)` is true**) | **Denied via direct table access** | `internal_finalize_attempt`, `admin_correct_result` |
| `result_items` | Active admin (institution); active student (**own rows ONLY when result is released AND `allow_review = true`**) | **Denied via direct table access** | `student_get_attempt_review` |
| `audit_logs` | Active admin (institution) | **Denied (`AUDIT_LOG_IMMUTABLE` trigger blocks UPDATE/DELETE)** | `internal_write_audit_log` |

---

## 4. Answer-Key & Result Protection Architecture

1. **Zero Direct Table Access to Answer Keys**: Students have no RLS `SELECT` policy on `exam_questions` or `question_options`. Calling `supabase.from('question_options').select('*')` with a valid student JWT returns `[]`.
2. **Sanitized Active-Attempt Projection**: `student_get_attempt_questions(p_attempt_id)` verifies `auth.uid()` owns an active, non-expired `in_progress` attempt and constructs JSON containing only `id`, `question_text`, `question_type`, `marks`, `negative_marks`, `display_order`, `is_required`, and `[id, option_text, display_order]`. Neither `is_correct` nor `explanation` is ever projected.
3. **Policy-Gated Review**: `student_get_attempt_review(p_attempt_id)` returns `correct_option_id`, `is_correct`, and `explanation` **only** after submission, **only** when `is_result_released_for_exam(exam_id)` evaluates to `true`, and **only** when `exams.allow_review = true`.

---

## 5. Privileged PostgreSQL Functions Reference

All `SECURITY DEFINER` functions enforce `SET search_path = public, pg_temp` and explicit `REVOKE ALL ... FROM PUBLIC, anon`.

| Function | Caller Requirement | Transactional | Purpose & Key Validations |
| :--- | :--- | :--- | :--- |
| `bootstrap_initial_admin(p_user_id, p_full_name)` | `service_role` / DB owner | Yes | Promotes an existing `auth.users` account to initial `admin` and writes `admin_bootstrapped` audit event. |
| `admin_configure_student_profile(...)` | Active `admin` | Yes | Sets student full name, institution-scoped `student_identifier`, and `account_status`. Cannot modify other admins. |
| `admin_create_class` / `admin_set_class_membership` | Active `admin` | Yes | Creates classes and manages student enrollments with institution matching. |
| `admin_create_exam` / `admin_publish_exam` / `admin_archive_exam` | Active `admin` | Yes | Manages exam lifecycle; publish verifies `>= 1` question, `total_marks > 0`, and 1 correct option per question. |
| `admin_upsert_question_with_options(...)` | Active `admin` | Yes | Validates option counts (2 for T/F, 2–8 for MCQ), unique option text, exactly 1 `is_correct`, and locks if attempts exist. |
| `admin_assign_exam(...)` | Active `admin` | Yes | Idempotently assigns or revokes student or class access. |
| `admin_set_exam_release_settings(...)` | Active `admin` | Yes | Updates `result_release_policy`, `results_released_manually`, and `allow_review`. |
| `admin_correct_result(p_result_id, p_corrected_marks, p_reason)` | Active `admin` | Yes (`FOR UPDATE`) | Updates marks/percentage/pass status with mandatory audit reason and increments `marking_version`. |
| `student_list_eligible_exams()` | Active `student` | Read | Lists assigned published exams with server time, active attempt ID, and next cooldown eligibility timestamp. |
| `student_start_or_resume_attempt(p_exam_id)` | Active `student` | Yes (`pg_advisory_xact_lock`) | Enforces assignment, schedule window, auto-expiry of stale active attempt, active attempt resume, `max_attempts`, and `retake_cooldown_minutes`. |
| `student_get_attempt_questions(p_attempt_id)` | Active `student` | Yes (`FOR UPDATE`) | Enforces attempt ownership & deadline; returns sanitized questions/options with deterministic per-attempt shuffle if enabled. |
| `student_save_answer(p_attempt_id, p_question_id, p_selected_option_id)` | Active `student` | Yes (`FOR UPDATE`) | Validates ownership, active status, deadline (auto-submits if expired), question-exam match, and option-question match; increments `revision`. |
| `student_submit_attempt(p_attempt_id)` | Active `student` | Yes (`FOR UPDATE`) | Idempotently grades objective answers, writes `results` + `result_items` + `audit_logs`, and withholds score unless release policy allows. |
| `finalize_expired_attempts(p_batch_limit)` | `service_role` or active `admin` | Yes (`FOR UPDATE SKIP LOCKED`) | Sweeps and auto-submits expired `in_progress` attempts idempotently. |
| `admin_get_exam_statistics` / `admin_list_exam_attempts` / `admin_get_attempt_detail` / `admin_get_question_analytics` / `admin_get_class_performance_summary` / `admin_export_exam_results_rows` | Active `admin` | Read / Audited | Delivers administrative analytics, per-question breakdowns, and formula-sanitized CSV rows. |

## 6. Admin UI Database Setup

The admin UI uses the existing `admin_upsert_question_with_options` RPC to edit question text and answer options, and `admin_archive_exam` to remove a quiz from student access while preserving its attempts, results, and audit history. Question and answer edits are intentionally locked once attempts exist so published scores retain their original meaning. No additional schema migration is required for these UI updates.

Verify that both RPCs are installed in the target database:
```sql
SELECT routine_name, specific_name
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name IN ('admin_archive_exam', 'admin_upsert_question_with_options')
ORDER BY routine_name;
```

If either function is missing, apply the version-controlled migrations from the project root:
```bash
npx supabase db push
```
