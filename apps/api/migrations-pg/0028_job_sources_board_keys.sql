-- v3.0 INT-4 (S2's edit A with S3's adapters; docs/design/part2/12-job-sourcing.md §4.2): discovery finds the source
-- that reads a board by the board its config names (features/ingest/discovery/offer.ts SOURCE_BOARD_SQL). 0020's
-- index read the v2.0 adapters' keys (token, site, board, account, tenant, host); wave 4's kinds name their board with
-- keys of their own: a Workday career site `{ host, tenant, careerSite }` (its site, before the tenant every site of the
-- tenant shares) and a feed `{ company }` (Personio, Recruitee, Breezy, BambooHR). The index takes the same expression as
-- the lookup, so "does a source read this board already?" stays an index lookup at 80,000 sources.
--
-- An index rebuilt, nothing else: no table, column or row changes. v3.0 starts on an empty database (DECISIONS P5).
DROP INDEX IF EXISTS idx_job_sources_board;
CREATE INDEX idx_job_sources_board ON job_sources(kind,
  lower(COALESCE(config->>'token', config->>'site', config->>'board', config->>'account', config->>'careerSite', config->>'company', config->>'tenant', config->>'host')));
