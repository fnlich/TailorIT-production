-- v3.8 ATS-C (SP v38 PLAN A1, A2, "Final coverage" rows 2, 8, 11, 15, 16, 22): six server-rendered platforms become board
-- kinds of their own (each one board-kind descriptor: @tailorit/shared/sourcing boards/<kind>.ts and the API's
-- features/ingest/boards/<kind>.ts; v38-board-registry.test.ts compares each row with its descriptor's).
--
-- 1. job_source_kinds gains, each the ATS's own posting data read from its pages (structured_data, precedence 4):
--      smartrecruiters  SmartRecruiters  links only (runs false): a numeric link's page microdata; no company list
--      jobvite          Jobvite          a company's list (/<company>/jobs) and each posting's page (JSON-LD)
--      taleo            Taleo            links only (runs false): a posting page's fillList data; no portal list
--      avature          Avature          a site's job search pages and each posting's page
--      paylocity        Paylocity        a board's page (window.pageData.Jobs) and each posting's Details page
--      paycom           Paycom           links only (runs false): a posting page's JSON-LD; no portal list
-- 2. platforms gains `avature` (the others are rows since the baseline): a board alias 'avature:<site>'.
-- 3. A job whose apply link is on www.paycomonline.net or an avature.net host reads as `paycom` / `avature` in
--    jobs.apply_platform, no longer as 'site' (features/mcp/platform.ts PLATFORM_HOSTS says the same in code;
--    pg-baseline.test.ts and v38-atsc-*.test.ts keep the two equal). The function's other lines are as the migration
--    before left them (v38 INT: cumulative, 0021's lines, then each earlier v3.8 package's; linkedin.com last). The
--    jobs already stored on those hosts are written again to themselves (a stored generated column is computed when its
--    row is written), and job_search's copy of the platform follows.
-- No source changes kind: a career site on a Taleo host made before v3.8 stays as it is (Taleo lists no portal in v3.8).
--
-- Every statement may run again (each finds nothing left to change).

INSERT INTO job_source_kinds(kind, label, access, runs, precedence, attribution, raw_keep_days) VALUES
  ('smartrecruiters', 'SmartRecruiters', 'structured_data', false, 4, NULL, 30),
  ('jobvite', 'Jobvite', 'structured_data', true, 4, NULL, 30),
  ('taleo', 'Taleo', 'structured_data', false, 4, NULL, 30),
  ('avature', 'Avature', 'structured_data', true, 4, NULL, 30),
  ('paylocity', 'Paylocity', 'structured_data', true, 4, NULL, 30),
  ('paycom', 'Paycom', 'structured_data', false, 4, NULL, 30)
  ON CONFLICT (kind) DO NOTHING;

INSERT INTO platforms(key, label, auto_apply) VALUES ('avature', 'Avature', 'tab')
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
        (42, 'linkedin', 'linkedin.com')
      ) AS p(rank, platform, suffix)
      WHERE right('.' || tailorit_url_host(url), char_length(p.suffix) + 1) = '.' || p.suffix
      ORDER BY p.rank LIMIT 1),
      CASE WHEN strpos(lower(url), 'gh_jid=') > 0 THEN 'greenhouse' ELSE 'site' END)
  END
$$;

UPDATE jobs SET apply_url = apply_url
  WHERE apply_platform = 'site' AND tailorit_url_platform(apply_url) IN ('paycom', 'avature');

UPDATE job_search s SET apply_platform = j.apply_platform
  FROM jobs j
  WHERE j.id = s.job_id AND s.apply_platform = 'site' AND j.apply_platform IN ('paycom', 'avature');
