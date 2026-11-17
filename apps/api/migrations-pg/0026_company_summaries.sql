-- v3.0 E3 (docs/design/part2/13-company-enrichment.md §7, §8, §11 phase 3): the company summaries written by AI. What
-- the AI wrote is a company_sources row (kind 'ai', licence 'ai_derived': refs 'summary' and 'industry', with the
-- model, the prompt version and the inputs' hash in its fields), so the profile ranks it as 13 §6.1 says. This table
-- is each company's own bookkeeping (features/companies/summaries/state.ts):
--   - the inputs' hash, the prompt version, the outcome and the time of the AI's last answer: a summary is written
--     again only when its inputs or the prompt changed, and at most once in COMPANY_AI_REFRESH_DAYS;
--   - the last look (last_check, checked_at): what the enrichment step or the daily sweep found;
--   - the pending mark the batch runner works: due_at (when it may run; later than now while the 30 days run),
--     priority (the open jobs: companies with open jobs first), leased_until (a batch holds it), attempts and
--     last_error (the AI failing, never its answer being refused).
-- A new table only: nothing else changes. v3.0 starts on an empty database (DECISIONS P5).
CREATE TABLE company_summaries(
  company_id bigint PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  inputs_hash text,
  prompt_version smallint,
  outcome text CHECK (outcome IN ('written','declined','refused')),
  answered_at timestamptz,
  last_check text NOT NULL CHECK (last_check IN ('due','waiting','current','too_little','no_jobs','locked','not_shared')),
  checked_at timestamptz NOT NULL,
  due_at timestamptz,
  priority integer NOT NULL DEFAULT 0,
  leased_until timestamptz,
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  CHECK ((outcome IS NULL) = (answered_at IS NULL) AND (outcome IS NULL) = (inputs_hash IS NULL)
    AND (outcome IS NULL) = (prompt_version IS NULL))
);
-- The batch runner's walk: the pending companies, most open jobs first, then the longest waiting.
CREATE INDEX idx_company_summaries_due ON company_summaries(priority DESC, due_at, company_id) WHERE due_at IS NOT NULL;
