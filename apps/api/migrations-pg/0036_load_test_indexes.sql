-- tailorit:no-transaction
-- v3.0 FIX-PG (PG-LOAD's load test at mix B's base size, docs/design/part2/measurements.md §6): three indexes for reads
-- that scanned a whole table or a whole index on every call. Each is built CONCURRENTLY (writers keep writing; a built
-- one serves at once), so this file runs outside a transaction; a rerun after a failure drops what a failed build left
-- (an invalid index) and builds it again.
--
-- - idx_app_user (PGL-8): the Tracker's counts (`... FROM applications WHERE user_id = ? GROUP BY ...`) read every
--   entry of every account (the per-person indexes are all partial): 4.3 M rows, 415-467 ms a call. An index-only scan
--   of the person's entries: 3 ms. It serves any per-person read without the partial indexes' predicates.
-- - idx_job_analyses_ai_version (PGL-10): the AI backlog's re-read (`EXISTS ... o.source = 'ai' AND o.version <
--   @version`) read job_analyses' unique index whole (its 2nd and 3rd columns) every 30 s step: 750 MB, 0.8-1.1 s warm,
--   291 s cold. Claude's readings by version: the older ones are a short range of it (0.07 ms).
-- - idx_job_source_runs_running (PGL-15): the worker's recovery every 15 s (`UPDATE job_source_runs ... WHERE status =
--   'running'`) scanned every run kept (90 days of them: 263 ms at 30 days of the base case). The running runs are a
--   handful; the index holds only them.
DROP INDEX CONCURRENTLY IF EXISTS idx_app_user;
CREATE INDEX CONCURRENTLY idx_app_user ON applications(user_id) INCLUDE (archived_at, current_status);
DROP INDEX CONCURRENTLY IF EXISTS idx_job_analyses_ai_version;
CREATE INDEX CONCURRENTLY idx_job_analyses_ai_version ON job_analyses(version, content_hash) WHERE source = 'ai';
DROP INDEX CONCURRENTLY IF EXISTS idx_job_source_runs_running;
CREATE INDEX CONCURRENTLY idx_job_source_runs_running ON job_source_runs(source_id) WHERE status = 'running';
