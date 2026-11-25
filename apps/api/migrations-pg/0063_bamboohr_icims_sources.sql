-- v3.7 BOARDS (SP v37 PLAN B2, I1, I3, I5): BambooHR's terms recorded, and iCIMS a source kind of its own.
--
-- 1. job_source_kinds gains `icims` ("iCIMS"): an employer's iCIMS site (<board>.icims.com), listed by its sitemap and
--    read posting by posting (each page's JSON-LD JobPosting), the ATS's own posting data (precedence 4, as a Workday
--    career site's).
-- 2. The owner decided on 2026-11-24 that TailorIT reads BambooHR careers lists (and iCIMS sites, step 3): every
--    BambooHR source still `unchecked` with no note gets "allowed with conditions" and the dated note new sources get
--    (features/ingest/sources.ts BAMBOOHR_TERMS_NOTE, word for word). Terms an admin recorded are left as they are.
-- 3. A career site on an employer's iCIMS host (careers-acme.icims.com; never iCIMS's www, api or login hosts nor an
--    internal-<co> portal: career/platforms.ts ICIMS_BOARD_HOST, the shared lookup's rule) that no admin ever turned on (enabled_at NULL, off) becomes an `icims`
--    source of that board (config {board, companyName?, addedBy?}), when no career site an admin turned on reads the
--    host (that one stays as it is: one source per host) and only the oldest of the host's (another stays a career
--    site, off). It keeps its id, name, host, jobs and links: each link's id becomes the posting's number, as the iCIMS
--    reader names it (/jobs/<id>/... -> <id>; a second link of one posting keeps its old id), and so do the closed reports'
--    and re-checks' references to it. Its terms become the iCIMS terms (ICIMS_TERMS_NOTE) unless an admin recorded
--    others; its robots.txt verdict, validators and next run are cleared (its paths are the iCIMS reader's now; it is off).
-- 4. Discovery's career-site candidates on iCIMS hosts become `icims` candidates of their boards; one whose board is a
--    candidate already is dropped (validation would make a second source of the host).
-- 5. v37 FIX-37A (REVIEW37-beh F8): job_sources.read_failures, the postings of a source whose own read failed lately, with
--    how many times and when (features/ingest/adapters/read-failures.ts): a BambooHR or iCIMS run reads them after the
--    others and backs them off, so a posting that keeps failing never holds the head of every run's plan. Empty for
--    every source.
--
-- Every statement may run again (each finds nothing left to change): v37-boards-migration.test.ts runs the file again.

INSERT INTO job_source_kinds(kind, label, access, runs, precedence, attribution, raw_keep_days)
  VALUES ('icims', 'iCIMS', 'sitemap', true, 4, NULL, 30)
  ON CONFLICT (kind) DO NOTHING;

-- 5. The postings whose own read failed lately (v37 FIX-37A).
ALTER TABLE job_sources ADD COLUMN IF NOT EXISTS read_failures jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 2. BambooHR's terms.
UPDATE job_sources SET terms_status = 'allowed_with_conditions', terms_checked_at = now(),
  terms_note = '2026-11-24: the owner decided TailorIT reads BambooHR careers lists. Checked that day: the list (/careers/list) and each opening''s detail (/careers/<id>/detail) are the public careers JSON the company''s own careers page loads (BambooHR documents no such API; its own API needs a customer''s key); robots.txt allows everything. Conditions: one request at a time per host, with the bot user agent (BOT_USER_AGENT); the apply form is never read or stored.'
WHERE kind = 'bamboohr' AND terms_status = 'unchecked' AND terms_note IS NULL;

-- 3. The career sites on iCIMS hosts to convert: their links' ids first (while they are career sites).
WITH conv AS (
  SELECT s.id FROM job_sources s
  WHERE s.kind = 'career_site' AND NOT s.enabled AND s.enabled_at IS NULL
    AND s.host ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.icims\.com$'
    AND split_part(s.host, '.', 1) NOT IN ('www', 'api', 'login')
    AND split_part(s.host, '.', 1) NOT LIKE 'internal-%'
    AND NOT EXISTS (SELECT 1 FROM job_sources o WHERE o.kind = 'career_site' AND o.host = s.host AND (o.enabled OR o.enabled_at IS NOT NULL))
    AND s.id = (SELECT min(d.id) FROM job_sources d WHERE d.kind = 'career_site' AND d.host = s.host AND NOT d.enabled AND d.enabled_at IS NULL)
),
ranked AS (
  SELECT l.source_id, l.source_job_id, p.posting,
    row_number() OVER (PARTITION BY l.source_id, p.posting ORDER BY (l.missing_since IS NULL) DESC, l.last_seen_at DESC, l.source_job_id) AS n
  FROM job_source_links l
  JOIN conv ON conv.id = l.source_id
  CROSS JOIN LATERAL (SELECT substring(l.source_job_id FROM '^https?://[^/]+/jobs/([0-9]{1,12})(?:[/?#]|$)') AS posting) p
  WHERE p.posting IS NOT NULL
)
UPDATE job_source_links l SET source_job_id = r.posting
FROM ranked r
WHERE l.source_id = r.source_id AND l.source_job_id = r.source_job_id AND r.n = 1
  AND NOT EXISTS (SELECT 1 FROM job_source_links x WHERE x.source_id = r.source_id AND x.source_job_id = r.posting);

-- 3. The closed reports' and re-checks' references to those links.
WITH conv AS (
  SELECT s.id FROM job_sources s
  WHERE s.kind = 'career_site' AND NOT s.enabled AND s.enabled_at IS NULL
    AND s.host ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.icims\.com$'
    AND split_part(s.host, '.', 1) NOT IN ('www', 'api', 'login')
    AND split_part(s.host, '.', 1) NOT LIKE 'internal-%'
    AND NOT EXISTS (SELECT 1 FROM job_sources o WHERE o.kind = 'career_site' AND o.host = s.host AND (o.enabled OR o.enabled_at IS NOT NULL))
    AND s.id = (SELECT min(d.id) FROM job_sources d WHERE d.kind = 'career_site' AND d.host = s.host AND NOT d.enabled AND d.enabled_at IS NULL)
)
UPDATE job_reviews r SET link_source_job_id = substring(r.link_source_job_id FROM '^https?://[^/]+/jobs/([0-9]{1,12})(?:[/?#]|$)')
FROM conv
WHERE r.link_source_id = conv.id AND substring(r.link_source_job_id FROM '^https?://[^/]+/jobs/([0-9]{1,12})(?:[/?#]|$)') IS NOT NULL
  AND EXISTS (SELECT 1 FROM job_source_links l WHERE l.source_id = conv.id
    AND l.source_job_id = substring(r.link_source_job_id FROM '^https?://[^/]+/jobs/([0-9]{1,12})(?:[/?#]|$)'));

WITH conv AS (
  SELECT s.id FROM job_sources s
  WHERE s.kind = 'career_site' AND NOT s.enabled AND s.enabled_at IS NULL
    AND s.host ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.icims\.com$'
    AND split_part(s.host, '.', 1) NOT IN ('www', 'api', 'login')
    AND split_part(s.host, '.', 1) NOT LIKE 'internal-%'
    AND NOT EXISTS (SELECT 1 FROM job_sources o WHERE o.kind = 'career_site' AND o.host = s.host AND (o.enabled OR o.enabled_at IS NOT NULL))
    AND s.id = (SELECT min(d.id) FROM job_sources d WHERE d.kind = 'career_site' AND d.host = s.host AND NOT d.enabled AND d.enabled_at IS NULL)
)
UPDATE job_review_checks c SET link_source_job_id = substring(c.link_source_job_id FROM '^https?://[^/]+/jobs/([0-9]{1,12})(?:[/?#]|$)')
FROM conv
WHERE c.link_source_id = conv.id AND substring(c.link_source_job_id FROM '^https?://[^/]+/jobs/([0-9]{1,12})(?:[/?#]|$)') IS NOT NULL
  AND EXISTS (SELECT 1 FROM job_source_links l WHERE l.source_id = conv.id
    AND l.source_job_id = substring(c.link_source_job_id FROM '^https?://[^/]+/jobs/([0-9]{1,12})(?:[/?#]|$)'));

-- 3. The sources themselves.
WITH conv AS (
  SELECT s.id FROM job_sources s
  WHERE s.kind = 'career_site' AND NOT s.enabled AND s.enabled_at IS NULL
    AND s.host ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.icims\.com$'
    AND split_part(s.host, '.', 1) NOT IN ('www', 'api', 'login')
    AND split_part(s.host, '.', 1) NOT LIKE 'internal-%'
    AND NOT EXISTS (SELECT 1 FROM job_sources o WHERE o.kind = 'career_site' AND o.host = s.host AND (o.enabled OR o.enabled_at IS NOT NULL))
    AND s.id = (SELECT min(d.id) FROM job_sources d WHERE d.kind = 'career_site' AND d.host = s.host AND NOT d.enabled AND d.enabled_at IS NULL)
)
UPDATE job_sources s SET kind = 'icims',
  config = jsonb_strip_nulls(jsonb_build_object('board', split_part(s.host, '.', 1), 'companyName', s.config->'companyName', 'addedBy', s.config->'addedBy')),
  terms_status = CASE WHEN s.terms_note IS NULL AND s.terms_url IS NULL AND s.terms_status IN ('unchecked', 'allowed_with_conditions')
    THEN 'allowed_with_conditions' ELSE s.terms_status END,
  terms_checked_at = CASE WHEN s.terms_note IS NULL AND s.terms_url IS NULL AND s.terms_status IN ('unchecked', 'allowed_with_conditions')
    THEN now() ELSE s.terms_checked_at END,
  terms_note = CASE WHEN s.terms_note IS NULL AND s.terms_url IS NULL AND s.terms_status IN ('unchecked', 'allowed_with_conditions')
    THEN '2026-11-24: the owner decided TailorIT reads iCIMS career sites. Checked that day: robots.txt names the sitemap (/sitemap.xml) and allows the job pages (/jobs/<id>/<slug>/job; it disallows the referral, login and candidate pages, never read); each job page''s content (?in_iframe=1) carries one schema.org JobPosting and says index,follow. Conditions: one request at a time per host, with the bot user agent (BOT_USER_AGENT).'
    ELSE s.terms_note END,
  robots_status = 'unchecked', robots_checked_at = NULL, etag = NULL, last_modified = NULL, next_run_at = NULL, updated_at = now()
FROM conv
WHERE s.id = conv.id;

-- 4. Discovery's career-site candidates on iCIMS hosts: an `icims` candidate of the board, else dropped.
UPDATE job_source_candidates c SET kind = 'icims', name = split_part(c.name, '.', 1)
WHERE c.kind = 'career_site'
  AND c.name ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.icims\.com$'
  AND split_part(c.name, '.', 1) NOT IN ('www', 'api', 'login')
  AND split_part(c.name, '.', 1) NOT LIKE 'internal-%'
  AND NOT EXISTS (SELECT 1 FROM job_source_candidates o WHERE o.kind = 'icims' AND o.name = split_part(c.name, '.', 1));

UPDATE job_source_candidates c SET status = 'dropped', next_check_at = NULL
WHERE c.kind = 'career_site' AND c.status <> 'dropped'
  AND c.name ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.icims\.com$'
  AND split_part(c.name, '.', 1) NOT IN ('www', 'api', 'login')
  AND split_part(c.name, '.', 1) NOT LIKE 'internal-%';
