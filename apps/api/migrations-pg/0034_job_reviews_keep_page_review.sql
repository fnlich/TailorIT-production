-- v3.0 FIX-B (REV-SEC SEC-9, REV-REQ REQ-9, INT-3 open item 7; docs/design/part2/14-extension-reports.md §5.3, §7):
-- a page job's review outlives the account that filed it first.
--
-- A new-job review from pages hangs on the first reporter's page job (job_reviews.job_id), and a page job is its
-- account's own row of `jobs` (owner_user_id ON DELETE CASCADE). Deleting that account deleted its page job, so the
-- review (job_id CASCADE), so every other reporter's report row (review_id CASCADE): the queue item was gone, the other
-- page jobs stayed private with no review, and those accounts' rejected reports no longer counted against their trust
-- (features/job-reviews/trust.ts reads rejected reviews' report rows).
--
-- 1. Before an owned job is deleted, every page review that names it moves to another reporter's page job that is not
--    the same account's (the earliest report first, as pageJobsOf orders them). A review with no other page job left is
--    deleted as before: no account holds that posting any more (TailorIT deletes a page job only with its account).
-- 2. A report row deleted with its account takes itself off its review's counts: `reporters` exact, `trusted_reporters`
--    at most that (the trust rule needs the constants; the next report or decision recounts by the rule).
--
-- Triggers only: no table, column or row changes. v3.0 starts on an empty database (DECISIONS P5).

CREATE FUNCTION job_reviews_keep_page_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE job_reviews v
     SET job_id = moved.page_job_id, updated_at = now()
    FROM (
      SELECT DISTINCT ON (r.review_id) r.review_id, r.page_job_id
        FROM job_review_reports r
        JOIN jobs j ON j.id = r.page_job_id
       WHERE r.review_id IN (SELECT id FROM job_reviews WHERE job_id = OLD.id AND kind = 'new_job' AND origin = 'page')
         AND r.user_id <> OLD.owner_user_id
         AND j.id <> OLD.id
         AND j.owner_user_id IS DISTINCT FROM OLD.owner_user_id
       ORDER BY r.review_id, r.created_at, r.user_id
    ) moved
   WHERE v.id = moved.review_id;
  RETURN OLD;
END
$$;

-- Owned jobs only (page jobs and an account's own jobs): a shared job's delete never runs it.
CREATE TRIGGER job_reviews_keep_page_review BEFORE DELETE ON jobs
  FOR EACH ROW WHEN (OLD.owner_user_id IS NOT NULL) EXECUTE FUNCTION job_reviews_keep_page_review();

CREATE FUNCTION job_review_reports_uncount() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A review deleted in the same statement (its rows going with it) is no longer visible here: nothing to update.
  UPDATE job_reviews
     SET reporters = GREATEST(reporters - 1, 0),
         trusted_reporters = LEAST(trusted_reporters, GREATEST(reporters - 1, 0))
   WHERE id = OLD.review_id;
  RETURN NULL;
END
$$;

CREATE TRIGGER job_review_reports_uncount AFTER DELETE ON job_review_reports
  FOR EACH ROW EXECUTE FUNCTION job_review_reports_uncount();
