-- v3.0 DB-JOBS (PLAN §9; docs/design/part2/11-database.md §5.5, §5.7, §5.8, §8.2): views and saves in job_stats and
-- the legacy jobs.view_count gone; no posting copies by default; the retention walks' indexes; the exact record's
-- frozen answers when a second submission replaces the first.

-- ── job_stats counts views and saves (11 §5.5): a view never rewrites the jobs row ─────────────────────────────────
-- The counts so far move over: each job's views (jobs.view_count) and its tracker entries as its saves. Nothing wrote
-- job_stats before this file; a row there already (a seed) keeps its numbers and adds these.
INSERT INTO job_stats(job_id, views, saves, updated_at)
SELECT j.id, j.view_count, coalesce(a.n, 0), now()
FROM jobs j
LEFT JOIN (SELECT job_id, count(*) AS n FROM applications WHERE job_id IS NOT NULL GROUP BY job_id) a ON a.job_id = j.id
WHERE j.view_count > 0 OR a.n > 0
ON CONFLICT (job_id) DO UPDATE SET views = job_stats.views + excluded.views,
  saves = greatest(job_stats.saves, excluded.saves), updated_at = excluded.updated_at;

-- The baseline's legacy column (PG-0's list: "legacy: DB-JOBS drops it").
ALTER TABLE jobs DROP COLUMN view_count;

-- ── No posting copies (D1c, 11 §5.8) ──────────────────────────────────────────────────────────────────────────────
-- NULL is the job's own text (job_texts), read when the entry or the letter is shown; a value is a text of its own. A
-- writer that names no description now stores none, so an entry or letter of a job shows the job's text.
ALTER TABLE applications ALTER COLUMN description_html DROP DEFAULT;
ALTER TABLE cover_letters ALTER COLUMN job_description DROP DEFAULT;

-- ── The retention walks (D1g, 11 §8.2; features/account/housekeeping.ts) ───────────────────────────────────────────
-- Views kept USER_JOB_VIEW_KEEP_DAYS (hides forever): the expired marks in age order.
CREATE INDEX idx_user_job_state_viewed ON user_job_state(viewed_at) WHERE hidden_at IS NULL AND viewed_at IS NOT NULL;
-- "A closed job nobody tracks": whether any tracker entry names a job (idx_app_user_job leads with the account).
CREATE INDEX idx_app_job ON applications(job_id) WHERE job_id IS NOT NULL;
-- Deleting an analysis sets job_facts.analysis_id NULL (its foreign key): found by this index, not a scan of job_facts.
CREATE INDEX idx_job_facts_analysis ON job_facts(analysis_id) WHERE analysis_id IS NOT NULL;

-- ── The exact record's answers (11 §5.8) ────────────────────────────────────────────────────────────────────────────
-- Submitted answers stay per application (application_form_answers) and a record says answers = 'submitted'. A later
-- submission of the same application replaces them (features/autofill/forms/store.ts replaceAnswers deletes, then
-- inserts): before they go, the set is frozen into the latest submitted record that does not keep its own yet, as
-- [{label, answer}] in the form's order (an empty question's answer null). Any delete freezes what it removes the same
-- way, so a record never loses the answers it was sent with.
CREATE FUNCTION freeze_replaced_submission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE application_apply_records r SET answers_used = g.used
  FROM (
    SELECT o.application_id,
      jsonb_agg(jsonb_build_object('label', coalesce(q.label, ''), 'answer', o.answer::jsonb)
        ORDER BY q.step, q.position, o.question_id) AS used
    FROM gone o LEFT JOIN job_form_questions q ON q.id = o.question_id
    GROUP BY o.application_id
  ) g
  WHERE r.id = (SELECT max(r2.id) FROM application_apply_records r2
                 WHERE r2.application_id = g.application_id AND r2.answers = 'submitted')
    AND r.answers_used IS NULL;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_form_answers_freeze AFTER DELETE ON application_form_answers
  REFERENCING OLD TABLE AS gone FOR EACH STATEMENT EXECUTE FUNCTION freeze_replaced_submission();
