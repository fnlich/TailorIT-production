-- v3.0 PG-F: the job AI backlog's write mark (features/job-analysis/backlog.ts; INT-1's list I). After a step that
-- found nothing to read, the backlog skips the next steps' walk of idx_jobs_ai_backlog (every live job's entry) until
-- something is written that could make a job a candidate. On SQLite it read `total_changes()` and
-- `pragma_data_version`; PostgreSQL has neither, and its cluster-wide signals (pg_current_snapshot, the WAL position)
-- move with every other database's writes too, while pg_stat_database's counters arrive late.
--
-- So: a statement on any table the candidates read bumps this sequence (non-transactional, never a lock between
-- writers). The mark is the sequence's value with the transaction ids of this database's writers still open
-- (pg_stat_activity): a write made before the mark but committed after the candidates were read leaves the open list,
-- so the next mark differs and the next step looks again. A bump the candidates did not need (a statement that changed
-- nothing, a write to a column they do not read) only costs one more walk.
CREATE SEQUENCE job_ai_backlog_writes AS bigint;

CREATE FUNCTION job_ai_backlog_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM nextval('job_ai_backlog_writes');
  RETURN NULL;
END
$$;

-- The tables a candidate depends on: the job (live, first seen, its text's hash), its text's length, someone's Saved
-- entry (saved mode, and the older readings read again while saved), the text's readings and its backoff.
CREATE TRIGGER job_ai_backlog_write_jobs AFTER INSERT OR UPDATE OR DELETE ON jobs
  FOR EACH STATEMENT EXECUTE FUNCTION job_ai_backlog_write();
CREATE TRIGGER job_ai_backlog_write_job_texts AFTER INSERT OR UPDATE OR DELETE ON job_texts
  FOR EACH STATEMENT EXECUTE FUNCTION job_ai_backlog_write();
CREATE TRIGGER job_ai_backlog_write_applications AFTER INSERT OR UPDATE OR DELETE ON applications
  FOR EACH STATEMENT EXECUTE FUNCTION job_ai_backlog_write();
CREATE TRIGGER job_ai_backlog_write_job_analyses AFTER INSERT OR UPDATE OR DELETE ON job_analyses
  FOR EACH STATEMENT EXECUTE FUNCTION job_ai_backlog_write();
CREATE TRIGGER job_ai_backlog_write_job_ai_attempts AFTER INSERT OR UPDATE OR DELETE ON job_ai_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION job_ai_backlog_write();
