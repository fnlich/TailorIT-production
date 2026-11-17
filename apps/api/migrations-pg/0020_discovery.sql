-- v3.0 S2 (docs/design/part2/12-job-sourcing.md §4, §11 phase 2): what discovery needs beside the baseline's
-- job_source_candidates (12 §12.2).
--
-- 1. job_source_candidates: the last validation read (checked_at), the open postings it found (open_jobs: the
--    postings per board 12 §5.2 asks Phase 2 to count) and why it failed (last_error, an admin's words: a board 404, a
--    robots.txt refusal, a 5xx); an index for Admin › Candidates' newest-first pages. A candidate still names no person.
-- 2. job_sources: two expression indexes so "does a source read this board already?" (offerToDiscovery, every signal,
--    tens of thousands a day) is an index lookup at 80,000 sources: the name in any case, and the board its config
--    names (token, site, board, account, tenant, host: the adapters' config keys).
-- 3. discovery_state: one row per signal's progress (the link sweep's high-water marks, Common Crawl's crawl and page).
-- 4. discovery_counters: exact counts per UTC day (validation reads under DISCOVERY_VALIDATIONS_PER_DAY, name probes
--    per host under DISCOVERY_PROBES_PER_HOST_PER_DAY), claimed one at a time with ON CONFLICT, so two processes never
--    pass a cap. Pruned after a month.
-- 5. job_source_measures: each board's open life and postings (12 §5.2, §11 phase 2: "measuring open life and postings
--    per board"), written by a daily step: open jobs, postings first seen in 30 days, jobs closed in 90 days and the
--    median and mean days those were open (closed_at - first_seen_at). Deleted with its source.
--
-- Additive: nullable columns, new tables, new indexes. No seeded table gains a required column.

ALTER TABLE job_source_candidates
  ADD COLUMN checked_at timestamptz,
  ADD COLUMN open_jobs integer CHECK (open_jobs >= 0),
  ADD COLUMN last_error text CHECK (char_length(last_error) <= 500);
CREATE INDEX idx_jsc_seen ON job_source_candidates(last_seen_at DESC, id DESC);

CREATE INDEX idx_job_sources_name_ci ON job_sources(kind, lower(name));
CREATE INDEX idx_job_sources_board ON job_sources(kind,
  lower(COALESCE(config->>'token', config->>'site', config->>'board', config->>'account', config->>'tenant', config->>'host')));

CREATE TABLE discovery_state(
  key text PRIMARY KEY CHECK (char_length(key) BETWEEN 1 AND 100),
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE discovery_counters(
  day date NOT NULL,
  counter text NOT NULL CHECK (char_length(counter) BETWEEN 1 AND 300),
  value integer NOT NULL DEFAULT 0 CHECK (value >= 0),
  PRIMARY KEY (day, counter)
);

CREATE TABLE job_source_measures(
  source_id bigint PRIMARY KEY REFERENCES job_sources(id) ON DELETE CASCADE,
  open_jobs integer NOT NULL DEFAULT 0 CHECK (open_jobs >= 0),
  new_30d integer NOT NULL DEFAULT 0 CHECK (new_30d >= 0),
  closed_90d integer NOT NULL DEFAULT 0 CHECK (closed_90d >= 0),
  open_life_days_median real CHECK (open_life_days_median >= 0),
  open_life_days_mean real CHECK (open_life_days_mean >= 0),
  measured_at timestamptz NOT NULL
);
