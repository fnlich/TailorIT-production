import {
  linkKey,
  type JobAddOrigin,
  type JobVerification,
  type JobVerifyReason,
  type UnverifiedLink,
  type UnverifiedLinksResponse,
} from '@tailorit/shared';
import { constantsOf } from '../../../core/constants/service';
import type { AppDeps } from '../../../core/context';
import type { DbQueries } from '../../../core/db/types';
import { sharedAddress } from './address';

// v31 LINK (D2, docs/design/v3.1/21-jobs-from-links.md §6): the jobs TailorIT could not read from their link, kept
// for their adder alone (job_verifications, migration 0039): why, when it was last tried, how often. Read by the job
// DTOs' `verification` (for the adder), by Retry read (POST /api/jobs/:id/verify) and by Admin › Review's
// "Couldn't verify" list (Retry read, Reject: an admin never types or publishes a job's content). A link an admin
// rejected (job_link_rejections) is never published, whoever adds it.
//
// v31 FIX-LINK: a note keeps the link's shared form (address.ts, REV-SEC SEC-2: an admin never sees a person's ?token=);
// a rejected link stays rejected with any parameter added or its path in another case (SEC-8: linkRejected); the
// hourly Review summary counts a link new to the list, never one a retry read again (REV-BEH BEH-7: unverifiedLinkCounts).

/** One job TailorIT could not read. */
export interface UnverifiedNote {
  jobId: number;
  /** The job's adder; null for a v3.0 job no one account added (v31 LINK2: a legacy job left held). */
  userId: string | null;
  /** The link as added (kept in its shared form: address.ts). */
  url: string;
  origin: JobAddOrigin;
  reason: JobVerifyReason;
}

/**
 * Notes (or notes again) that TailorIT could not read the job's link: its reason and time now, one more attempt. A
 * link that is no https address keeps no row. Joins the caller's transaction when given one.
 */
export async function noteUnverified(db: DbQueries, note: UnverifiedNote, at: string): Promise<void> {
  const url = sharedAddress(note.url);
  const key = url ? linkKey(url) : null;
  if (!url || !key || url.length > 2100) return;
  const host = new URL(url).hostname;
  await db.run(
    `INSERT INTO job_verifications(job_id, user_id, url, url_key, host, origin, reason, checked_at, attempts, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT (job_id) DO UPDATE SET reason = excluded.reason, checked_at = excluded.checked_at,
       attempts = job_verifications.attempts + 1`,
    [note.jobId, note.userId, url, key, host, note.origin, note.reason, at, at],
  );
}

/** A link key's parts as a rejection compares them: its origin, its path in lower case, and its parameters. */
function rejectionParts(key: string): { origin: string; path: string; params: Array<[string, string]> } | null {
  try {
    const url = new URL(key);
    return {
      origin: `${url.protocol}//${url.host}`,
      path: url.pathname.toLowerCase(),
      params: [...url.searchParams].map(([name, value]) => [name.toLowerCase(), value] as [string, string]),
    };
  } catch {
    return null;
  }
}

/**
 * Whether link key `key` is the rejected link key `rejected` (SEC-8): on the same host, the same path in any case, with
 * every parameter of the rejected link (a parameter added, "?x=1", does not make another posting of it; a parameter of
 * another value does: "?id=2" is not "?id=1").
 */
export function rejectionCovers(rejected: string, key: string): boolean {
  const a = rejectionParts(rejected);
  const b = rejectionParts(key);
  if (!a || !b || a.origin !== b.origin || a.path !== b.path) return false;
  return a.params.every(([name, value]) => b.params.some(([other, otherValue]) => other === name && otherValue === value));
}

/**
 * Whether an admin rejected the link: its link key, or (v31 FIX-LINK, SEC-8) a rejected link of the same host that it
 * covers (rejectionCovers: the rejected link with a parameter added, or its path in another case). The rejections of the
 * host are one range of the table's key.
 */
export async function linkRejected(db: DbQueries, url: string): Promise<boolean> {
  const key = linkKey(sharedAddress(url) ?? url);
  if (!key) return false;
  if ((await db.one('SELECT 1 FROM job_link_rejections WHERE url_key = ?', [key])) !== undefined) return true;
  const origin = rejectionParts(key)?.origin;
  if (!origin) return false;
  // Every rejected key of the host: "https://host/" up to "https://host0" ('0' follows '/').
  const rows = await db.all<{ url_key: string }>('SELECT url_key FROM job_link_rejections WHERE url_key >= ? AND url_key < ? LIMIT 1000', [
    `${origin}/`,
    `${origin}0`,
  ]);
  return rows.some((row) => rejectionCovers(row.url_key, key));
}

/** The SQL of a job's verification fields beside a job row `j` (the DTOs' `verification`): its held time and its row. */
export function verificationColumns(alias = 'j'): string {
  return `CASE WHEN ${alias}.owner_user_id IS NOT NULL THEN (SELECT json_build_object('reason', v.reason, 'checkedAt', v.checked_at)
      FROM job_verifications v WHERE v.job_id = ${alias}.id) END AS verification_json, ${alias}.owner_user_id IS NOT NULL AS owned_job`;
}

/**
 * The SQL of one JSON value holding a job row `j`'s verification fields (an entry's column: one subquery per entry):
 * null for a job everyone sees.
 */
export function verificationRowSql(alias = 'j'): string {
  return `CASE WHEN ${alias}.owner_user_id IS NOT NULL THEN json_build_object('owned', true, 'v', (SELECT json_build_object('reason', v.reason,
      'checkedAt', v.checked_at) FROM job_verifications v WHERE v.job_id = ${alias}.id))
    WHEN ${alias}.held_since IS NOT NULL THEN json_build_object('held', ${alias}.held_since) END`;
}

/** An entry's job verification from verificationRowSql's value (absent for a job everyone sees). */
export function verificationOfJson(value: unknown): { verification?: JobVerification } {
  const stored = parseJson(value);
  if (!stored) return {};
  if (stored.owned === true) return verificationOf({ owned_job: true, verification_json: stored.v ?? null });
  return typeof stored.held === 'string' ? verificationOf({ held_since: stored.held }) : {};
}

/** A job row's `verification` (absent for a job everyone sees): held for an admin, or the viewer's own unread job. */
export function verificationOf(row: {
  held_since?: string | null;
  owned_job?: boolean | null;
  verification_json?: unknown;
}): { verification?: JobVerification } {
  if (row.owned_job) {
    const stored = parseJson(row.verification_json);
    const reason = typeof stored?.reason === 'string' ? (stored.reason as JobVerifyReason) : null;
    const checked = typeof stored?.checkedAt === 'string' ? new Date(stored.checkedAt).toISOString() : null;
    return { verification: { state: 'private_unverified', checkedAt: checked, reason } };
  }
  if (row.held_since) {
    return { verification: { state: 'waiting_admin', checkedAt: new Date(row.held_since).toISOString(), reason: null } };
  }
  return {};
}

function parseJson(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The jobs of a link's key that are their adders' own and still open (Retry read upgrades each). */
export async function ownJobsOfLink(db: DbQueries, urlKey: string): Promise<Array<{ job_id: number; user_id: string }>> {
  return db.all<{ job_id: number; user_id: string }>(
    `SELECT v.job_id, v.user_id FROM job_verifications v JOIN jobs j ON j.id = v.job_id
     WHERE v.url_key = ? AND j.owner_user_id = v.user_id AND j.superseded_by IS NULL ORDER BY v.job_id`,
    [urlKey],
  );
}

/**
 * Rejects a link from the "Couldn't verify" list: never published from now on, whoever adds it, and every job of it
 * noted as rejected (each stays its adder's own). Answers the jobs noted.
 */
export async function rejectLink(db: DbQueries, url: string, adminId: string, at: string): Promise<number> {
  const key = linkKey(sharedAddress(url) ?? url);
  if (!key) return 0;
  await db.run(
    'INSERT INTO job_link_rejections(url_key, rejected_by, rejected_at) VALUES (?, ?, ?) ON CONFLICT (url_key) DO NOTHING',
    [key, adminId, at],
  );
  const { changes } = await db.run("UPDATE job_verifications SET reason = 'rejected', checked_at = ? WHERE url_key = ?", [at, key]);
  return changes;
}

/**
 * The SQL condition of a "Couldn't verify" row (verification `v`, its job `j`). v31 FIX-LINK (SEC-8): a link a
 * rejection covers (its reason `rejected`) is not listed either.
 */
const LISTED = `(j.owner_user_id = v.user_id OR (v.user_id IS NULL AND j.owner_user_id IS NULL AND j.held_since IS NOT NULL))
       AND j.superseded_by IS NULL AND j.active AND v.reason NOT IN ('unreadable_host', 'rejected')
       AND NOT EXISTS (SELECT 1 FROM job_link_rejections r WHERE r.url_key = v.url_key)`;

/** GET /api/admin/jobs/unverified/count: the links the list holds (0 while EXT_NEW_PAGE_JOBS_REVIEW is off). */
export async function countUnverifiedLinks(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>): Promise<{ count: number }> {
  if (!constantsOf(deps).get('EXT_NEW_PAGE_JOBS_REVIEW')) return { count: 0 };
  const row = await deps.db.one<{ n: number }>(
    `SELECT count(DISTINCT v.url_key)::int AS n FROM job_verifications v JOIN jobs j ON j.id = v.job_id WHERE ${LISTED}`,
  );
  return { count: Number(row?.n ?? 0) };
}

/**
 * v31 INT-1: NOTIFY's hourly Review summary (notifications/housekeeping.ts summarizeReviewItems): the "Couldn't verify"
 * links new to the list since `since`, and all the list holds; both 0 while EXT_NEW_PAGE_JOBS_REVIEW is off (the list
 * is empty). v31 FIX-LINK (BEH-7): a link arrives when its first note was made (created_at), never when a Retry read
 * or a queued retry checked it again (checked_at moves), so an old link is never announced twice.
 */
export async function unverifiedLinkCounts(
  deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>,
  since: string,
): Promise<{ arrived: number; pending: number }> {
  if (!constantsOf(deps).get('EXT_NEW_PAGE_JOBS_REVIEW')) return { arrived: 0, pending: 0 };
  const row = await deps.db.one<{ arrived: number; pending: number }>(
    `SELECT count(*) FILTER (WHERE x.first_listed > CAST(? AS timestamptz))::int AS arrived, count(*)::int AS pending
       FROM (SELECT v.url_key, min(v.created_at) AS first_listed
               FROM job_verifications v JOIN jobs j ON j.id = v.job_id WHERE ${LISTED} GROUP BY v.url_key) x`,
    [since],
  );
  return { arrived: Number(row?.arrived ?? 0), pending: Number(row?.pending ?? 0) };
}

interface ListRow {
  job_id: number;
  url_key: string;
  url: string;
  host: string;
  reason: string;
  checked_at: string;
  first_added_at: string;
  adders: number;
  attempts: number;
}

/** A page cursor of the list: the last row's check time and link key. */
function cursorOf(row: ListRow): string {
  return Buffer.from(JSON.stringify([new Date(row.checked_at).toISOString(), row.url_key]), 'utf8').toString('base64url');
}

function readCursor(cursor: string | undefined): [string, string] | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    return Array.isArray(value) && typeof value[0] === 'string' && typeof value[1] === 'string' ? [value[0], value[1]] : null;
  } catch {
    return null;
  }
}

/**
 * Admin › Review's "Couldn't verify" list (GET /api/admin/jobs/unverified): one row per link TailorIT could not read
 * that some account keeps as its own open job, newest check first; never a site TailorIT never reads (LinkedIn, the
 * refused boards: no read could ever verify them) or a link an admin rejected. Empty while EXT_NEW_PAGE_JOBS_REVIEW
 * ("List links TailorIT couldn't verify") is off.
 */
export async function listUnverifiedLinks(
  deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>,
  query: { cursor?: string; limit?: number },
): Promise<UnverifiedLinksResponse> {
  if (!constantsOf(deps).get('EXT_NEW_PAGE_JOBS_REVIEW')) return { items: [], nextCursor: null };
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
  const after = readCursor(query.cursor);
  const rows = await deps.db.all<ListRow>(
    `SELECT min(v.job_id) AS job_id, v.url_key, min(v.url) AS url, min(v.host) AS host,
       (array_agg(v.reason ORDER BY v.checked_at DESC))[1] AS reason, max(v.checked_at) AS checked_at,
       min(v.created_at) AS first_added_at, count(*)::int AS adders, sum(v.attempts)::int AS attempts
     FROM job_verifications v JOIN jobs j ON j.id = v.job_id
     WHERE ${LISTED}
     GROUP BY v.url_key
     ${after ? 'HAVING (max(v.checked_at), v.url_key) < (CAST(? AS timestamptz), ?)' : ''}
     ORDER BY max(v.checked_at) DESC, v.url_key DESC LIMIT ?`,
    after ? [after[0], after[1], limit + 1] : [limit + 1],
  );
  const page = rows.slice(0, limit);
  const items: UnverifiedLink[] = page.map((row) => ({
    jobId: Number(row.job_id),
    url: row.url,
    host: row.host,
    reason: row.reason as JobVerifyReason,
    checkedAt: new Date(row.checked_at).toISOString(),
    firstAddedAt: new Date(row.first_added_at).toISOString(),
    adders: Number(row.adders),
    attempts: Number(row.attempts),
  }));
  return { items, nextCursor: rows.length > limit ? cursorOf(page[page.length - 1]!) : null };
}
