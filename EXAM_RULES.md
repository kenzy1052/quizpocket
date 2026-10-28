# QuizPocket Examination Rules Specification (`EXAM_RULES.md`)

All rules below are enforced authoritatively by PostgreSQL triggers and server-side RPCs using UTC server timestamps (`public.utc_now()`).

---

## 1. Examination Lifecycle & Controlled Editing Policy

- **Statuses**:
  - `draft`: Visible only to administrators. Cannot be started or viewed by students even if pre-assigned.
  - `published`: Eligible assigned students may view metadata and start attempts within the configured schedule window. Publishing requires `>= 1` valid question, `total_marks > 0`, and **exactly 1** correct option per question.
  - `archived`: Closed to new attempts while preserving all historical attempts, answers, results, and analytics.
- **Controlled Editing**:
  - **Draft exams** and **published exams with zero attempts** can have questions, options, marks, duration, and passing percentage edited freely (`exams.total_marks` updates automatically).
  - **Exams with one or more recorded attempts** automatically lock question additions/deletions, question text, marks, negative marks, option text, `is_correct`, `duration_minutes`, `total_marks`, and `passing_percentage` (`EXAM_LOCKED_BY_ATTEMPTS`) so historical results remain reproducible.
  - Administrative release controls (`result_release_policy`, `results_released_manually`, `allow_review`, `archived` status) remain adjustable at any time.

---

## 2. Eligibility & Availability Windows vs. Personal Deadlines

- **Explicit Assignment Required**: An exam is accessible to a student **only** if they have an `active` direct `exam_assignments` row **or** an `active` class `exam_assignments` row paired with an `active` `class_memberships` enrollment.
- **Availability Window (`scheduled_start_at`, `scheduled_end_at`)**:
  - Governs **when a new attempt may be started**:
    - If `utc_now() < scheduled_start_at` -> rejected with `EXAM_NOT_YET_OPEN`.
    - If `utc_now() > scheduled_end_at` -> rejected with `EXAM_WINDOW_CLOSED`.
- **Personal Attempt Deadline (`deadline_at`)**:
  - Distinct from `scheduled_end_at`. When a student validly starts within the availability window, their personal attempt deadline is computed on the server as:
    ```text
    deadline_at = started_at + duration_minutes
    ```
  - For example, an examination window may stay open from `09:00` to `17:00` (`8 hours`) while each student receives a strict `30-minute` personal timer from the moment they start.

---

## 3. Starting, Resuming, and Concurrent Request Safety

When `student_start_or_resume_attempt(p_exam_id)` is called:
1. A transactional advisory lock (`pg_advisory_xact_lock`) + partial unique index (`WHERE status = 'in_progress'`) serializes simultaneous requests from multiple tabs or devices.
2. If an `in_progress` attempt already exists:
   - **Still within `deadline_at`**: Resumed (`resumed: true`) with its original `started_at` and `deadline_at` unchanged. Refreshing the browser, reopening the app, or changing the phone's clock never grants extra time.
   - **Past `deadline_at`**: Automatically finalized as `auto_submitted` before evaluating whether a new retake is allowed.

---

## 4. Saving Answers

When `student_save_answer(p_attempt_id, p_question_id, p_selected_option_id)` is called:
- Verifies authenticated student ownership of the attempt and `status = 'in_progress'`.
- Checks `utc_now() <= deadline_at`:
  - If `utc_now() > deadline_at`, the late answer is **rejected**, the attempt is atomically finalized as `auto_submitted` using only answers saved prior to `deadline_at`, and `ATTEMPT_DEADLINE_EXPIRED` is returned.
- Validates that `p_question_id` belongs to the attempt's examination and `p_selected_option_id` belongs to `p_question_id`.
- Upserts on `(attempt_id, question_id)` so repeated saves update the existing answer in place and increment `revision` (`1, 2, 3, ...`) without creating duplicate rows.

---

## 5. Manual & Automatic Submission Rules

- **Manual Submission (`student_submit_attempt`)**:
  - If received at `utc_now() <= deadline_at`: marks objective questions atomically, sets `status = 'submitted'` and `submitted_at = utc_now()`.
  - **At/After Deadline Arrival Policy**: If a manual submit request arrives after `deadline_at` (e.g., network latency at expiry), previously saved valid answers are still graded, and the attempt is finalized with `status = 'auto_submitted'` and effective cutoff `submitted_at = deadline_at` (while `results.finalized_at` records exact grading timestamp `utc_now()`).
  - **Idempotency**: Repeated submission requests (e.g., retry after network drop) return the existing finalized state (`already_finalized: true`) without re-grading or creating duplicate results.
- **Automatic Background Submission (`finalize_expired_attempts`)**:
  - Runs independently of student browsers via three complementary mechanisms:
    1. **PostgreSQL `pg_cron`** (`20261025000600_scheduled_auto_submit.sql`, every minute on Supabase projects with `pg_cron` enabled).
    2. **Scheduled Edge Function / Express Sweeper** (`supabase/functions/finalize-expired-attempts` or `server.ts` 60-second interval / `/api/internal/cron/finalize-expired-attempts`).
    3. **Lazy Server Enforcement** on `student_save_answer`, `student_get_attempt_questions`, and `student_start_or_resume_attempt`.
  - Uses `FOR UPDATE SKIP LOCKED` and idempotent checks in `internal_finalize_attempt` so concurrent sweeps never conflict or duplicate results.

---

## 6. Retake Cooldowns & Attempt Limits

- **Default Cooldown**: `180 minutes` (configurable per examination: `0`, `120`, `180`, or any administrator value up to `43200` minutes).
- **Cooldown Calculation**:
  - Cooldown begins at the previous attempt's finalized cutoff (`submitted_at`), whether `submitted` manually or `auto_submitted` automatically:
    ```text
    next_eligible_at = previous_attempt.submitted_at + retake_cooldown_minutes
    ```
  - Any start request before `utc_now() >= next_eligible_at` is rejected with `RETAKE_COOLDOWN_ACTIVE`.
- **Maximum Attempts (`max_attempts`)**:
  - Counts all finalized (`submitted` and `auto_submitted`) attempts for `(exam_id, student_id)`.
  - Once `completed_attempts >= max_attempts`, further attempts are permanently denied (`MAX_ATTEMPTS_REACHED`), even after the cooldown period has elapsed.

---

## 7. Automated Marking, Rubric Evaluation, & Teacher Grading

Supported question types: **Multiple Choice**, **True/False**, **Fill-in-the-Blank**, and **Short Answer**.

- **Per-Question Award**:
  - **Multiple Choice & True/False**:
    - Correct (`selected_option_id = correct_option_id`): `+question.marks`
    - Unanswered (`selected_option_id IS NULL`): `0`
    - Incorrect (`selected_option_id <> correct_option_id`): `-question.negative_marks` (defaults to `0`)
  - **Fill-in-the-Blank (`fill_in_blank`)**:
    - Normalized case- and punctuation-insensitively (`normalize_answer_token` & `normalize_answer_compact`, so `"ICD-10"`, `"icd 10"`, and `"ICD10"` match cleanly against `accepted_answers`).
    - Match: `+question.marks`; Blank: `0`; Non-match: `-question.negative_marks` (defaults to `0`).
  - **Short Answer (`short_answer`)**:
    - Evaluated against structured `rubric_keywords` concept groups (`ROUND((matched_groups / required_matches) * marks, 2)`), awarding `'correct'`, `'partial'`, or `'incorrect'` credit automatically, with full teacher item-level adjustment support.
- **Aggregate Score, Percentage, and Pass/Fail**:
  ```text
  raw_marks      = SUM(marks_awarded)
  marks_obtained = LEAST(total_marks, GREATEST(0, raw_marks))   -- floored at 0
  percentage     = ROUND((marks_obtained / total_marks) * 100, 2)
  passed         = (percentage >= exam.passing_percentage)
  ```
- **Audited Item & Overall Corrections**: Students can never modify `results` or `result_items`. Administrators may grade/adjust individual items via `admin_grade_result_item(p_result_id, p_question_id, p_marks_awarded, p_reason)` or adjust an overall result via `admin_correct_result(p_result_id, p_corrected_marks, p_reason)`, both of which validate bounds, recompute `percentage` and `passed`, increment `marking_version`, and append an immutable record to `audit_logs`.

---

## 8. Result Release & Answer Review Policies

| `result_release_policy` | When Score / Pass Status Is Visible to Student | When Questions, Correct Answers, & Explanations Are Visible |
| :--- | :--- | :--- |
| `immediate` | Immediately upon attempt finalization | Immediately upon finalization **if and only if** `allow_review = true` |
| `after_window` | When `utc_now() >= scheduled_end_at` (or if `results_released_manually = true`) | After window closes **if and only if** `allow_review = true` |
| `manual` | Only after an administrator sets `results_released_manually = true` | After manual release **if and only if** `allow_review = true` |
