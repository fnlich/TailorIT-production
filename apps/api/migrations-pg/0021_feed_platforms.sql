-- v3.0 S3 (docs/design/part2/12-job-sourcing.md §3.3; SCH's note for wave 4): Personio and Recruitee become platforms of
-- their own. Their sources' board aliases are 'personio:<company>' and 'recruitee:<company>' (@tailorit/shared
-- JOB_SOURCE_KIND_PLATFORM; pg-closed-lists.test.ts checks every board kind's platform is a row here), and a job whose
-- apply link is on their hosts reads as their platform, no longer as 'site' (features/mcp/platform.ts PLATFORM_HOSTS
-- says the same in code; pg-baseline.test.ts keeps the two equal).
--
-- The rows first (jobs.apply_platform references platforms), then the function with the two platforms' lines (its
-- other lines as the baseline wrote them), then the jobs already stored: a stored generated column is computed when its
-- row is written, so their links are written again to themselves, and job_search's copy of the platform follows. v3.0
-- starts on an empty database (DECISIONS P5): on it the two UPDATEs change nothing.
INSERT INTO platforms(key, label, auto_apply) VALUES ('personio', 'Personio', 'tab'), ('recruitee', 'Recruitee', 'tab')
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
        (30, 'personio', 'personio.com'), (31, 'recruitee', 'recruitee.com'), (32, 'linkedin', 'linkedin.com')
      ) AS p(rank, platform, suffix)
      WHERE right('.' || tailorit_url_host(url), char_length(p.suffix) + 1) = '.' || p.suffix
      ORDER BY p.rank LIMIT 1),
      CASE WHEN strpos(lower(url), 'gh_jid=') > 0 THEN 'greenhouse' ELSE 'site' END)
  END
$$;

UPDATE jobs SET apply_url = apply_url
  WHERE apply_platform = 'site' AND tailorit_url_platform(apply_url) IN ('personio', 'recruitee');

UPDATE job_search s SET apply_platform = j.apply_platform
  FROM jobs j
  WHERE j.id = s.job_id AND s.apply_platform = 'site' AND j.apply_platform IN ('personio', 'recruitee');
