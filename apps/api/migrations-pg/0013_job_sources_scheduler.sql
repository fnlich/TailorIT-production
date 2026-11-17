-- v3.0 S1-API (12-job-sourcing.md §9.3, §11 phase 1; 11-database.md §5.3): the ingest worker's due queue reads
-- job_sources' Part 2 columns (next_run_at, tier, cadence, lease_until, host, terms_status, robots_status), so v2.0's
-- `schedule` ('daily' or 'manual') goes. What it meant moves to those columns first, for any row made before this file
-- (an empty install has none):
--   - a source's host: where its reads go (crawl_hosts' and site_robots' key), from its kind and config, as
--     features/ingest/sources.ts hostOf writes it for a new source;
--   - the terms of v2.0's kinds: read and recorded by the design (12 §3.1, §3.11: "use"), so `allowed`; the kinds that
--     read no outside host (imports, the lake, the seed, pages) are allowed too, and need no robots.txt;
--   - a daily source is due now (the worker reads it at once, then at its tier's cadence); a manual one has no
--     next_run_at (never due: an import, the seed).
-- Then two indexes: Admin › Sources' default order at 80,000 rows (next run, then id), and the worker's robots.txt
-- refresh (the sources whose verdict is oldest).

UPDATE job_sources SET host = CASE kind
    WHEN 'greenhouse' THEN 'boards-api.greenhouse.io'
    WHEN 'lever' THEN CASE WHEN lower(coalesce(config->>'region', '')) = 'eu' THEN 'api.eu.lever.co' ELSE 'api.lever.co' END
    WHEN 'ashby' THEN 'api.ashbyhq.com'
    WHEN 'workable' THEN 'apply.workable.com'
    ELSE NULL END
  WHERE host IS NULL;

UPDATE job_sources SET terms_status = 'allowed'
  WHERE terms_status = 'unchecked'
    AND kind IN ('greenhouse', 'lever', 'ashby', 'workable', 'workday', 'ft_lake', 'csv', 'json', 'seed', 'page', 'ext_page');

UPDATE job_sources SET robots_status = 'not_applicable'
  WHERE robots_status = 'unchecked' AND kind IN ('ft_lake', 'csv', 'json', 'seed', 'page', 'ext_page');

UPDATE job_sources SET next_run_at = now()
  WHERE schedule = 'daily' AND next_run_at IS NULL AND kind IN ('greenhouse', 'lever', 'ashby', 'workable', 'ft_lake');

ALTER TABLE job_sources DROP COLUMN schedule;

CREATE INDEX idx_job_sources_next_run ON job_sources(next_run_at, id);
CREATE INDEX idx_job_sources_robots ON job_sources(robots_checked_at NULLS FIRST, id) WHERE enabled AND host IS NOT NULL;
