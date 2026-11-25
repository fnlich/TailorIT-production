-- v3.7 TRANSFER (SP v37 PLAN T2, T3): sources from a file, and a host row for every source that is on.
--
-- 1. job_sources.discovered_via gains `file`: a source an admin's sources file named (Admin › Sources › Import,
--    features/ingest/source-transfer.ts), made off and waiting for an admin ("Imported from a file"). Only an admin's
--    action turns it on (sources.ts enableSources). A candidate never has this value (job_source_candidates keeps its
--    list).
-- 2. Turning a source on adds its host to crawl_hosts when the host has no row yet (sources.ts enableSources, in the
--    statement that turns it on), so Admin › Hosts lists it before its first request. The sources on now get theirs
--    here, once: the host's pace is INGEST_HOST_MIN_INTERVAL_MS (an admin's value from Admin › Constants, else its default
--    1000; a value set in .env is not visible here, and every reader paces by it anyway: the larger of the row's and the
--    constant's), or the host's robots.txt Crawl-delay when that is longer (as the robots store writes it). A host that
--    has a row keeps it as it is.
-- 3. v3.7 INT-B (LANE W1): every Workday site's requests take turns on one lane, crawl_hosts' `workday.lane` row (its
--    own pace 0: WORKDAY_MIN_INTERVAL_MS rules, read at each turn). Turning a Workday source on adds that row too
--    (enableSources); while a Workday source is on, it is added here, once. A lane row that is there is kept as it is.
--    v3.7 INT-2b (E1): every platform lane alike: Workday's, BambooHR's (`bamboohr.lane`) and iCIMS's (`icims.lane`), each
--    by its key and its ONE host pattern, the same text as features/ingest/hosts.ts LANES (v37-int2b-lanes.test.ts holds
--    this list to the registry).
-- 4. v3.7 FIX-37B (SP v37 FIXES-37 E2, E8): a link whose board's source has terms an admin recorded as not allowing
--    automated access is never read: job_verifications.reason gains `terms` (packages/shared jobs/add.ts
--    JOB_VERIFY_REASONS), the reason a person's own job of such a link is kept with.
--
-- Additive: two wider CHECKs (validated against the rows, which all hold an older value or null) and new rows in
-- crawl_hosts. Every statement may run again.

ALTER TABLE job_sources DROP CONSTRAINT job_sources_discovered_via_check;
ALTER TABLE job_sources ADD CONSTRAINT job_sources_discovered_via_check
  CHECK (discovered_via IN ('extension','application_link','common_crawl','company_site','cross_link','probe','vendor','admin','import','file'));

WITH pace AS (
  SELECT LEAST(600000, GREATEST(1000, COALESCE((
    SELECT CAST(value->>'v' AS integer) FROM app_settings
    WHERE key = 'const:INGEST_HOST_MIN_INTERVAL_MS' AND json_typeof(value->'v') = 'number' AND (value->>'v') ~ '^[0-9]{1,9}$'
  ), 1000))) AS ms
)
INSERT INTO crawl_hosts(host, min_interval_ms, next_slot_at, updated_at)
SELECT s.host, GREATEST(p.ms, COALESCE(r.crawl_delay_s, 0) * 1000), now(), now()
FROM (SELECT DISTINCT host FROM job_sources WHERE enabled AND host IS NOT NULL AND host <> '') s
CROSS JOIN pace p
LEFT JOIN site_robots r ON r.host = s.host AND r.status <> 'unreachable'
ORDER BY s.host
ON CONFLICT (host) DO NOTHING;

-- v3.7 INT-B: the Workday lane's row (LANE W1) when a Workday source is on: its own pace 0 (WORKDAY_MIN_INTERVAL_MS rules).
-- v3.7 INT-2b (E1): each platform lane's row when one of its sources is on (its own pace 0: its least-gap constant rules).
INSERT INTO crawl_hosts(host, min_interval_ms, next_slot_at, updated_at)
SELECT l.lane, 0, now(), now()
FROM (VALUES
  ('workday.lane', '(?:^|\.)(?:myworkdayjobs|myworkdaysite|myworkday)\.com$'),
  ('bamboohr.lane', '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.bamboohr\.com$'),
  ('icims.lane', '^(?!(?:www|api|login)\.)(?!internal-)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.icims\.com$')
) AS l(lane, hosts)
WHERE EXISTS (SELECT 1 FROM job_sources s WHERE s.enabled AND COALESCE(s.host ~ l.hosts, false))
ON CONFLICT (host) DO NOTHING;

-- v3.7 FIX-37B (E2, E8): a link whose board's terms say no keeps its person's own job with the reason `terms`.
ALTER TABLE job_verifications DROP CONSTRAINT IF EXISTS job_verifications_reason_check;
ALTER TABLE job_verifications ADD CONSTRAINT job_verifications_reason_check
  CHECK (reason IN ('unreadable_host','no_posting','robots','blocked','unavailable','not_set_up','unlisted',
                    'opted_out','rejected','closed','invalid_link','terms'));
