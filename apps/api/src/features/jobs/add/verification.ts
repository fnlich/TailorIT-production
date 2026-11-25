import {
  linkKey,
  REVIEW_PAGE_SIZE, // v37 REVIEW
  type JobAddOrigin,
  type JobVerification,
  type JobVerifyReason,
  type UnverifiedLink,
  type UnverifiedFrom,
  type UnverifiedLinksResponse,
} from '@tailorit/shared';
import { constantsOf } from '../../../core/constants/service';
import type { AppDeps } from '../../../core/context';
import type { DbQueries, DbTx } from '../../../core/db/types';
import { sharedAddress } from './address';
import { versionCounts } from './versions'; // v32 FIX-API (SB-1)

// v31 LINK (D2, docs/design/v3.1/21-jobs-from-links.md §6): the jobs TailorIT could not read from their link, kept
// for their adder alone (job_verifications, migration 0039): why, when it was last tried, how often. Read by the job
// DTOs' `verification` (for the adder), by Retry read (POST /api/jobs/:id/verify) and by Admin › Review's
// "Couldn't verify" list (Retry read, Reject: an admin never types or publishes a job's content). A link an admin
// rejected (job_link_rejections) is never published, whoever adds it.
//
// v31 FIX-LINK: a note keeps the link's shared form (address.ts, REV-SEC SEC-2: an admin never sees a person's ?token=);
// a rejected link stays rejected with any parameter added or its path in another case (SEC-8: linkRejected); the
// hourly Review summary counts a link new to the list, never one a retry read again (REV-BEH BEH-7: unverifiedLinkCounts).

/**
 * v32 ADMINAPP (E6): pg_advisory_xact_lock's key for approvals of one link (with hashtext(url_key)): a number no other
 * code uses. v32 FIX-API (REV-SECBEH SB-3): a Reject of the link takes it too, so a Reject and an approval of one link
 * never cross (approve.ts re-checks the rejection under it).
 */
export const APPROVAL_LOCK = 7_320_044;

/** One job TailorIT could not read. */
export interface UnverifiedNote {
  jobId: number;
  /** The job's adder; null for a v3.0 job no one account added (v31 LINK2: a legacy job left held). */
  userId: string | null;
  /** The link as added (kept in its shared form: address.ts). */
  url: string;
  origin: JobAddOrigin;
  reason: JobVerifyReason;
  /**
   * v33 SHARE-6 (migration 0052): who added it when that is someone else than `userId` (B adding on A's profile), and
   * the grant they added it under: the link's notices go to them while that grant lets them (notify.ts). Left out (a
   * Retry read, a recheck, an admin): the note keeps who it named. Named as `userId` itself: the owner's own add.
   */
  addedBy?: string | null;
  grantId?: string | null;
}

/** v33 SHARE-6: a note's adder, as the link's notices read it (ownJobsOfLink, the approval's row). */
export interface LinkAdder {
  /** Whose own job it is (the profile's owner). */
  user_id: string;
  /** Who added it, when someone else did on that person's profile (migration 0052). */
  added_by?: string | null;
  /** The grant they added it under. */
  grant_id?: string | null;
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
  // v33 SHARE-6: an add names its adder (someone else's, or the owner's own: none); other notes keep the one named.
  const named = note.addedBy !== undefined;
  const addedBy = named && note.addedBy !== note.userId ? note.addedBy : null;
  const grantId = addedBy !== null ? (note.grantId ?? null) : null;
  await db.run(
    `INSERT INTO job_verifications(job_id, user_id, url, url_key, host, origin, reason, checked_at, attempts, created_at,
       added_by, grant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT (job_id) DO UPDATE SET reason = excluded.reason, checked_at = excluded.checked_at,
       attempts = job_verifications.attempts + 1,
       added_by = CASE WHEN ? THEN excluded.added_by ELSE job_verifications.added_by END,
       grant_id = CASE WHEN ? THEN excluded.grant_id ELSE job_verifications.grant_id END`,
    [note.jobId, note.userId, url, key, host, note.origin, note.reason, at, at, addedBy, grantId, named, named],
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

/**
 * The SQL of a job's verification fields beside a job row `j` (the DTOs' `verification`): its held time and its row.
 * v32 ADMINAPP (E6): and when an admin approved it as captured (job_admin_approvals, by its key: one row at most).
 * v37 FIX-REV (REVIEW361-ux M5): a person's own job that has closed is no job to verify (it shows Closed, with no
 * "not verified" mark and no Retry read): no verification.
 */
export function verificationColumns(alias = 'j'): string {
  return `CASE WHEN ${alias}.owner_user_id IS NOT NULL AND ${alias}.active THEN (SELECT json_build_object('reason', v.reason, 'checkedAt', v.checked_at)
      FROM job_verifications v WHERE v.job_id = ${alias}.id) END AS verification_json,
    (${alias}.owner_user_id IS NOT NULL AND ${alias}.active) AS owned_job,
    (SELECT aa.approved_at FROM job_admin_approvals aa WHERE aa.job_id = ${alias}.id) AS admin_approved_at`;
}

/**
 * The SQL of one JSON value holding a job row `j`'s verification fields (an entry's column: one subquery per entry):
 * null for a job everyone sees. v37 FIX-REV (M5): null for a person's own job that has closed.
 */
export function verificationRowSql(alias = 'j'): string {
  return `CASE WHEN ${alias}.owner_user_id IS NOT NULL THEN CASE WHEN ${alias}.active THEN json_build_object('owned', true,
      'v', (SELECT json_build_object('reason', v.reason, 'checkedAt', v.checked_at) FROM job_verifications v WHERE v.job_id = ${alias}.id)) END
    WHEN ${alias}.held_since IS NOT NULL THEN json_build_object('held', ${alias}.held_since)
    ELSE (SELECT json_build_object('approved', aa.approved_at) FROM job_admin_approvals aa WHERE aa.job_id = ${alias}.id) END`;
}

/** An entry's job verification from verificationRowSql's value (absent for a job everyone sees). */
export function verificationOfJson(value: unknown): { verification?: JobVerification } {
  const stored = parseJson(value);
  if (!stored) return {};
  if (stored.owned === true) return verificationOf({ owned_job: true, verification_json: stored.v ?? null });
  if (typeof stored.approved === 'string') return verificationOf({ admin_approved_at: stored.approved }); // v32 ADMINAPP
  return typeof stored.held === 'string' ? verificationOf({ held_since: stored.held }) : {};
}

/**
 * A job row's `verification` (absent for a job everyone sees that TailorIT read): held for an admin, or the viewer's own
 * unread job; v32 ADMINAPP (E6) `admin_approved` for a job an admin published as it was captured.
 */
export function verificationOf(row: {
  held_since?: string | null;
  owned_job?: boolean | null;
  verification_json?: unknown;
  admin_approved_at?: string | null;
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
  if (row.admin_approved_at) {
    return { verification: { state: 'admin_approved', checkedAt: new Date(row.admin_approved_at).toISOString(), reason: null } };
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

/**
 * The jobs of a link's key that are their adders' own and still open (Retry read upgrades each). v33 SHARE-6: with who
 * added each one on its owner's profile (LinkAdder), for the notices.
 */
export async function ownJobsOfLink(db: DbQueries, urlKey: string): Promise<Array<{ job_id: number } & LinkAdder>> {
  return db.all<{ job_id: number } & LinkAdder>(
    `SELECT v.job_id, v.user_id, v.added_by, v.grant_id FROM job_verifications v JOIN jobs j ON j.id = v.job_id
     WHERE v.url_key = ? AND j.owner_user_id = v.user_id AND j.superseded_by IS NULL ORDER BY v.job_id`,
    [urlKey],
  );
}

/**
 * Rejects a link from the "Couldn't verify" list: never published from now on, whoever adds it, and every job of it
 * noted as rejected (each stays its adder's own). Answers the jobs noted. v32 FIX-API (REV-SECBEH SB-3): in a
 * transaction under the link's approval lock (an approval under way finishes first, or sees the rejection); and
 * `unpublish` (the route's: closeLink) closes each job an admin published of the link (an approval that ran out and is
 * listed again, SB-4): the link is never published. (This module stays free of core/seams: the notifications'
 * housekeeping reads it.)
 */
export async function rejectLink(
  deps: Pick<AppDeps, 'db'>,
  url: string,
  adminId: string,
  at: string,
  unpublish?: (t: DbTx, jobId: number) => Promise<unknown>,
): Promise<number> {
  const key = linkKey(sharedAddress(url) ?? url);
  if (!key) return 0;
  return deps.db.tx(
    async (t) => {
      await t.run('SELECT pg_advisory_xact_lock(?, hashtext(?))', [APPROVAL_LOCK, key]);
      await t.run(
        'INSERT INTO job_link_rejections(url_key, rejected_by, rejected_at) VALUES (?, ?, ?) ON CONFLICT (url_key) DO NOTHING',
        [key, adminId, at],
      );
      const { changes } = await t.run("UPDATE job_verifications SET reason = 'rejected', checked_at = ? WHERE url_key = ?", [at, key]);
      const published = await t.all<{ job_id: number }>(
        `SELECT a.job_id FROM job_admin_approvals a JOIN jobs j ON j.id = a.job_id
         WHERE a.url_key = ? AND j.active AND j.owner_user_id IS NULL AND j.superseded_by IS NULL`,
        [key],
      );
      for (const row of published) await unpublish?.(t, Number(row.job_id));
      return changes;
    },
    { label: 'reject a link' },
  );
}

/**
 * v32 FIX-API (SB-1): the SQL condition "the link of note `v` has a published approval" (its job open, everyone's, not
 * given way): its adders' own jobs are no rows of the list then.
 */
const LINK_APPROVED = `EXISTS (SELECT 1 FROM job_admin_approvals la JOIN jobs lj ON lj.id = la.job_id
         WHERE la.url_key = v.url_key AND lj.active AND lj.owner_user_id IS NULL AND lj.superseded_by IS NULL)`;

/**
 * The SQL condition of a "Couldn't verify" row (verification `v`, its job `j`). v31 FIX-LINK (SEC-8): a link a
 * rejection covers (its reason `rejected`) is not listed either. v32 FIX-API: an adder's own job only while no approval
 * of its link is published (SB-1: the adders keep their own jobs after one); a job an admin published whose approval ran
 * out and left search (SB-4: its note kept with no adder), to be approved again, read again or rejected. v37 REVIEW
 * (SP v37 PLAN.md R5: "never lists a closed job"): never a job that is closed (`j.active`) nor one TailorIT's last read
 * of its link found closed (its reason `closed`: nothing to approve, verify or reject there).
 */
export const LISTED = `((j.owner_user_id = v.user_id AND NOT ${LINK_APPROVED})
         OR (v.user_id IS NULL AND j.owner_user_id IS NULL AND j.held_since IS NOT NULL)
         OR (v.user_id IS NULL AND j.owner_user_id IS NULL AND j.held_since IS NULL AND j.unverified_since IS NOT NULL
             AND EXISTS (SELECT 1 FROM job_admin_approvals xa WHERE xa.job_id = j.id)))
       AND j.superseded_by IS NULL AND j.active AND v.reason NOT IN ('unreadable_host', 'rejected', 'closed')
       AND NOT EXISTS (SELECT 1 FROM job_link_rejections r WHERE r.url_key = v.url_key)`;

/**
 * v35 IMPORT (SP v35 PLAN.md H3): the From filter of the list, as an SQL condition on the note `v` and its values:
 * Imports (an admin import's job: no adder, origin `import`), People's adds (an adder's own job), one import (its rows'
 * jobs, by the import's id or its run's). All: no condition.
 */
export interface UnverifiedFilter {
  from?: UnverifiedFrom;
  importId?: number;
  runId?: number;
}

/** v35 IMPORT: a note `v` of an admin import's job (made from its row: no adder, origin `import`). */
export const FROM_IMPORT_SQL = "v.user_id IS NULL AND v.origin = 'import'";

/**
 * v37 REVIEW (SP v37 PLAN.md R5): the condition of a row Couldn't verify lists now (verification `v`, its job `j`):
 * LISTED, and while "List links TailorIT couldn't verify" (EXT_NEW_PAGE_JOBS_REVIEW) is off, an admin import's rows
 * alone. The switch is about people's links; an admin's import held its jobs for an admin, so they are always listed (and
 * counted, approved, read again and rejected) whatever it says. The list, its count, its "all", the bell's count, the
 * import results' heldIn and an approval all read it.
 */
export function listedSql(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>): string {
  return constantsOf(deps).get('EXT_NEW_PAGE_JOBS_REVIEW') ? LISTED : `${LISTED} AND (${FROM_IMPORT_SQL})`;
}

/** v35 IMPORT: the filter's condition (after the LISTED condition) and its values. */
export function unverifiedFilterSql(filter: UnverifiedFilter): { sql: string; params: Array<string | number> } {
  const parts: string[] = [];
  const params: Array<string | number> = [];
  if (filter.from === 'imports') parts.push(`(${FROM_IMPORT_SQL})`);
  if (filter.from === 'adds') parts.push('v.user_id IS NOT NULL');
  if (filter.importId !== undefined) {
    parts.push('EXISTS (SELECT 1 FROM job_import_rows ir WHERE ir.job_id = v.job_id AND ir.import_id = ?)');
    params.push(filter.importId);
  }
  if (filter.runId !== undefined) {
    parts.push('EXISTS (SELECT 1 FROM job_import_rows ir JOIN job_imports ii ON ii.id = ir.import_id WHERE ir.job_id = v.job_id AND ii.run_id = ?)');
    params.push(filter.runId);
  }
  return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', params };
}

/**
 * GET /api/admin/jobs/unverified/count: the links the list holds. v37 REVIEW (R5): while EXT_NEW_PAGE_JOBS_REVIEW is
 * off, an admin import's (listedSql).
 */
export async function countUnverifiedLinks(
  deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>,
  filter: UnverifiedFilter = {}, // v35 IMPORT: the From filter
): Promise<{ count: number }> {
  const where = unverifiedFilterSql(filter);
  const row = await deps.db.one<{ n: number }>(
    `SELECT count(DISTINCT v.url_key)::int AS n FROM job_verifications v JOIN jobs j ON j.id = v.job_id WHERE ${listedSql(deps)}${where.sql}`,
    where.params,
  );
  return { count: Number(row?.n ?? 0) };
}

/**
 * v31 INT-1: NOTIFY's hourly Review summary (notifications/housekeeping.ts summarizeReviewItems): the "Couldn't verify"
 * links new to the list since `since`, and all the list holds. v37 REVIEW (R5): while EXT_NEW_PAGE_JOBS_REVIEW is off,
 * an admin import's (listedSql), as the list. v31 FIX-LINK (BEH-7): a link arrives when its first note was made
 * (created_at), never when a Retry read or a queued retry checked it again (checked_at moves), so an old link is never
 * announced twice.
 */
export async function unverifiedLinkCounts(
  deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>,
  since: string,
): Promise<{ arrived: number; pending: number }> {
  const row = await deps.db.one<{ arrived: number; pending: number }>(
    `SELECT count(*) FILTER (WHERE x.first_listed > CAST(? AS timestamptz))::int AS arrived, count(*)::int AS pending
       FROM (SELECT v.url_key, min(v.created_at) AS first_listed
               FROM job_verifications v JOIN jobs j ON j.id = v.job_id WHERE ${listedSql(deps)} GROUP BY v.url_key) x`,
    [since],
  );
  return { arrived: Number(row?.arrived ?? 0), pending: Number(row?.pending ?? 0) };
}

interface ListRow {
  job_id: number;
  title: string | null;
  company_name: string | null;
  location: string | null;
  approved_before: boolean | null;
  url_key: string;
  url: string;
  host: string;
  reason: string;
  checked_at: string;
  first_added_at: string;
  adders: number;
  attempts: number;
  from_import: boolean; // v35 IMPORT
  from_add: boolean; // v35 IMPORT
  import_id: number | null; // v35 IMPORT
  run_id: number | null; // v35 IMPORT
  import_name: string | null; // v35 OPSWEB
  import_row: number | null; // v35 OPSWEB
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
 * refused boards: no read could ever verify them) or a link an admin rejected. While EXT_NEW_PAGE_JOBS_REVIEW ("List
 * links TailorIT couldn't verify") is off: v37 REVIEW (R5) an admin import's rows alone (listedSql; before, none).
 * v37 REVIEW (R1): REVIEW_PAGE_SIZE (100) a page by default.
 */
export async function listUnverifiedLinks(
  deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>,
  query: { cursor?: string; limit?: number } & UnverifiedFilter, // v35 IMPORT: the From filter
): Promise<UnverifiedLinksResponse> {
  const limit = Math.min(Math.max(query.limit ?? REVIEW_PAGE_SIZE, 1), REVIEW_PAGE_SIZE);
  const listed = listedSql(deps); // v37 REVIEW (R5)
  const after = readCursor(query.cursor);
  const where = unverifiedFilterSql(query);
  // v32 ADMINAPP (E6): with the row's job as captured (its title and company), what Approve publishes. v32 FIX-API
  // (SB-1): its place, and how many versions the link's adders captured (read in full in the row's detail).
  const rows = await deps.db.all<ListRow>(
    `SELECT g.*, rj.title, rc.name AS company_name, rj.locations_text AS location,
       EXISTS (SELECT 1 FROM job_admin_approvals ra WHERE ra.job_id = g.job_id) AS approved_before,
       (SELECT ir.import_id FROM job_import_rows ir WHERE ir.job_id = g.job_id ORDER BY ir.import_id DESC LIMIT 1) AS import_id,
       (SELECT ii.run_id FROM job_import_rows ir JOIN job_imports ii ON ii.id = ir.import_id WHERE ir.job_id = g.job_id
         ORDER BY ir.import_id DESC LIMIT 1) AS run_id,
       (SELECT ii.name FROM job_import_rows ir JOIN job_imports ii ON ii.id = ir.import_id WHERE ir.job_id = g.job_id
         ORDER BY ir.import_id DESC LIMIT 1) AS import_name,
       (SELECT ir.row_number FROM job_import_rows ir WHERE ir.job_id = g.job_id
         ORDER BY ir.import_id DESC, ir.row_number LIMIT 1) AS import_row FROM (
       SELECT min(v.job_id) AS job_id, v.url_key, min(v.url) AS url, min(v.host) AS host,
         (array_agg(v.reason ORDER BY v.checked_at DESC))[1] AS reason, max(v.checked_at) AS checked_at,
         min(v.created_at) AS first_added_at, count(*)::int AS adders, sum(v.attempts)::int AS attempts,
         bool_or(${FROM_IMPORT_SQL}) AS from_import, bool_or(v.user_id IS NOT NULL) AS from_add
       FROM job_verifications v JOIN jobs j ON j.id = v.job_id
       WHERE ${listed}${where.sql}
       GROUP BY v.url_key
       ${after ? 'HAVING (max(v.checked_at), v.url_key) < (CAST(? AS timestamptz), ?)' : ''}
       ORDER BY max(v.checked_at) DESC, v.url_key DESC LIMIT ?) g
     LEFT JOIN jobs rj ON rj.id = g.job_id LEFT JOIN companies rc ON rc.id = rj.company_id
     ORDER BY g.checked_at DESC, g.url_key DESC`,
    [...where.params, ...(after ? [after[0], after[1], limit + 1] : [limit + 1])],
  );
  const page = rows.slice(0, limit);
  const versions = await versionCounts(deps.db, page.map((row) => row.url_key));
  const items: UnverifiedLink[] = page.map((row) => ({
    jobId: Number(row.job_id),
    url: row.url,
    host: row.host,
    reason: row.reason as JobVerifyReason,
    checkedAt: new Date(row.checked_at).toISOString(),
    firstAddedAt: new Date(row.first_added_at).toISOString(),
    adders: Number(row.adders),
    attempts: Number(row.attempts),
    ...(row.title ? { title: row.title } : {}),
    ...(row.company_name ? { companyName: row.company_name } : {}),
    ...(row.location?.trim() ? { location: row.location.trim() } : {}),
    versions: versions.get(row.url_key) ?? 1,
    ...(row.approved_before ? { approvedBefore: true } : {}),
    // v35 IMPORT (H3): where it came from.
    from: row.from_import ? ('import' as const) : row.from_add ? ('add' as const) : ('other' as const),
    importId: row.import_id === null ? null : Number(row.import_id),
    runId: row.run_id === null ? null : Number(row.run_id),
    // v35 OPSWEB: "Import · jobs.csv, row 12".
    importName: row.import_name ?? null,
    importRow: row.import_row === null ? null : Number(row.import_row),
  }));
  return { items, nextCursor: rows.length > limit ? cursorOf(page[page.length - 1]!) : null };
}
