-- v3.5 ADMIN (PLAN H3, H6): the boards an admin's import found, and the held new jobs an import read.
--
-- 1. job_sources.discovered_via gains `import`: the board of a link an admin import read (a Greenhouse, Lever, Ashby or
--    Workable board, or a Workday career site), made a source switched off and marked "Found by import"
--    (features/ingest/import-sources.ts rememberImportBoard). It runs only once an admin switches it on: discovery's
--    validation never does (ingest/discovery/offer.ts isLinkKeeper, validate.ts sourceForCandidate). A candidate never
--    has this value (job_source_candidates keeps its list).
-- 2. job_source_import_finds: each board source an import run named, made by it (`created`) or there already, as Admin ›
--    Runs shows the run's "Sources found" and switches the ones it made on or off (Enable all / Disable all). One row per
--    run and source; gone with the run (a deleted import record's runs go with it) or the source.
-- 3. job_reviews.imported and import_run_id: a held new job an admin's import read. Its review keeps origin `ats` (a held
--    read: every reader of held reads reads it as before); these feed Admin › Review › New jobs' From filter (Imports,
--    Link reads, one import) and its "From import" line. import_run_id goes null once that run is gone; `imported` stays.
--
-- Additive: one wider CHECK (validated against job_sources' rows, which all hold an older value or null), one table, two
-- columns (a constant default: no table rewrite), one partial index. No row changes.

ALTER TABLE job_sources DROP CONSTRAINT job_sources_discovered_via_check;
ALTER TABLE job_sources ADD CONSTRAINT job_sources_discovered_via_check
  CHECK (discovered_via IN ('extension','application_link','common_crawl','company_site','cross_link','probe','vendor','admin','import'));

CREATE TABLE job_source_import_finds(
  run_id bigint NOT NULL REFERENCES job_source_runs(id) ON DELETE CASCADE,
  source_id bigint NOT NULL REFERENCES job_sources(id) ON DELETE CASCADE,
  created boolean NOT NULL,
  found_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, source_id)
);
CREATE INDEX idx_job_source_import_finds_source ON job_source_import_finds(source_id);

ALTER TABLE job_reviews ADD COLUMN imported boolean NOT NULL DEFAULT false;
ALTER TABLE job_reviews ADD COLUMN import_run_id bigint REFERENCES job_source_runs(id) ON DELETE SET NULL;
CREATE INDEX idx_job_reviews_import_run ON job_reviews(import_run_id) WHERE import_run_id IS NOT NULL;
