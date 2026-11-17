-- v3.0 PG-0: v2.0's name for job_source_runs (11 §5.3 renamed ingest_runs), as an updatable view, so v2.0's ingest SQL
-- (its start-up recovery runs at every API start) works on PostgreSQL until PG-C moves the folder to job_source_runs.
-- PG-C drops it in its own migration (0003) with that port; nothing new reads or writes it.
CREATE VIEW ingest_runs AS
  SELECT id, source_id, trigger, status, started_at, finished_at, fetched, created, updated, unchanged, deactivated,
    failed, error, log
  FROM job_source_runs;
