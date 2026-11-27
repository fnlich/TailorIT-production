-- v3.8 ATS-B (SP v38 PLAN A1, A5, A9, "Final coverage" 12, 13, 14, 17, 19, 21; WAVE2 items 7, 8): six board kinds, their
-- platforms, and the never-turned-on career sites on Oracle Recruiting Cloud hosts become Oracle sources.
--
-- 1. job_source_kinds gains the six kinds, each its board descriptor's row (@tailorit/shared/sourcing boards/<kind>.ts;
--    test/v38-board-registry.test.ts compares them): `oracle` (Oracle Recruiting Cloud: a career site's REST list and each
--    posting's details), `adp` (ADP Workforce Now: a career center's JSON list and each posting's record), `zoho_recruit`
--    (Zoho Recruit: a careers site's embedded list and job pages), `join` (Join.com: a company's page and each job's page),
--    `recruiterflow` (Recruiterflow: a board's page and each job's page) and `dayforce` (Dayforce: one posting at a time,
--    never run: a portal's list needs a browser). Each an ATS's own posting data (precedence 4).
-- 2. platforms gains Zoho Recruit, Join.com and Recruiterflow (Oracle, ADP and Dayforce are rows since v3.0), and a job
--    whose apply link is on their hosts reads as their platform, no longer as 'site': tailorit_url_platform takes their
--    lines (its others as 0065 left them, v38 INT: cumulative, linkedin.com last; features/mcp/platform.ts
--    PLATFORM_HOSTS says the same in code and pg-baseline.test.ts keeps the two equal); the jobs already stored there
--    are written again to themselves (a stored generated column is computed when its row is written) and job_search's
--    copy follows.
-- 3. A career site on an Oracle Recruiting Cloud tenant's host (<tenant>.fa.<region>.oraclecloud.com, or Oracle's
--    government cloud) that no admin ever turned on (enabled_at NULL, off) becomes an `oracle` source of its career site
--    (config {site: "<host>/<SITE>", companyName?, addedBy?}), when its links (and its sitemaps and posting paths) name exactly
--    one site (/sites/<site>/), no career site an admin turned on reads the host (that one stays as it is: one source per
--    host, the descriptor's adoptsCareerSites), only the oldest of the host's, and no Oracle source of that site or name
--    exists. It keeps its id, name, host, jobs and links: each link's id becomes the posting's number (/job/<id> ->
--    <id>; a second link of one posting keeps its old id), and so do the closed reports' and re-checks' references to it.
--    Its terms become the Oracle terms (ORACLE_TERMS_NOTE, boards/oracle.ts) unless an admin recorded others; its
--    robots.txt verdict, validators and next run are cleared (its paths are the Oracle reader's now; it is off).
-- 4. Discovery's career-site candidates on Oracle hosts are dropped: a host names no career site of its own (an Oracle
--    board is <host>/<site>), and discovery finds those as Oracle boards now.
--
-- Every statement may run again (each finds nothing left to change): v38-atsb-migration.test.ts runs the file again.

-- 1. The kinds.
INSERT INTO job_source_kinds(kind, label, access, runs, precedence, attribution, raw_keep_days) VALUES
  ('oracle', 'Oracle Recruiting Cloud', 'public_api', true, 4, NULL, 30),
  ('adp', 'ADP Workforce Now', 'public_api', true, 4, NULL, 30),
  ('zoho_recruit', 'Zoho Recruit', 'structured_data', true, 4, NULL, 30),
  ('join', 'Join.com', 'structured_data', true, 4, NULL, 30),
  ('recruiterflow', 'Recruiterflow', 'structured_data', true, 4, NULL, 30),
  ('dayforce', 'Dayforce (one posting)', 'structured_data', false, 4, NULL, 30)
  ON CONFLICT (kind) DO NOTHING;

-- 2. The platforms (the rows first: jobs.apply_platform references them), then the function, then the jobs stored.
INSERT INTO platforms(key, label, auto_apply) VALUES
  ('zohorecruit', 'Zoho Recruit', 'tab'), ('join', 'Join.com', 'tab'), ('recruiterflow', 'Recruiterflow', 'tab')
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
        -- v3.8 INT: cumulative: each earlier v3.8 migration's lines (0065 to this one), then this one's; linkedin.com last
        -- v3.8 ATS-A
        (32, 'gem', 'gem.com'), (33, 'teamtailor', 'teamtailor.com'),
        -- v3.8 ATS-B
        (34, 'zohorecruit', 'zohorecruit.com'), (35, 'zohorecruit', 'zohorecruit.eu'), (36, 'zohorecruit', 'zohorecruit.in'),
        (37, 'zohorecruit', 'zohorecruit.com.au'), (38, 'join', 'join.com'), (39, 'recruiterflow', 'recruiterflow.com'),
        (40, 'linkedin', 'linkedin.com')
      ) AS p(rank, platform, suffix)
      WHERE right('.' || tailorit_url_host(url), char_length(p.suffix) + 1) = '.' || p.suffix
      ORDER BY p.rank LIMIT 1),
      CASE WHEN strpos(lower(url), 'gh_jid=') > 0 THEN 'greenhouse' ELSE 'site' END)
  END
$$;

UPDATE jobs SET apply_url = apply_url
  WHERE apply_platform = 'site' AND tailorit_url_platform(apply_url) IN ('zohorecruit', 'join', 'recruiterflow');

UPDATE job_search s SET apply_platform = j.apply_platform
  FROM jobs j
  WHERE j.id = s.job_id AND s.apply_platform = 'site' AND j.apply_platform IN ('zohorecruit', 'join', 'recruiterflow');

-- 3. The career sites on Oracle hosts to convert, each with its one site (this transaction's table).
CREATE TEMP TABLE v38_oracle_conv ON COMMIT DROP AS
WITH cand AS (
  SELECT s.id, s.host, s.config FROM job_sources s
  WHERE s.kind = 'career_site' AND NOT s.enabled AND s.enabled_at IS NULL
    AND s.host ~ '^[a-z0-9-]+\.fa(?:(?:\.[a-z0-9-]+)?\.oraclecloud|\.ocs\.oraclegovcloud)\.com$'
    AND NOT EXISTS (SELECT 1 FROM job_sources o WHERE o.kind = 'career_site' AND o.host = s.host AND (o.enabled OR o.enabled_at IS NOT NULL))
    AND s.id = (SELECT min(d.id) FROM job_sources d WHERE d.kind = 'career_site' AND d.host = s.host AND NOT d.enabled AND d.enabled_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM job_sources n WHERE n.kind = 'oracle' AND n.name = s.name)
),
named AS (
  SELECT c.id, upper(substring(t.text FROM '/hcmUI/CandidateExperience/[A-Za-z0-9-]{2,12}/sites/([A-Za-z0-9_-]{1,40})(?:[/?#]|$)')) AS site
  FROM cand c
  CROSS JOIN LATERAL (
    SELECT l.source_job_id AS text FROM job_source_links l WHERE l.source_id = c.id
    UNION ALL
    SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(c.config->'sitemaps') = 'array' THEN c.config->'sitemaps' ELSE '[]'::jsonb END)
    UNION ALL
    SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(c.config->'postingPaths') = 'array' THEN c.config->'postingPaths' ELSE '[]'::jsonb END)
  ) t
)
SELECT c.id, c.host, min(n.site) AS site
FROM cand c JOIN named n ON n.id = c.id
WHERE n.site IS NOT NULL
GROUP BY c.id, c.host
HAVING count(DISTINCT n.site) = 1;

-- An Oracle source of that site already reads it: the career site stays as it is.
DELETE FROM v38_oracle_conv v
WHERE EXISTS (SELECT 1 FROM job_sources o WHERE o.kind = 'oracle' AND lower(o.config->>'site') = lower(v.host || '/' || v.site));

-- 3. Their links' ids first (while they are career sites): the posting's number, once per posting.
WITH ranked AS (
  SELECT l.source_id, l.source_job_id, p.posting,
    row_number() OVER (PARTITION BY l.source_id, p.posting ORDER BY (l.missing_since IS NULL) DESC, l.last_seen_at DESC, l.source_job_id) AS n
  FROM job_source_links l
  JOIN v38_oracle_conv conv ON conv.id = l.source_id
  CROSS JOIN LATERAL (SELECT substring(l.source_job_id FROM '^https?://[^/]+/hcmUI/CandidateExperience/[A-Za-z0-9-]{2,12}/sites/[A-Za-z0-9_-]{1,40}/(?:job|requisitions/preview)/([0-9]{1,15})(?:[/?#]|$)') AS posting) p
  WHERE p.posting IS NOT NULL
)
UPDATE job_source_links l SET source_job_id = r.posting
FROM ranked r
WHERE l.source_id = r.source_id AND l.source_job_id = r.source_job_id AND r.n = 1
  AND NOT EXISTS (SELECT 1 FROM job_source_links x WHERE x.source_id = r.source_id AND x.source_job_id = r.posting);

-- 3. The closed reports' and re-checks' references to those links.
UPDATE job_reviews r
SET link_source_job_id = substring(r.link_source_job_id FROM '^https?://[^/]+/hcmUI/CandidateExperience/[A-Za-z0-9-]{2,12}/sites/[A-Za-z0-9_-]{1,40}/(?:job|requisitions/preview)/([0-9]{1,15})(?:[/?#]|$)')
FROM v38_oracle_conv conv
WHERE r.link_source_id = conv.id
  AND substring(r.link_source_job_id FROM '^https?://[^/]+/hcmUI/CandidateExperience/[A-Za-z0-9-]{2,12}/sites/[A-Za-z0-9_-]{1,40}/(?:job|requisitions/preview)/([0-9]{1,15})(?:[/?#]|$)') IS NOT NULL
  AND EXISTS (SELECT 1 FROM job_source_links l WHERE l.source_id = conv.id
    AND l.source_job_id = substring(r.link_source_job_id FROM '^https?://[^/]+/hcmUI/CandidateExperience/[A-Za-z0-9-]{2,12}/sites/[A-Za-z0-9_-]{1,40}/(?:job|requisitions/preview)/([0-9]{1,15})(?:[/?#]|$)'));

UPDATE job_review_checks c
SET link_source_job_id = substring(c.link_source_job_id FROM '^https?://[^/]+/hcmUI/CandidateExperience/[A-Za-z0-9-]{2,12}/sites/[A-Za-z0-9_-]{1,40}/(?:job|requisitions/preview)/([0-9]{1,15})(?:[/?#]|$)')
FROM v38_oracle_conv conv
WHERE c.link_source_id = conv.id
  AND substring(c.link_source_job_id FROM '^https?://[^/]+/hcmUI/CandidateExperience/[A-Za-z0-9-]{2,12}/sites/[A-Za-z0-9_-]{1,40}/(?:job|requisitions/preview)/([0-9]{1,15})(?:[/?#]|$)') IS NOT NULL
  AND EXISTS (SELECT 1 FROM job_source_links l WHERE l.source_id = conv.id
    AND l.source_job_id = substring(c.link_source_job_id FROM '^https?://[^/]+/hcmUI/CandidateExperience/[A-Za-z0-9-]{2,12}/sites/[A-Za-z0-9_-]{1,40}/(?:job|requisitions/preview)/([0-9]{1,15})(?:[/?#]|$)'));

-- 3. The sources themselves.
UPDATE job_sources s SET kind = 'oracle',
  config = jsonb_strip_nulls(jsonb_build_object('site', conv.host || '/' || conv.site, 'companyName', s.config->'companyName', 'addedBy', s.config->'addedBy')),
  terms_status = CASE WHEN s.terms_note IS NULL AND s.terms_url IS NULL AND s.terms_status IN ('unchecked', 'allowed_with_conditions')
    THEN 'allowed_with_conditions' ELSE s.terms_status END,
  terms_checked_at = CASE WHEN s.terms_note IS NULL AND s.terms_url IS NULL AND s.terms_status IN ('unchecked', 'allowed_with_conditions')
    THEN now() ELSE s.terms_checked_at END,
  terms_note = CASE WHEN s.terms_note IS NULL AND s.terms_url IS NULL AND s.terms_status IN ('unchecked', 'allowed_with_conditions')
    THEN '2026-11-25: the owner asked TailorIT to verify job links and read career sites on Oracle Recruiting Cloud. Checked that day: the career site''s own pages load its job list (recruitingCEJobRequisitions) and each job''s details (recruitingCEJobRequisitionDetails) as keyless JSON from the tenant''s host; Oracle''s reference marks these Candidate Experience resources for its own pages'' use; robots.txt answers 404 (no rules). Conditions: one request at a time to all of Oracle Recruiting Cloud, with the bot user agent (BOT_USER_AGENT); a run reads at most ORACLE_LIST_MAX listed jobs and ORACLE_READS_PER_RUN jobs'' details; a job''s contact name and email are never read or stored.'
    ELSE s.terms_note END,
  robots_status = 'unchecked', robots_checked_at = NULL, etag = NULL, last_modified = NULL, next_run_at = NULL, updated_at = now()
FROM v38_oracle_conv conv
WHERE s.id = conv.id;

-- 4. Discovery's career-site candidates on Oracle hosts.
UPDATE job_source_candidates c SET status = 'dropped', next_check_at = NULL
WHERE c.kind = 'career_site' AND c.status <> 'dropped'
  AND c.name ~ '^[a-z0-9-]+\.fa(?:(?:\.[a-z0-9-]+)?\.oraclecloud|\.ocs\.oraclegovcloud)\.com$';
