-- v3.8 ATS-A (SP v38 PLAN "Final coverage" rows 1, 3, 4, 5, 7, 9, 24; A4, A5, A9; SP v38 WAVE2 items 2, 7, 8): four new
-- board kinds (Gem, Pinpoint, Rippling, Teamtailor), Breezy HR's terms, the platforms' lanes, and v3.7's career sites
-- on Teamtailor's hosts as Teamtailor sources.
--
-- 1. job_source_kinds gains `gem` (Gem), `pinpoint` (Pinpoint), `rippling` (Rippling) and `teamtailor` (Teamtailor):
--    one employer's board on each platform, read from its public JSON (the ATS's own posting data: precedence 4). Each
--    row is its board descriptor's (packages/shared/src/sourcing/boards/<kind>.ts; v38-board-registry.test.ts compares).
-- 2. platforms gains `gem` and `teamtailor` (pinpoint and rippling are there since the baseline), and
--    tailorit_url_platform reads their hosts (gem.com, teamtailor.com) as theirs, as features/mcp/platform.ts
--    PLATFORM_HOSTS does (pg-baseline.test.ts keeps the two equal; its other lines as 0021 wrote them). The jobs already
--    stored on those hosts are written again to themselves (their generated platform follows), and job_search's copy.
-- 3. The owner decided on 2026-11-25 that TailorIT reads Breezy HR (and the new platforms): every Breezy source still
--    `unchecked` with no note gets "allowed with conditions" and the dated note new sources get (features/ingest/boards/
--    breezy.ts BREEZY_TERMS_NOTE, word for word). Terms an admin recorded are left as they are.
-- 4. A career site on a company's Teamtailor host (<company>.teamtailor.com, never Teamtailor's own hosts: the
--    descriptor's pattern) that no admin ever turned on (enabled_at NULL, off) becomes a `teamtailor` source of that
--    company (config {company, companyName?, addedBy?}), when no career site an admin turned on reads the host (that one
--    stays as it is: one source per host, and Teamtailor's links adopt it) and only the oldest of the host's (another stays
--    a career site, off). It keeps its id, name, host, jobs and links: each link's id becomes the job's number, as the
--    Teamtailor reader names it (/jobs/<number>-<slug> -> <number>; a second link of one job keeps its old id), and so do
--    the closed reports' and re-checks' references to it. Its terms become Teamtailor's (TEAMTAILOR_TERMS_NOTE) unless an
--    admin recorded others; its robots.txt verdict, validators and next run are cleared (it is off).
-- 5. Discovery's career-site candidates on Teamtailor hosts become `teamtailor` candidates of their companies; one whose
--    company is a candidate already is dropped.
-- 6. Each new platform lane's row when one of its sources is on (its own pace 0: LANE_DEFAULT_MIN_INTERVAL_MS rules), as
--    0064 added v3.7's: Personio's, Recruitee's, Breezy HR's, Pinpoint's, Rippling's and Teamtailor's, by their keys and
--    their ONE host patterns (features/ingest/hosts.ts's registry; v38-atsa-boards.test.ts holds this list to it).
--
-- Every statement may run again (each finds nothing left to change).

-- 1. The new kinds.
INSERT INTO job_source_kinds(kind, label, access, runs, precedence, attribution, raw_keep_days) VALUES
  ('gem', 'Gem', 'public_api', true, 4, NULL, 30),
  ('pinpoint', 'Pinpoint', 'public_api', true, 4, NULL, 30),
  ('rippling', 'Rippling', 'public_api', true, 4, NULL, 30),
  ('teamtailor', 'Teamtailor', 'public_api', true, 4, NULL, 30)
  ON CONFLICT (kind) DO NOTHING;

-- 2. The platforms and the links' platform.
INSERT INTO platforms(key, label, auto_apply) VALUES ('gem', 'Gem', 'tab'), ('teamtailor', 'Teamtailor', 'tab')
  ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION tailorit_url_platform(url text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN url IS NULL OR btrim(url) = '' THEN 'unknown'
    WHEN tailorit_url_host(url) IS NULL THEN 'site'
    ELSE coalesce((
      SELECT p.platform FROM (VALUES
        (1, 'greenhouse', 'greenhouse.io'), (2, 'lever', 'lever.co'), (3, 'ashby', 'ashbyhq.com'),
        (4, 'workday', 'myworkdayjobs.com'), (5, 'workday', 'myworkdaysite.com'), (6, 'workable', 'workable.com'),
        (7, 'icims', 'icims.com'), (8, 'taleo', 'taleo.net'), (9, 'successfactors', 'successfactors.com'),
        (10, 'successfactors', 'successfactors.eu'), (11, 'oracle', 'oraclecloud.com'),
        (12, 'oracle', 'oraclegovcloud.com'), (13, 'jobvite', 'jobvite.com'), (14, 'jazzhr', 'applytojob.com'),
        (15, 'bamboohr', 'bamboohr.com'), (16, 'rippling', 'rippling.com'), (17, 'breezy', 'breezy.hr'),
        (18, 'careerplug', 'careerplug.com'), (19, 'pinpoint', 'pinpointhq.com'),
        (20, 'paycor', 'recruitingbypaycor.com'), (21, 'hibob', 'hibob.com'), (22, 'ultipro', 'ultipro.com'),
        (23, 'dayforce', 'dayforcehcm.com'), (24, 'paylocity', 'paylocity.com'), (25, 'dice', 'dice.com'),
        (26, 'clearcompany', 'clearcompany.com'), (27, 'adp', 'adp.com'),
        (28, 'smartrecruiters', 'smartrecruiters.com'), (29, 'personio', 'personio.de'),
        (30, 'personio', 'personio.com'), (31, 'recruitee', 'recruitee.com'),
        -- v3.8 ATS-A
        (32, 'gem', 'gem.com'), (33, 'teamtailor', 'teamtailor.com'),
        (34, 'linkedin', 'linkedin.com')
      ) AS p(rank, platform, suffix)
      WHERE right('.' || tailorit_url_host(url), char_length(p.suffix) + 1) = '.' || p.suffix
      ORDER BY p.rank LIMIT 1),
      CASE WHEN strpos(lower(url), 'gh_jid=') > 0 THEN 'greenhouse' ELSE 'site' END)
  END
$$;

UPDATE jobs SET apply_url = apply_url
  WHERE apply_platform = 'site' AND tailorit_url_platform(apply_url) IN ('gem', 'teamtailor');

UPDATE job_search s SET apply_platform = j.apply_platform
  FROM jobs j
  WHERE j.id = s.job_id AND s.apply_platform = 'site' AND j.apply_platform IN ('gem', 'teamtailor');

-- 3. Breezy HR's terms.
UPDATE job_sources SET terms_status = 'allowed_with_conditions', terms_checked_at = now(),
  terms_note = '2026-11-25: the owner decided TailorIT reads Breezy HR careers lists. Checked that day: the list (/json, with each position''s text: /json?verbose=true) is the public JSON the company''s own careers page loads (Breezy documents no such API); robots.txt allows it (it disallows only /css, /fonts, /stylesheets and /javascripts). A position missing from the list is closed. Conditions: one request at a time to all of Breezy HR (its lane), with the bot user agent (BOT_USER_AGENT); the list is read once a run; the apply form is never read or stored.'
WHERE kind = 'breezy' AND terms_status = 'unchecked' AND terms_note IS NULL;

-- 4. The career sites on Teamtailor hosts to convert: their links' ids first (while they are career sites).
WITH conv AS (
  SELECT s.id FROM job_sources s
  WHERE s.kind = 'career_site' AND NOT s.enabled AND s.enabled_at IS NULL
    AND s.host ~ '^(?!(?:www|app|api|support|status|cdn|static|help|blog|docs|developer|developers|partner|partners|assets|images|login|mail|marketplace|go|info)\.)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.teamtailor\.com$'
    AND NOT EXISTS (SELECT 1 FROM job_sources o WHERE o.kind = 'career_site' AND o.host = s.host AND (o.enabled OR o.enabled_at IS NOT NULL))
    AND s.id = (SELECT min(d.id) FROM job_sources d WHERE d.kind = 'career_site' AND d.host = s.host AND NOT d.enabled AND d.enabled_at IS NULL)
),
ranked AS (
  SELECT l.source_id, l.source_job_id, p.posting,
    row_number() OVER (PARTITION BY l.source_id, p.posting ORDER BY (l.missing_since IS NULL) DESC, l.last_seen_at DESC, l.source_job_id) AS n
  FROM job_source_links l
  JOIN conv ON conv.id = l.source_id
  CROSS JOIN LATERAL (SELECT substring(l.source_job_id FROM '^https?://[^/]+/(?:[a-z]{2}(?:-[a-z]{2})?/)?jobs/([0-9]{1,12})(?:-[^/?#]*)?(?:[/?#]|$)') AS posting) p
  WHERE p.posting IS NOT NULL
)
UPDATE job_source_links l SET source_job_id = r.posting
FROM ranked r
WHERE l.source_id = r.source_id AND l.source_job_id = r.source_job_id AND r.n = 1
  AND NOT EXISTS (SELECT 1 FROM job_source_links x WHERE x.source_id = r.source_id AND x.source_job_id = r.posting);

-- 4. The closed reports' and re-checks' references to those links.
WITH conv AS (
  SELECT s.id FROM job_sources s
  WHERE s.kind = 'career_site' AND NOT s.enabled AND s.enabled_at IS NULL
    AND s.host ~ '^(?!(?:www|app|api|support|status|cdn|static|help|blog|docs|developer|developers|partner|partners|assets|images|login|mail|marketplace|go|info)\.)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.teamtailor\.com$'
    AND NOT EXISTS (SELECT 1 FROM job_sources o WHERE o.kind = 'career_site' AND o.host = s.host AND (o.enabled OR o.enabled_at IS NOT NULL))
    AND s.id = (SELECT min(d.id) FROM job_sources d WHERE d.kind = 'career_site' AND d.host = s.host AND NOT d.enabled AND d.enabled_at IS NULL)
)
UPDATE job_reviews r SET link_source_job_id = substring(r.link_source_job_id FROM '^https?://[^/]+/(?:[a-z]{2}(?:-[a-z]{2})?/)?jobs/([0-9]{1,12})(?:-[^/?#]*)?(?:[/?#]|$)')
FROM conv
WHERE r.link_source_id = conv.id
  AND substring(r.link_source_job_id FROM '^https?://[^/]+/(?:[a-z]{2}(?:-[a-z]{2})?/)?jobs/([0-9]{1,12})(?:-[^/?#]*)?(?:[/?#]|$)') IS NOT NULL
  AND EXISTS (SELECT 1 FROM job_source_links l WHERE l.source_id = conv.id
    AND l.source_job_id = substring(r.link_source_job_id FROM '^https?://[^/]+/(?:[a-z]{2}(?:-[a-z]{2})?/)?jobs/([0-9]{1,12})(?:-[^/?#]*)?(?:[/?#]|$)'));

WITH conv AS (
  SELECT s.id FROM job_sources s
  WHERE s.kind = 'career_site' AND NOT s.enabled AND s.enabled_at IS NULL
    AND s.host ~ '^(?!(?:www|app|api|support|status|cdn|static|help|blog|docs|developer|developers|partner|partners|assets|images|login|mail|marketplace|go|info)\.)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.teamtailor\.com$'
    AND NOT EXISTS (SELECT 1 FROM job_sources o WHERE o.kind = 'career_site' AND o.host = s.host AND (o.enabled OR o.enabled_at IS NOT NULL))
    AND s.id = (SELECT min(d.id) FROM job_sources d WHERE d.kind = 'career_site' AND d.host = s.host AND NOT d.enabled AND d.enabled_at IS NULL)
)
UPDATE job_review_checks c SET link_source_job_id = substring(c.link_source_job_id FROM '^https?://[^/]+/(?:[a-z]{2}(?:-[a-z]{2})?/)?jobs/([0-9]{1,12})(?:-[^/?#]*)?(?:[/?#]|$)')
FROM conv
WHERE c.link_source_id = conv.id
  AND substring(c.link_source_job_id FROM '^https?://[^/]+/(?:[a-z]{2}(?:-[a-z]{2})?/)?jobs/([0-9]{1,12})(?:-[^/?#]*)?(?:[/?#]|$)') IS NOT NULL
  AND EXISTS (SELECT 1 FROM job_source_links l WHERE l.source_id = conv.id
    AND l.source_job_id = substring(c.link_source_job_id FROM '^https?://[^/]+/(?:[a-z]{2}(?:-[a-z]{2})?/)?jobs/([0-9]{1,12})(?:-[^/?#]*)?(?:[/?#]|$)'));

-- 4. The sources themselves.
WITH conv AS (
  SELECT s.id FROM job_sources s
  WHERE s.kind = 'career_site' AND NOT s.enabled AND s.enabled_at IS NULL
    AND s.host ~ '^(?!(?:www|app|api|support|status|cdn|static|help|blog|docs|developer|developers|partner|partners|assets|images|login|mail|marketplace|go|info)\.)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.teamtailor\.com$'
    AND NOT EXISTS (SELECT 1 FROM job_sources o WHERE o.kind = 'career_site' AND o.host = s.host AND (o.enabled OR o.enabled_at IS NOT NULL))
    AND s.id = (SELECT min(d.id) FROM job_sources d WHERE d.kind = 'career_site' AND d.host = s.host AND NOT d.enabled AND d.enabled_at IS NULL)
)
UPDATE job_sources s SET kind = 'teamtailor',
  config = jsonb_strip_nulls(jsonb_build_object('company', split_part(s.host, '.', 1), 'companyName', s.config->'companyName', 'addedBy', s.config->'addedBy')),
  terms_status = CASE WHEN s.terms_note IS NULL AND s.terms_url IS NULL AND s.terms_status IN ('unchecked', 'allowed_with_conditions')
    THEN 'allowed_with_conditions' ELSE s.terms_status END,
  terms_checked_at = CASE WHEN s.terms_note IS NULL AND s.terms_url IS NULL AND s.terms_status IN ('unchecked', 'allowed_with_conditions')
    THEN now() ELSE s.terms_checked_at END,
  terms_note = CASE WHEN s.terms_note IS NULL AND s.terms_url IS NULL AND s.terms_status IN ('unchecked', 'allowed_with_conditions')
    THEN '2026-11-25: the owner decided TailorIT reads Teamtailor careers sites. Checked that day: /jobs.json (a JSON Feed of the listed jobs, each with its schema.org JobPosting) and each job''s page (/jobs/<number>-<slug>, its JobPosting as JSON-LD) are public, with no key; robots.txt allows them (it disallows /app/, /messages/, /messenger/, /facebook/tab/ and /jobs/internal/; its Content-Signal says search=yes, ai-input=yes, ai-train=no). An unlisted job is still open: only its page''s 404 closes it. Conditions: one request at a time to all of Teamtailor (its lane), with the bot user agent (BOT_USER_AGENT); the feed is read once a run.'
    ELSE s.terms_note END,
  robots_status = 'unchecked', robots_checked_at = NULL, etag = NULL, last_modified = NULL, next_run_at = NULL, updated_at = now()
FROM conv
WHERE s.id = conv.id;

-- 5. Discovery's career-site candidates on Teamtailor hosts: a `teamtailor` candidate of the company, else dropped.
UPDATE job_source_candidates c SET kind = 'teamtailor', name = split_part(c.name, '.', 1)
WHERE c.kind = 'career_site'
  AND c.name ~ '^(?!(?:www|app|api|support|status|cdn|static|help|blog|docs|developer|developers|partner|partners|assets|images|login|mail|marketplace|go|info)\.)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.teamtailor\.com$'
  AND NOT EXISTS (SELECT 1 FROM job_source_candidates o WHERE o.kind = 'teamtailor' AND o.name = split_part(c.name, '.', 1));

UPDATE job_source_candidates c SET status = 'dropped', next_check_at = NULL
WHERE c.kind = 'career_site' AND c.status <> 'dropped'
  AND c.name ~ '^(?!(?:www|app|api|support|status|cdn|static|help|blog|docs|developer|developers|partner|partners|assets|images|login|mail|marketplace|go|info)\.)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.teamtailor\.com$';

-- 6. Each new platform lane's row when one of its sources is on (its own pace 0: its least-gap constant rules).
INSERT INTO crawl_hosts(host, min_interval_ms, next_slot_at, updated_at)
SELECT l.lane, 0, now(), now()
FROM (VALUES
  ('personio.lane', '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.jobs\.personio\.(?:de|com)$'),
  ('recruitee.lane', '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.recruitee\.com$'),
  ('breezy.lane', '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.breezy\.hr$'),
  ('pinpoint.lane', '^(?!(?:www|app|api|apply|help|support|docs|blog|status|login|developers|static|cdn)\.)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.pinpointhq\.com$'),
  ('rippling.lane', '^(?:ats|api)\.rippling\.com$'),
  ('teamtailor.lane', '^(?!(?:www|app|api|support|status|cdn|static|help|blog|docs|developer|developers|partner|partners|assets|images|login|mail|marketplace|go|info)\.)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.teamtailor\.com$')
) AS l(lane, hosts)
WHERE EXISTS (SELECT 1 FROM job_sources s WHERE s.enabled AND COALESCE(s.host ~ l.hosts, false))
ON CONFLICT (host) DO NOTHING;
