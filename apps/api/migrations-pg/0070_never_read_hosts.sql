-- v3.8 FIX-C (SP v38 FIXES-38 D2, D3; REVIEW38-beh H2, M1): hosts TailorIT never reads, and a gone sign seen twice.
--
-- 1. D3: TailorIT never sends a request to a host of SAP SuccessFactors (career<n>.successfactors.com / .eu: robots.txt
--    disallows every page), Phenom (<company>.phenompro.com: an AWS WAF bot check on every request, robots.txt too) or
--    JobDiva (www<n>.jobdiva.com: a portal gated by Turnstile and reCAPTCHA), by any path. A career site an admin added
--    on one of those hosts before v3.8 is turned off here, with a dated note before the admin's own note (job_sources.
--    terms_note: Admin › Sources shows it on the source), and can't be turned on again (features/ingest/router.ts
--    patchSource and sources.ts bulkSources refuse it; career/run.ts refuses its run). The hosts are the board
--    descriptors' (packages/shared/src/sourcing/boards/successfactors.ts, phenom.ts, jobdiva.ts); the note is
--    features/ingest/career/platforms.ts NEVER_READ_CAREER_SITE_NOTE. Its terms, robots status, jobs and links are left
--    as they are (its page jobs stay their adders'; their re-checks answer can't read, nothing sent).
-- 2. D2: job_source_links.gone_seen_at, when a read first saw a gone sign that closes a stored job only once two reads
--    at least a day apart see it (Paycom's empty portal page: features/ingest/boards/sightings.ts); null until then, and
--    cleared when a read finds the posting again.
--
-- Every statement may run again: the column is added once, and a source that has the note keeps one.

ALTER TABLE job_source_links ADD COLUMN IF NOT EXISTS gone_seen_at timestamptz;

UPDATE job_sources
   SET enabled = false,
       updated_at = now(),
       terms_note = left(
         '2026-11-26: TailorIT doesn''t read this platform (robots.txt or a bot check guards every page), so this career site was turned off and can''t be turned on.'
           || CASE WHEN COALESCE(terms_note, '') = '' THEN '' ELSE ' ' || terms_note END,
         1000)
 WHERE kind = 'career_site'
   AND lower(rtrim(COALESCE(NULLIF(host, ''), config->>'host', ''), '.')) ~ '^(career[0-9]{0,3}[.]successfactors[.](com|eu)|[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?[.]phenompro[.]com|www[0-9]{0,2}[.]jobdiva[.]com)$'
   AND strpos(COALESCE(terms_note, ''), '2026-11-26: TailorIT doesn''t read this platform') = 0;
