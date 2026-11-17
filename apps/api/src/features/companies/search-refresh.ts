import type { AppDeps } from '../../core/context';
import type { DbQueries } from '../../core/db/types';
import { projectJobs } from '../jobs/search-projection/index';
import { openJobIdsOf, type RecomputeResult } from './profile';

// v30 FIX-PERF (PG-LOAD PGL-19; docs/design/part2/measurements.md §6, §7.4): a company's profile change and its open
// jobs' search rows. Each row copies four things of its company: the name (in its words, title_tsv and body_tsv), the
// industry (when the job and its facts give none), the size and the sponsorship. Writing every row again
// (projectJobs: the posting's text read, its words rebuilt, its vector and GIN entries rewritten) cost E1's matching of
// the largest company (13,605 open jobs at mix B's size) more than 300 s in one transaction. Now:
//   - only the industry, size or sponsorship changed: the rows' company columns are set from the profile, set-based,
//     a batch of COMPANY_SEARCH_BATCH rows per statement (their words, and their vectors' TOAST, stay as they are);
//   - the name changed (rare: an admin's rename, a board's new name): the rows are projected again, as before.
// refreshCompanySearchIn runs in the caller's transaction (the profile's writers that change one company);
// refreshCompanySearch runs after it, each batch its own transaction (E1's match, which matches every company: a
// failure between leaves rows the nightly search repair finds stale, `refreshed_at < company_profiles.updated_at`).

/** Open jobs one statement (one transaction, out of the caller's) refreshes. */
export const COMPANY_SEARCH_BATCH = 1_000;

/** What a profile change asks of its jobs' search rows (recomputeProfile's answer). */
export type CompanySearchChange = Pick<RecomputeResult, 'searchChanged' | 'nameChanged'>;

/**
 * The company columns of the search rows of `jobIds` (all of one company), as projectJobs computes them: the job's
 * own industry, else its facts', else the company's; the company's size and sponsorship (company_profiles).
 */
function columnsSql(t: DbQueries, count: number): string {
  return `UPDATE job_search s
    SET industry = COALESCE(NULLIF(j.industry, ''), f.industry, NULLIF(cp.industry, '')),
      company_size = cp.size_bucket, company_sponsors = cp.sponsors_h1b, refreshed_at = now()
    FROM jobs j LEFT JOIN job_facts f ON f.job_id = j.id LEFT JOIN company_profiles cp ON cp.company_id = j.company_id
    WHERE j.id = s.job_id AND s.job_id IN (${t.dialect.list(count)})
    /* held_since: a held job has no search row (0004's trigger removes it), so none is set here */`;
}

/** One batch of the company's open jobs: their columns, or (the name changed) their whole rows. */
async function refreshRows(t: DbQueries, jobIds: readonly number[], change: CompanySearchChange): Promise<void> {
  if (jobIds.length === 0) return;
  if (change.nameChanged) await projectJobs(t, jobIds);
  else await t.run(columnsSql(t, jobIds.length), [...jobIds]);
}

const batchesOf = (ids: readonly number[]) => {
  const batches: number[][] = [];
  for (let start = 0; start < ids.length; start += COMPANY_SEARCH_BATCH) batches.push(ids.slice(start, start + COMPANY_SEARCH_BATCH));
  return batches;
};

/** In the caller's transaction: the search rows of the company's open jobs follow its profile. Answers how many. */
export async function refreshCompanySearchIn(t: DbQueries, companyId: number, change: CompanySearchChange): Promise<number> {
  if (!change.searchChanged) return 0;
  const ids = await openJobIdsOf(t, companyId);
  for (const batch of batchesOf(ids)) await refreshRows(t, batch, change);
  return ids.length;
}

/** After the change's transaction: the same, each batch its own transaction. Answers how many open jobs it read. */
export async function refreshCompanySearch(deps: Pick<AppDeps, 'db'>, companyId: number, change: CompanySearchChange): Promise<number> {
  if (!change.searchChanged) return 0;
  const ids = await openJobIdsOf(deps.db, companyId);
  for (const batch of batchesOf(ids)) await deps.db.tx((t) => refreshRows(t, batch, change), { label: 'company search refresh' });
  return ids.length;
}
