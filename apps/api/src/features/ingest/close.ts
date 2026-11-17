import { constantsOf } from '../../core/constants/index';
import type { DbQueries } from '../../core/db/types';
import type { CloseLink, CloseLinkInput, CloseLinkResult } from '../../core/seams';
import { storedSourceJobId } from './normalize';
import { projectJobs } from './project-job';

// v3.0 DB-INGEST: the one close function (core/seams.ts CloseLink; 12-job-sourcing.md §8, 11-database.md §8.3,
// 14-extension-reports.md §5.1 step 5), built here where SCH's seam waited for it. Every way a posting ends goes through
// this file: its listings missed it INGEST_CLOSE_AFTER_MISSES times in a row (store.ts markMissing, reason `missing`),
// its own read answered 404 (store.ts markGone, `gone`), an approved closed report (X1-API, `report`), a purge's batch
// (S1-API, `purge`), an admin's close (`admin`). In the caller's transaction, and nothing but statements:
// - the link (or every live link of the job) gets missing_since = at and miss_count at least INGEST_CLOSE_AFTER_MISSES,
//   as its own read's 404 would; a link already missing is left as it is;
// - a job left with no live link (or with none at all: a page job) closes (active false, closed_at = at) and leaves
//   job_search through projectJob in the same transaction.
// The reverse is the store's: a link seen again (a listing, its own read) is live again (missing_since NULL, miss_count
// 0), its job reopens and is projected, and jobReviews.reopenedBySource hears of it. Callers import closeLink from
// core/seams.

/**
 * Closes the jobs among `jobIds` that are open and have no live link left; projects them (they leave job_search).
 * Answers the ids it closed, in id order. The caller's transaction.
 */
export async function closeOrphanJobs(db: DbQueries, jobIds: readonly number[], at: string): Promise<number[]> {
  const ids = [...new Set(jobIds)];
  if (ids.length === 0) return [];
  const closed = await db.all<{ id: number }>(
    `UPDATE jobs SET active = false, closed_at = ?, updated_at = ?
      WHERE active AND id IN (SELECT CAST(value AS bigint) FROM ${db.dialect.jsonEach('?')})
        AND NOT EXISTS (SELECT 1 FROM job_source_links l WHERE l.job_id = jobs.id AND l.missing_since IS NULL)
      RETURNING id`,
    [at, at, JSON.stringify(ids)],
  );
  const closedIds = closed.map((row) => row.id).sort((a, b) => a - b);
  if (closedIds.length > 0) await projectJobs(db, closedIds);
  return closedIds;
}

/**
 * closeLink's body with the miss count given (the store passes the constant it read; the seam reads it from deps).
 * The caller's transaction.
 */
export async function closeLinkIn(db: DbQueries, input: CloseLinkInput, closeAfterMisses: number): Promise<CloseLinkResult> {
  const misses = Math.max(1, Math.trunc(closeAfterMisses));
  const linksClosed = input.link
    ? (
        await db.run(
          `UPDATE job_source_links SET missing_since = ?, miss_count = GREATEST(miss_count, ?)
            WHERE source_id = ? AND source_job_id = ? AND job_id = ? AND missing_since IS NULL`,
          [input.at, misses, input.link.sourceId, storedSourceJobId(input.link.sourceJobId), input.jobId],
        )
      ).changes
    : (
        await db.run(
          'UPDATE job_source_links SET missing_since = ?, miss_count = GREATEST(miss_count, ?) WHERE job_id = ? AND missing_since IS NULL',
          [input.at, misses, input.jobId],
        )
      ).changes;
  const live = (await db.one<{ n: number }>('SELECT count(*) AS n FROM job_source_links WHERE job_id = ? AND missing_since IS NULL', [
    input.jobId,
  ]))!.n;
  const jobClosed = live === 0 ? (await closeOrphanJobs(db, [input.jobId], input.at)).length > 0 : false;
  return { linksClosed, liveLinks: live, jobClosed };
}

/**
 * The batch form for a source's listing (store.ts markMissing): its links among `sourceJobIds` whose miss count reached
 * `closeAfterMisses` are missing from `at`, and the jobs they leave with no live link close. Answers how many links it
 * marked and the jobs it closed. The caller's transaction.
 */
export async function closeLinksOfSource(
  db: DbQueries,
  sourceId: number,
  sourceJobIds: readonly string[],
  at: string,
  closeAfterMisses: number,
): Promise<{ linksClosed: number; closedJobs: number[] }> {
  if (sourceJobIds.length === 0) return { linksClosed: 0, closedJobs: [] };
  const marked = await db.all<{ job_id: number }>(
    `UPDATE job_source_links SET missing_since = ?
      WHERE source_id = ? AND missing_since IS NULL AND miss_count >= ?
        AND source_job_id IN (SELECT value FROM ${db.dialect.jsonEach('?')})
      RETURNING job_id`,
    [at, sourceId, Math.max(1, Math.trunc(closeAfterMisses)), JSON.stringify(sourceJobIds.map(storedSourceJobId))],
  );
  const closedJobs = await closeOrphanJobs(
    db,
    marked.map((row) => row.job_id),
    at,
  );
  return { linksClosed: marked.length, closedJobs };
}

/** The one close function (core/seams.ts CloseLink): INGEST_CLOSE_AFTER_MISSES from the central constants. */
export const closeLink: CloseLink = async (deps, t, input) =>
  closeLinkIn(t, input, constantsOf(deps).get('INGEST_CLOSE_AFTER_MISSES'));
