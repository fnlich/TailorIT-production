import {
  ADMIN_REVIEW_CHECKS_MAX,
  JOB_REPORT_REASON_LABEL,
  reviewGroupOf,
  reviewStateBase, // v37 REVIEW
  type AdminFlag,
  type AdminReviewCheck,
  type AdminReviewCounts,
  type AdminReviewDetail,
  type AdminReviewList,
  type AdminReviewReporters,
  type AdminReviewRow,
  type AdminReviewsFilter,
  type AdminReviewsQuery,
  type JobReviewSignal,
  type JobReviewStrength,
  type JobReviewVia,
  type JobSourceKind,
  type ReviewJobRef,
} from '@tailorit/shared';
import { afterCursor, likeText, pageOf, Where } from '../../core/admin/index';
import { dayKeyAt } from '../../core/constants/day';
import type { AppDeps } from '../../core/context';
import type { DbQueries, SqlParam } from '../../core/db/types';
import { sanitizeDescription } from '../jobs/html';
import { readJobText } from '../jobs/text';
import { boardOfJob, companyOf, likelyDuplicates } from './checks';
import { REVIEW_LANE_FROM, reviewLaneCounts } from './counts'; // v37 REVIEW
import { pageJobsOf } from './decide';
import { FLAG_RESOLVED_WITH_JOB } from './settle'; // v37 FIX-REV (D1)
import { REVIEW_COLUMNS, type ReviewRow } from './store';
import { trustedSql, trustParams } from './trust';

// v30 X1-API: Admin › Review's reads (docs/design/part2/14-extension-reports.md §6; the shapes are CT's
// @tailorit/shared/reviews): the Closed links and New jobs lanes (job_reviews), each lane's count of items needing a
// decision, a review's detail sheet and, on expand, its reporting accounts (admins only, owner question 28). The lists
// page by a keyset cursor (core/admin/paging.ts), newest first: a pending lane by its newest report, the decided one by
// its decision, "All" by whichever is later. Decided rows stay listable until the daily prune (EXT_REVIEW_KEEP_DAYS).

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

const STALE = 'This list changed since it was opened. Load it again.';

/** A review row joined with its job and company, as the lanes read it. */
interface LaneRow extends ReviewRow {
  /**
   * v35 ADMIN: the import's name (its csv or json record's), when its run is still there. v35 INT-A: the import's own
   * name first (IMPORT's job_imports: "24 pasted links", the file, the tab), then its record's.
   */
  import_name: string | null;
  title: string;
  company_id: number;
  company_name: string;
  active: boolean;
  held: boolean;
  apply_url: string;
  apply_platform: string;
  strongest_signal: JobReviewSignal | null;
  sort_at: string;
  /** v38 REVEDIT (PLAN E4): an admin edited the job. */
  admin_edited?: boolean;
}

const LANE_SELECT = (sort: string) =>
  `SELECT ${REVIEW_COLUMNS.split(', ')
    .map((column) => `r.${column}`)
    .join(', ')}, j.title, j.company_id, c.name AS company_name, j.active, j.held_since IS NOT NULL AS held, j.apply_url,
     j.apply_platform,
     (SELECT p.signal FROM job_review_reports p WHERE p.review_id = r.id AND p.signal IS NOT NULL
      ORDER BY CASE p.strength WHEN 'strong' THEN 3 WHEN 'person' THEN 2 WHEN 'weak' THEN 1 ELSE 0 END DESC, p.seen_at DESC
      LIMIT 1) AS strongest_signal,
     ${sort} AS sort_at, COALESCE(ji.name, iso.name) AS import_name,
     EXISTS (SELECT 1 FROM job_admin_edits ae WHERE ae.job_id = j.id) AS admin_edited
   FROM job_reviews r JOIN jobs j ON j.id = r.job_id JOIN companies c ON c.id = j.company_id
     LEFT JOIN job_source_runs ir ON ir.id = r.import_run_id LEFT JOIN job_sources iso ON iso.id = ir.source_id
     LEFT JOIN job_imports ji ON ji.run_id = r.import_run_id`;

/**
 * The sort key of a state filter's list (newest first). v37 REVIEW (R2): Waiting by its newest report, as Needs review
 * and Checking.
 */
function sortOf(state: AdminReviewsQuery['state']): string {
  if (state === 'decided') return 'r.decided_at';
  if (state === 'all') return 'COALESCE(r.decided_at, r.last_reported_at)';
  return 'r.last_reported_at';
}

function jobRef(row: {
  job_id: number;
  title: string;
  company_id: number;
  company_name: string;
  active: boolean;
  held: boolean;
  apply_url: string;
  admin_edited?: boolean;
}): ReviewJobRef {
  return {
    id: row.job_id,
    title: row.title,
    companyId: row.company_id,
    companyName: row.company_name,
    active: row.active === true,
    held: row.held === true,
    applyUrl: row.apply_url,
    // v38 REVEDIT (SP v38 PLAN.md E4): "Edited by an admin" (Review is admins' only).
    ...(row.admin_edited === true ? { adminEdited: true } : {}),
  };
}

function toRow(deps: Deps, row: LaneRow, today: string): AdminReviewRow {
  const decidedToday = row.decided_at !== null && dayKeyAt(deps, new Date(row.decided_at)) === today;
  return {
    id: row.id,
    kind: row.kind,
    origin: row.origin,
    platform: row.origin === 'ats' ? row.apply_platform : null,
    pageHost: row.origin === 'page' ? row.page_host : null,
    job: jobRef(row),
    state: row.state,
    group: reviewGroupOf({ state: row.state, checkState: row.check_state }, decidedToday),
    reporters: row.reporters,
    trustedReporters: row.trusted_reporters,
    strongest: row.strongest,
    strongestSignal: row.strongest_signal,
    checkState: row.check_state,
    checkedAt: row.checked_at,
    firstReportedAt: row.first_reported_at,
    lastReportedAt: row.last_reported_at,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    note: row.note,
    // v30 INT-3 (decision 3): "Reopened by its source", when a listing reopened the job after an approval.
    ...(row.reopened_at ? { reopenedAt: row.reopened_at } : {}),
    // v35 ADMIN (PLAN H3): a new job an admin's import read, and that import.
    ...(row.imported === true ? { imported: true, importRunId: row.import_run_id ?? null, importName: row.import_name ?? null } : {}),
  };
}

/**
 * Each lane's items needing a decision: pending reviews of each kind, open flags. v37 REVIEW (R2): read as the lanes
 * list them (counts.ts), so each count is what its Waiting list shows, Checking rows included.
 */
export async function reviewCounts(db: DbQueries): Promise<AdminReviewCounts> {
  return reviewLaneCounts(db);
}

/**
 * A lane's filters on the review `r` (its job `j`, company `c`): the lane, the state filter, the search, and (v35 ADMIN,
 * PLAN H3) on the New jobs lane where its jobs came from (an admin's imports, people's link reads) and one import.
 */
export function reviewsWhere(deps: Pick<Deps, 'db'>, filter: AdminReviewsFilter): Where {
  const where = new Where().add('r.kind = @lane', { lane: filter.lane });
  if (filter.state === 'waiting') where.add("r.state = 'pending'"); // v37 REVIEW (R2): needs review and checking
  else if (filter.state === 'needs_review') where.add("r.state = 'pending' AND r.check_state <> 'queued'");
  else if (filter.state === 'checking') where.add("r.state = 'pending' AND r.check_state = 'queued'");
  else if (filter.state === 'decided') where.add("r.state <> 'pending'");
  const d = deps.db.dialect;
  if (filter.q) where.add(`(${d.like('j.title', '@q')} OR ${d.like('c.name', '@q')})`, { q: likeText(filter.q) });
  if (filter.lane === 'new_job') {
    if (filter.importRunId !== undefined) where.add('r.imported AND r.import_run_id = @importRunId', { importRunId: filter.importRunId });
    else if (filter.from === 'imports') where.add('r.imported');
    else if (filter.from === 'reads') where.add('NOT r.imported');
  }
  return where;
}

/**
 * v37 REVIEW (R2): whether a lane's filter narrows its view (a search, New jobs' From filter or one import, or Needs
 * review / Checking within Waiting): its header then says "12 of 340".
 */
export function narrowsView(filter: Pick<AdminReviewsFilter, 'state' | 'q' | 'from' | 'importRunId'> & { lane?: AdminReviewsFilter['lane'] }): boolean {
  const fromFilter = filter.lane !== 'closed' && ((filter.from !== undefined && filter.from !== 'all') || filter.importRunId !== undefined);
  return Boolean(filter.q) || fromFilter || reviewStateBase(filter.state) !== filter.state;
}

/**
 * GET /api/admin/reviews: one lane's page (see above). v37 REVIEW (R2, R3): with the rows the query matches (`total`),
 * those a decision can take (`decidable`), and the view's rows without its search or From filter (`unfiltered`).
 */
export async function listReviews(deps: Deps, query: AdminReviewsQuery): Promise<AdminReviewList> {
  const sort = sortOf(query.state);
  const where = reviewsWhere(deps, query);
  const counted = await deps.db.one<{ n: number; decidable: number }>(
    `SELECT count(*) AS n, count(*) FILTER (WHERE r.state = 'pending') AS decidable ${REVIEW_LANE_FROM} ${where.sql()}`,
    where.params as Record<string, SqlParam>,
  );
  const total = Number(counted?.n ?? 0);
  let unfiltered = total;
  if (narrowsView(query)) {
    const base = reviewsWhere(deps, { lane: query.lane, state: reviewStateBase(query.state) });
    const row = await deps.db.one<{ n: number }>(`SELECT count(*) AS n ${REVIEW_LANE_FROM} ${base.sql()}`, base.params as Record<string, SqlParam>);
    unfiltered = Number(row?.n ?? 0);
  }
  if (query.cursor) {
    const after = afterCursor(query.cursor, { sortColumn: sort, idColumn: 'r.id', staleMessage: STALE });
    where.add(after.sql, after.params);
  }
  const rows = await deps.db.all<LaneRow>(
    `${LANE_SELECT(sort)} ${where.sql()} ORDER BY ${sort} DESC, r.id DESC LIMIT ${query.limit + 1}`,
    where.params as Record<string, SqlParam>,
  );
  const today = dayKeyAt(deps);
  const page = pageOf(rows, query.limit, (last) => ({ c: last.sort_at, id: last.id }), (row) => toRow(deps, row, today));
  return { ...page, counts: await reviewCounts(deps.db), total, decidable: Number(counted?.decidable ?? 0), unfiltered };
}

async function laneRow(db: DbQueries, id: number): Promise<LaneRow | undefined> {
  return db.one<LaneRow>(`${LANE_SELECT('r.last_reported_at')} WHERE r.id = ?`, [id]);
}

/** GET /api/admin/reviews/:id: the detail sheet; null when there is no such review. */
export async function reviewDetail(deps: Deps, id: number): Promise<AdminReviewDetail | null> {
  const db = deps.db;
  const row = await laneRow(db, id);
  if (!row) return null;
  const now = deps.now();
  const reports = await db.all<{
    via: JobReviewVia;
    signal: JobReviewSignal | null;
    marker: string | null;
    strength: JobReviewStrength | null;
    trusted: boolean;
    details: string | null;
    page_job_id: number | null;
    seen_at: string;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT r.via, r.signal, r.marker, r.strength, ${trustedSql('u')} AS trusted, r.details, r.page_job_id, r.seen_at, r.created_at,
       r.updated_at
     FROM job_review_reports r JOIN users u ON u.id = r.user_id WHERE r.review_id = @id ORDER BY r.created_at, r.user_id`,
    { id, ...trustParams(deps, now) },
  );
  const links = await db.all<{
    source_id: number;
    kind: JobSourceKind;
    name: string;
    source_job_id: string;
    miss_count: number;
    missing_since: string | null;
    verified_at: string | null;
  }>(
    `SELECT l.source_id, s.kind, s.name, l.source_job_id, l.miss_count, l.missing_since,
       GREATEST(l.liveness_checked_at, s.last_complete_at) AS verified_at
     FROM job_source_links l JOIN job_sources s ON s.id = l.source_id WHERE l.job_id = ? ORDER BY l.seq`,
    [row.job_id],
  );
  let posting: AdminReviewDetail['posting'] = null;
  let duplicates: AdminReviewDetail['duplicates'] = [];
  let company: AdminReviewDetail['company'] = null;
  let offersToDiscovery: AdminReviewDetail['offersToDiscovery'] = null;
  if (row.kind === 'new_job') {
    // A page review shows the posting most accounts captured (the one approving publishes); an ATS one its own job.
    const shown = row.origin === 'page' ? ((await pageJobsOf(db, id)).chosen ?? row.job_id) : row.job_id;
    const job = await db.one<{ title: string; company_name: string; apply_url: string }>(
      'SELECT j.title, c.name AS company_name, j.apply_url FROM jobs j JOIN companies c ON c.id = j.company_id WHERE j.id = ?',
      [shown],
    );
    const places = await db.all<{ raw: string }>('SELECT raw FROM job_locations WHERE job_id = ? ORDER BY position', [shown]);
    if (job) {
      posting = {
        title: job.title,
        companyName: job.company_name,
        locations: places.map((place) => place.raw),
        // v30 FIX-B (SEC-8): cleaned on the way out, as /api/jobs/:id does: ReviewSheet draws it in an admin's session.
        descriptionHtml: sanitizeDescription((await readJobText(db, shown))?.html),
        applyUrl: job.apply_url,
      };
    }
    const facts = await companyOf(db, shown);
    if (facts) company = { companyId: facts.companyId, name: facts.name, resolvedBy: facts.resolvedBy, doNotFetch: facts.doNotFetch };
    if (row.origin === 'ats') duplicates = await likelyDuplicates(deps, db, row.job_id);
    if (!facts?.doNotFetch) {
      offersToDiscovery = row.origin === 'page' ? (row.page_host ? { kind: 'career_site', name: row.page_host } : null) : await boardOfJob(db, row.job_id);
    }
  }
  // v30 INT-3 (decision 3): the job's re-checks, newest first (idx_job_review_checks_job).
  const checks = await db.all<{ state: AdminReviewCheck['state']; checked_at: string; source_made_due: boolean }>(
    'SELECT state, checked_at, source_made_due FROM job_review_checks WHERE job_id = ? ORDER BY checked_at DESC, id DESC LIMIT ?',
    [row.job_id, ADMIN_REVIEW_CHECKS_MAX],
  );
  const today = dayKeyAt(deps);
  return {
    ...toRow(deps, row, today),
    reports: reports.map((report) => ({
      via: report.via,
      signal: report.signal,
      marker: report.marker,
      strength: report.strength,
      trusted: report.trusted === true,
      details: report.details,
      pageJobId: report.page_job_id,
      seenAt: report.seen_at,
      createdAt: report.created_at,
      updatedAt: report.updated_at,
    })),
    links: links.map((link) => ({
      sourceId: link.source_id,
      sourceKind: link.kind,
      sourceName: link.name,
      sourceJobId: link.source_job_id,
      state: link.missing_since === null ? 'live' : 'missing',
      missCount: link.miss_count,
      missingSince: link.missing_since,
      lastVerifiedAt: link.verified_at,
      reported: link.source_id === row.link_source_id && link.source_job_id === row.link_source_job_id,
    })),
    posting,
    duplicates,
    company,
    offersToDiscovery,
    checks: checks.map((check) => ({ state: check.state, checkedAt: check.checked_at, sourceMadeDue: check.source_made_due === true })),
  };
}

/** GET /api/admin/reviews/:id/reporters: the reporting accounts (admins only); null when there is no such review. */
export async function reviewReporters(deps: Deps, id: number): Promise<AdminReviewReporters | null> {
  const exists = await deps.db.one('SELECT 1 FROM job_reviews WHERE id = ?', [id]);
  if (!exists) return null;
  const rows = await deps.db.all<{ id: string; email: string; name: string; via: JobReviewVia; trusted: boolean; reported_at: string }>(
    `SELECT u.id, u.email, u.name, r.via, ${trustedSql('u')} AS trusted, r.updated_at AS reported_at
     FROM job_review_reports r JOIN users u ON u.id = r.user_id WHERE r.review_id = @id ORDER BY r.created_at, u.id`,
    { id, ...trustParams(deps, deps.now()) },
  );
  return {
    items: rows.map((row) => ({ userId: row.id, email: row.email, name: row.name, via: row.via, trusted: row.trusted === true, reportedAt: row.reported_at })),
  };
}

// The Flags lane ---------------------------------------------------------------------------------------------------

/** A job_reports row joined with its reporter, resolver, job and company. */
export interface FlagRow {
  id: number;
  status: AdminFlag['status'];
  reason: AdminFlag['reason'];
  details: string;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolver_email: string | null;
  user_id: string;
  email: string;
  user_name: string;
  job_id: number;
  title: string;
  company_id: number;
  company_name: string;
  active: boolean;
  held: boolean;
  apply_url: string;
  /** v38 REVEDIT (PLAN E4): an admin edited the job. */
  admin_edited?: boolean;
}

export const FLAG_SELECT =
  'SELECT r.id, r.status, r.reason, r.details, r.created_at, r.resolved_at, r.resolved_by, rb.email AS resolver_email, ' +
  'r.user_id, u.email, u.name AS user_name, r.job_id, j.title, j.company_id, c.name AS company_name, j.active, ' +
  'j.held_since IS NOT NULL AS held, j.apply_url, ' +
  'EXISTS (SELECT 1 FROM job_admin_edits ae WHERE ae.job_id = j.id) AS admin_edited ' + // v38 REVEDIT
  'FROM job_reports r JOIN users u ON u.id = r.user_id JOIN jobs j ON j.id = r.job_id JOIN companies c ON c.id = j.company_id ' +
  'LEFT JOIN users rb ON rb.id = r.resolved_by';

export function toFlag(row: FlagRow): AdminFlag {
  // v37 FIX-REV (SP v37 FIXES-361.md D1): a flag the server resolved because its job closed (settle.ts) names no resolver.
  const jobClosed = row.status === 'resolved' && row.resolved_by === FLAG_RESOLVED_WITH_JOB;
  return {
    id: row.id,
    status: row.status,
    reason: row.reason,
    reasonLabel: JOB_REPORT_REASON_LABEL[row.reason] ?? row.reason,
    details: row.details,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedBy: jobClosed ? null : (row.resolver_email ?? row.resolved_by),
    reporter: { id: row.user_id, email: row.email, name: row.user_name },
    job: jobRef(row),
    ...(jobClosed ? { jobClosed: true } : {}),
  };
}
