// v3.0 PG-C: ingest's and the job facts' one way to PG-SEARCH's search projection (11-database.md §5.6:
// `projectJob(t, jobId)` writes or removes a job's job_search row in the caller's transaction). Every change those
// folders make that can move a job's search row calls it through here, so ingest-projection.test.ts can watch them.
export { projectJob, projectJobs } from '../jobs/search-projection/index';
