-- tailorit:no-transaction
-- v3.0.1 FIX-PERF2 (PG-LOAD's re-measure of v3.0, docs/design/part2/measurements.md §10.3). Each statement runs on its
-- own (indexes built CONCURRENTLY: writers keep writing); a rerun after a failure drops what a failed build left and
-- builds it again.
--
-- - idx_job_sources_workday_site (PGL-25): discovery's board lookup (features/ingest/discovery/offer.ts
--   sourcesOfBoards) found a Workday career site by its config's `careerSite` alone, which many tenants name alike
--   ("External"): each Workday link's lookup returned every Workday site source (18,067 at mix B's size). A Workday
--   site is looked up by its tenant and its site (offer.ts WORKDAY_SITE_KEY_SQL: the same expressions, the same text).
DROP INDEX CONCURRENTLY IF EXISTS idx_job_sources_workday_site;
CREATE INDEX CONCURRENTLY idx_job_sources_workday_site ON job_sources
  (lower(COALESCE(config->>'tenant', split_part(config->>'host', '.', 1))), lower(config->>'careerSite'))
  WHERE kind = 'workday_site';
--
-- - idx_job_analyses_created (PGL-22): the nightly retention of closed jobs' analyses (features/account/retention.ts
--   closedJobAnalyses) walked job_analyses' primary key whole, every night, reading each row for its created_at (461.6
--   s cold at mix B's base size when nothing was due). It now reads the analyses that turned older than the window
--   since its last pass, and a round of the older ones, in (created_at, id) order: this index alone.
DROP INDEX CONCURRENTLY IF EXISTS idx_job_analyses_created;
CREATE INDEX CONCURRENTLY idx_job_analyses_created ON job_analyses(created_at, id);
--
-- - job_search fillfactor 85 (PGL-24, PGL-19): a company's new industry, size or sponsorship sets its open jobs' search
--   rows' company columns (features/companies/search-refresh.ts), none of which an index reads, so each row's new
--   version could stay on its page with no index entry written (a HOT update). The rows filled their pages (fillfactor
--   100), so every one moved and wrote an entry in each of job_search's eleven indexes (five GIN): 1.35 s warm for 1,000
--   rows at mix B's size, 8-50 s on a busy disk. Pages now keep 15% free. A table setting: no row is rewritten now; pages
--   written from now on (new rows, and rows that move) keep the room. A lock that lets reads and writes go on.
ALTER TABLE job_search SET (fillfactor = 85);
--
-- - resumes.list_data (PGL-23, PGL-13): the Resumes list read each built resume's list fields (its name, headline and
--   template: features/resumes/repository.ts LIST_DOCUMENT_SQL) with json_each over the whole document, parsed again at
--   every list (the column is json, kept as written): 110 of 149 ms for an account of 5,040 resumes at mix B's size.
--   list_data keeps those fields, written with the document by a trigger (every writer, a restore's COPY too: ENABLE
--   ALWAYS), so the list parses nothing. NULL for an upload, and for a document json_each will not read (a value it
--   cannot unescape): the list reads such an account's documents whole, as before. The resumes there now are filled
--   once here (only list_data is set: no other trigger of resumes fires).
ALTER TABLE resumes ADD COLUMN IF NOT EXISTS list_data json;
CREATE OR REPLACE FUNCTION tailorit_resume_list_data(kind text, data json) RETURNS json LANGUAGE plpgsql AS $$
BEGIN
  IF kind <> 'built' OR data IS NULL THEN
    RETURN NULL;
  END IF;
  IF json_typeof(data) <> 'object' THEN
    RETURN CAST('{}' AS json);
  END IF;
  RETURN COALESCE((SELECT json_object_agg(e.key, e.value) FROM json_each(data) e
                   WHERE e.key IN ('name', 'title', 'preferredTemplate', 'templateId', 'markupVersion')), CAST('{}' AS json));
EXCEPTION WHEN data_exception THEN
  RETURN NULL;
END
$$;
CREATE OR REPLACE FUNCTION tailorit_resumes_list_data() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.list_data := tailorit_resume_list_data(NEW.kind, NEW.data);
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trg_resumes_list_data ON resumes;
CREATE TRIGGER trg_resumes_list_data BEFORE INSERT OR UPDATE OF kind, data ON resumes
  FOR EACH ROW EXECUTE FUNCTION tailorit_resumes_list_data();
ALTER TABLE resumes ENABLE ALWAYS TRIGGER trg_resumes_list_data;
UPDATE resumes SET list_data = tailorit_resume_list_data(kind, data) WHERE kind = 'built' AND data IS NOT NULL AND list_data IS NULL;
