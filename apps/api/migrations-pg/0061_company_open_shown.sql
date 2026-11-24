-- tailorit:no-transaction
-- v3.6 FIX-SRC (the final data review's D3): a company page lists its open positions by the time each row shows.
-- Since v3.6 (SP v36 PLAN I1) an admin's import dates every job it brings in (jobs.reposted_at), and a job's row, on the
-- company page as everywhere, reads the later of its own date (posted_sort: COALESCE(posted_at, first_seen_at)) and that
-- import's time (features/jobs/rows.ts postingTimesOf). companies/page.ts companyJobs now orders the open positions by
-- that same later time, GREATEST(posted_sort, reposted_at) (GREATEST skips NULL: a job no admin imported orders as
-- before), newest first. This index holds a company's open jobs in that order, as idx_jobs_company_open holds them by
-- posted_sort (which the company's counts and its newest posting still read), so a page reads its rows and no sort
-- (PG-LOAD PGL-2: companies-perf.test.ts).
--
-- Built CONCURRENTLY (writers keep writing), so this file runs outside a transaction; a rerun after a failure drops what
-- a failed build left (an invalid index) and builds it again. Additive: one index; no row changes.
DROP INDEX CONCURRENTLY IF EXISTS idx_jobs_company_open_shown;
CREATE INDEX CONCURRENTLY idx_jobs_company_open_shown ON jobs(company_id, (GREATEST(posted_sort, reposted_at)) DESC, id DESC) WHERE active;
