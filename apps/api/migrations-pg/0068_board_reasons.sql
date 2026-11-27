-- v3.8 ATS-D (SP v38 PLAN "Final coverage" #6, #10, #18, #20, #23, #25; A3, A8): UKG Recruiting, SAP SuccessFactors,
-- Phenom and JobDiva as board kinds, and the reasons a platform's link can't be read at all.
--
-- 1. job_source_kinds gains four kinds, none of which runs (runs false: no board list is read):
--    `ukg` "UKG Recruiting": a tenant's postings, each read from its own page's inline record (structured data); its
--    board's list is a POST robots.txt disallows;
--    `successfactors` "SAP SuccessFactors", `phenom` "Phenom" and `jobdiva` "JobDiva": links recognised and cleaned,
--    never read (robots.txt disallows every page; a bot check on every page; a portal gated by checks, its data behind the
--    agency's own API user). Each row is its board descriptor's (packages/shared/src/sourcing/boards/<kind>.ts).
-- 2. platforms gains `phenom` (its board alias is 'phenom:<site>'); UKG's, SuccessFactors' and JobDiva's rows exist.
-- 3. tailorit_url_platform reads a UKG tenant's host (<sub>.rec.pro.ukg.net) as `ultipro`, JobDiva's hosts as `jobdiva`
--    and Phenom's hosted sites (<company>.phenompro.com) as `phenom` (features/mcp/platform.ts PLATFORM_HOSTS says the same
--    in code; pg-baseline.test.ts keeps the two equal); the other lines as the migration before left them (v38 INT:
--    cumulative: 0021's, then each earlier v3.8 package's; linkedin.com last). The jobs already
--    stored on those hosts are written again to themselves (their generated apply_platform follows), and job_search's
--    copy of the platform with them.
-- 4. job_verifications.reason gains `bot_check` (a site that checks every visitor for robots: TailorIT never reads it)
--    and `needs_login` (a job site behind the employer's own login): packages/shared jobs/add.ts JOB_VERIFY_REASONS.
--
-- A link's stored forms (Apply links, link keys, tracker links, a Couldn't verify row's link) are re-cleaned once by the
-- jobs feature's daily pass `job-links.links-board-clean` (features/jobs/add/clean-link-pass.ts), not here: a platform's
-- clean link is the shared code's (canonicalJobUrl), and an SQL copy of it would be a second source.
--
-- Additive: new rows, a wider CHECK (validated against the rows, which all hold an older value) and the function's new
-- lines. Every statement may run again.

INSERT INTO job_source_kinds(kind, label, access, runs, precedence, attribution, raw_keep_days) VALUES
  ('ukg', 'UKG Recruiting', 'structured_data', false, 4, NULL, 30),
  ('successfactors', 'SAP SuccessFactors', 'public_api', false, 4, NULL, 30),
  ('phenom', 'Phenom', 'structured_data', false, 4, NULL, 30),
  ('jobdiva', 'JobDiva', 'licensed_api', false, 4, NULL, 30)
  ON CONFLICT (kind) DO NOTHING;

INSERT INTO platforms(key, label, auto_apply) VALUES ('phenom', 'Phenom', 'tab')
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
        -- v3.8 ATS-C
        (40, 'paycom', 'paycomonline.net'), (41, 'avature', 'avature.net'),
        -- v3.8 ATS-D
        (42, 'ultipro', 'rec.pro.ukg.net'), (43, 'jobdiva', 'jobdiva.com'), (44, 'phenom', 'phenompro.com'),
        (45, 'linkedin', 'linkedin.com')
      ) AS p(rank, platform, suffix)
      WHERE right('.' || tailorit_url_host(url), char_length(p.suffix) + 1) = '.' || p.suffix
      ORDER BY p.rank LIMIT 1),
      CASE WHEN strpos(lower(url), 'gh_jid=') > 0 THEN 'greenhouse' ELSE 'site' END)
  END
$$;

UPDATE jobs SET apply_url = apply_url
  WHERE apply_platform = 'site' AND tailorit_url_platform(apply_url) IN ('ultipro', 'jobdiva', 'phenom');

UPDATE job_search s SET apply_platform = j.apply_platform
  FROM jobs j
  WHERE j.id = s.job_id AND s.apply_platform = 'site' AND j.apply_platform IN ('ultipro', 'jobdiva', 'phenom');

ALTER TABLE job_verifications DROP CONSTRAINT IF EXISTS job_verifications_reason_check;
ALTER TABLE job_verifications ADD CONSTRAINT job_verifications_reason_check
  CHECK (reason IN ('unreadable_host','no_posting','robots','blocked','unavailable','not_set_up','unlisted',
                    'opted_out','rejected','closed','invalid_link','terms','bot_check','needs_login'));
