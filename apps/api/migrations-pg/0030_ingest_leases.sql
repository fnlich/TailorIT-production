-- v3.0 FIX-A (the W6 review's ingest findings; docs/design/part2/12-job-sourcing.md §8.2, §9.2, §9.3): four small
-- additions, each a nullable column or a one-row table, so the file is metadata only (no row is rewritten).
--
-- - job_sources.lease_owner (REV-BEH BEH-4): the run that holds the source's lease (a random id per run, set with
--   lease_until). Renewals, the run's finish and its close of missing postings act only while the lease is still that
--   run's; a run whose lease ran out and was taken over writes only its own run row (as interrupted).
-- - job_sources.suspect_at (BEH-1): when the source's last listing was judged suspect (it dropped most open postings).
--   A suspect listing is read again within the hour once; a second suspect listing in a row waits for the tier's
--   cadence (the hourly re-reads are capped). Cleared by the next listing that is not suspect.
-- - crawl_hosts.busy_until (REV-BEH's per-host note, 12 §9.3 "one request in flight per host"): a request that took
--   the host's turn holds the host until its answer is read (or this time passes), so the API and the worker never
--   have two requests in flight to one host.
-- - ingest_worker_lock (BEH-4): the one ingest worker's lock, a row renewed while the worker runs. A second
--   `ingest:worker` finds it held and exits with a plain message. (A session advisory lock would need a dedicated
--   connection the data layer does not hand to features; a lease row works through deps.db.)
ALTER TABLE job_sources ADD COLUMN lease_owner uuid;
ALTER TABLE job_sources ADD COLUMN suspect_at timestamptz;
ALTER TABLE crawl_hosts ADD COLUMN busy_until timestamptz;

CREATE TABLE ingest_worker_lock(
  id smallint PRIMARY KEY CHECK (id = 1),
  owner uuid NOT NULL,
  host_name text NOT NULL CHECK (char_length(host_name) <= 255),
  pid integer NOT NULL,
  started_at timestamptz NOT NULL,
  lease_until timestamptz NOT NULL
);
