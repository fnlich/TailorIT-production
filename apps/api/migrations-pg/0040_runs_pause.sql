-- v3.1 RUNS: admins pause and continue job-source runs (docs/design/v3.1/22-runs-pause.md; SP\v31\PLAN.md §4 RUNS, D5).
-- Additive: two nullable columns on job_sources, one on job_source_runs, and one more value in job_source_runs' status
-- list. No row is rewritten (the CHECK is added NOT VALID, then validated under a lock that lets reads and writes go on).
--
-- - job_source_runs.status gains `paused`: an admin paused the run (or every run, or its source); it stopped at its next
--   safe point (between two batches of 200 postings, or its read's abort signal). What it saved stays; it closed
--   nothing; Continue reads the source again from the top (upserts are idempotent).
-- - job_source_runs.stop_requested_at: when an admin asked the run to pause. The process that runs it (the API or the
--   ingest worker) looks for such requests on its own runs every RUN_STOP_POLL_MS and stops the run.
-- - job_sources.paused_at, paused_by: an admin paused the source; no run of it starts (the due queue, Run now) until
--   Continue. Apart from `enabled` (off, or turned off after failures), so Continue gives the source back its schedule.
-- - Every run paused at once is app_settings' key `ingest:paused` ({"at": ..., "by": <users.id>}): no table change. The
--   key exists only while runs are paused.
ALTER TABLE job_source_runs DROP CONSTRAINT IF EXISTS job_source_runs_status_check;
ALTER TABLE job_source_runs ADD CONSTRAINT job_source_runs_status_check
  CHECK (status IN ('running','succeeded','failed','partial','not_modified','paused')) NOT VALID;
ALTER TABLE job_source_runs VALIDATE CONSTRAINT job_source_runs_status_check;
ALTER TABLE job_source_runs ADD COLUMN IF NOT EXISTS stop_requested_at timestamptz;

ALTER TABLE job_sources ADD COLUMN IF NOT EXISTS paused_at timestamptz;
ALTER TABLE job_sources ADD COLUMN IF NOT EXISTS paused_by text REFERENCES users(id) ON DELETE SET NULL;
