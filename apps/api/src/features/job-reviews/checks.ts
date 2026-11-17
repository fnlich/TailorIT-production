import type { JobSourceKind } from '@tailorit/shared';
import { constantsOf } from '../../core/constants/service';
import type { AppDeps } from '../../core/context';
import type { DbQueries } from '../../core/db/types';
import { boardNameOf } from '../ingest/discovery/offer';
import { titleKeyOf } from '../ingest/normalize';

// v30 X1-API: what a new job's review shows the admin and what the automatic rule of a new ATS job reads
// (docs/design/part2/14-extension-reports.md §5.2 step 2, §6.2's sheet): the job's company and whether it opted out,
// the likely duplicates (12 §7.3: an open public job of the same company and title key with a near text fingerprint),
// and the board approving it would offer to discovery.

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** How many open jobs of the company a duplicate check reads at most (newest first). */
const DUPLICATE_SCAN = 500;
/** The most likely duplicates a sheet lists (AdminReviewDetailSchema's cap). */
export const DUPLICATES_LISTED = 20;

export interface CompanyFacts {
  companyId: number;
  name: string;
  doNotFetch: boolean;
  /** How the company was found, as far as the rows tell: its board alias, its domain, its name, or new with this job. */
  resolvedBy: 'board' | 'domain' | 'name' | 'new';
}

/** The job's company, how it resolved and whether it opted out; undefined when the job is gone. */
export async function companyOf(db: DbQueries, jobId: number): Promise<CompanyFacts | undefined> {
  const row = await db.one<{ id: number; name: string; do_not_fetch: boolean; board: boolean; domain: boolean; older: boolean }>(
    `SELECT c.id, c.name, c.do_not_fetch,
       EXISTS (SELECT 1 FROM company_aliases a WHERE a.company_id = c.id AND a.kind = 'board') AS board,
       EXISTS (SELECT 1 FROM company_aliases a WHERE a.company_id = c.id AND a.kind IN ('domain', 'domain_shared')) AS domain,
       EXISTS (SELECT 1 FROM jobs o WHERE o.company_id = c.id AND o.id <> j.id AND o.created_at <= j.created_at) AS older
     FROM jobs j JOIN companies c ON c.id = j.company_id WHERE j.id = ?`,
    [jobId],
  );
  if (!row) return undefined;
  const resolvedBy = row.board ? 'board' : row.domain ? 'domain' : row.older ? 'name' : 'new';
  return { companyId: row.id, name: row.name, doNotFetch: row.do_not_fetch === true, resolvedBy };
}

export interface LikelyDuplicate {
  jobId: number;
  title: string;
  companyName: string;
  postedAt: string | null;
  distanceBits: number | null;
}

/**
 * The open, public, unheld jobs of the job's company with the same title key whose text fingerprints differ in at most
 * JOB_FUZZY_SIMHASH_BITS bits, or have none to compare (an unknown is shown, and keeps the automatic rule off).
 */
export async function likelyDuplicates(deps: Deps, db: DbQueries, jobId: number): Promise<LikelyDuplicate[]> {
  const job = await db.one<{ company_id: number; title: string }>('SELECT company_id, title FROM jobs WHERE id = ?', [jobId]);
  if (!job) return [];
  const key = titleKeyOf(job.title);
  const bits = constantsOf(deps).get('JOB_FUZZY_SIMHASH_BITS');
  const rows = await db.all<{ id: number; title: string; company_name: string; posted_at: string | null; distance: number | null }>(
    `SELECT o.id, o.title, c.name AS company_name, o.posted_at,
       CASE WHEN o.text_simhash IS NULL OR h.text_simhash IS NULL THEN NULL
         ELSE bit_count((o.text_simhash # h.text_simhash)::bit(64)) END AS distance
     FROM jobs o JOIN companies c ON c.id = o.company_id JOIN jobs h ON h.id = ?
     WHERE o.company_id = ? AND o.id <> ? AND o.active AND o.owner_user_id IS NULL AND o.held_since IS NULL
     ORDER BY o.posted_sort DESC, o.id DESC LIMIT ${DUPLICATE_SCAN}`,
    [jobId, job.company_id, jobId],
  );
  return rows
    .filter((row) => titleKeyOf(row.title) === key && (row.distance === null || row.distance <= bits))
    .slice(0, DUPLICATES_LISTED)
    .map((row) => ({ jobId: row.id, title: row.title, companyName: row.company_name, postedAt: row.posted_at, distanceBits: row.distance }));
}

/** The board a held ATS job came from (its first board link's source), as approving it offers it; null for none. */
export async function boardOfJob(db: DbQueries, jobId: number): Promise<{ kind: JobSourceKind; name: string } | null> {
  const rows = await db.all<{ kind: JobSourceKind; config: string }>(
    `SELECT s.kind, s.config::text AS config FROM job_source_links l JOIN job_sources s ON s.id = l.source_id
     WHERE l.job_id = ? ORDER BY (l.missing_since IS NULL) DESC, l.seq`,
    [jobId],
  );
  for (const row of rows) {
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(row.config) as Record<string, unknown>;
    } catch {
      config = {};
    }
    const name = boardNameOf(row.kind, config);
    if (name) return { kind: row.kind, name };
  }
  return null;
}
