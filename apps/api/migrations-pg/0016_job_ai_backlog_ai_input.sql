-- v3.0 INT-3 (S1-API's edit C, docs/design/part2/12-job-sourcing.md §9.7): the AI backlog never queues a job whose
-- host's robots.txt says ai-input=no (jobs.ai_input false: ingest/hosts.ts keeps it with the host's content signal, the
-- store writes it from the source). The backlog's candidates read `WHERE j.active AND j.ai_input`
-- (features/job-analysis/backlog.ts), so its partial index takes the same predicate and the walk stays an index walk in
-- the order it reads (job-analysis-backlog-perf.test.ts): the live jobs AI may read, newest first.
--
-- An index rebuilt, nothing else: no table, column or row changes. v3.0 starts on an empty database (DECISIONS P5).
DROP INDEX IF EXISTS idx_jobs_ai_backlog;
CREATE INDEX idx_jobs_ai_backlog ON jobs(first_seen_at DESC, id DESC) INCLUDE (content_hash) WHERE active AND ai_input;
