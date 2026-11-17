-- v3.0 PG-C: ingest reads and writes job_source_runs (11 §5.3 renamed v2.0's ingest_runs), so the temporary view
-- 0002 made for v2.0's SQL goes. Nothing reads it any more.
DROP VIEW IF EXISTS ingest_runs;
