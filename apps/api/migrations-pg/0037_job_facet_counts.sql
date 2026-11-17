-- v3.0 FIX-PG (PG-LOAD PGL-5, docs/design/part2/measurements.md §6): the Jobs page's filter lists, kept. The facets
-- summary (which filters the data can answer, the categories and the "Remote in" countries with their counts) read
-- every shared row of job_search three times a request: 1.7-3.2 s at mix B's base size. Those counts are the same for
-- every account but its own page jobs, so they are kept here once (features/jobs/facet-counts.ts) and the viewer's own
-- page jobs (js_owner) are added at each request.
--
-- The freshness rule (JOB_FACETS_REFRESH_MINUTES, JOB_FACETS_CACHE_MIN_JOBS): under the minimum of open shared jobs the
-- counts are made at every request (exact; this row is not written). From it on, a request answers with this row's
-- counts; when they are older than the refresh period it also counts them again after answering, one process at a time
-- (refreshing_until is that process's claim, which runs out by itself if the process stops).
--
-- One row, nothing else: a new table, no row of another table changes.
CREATE TABLE job_facet_counts(
  id smallint PRIMARY KEY CHECK (id = 1),
  -- {total, available: {...}, categories: [[value, count]], remoteCountries: [[value, count]]} over the shared rows.
  counts jsonb NOT NULL,
  counted_at timestamptz NOT NULL,
  refreshing_until timestamptz
);
