import {
  FILTER_REASON_LABELS,
  FILTER_REASONS,
  SAVED_JOB_MARKER_LABELS,
  STATUS,
  type FilterReason,
  type FilterReasonEntry,
  type PrepareJobState,
  type PrepareReason,
  type SavedJobFilter,
  type SavedJobItem,
  type SavedJobList,
  type SavedJobListQuery,
  type SavedJobMarker,
  type SavedJobSupport,
} from '@tailorit/shared';
import { agentApplicationUrl, queueCanOpen, type AutofillAgentState } from '@tailorit/shared/autofill';
import { constantsOf, type ConstantsService } from '../../core/constants/service';
import type { AppDeps } from '../../core/context';
import type { FilterCheck } from '../../core/seams';
import { decodeCursor, encodeCursor, keyText, keyValues } from '../applications/query';
import { logoUrlOf } from '../applications/store';
import { verificationColumns, verificationOf } from '../jobs/add/verification'; // v31 INT-2
import { jobMarksOf } from '../jobs/credit'; // v30 FIX-B

// v2.0: the Auto-apply page's Saved Jobs pane (docs/design/v2.0/05-prepare-flow.md, "The state machine" and "Read
// models for the web"; 08-ui.md, "The Saved pane"). The person's Tracker entries at Saved, not archived, with a job,
// newest first (as the Tracker's Saved column: the tracked day, then the moment it was added), each with its marker
// from three records: its newest Prepare (P), its job's queue row (Q, one per account and job), and its filter verdict
// (prepare_filter_results, F). The marker's order:
//   1. P active                                         preparing
//   2. Q queued or running                              queued (A30: the entry shows Draft)
//   3. P failed                                         prepare_failed
//   4. P prepared                                       prepared
//   5. Q failed, skipped or needs-you                   not_applied (the kit is kept: Try again reuses it)
//   6. F fail, or P filtered not overruled by a later   filtered
//      pass
//   7. otherwise                                        none
// A verdict is stale when the person's filters_revision or the job's facts_version moved on (or there is none): the
// pane's read has P4's filter service compute the stale verdicts of the page it returns (no AI), and the markers then
// read the fresh ones. The tab filters (`ready`: none, filtered or prepare_failed) are applied in SQL first and again
// after the recompute, so a page may hold fewer rows than asked; `nextCursor` still follows the order.
// v3.0 D2: async on deps.db. v3.0 PG-D: the newest Prepare's tie-break is prepare_jobs' insert order (`seq`); the saved
// day is a `date` column; the order is the tracker's tracked sort (the tracked day, then the moment the entry was
// added, compared as one row value with the id: applications/query.ts), the cursor's key in its form.

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

const ACTIVE = "('waiting', 'filtering', 'analyzing', 'building')";

/** The marker as SQL, over the joined p, q and f (the fresh verdict's or the stored one's). */
const MARKER_SQL = `CASE
    WHEN p.state IN ${ACTIVE} THEN 'preparing'
    WHEN q.state IN ('queued', 'running') THEN 'queued'
    WHEN p.state = 'failed' THEN 'prepare_failed'
    WHEN p.state = 'prepared' THEN 'prepared'
    WHEN q.state IN ('failed', 'skipped', 'needs-you') THEN 'not_applied'
    WHEN f.verdict = 'fail' OR (p.state = 'filtered' AND (f.verdict IS NULL OR f.checked_at <= p.finished_at)) THEN 'filtered'
    ELSE 'none'
  END`;

const TAB_MARKERS: Record<SavedJobFilter, readonly SavedJobMarker[] | null> = {
  all: null,
  ready: ['none', 'filtered', 'prepare_failed'],
  filtered: ['filtered'],
  queued: ['queued'],
};

interface SavedRow {
  id: string;
  job_id: number;
  title: string;
  company_name: string;
  location: string;
  logo_path: string | null;
  saved_on: string;
  /** The tracked sort's key: the tracked day and the moment the entry was added. */
  sort_day: string;
  sort_at: string;
  apply_url: string;
  /** v30 INT-3: jobs.held_since is set (held for review). */
  held: boolean;
  /** v31 INT-2: the job's verification columns, as the job summaries read them (jobs/add/verification.ts). */
  held_since: string | null;
  owned_job: boolean | null;
  verification_json: unknown;
  p_id: string | null;
  p_state: PrepareJobState | null;
  p_reason: string | null;
  p_finished: string | null;
  q_id: string | null;
  q_state: AutofillAgentState | null;
  q_run: string | null;
  f_verdict: 'pass' | 'fail' | null;
  f_reasons: string | null;
  /** A flag: 0/1 on SQLite, a boolean on PostgreSQL. */
  f_stale: number | boolean;
  marker: SavedJobMarker;
}

const isFilterReason = (code: string): code is FilterReason => (FILTER_REASONS as readonly string[]).includes(code);

/** A filter reason's words ("on-site", "pay below $90k"), rendered from its constant; an unknown code as it is. */
export function reasonOf(constants: ConstantsService, entry: { code: string; value?: string }): PrepareReason {
  const label = isFilterReason(entry.code)
    ? constants.message(FILTER_REASON_LABELS[entry.code], { value: entry.value ?? '' })
    : entry.code;
  return { code: entry.code, label };
}

function storedReasons(text: string | null): FilterReasonEntry[] {
  if (!text) return [];
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value)
      ? value.filter((entry): entry is FilterReasonEntry => typeof entry?.code === 'string' && isFilterReason(entry.code))
      : [];
  } catch {
    return [];
  }
}

/** Which run can apply to a job at `url`: Run auto-apply, the Queue tab alone, or the person. */
export function supportOf(url: string, run: string | null = null): SavedJobSupport {
  if (run === 'manual') return 'manual';
  if (agentApplicationUrl(url) !== null) return 'agent';
  return queueCanOpen(url) ? 'tab' : 'manual';
}

/**
 * The person's saved entries with a job, joined to the three records the marker reads: the newest Prepare (p), the
 * job's queue row (q) and the filter verdict (f). `@userId` names the person.
 */
function savedFrom(d: Deps['db']['dialect']): string {
  return `FROM applications a
      JOIN jobs j ON j.id = a.job_id
      LEFT JOIN companies c ON c.id = a.company_id
      LEFT JOIN prepare_jobs p ON p.id = (SELECT p2.id FROM prepare_jobs p2 WHERE p2.application_id = a.id
        ORDER BY p2.created_at DESC, ${d.seq('p2')} DESC LIMIT 1)
      LEFT JOIN autofill_agent_queue q ON q.user_id = a.user_id AND q.job_id = a.job_id
      LEFT JOIN prepare_filter_results f ON f.application_id = a.id
      WHERE a.user_id = @userId AND a.current_status = ${STATUS.saved} AND a.archived_at IS NULL`;
}

const markerList = (markers: readonly SavedJobMarker[]) => markers.map((marker) => `'${marker}'`).join(', ');

function rowsOf(deps: Deps, userId: string, query: SavedJobListQuery): Promise<SavedRow[]> {
  const d = deps.db.dialect;
  const scope = `saved:${query.filter}`;
  const after = query.cursor ? decodeCursor(query.cursor, scope) : null;
  const markers = TAB_MARKERS[query.filter];
  const sql = `SELECT * FROM (
      SELECT a.id, a.job_id, a.title, a.company_name, a.location, (SELECT cp.logo_path FROM company_profiles cp WHERE cp.company_id = c.id) AS logo_path, j.apply_url, j.held_since IS NOT NULL AS held,
        j.held_since, ${verificationColumns('j')},
        coalesce((SELECT e.occurred_on FROM application_status_events e WHERE e.application_id = a.id AND e.status = 1),
          a.tracked_on) AS saved_on,
        a.tracked_on AS sort_day, a.created_at AS sort_at,
        p.id AS p_id, p.state AS p_state, p.reason_code AS p_reason, p.finished_at AS p_finished,
        q.id AS q_id, q.state AS q_state, q.run AS q_run,
        f.verdict AS f_verdict, f.reasons AS f_reasons,
        CASE WHEN f.verdict IS NULL
            OR f.filters_revision <> coalesce((SELECT s.filters_revision FROM user_settings s WHERE s.user_id = a.user_id), 0)
            OR f.facts_version <> coalesce((SELECT jf.facts_version FROM job_facts jf WHERE jf.job_id = a.job_id), f.facts_version)
          THEN ${d.true} ELSE ${d.false} END AS f_stale,
        ${MARKER_SQL} AS marker
      ${savedFrom(d)}
    ) saved WHERE 1 = 1
      ${markers ? `AND marker IN (${markerList(markers)})` : ''}
      ${after ? 'AND (sort_day, sort_at, id) < (@day, @at, @id)' : ''}
    ORDER BY sort_day DESC, sort_at DESC, id DESC LIMIT @limit`;
  const [day, at] = after ? keyValues(after.k, 'tracked') : [null, null];
  return deps.db.all<SavedRow>(sql, { userId, day, at, id: after?.id ?? null, limit: query.limit + 1 });
}

/** A saved entry Prepare All may take: the Tracker entry and its job. */
export interface ToPrepareEntry {
  applicationId: string;
  jobId: number;
}

/**
 * v31 AUTO (D10): Prepare All's candidates, the person's saved jobs in To prepare (the `ready` tab's markers: no
 * Prepare yet, filtered, or preparation failed) whose job is still open, in the pane's order (newest saved first), at
 * most `max`. The filters are not applied here: the caller asks the filter service for fresh verdicts.
 */
export async function toPrepareEntries(deps: Deps, userId: string, max: number): Promise<ToPrepareEntry[]> {
  const d = deps.db.dialect;
  const rows = await deps.db.all<{ id: string; job_id: number }>(
    `SELECT id, job_id FROM (
        SELECT a.id, a.job_id, j.active, a.tracked_on AS sort_day, a.created_at AS sort_at, ${MARKER_SQL} AS marker
        ${savedFrom(d)}
      ) saved WHERE active = ${d.true} AND marker IN (${markerList(TAB_MARKERS.ready!)})
      ORDER BY sort_day DESC, sort_at DESC, id DESC LIMIT @limit`,
    { userId, limit: max },
  );
  return rows.map((row) => ({ applicationId: row.id, jobId: row.job_id }));
}

/** GET /api/auto-apply/saved: one page of the Saved pane (SavedJobList), stale verdicts computed again for it. */
export async function savedJobs(deps: Deps, userId: string, query: SavedJobListQuery): Promise<SavedJobList> {
  const constants = constantsOf(deps);
  const rows = await rowsOf(deps, userId, query);
  const page = rows.slice(0, query.limit);
  // The stale verdicts of the rows whose marker reads them (no Prepare or queue state above them).
  const checks = new Map<string, FilterCheck>();
  const filters = deps.services.prepareFilters;
  const stale = page.filter((row) => Boolean(row.f_stale) && (row.marker === 'none' || row.marker === 'filtered'));
  if (filters && stale.length > 0) {
    try {
      for (const check of await filters.evaluate(userId, stale.map((row) => row.id), { record: true })) {
        checks.set(check.applicationId, check);
      }
    } catch (error) {
      deps.log.warn('[auto-apply] the Saved pane could not check filters', error instanceof Error ? error.name : 'unknown');
    }
  }
  const tab = TAB_MARKERS[query.filter];
  // v30 FIX-B (REQ-1, UX-10): the page's jobs' credit lines and closed marks, in one read.
  const marks = await jobMarksOf(deps.db, page.map((row) => row.job_id));
  const items: SavedJobItem[] = [];
  for (const row of page) {
    let marker = row.marker;
    let reasons: FilterReasonEntry[] = row.f_verdict === 'fail' ? storedReasons(row.f_reasons) : [];
    const check = checks.get(row.id);
    if (check) {
      const failed = check.verdict.verdict === 'fail' || check.custom === 'fail';
      reasons = check.verdict.verdict === 'fail' ? check.verdict.reasons : check.custom === 'fail' ? [{ code: 'custom' }] : [];
      marker = failed ? 'filtered' : 'none';
    }
    if (marker === 'filtered' && reasons.length === 0 && row.p_reason) reasons = [{ code: row.p_reason as FilterReason }];
    if (tab && !tab.includes(marker)) continue;
    const shown = marker === 'filtered' ? reasons.map((entry) => reasonOf(constants, entry)) : [];
    const key = SAVED_JOB_MARKER_LABELS[marker];
    const label =
      marker === 'filtered'
        ? constants.message('MSG_FILTERED', { reason: shown[0]?.label ?? '' })
        : key
          ? constants.message(key)
          : undefined;
    items.push({
      applicationId: row.id,
      jobId: row.job_id,
      title: row.title,
      company: row.company_name,
      logoUrl: logoUrlOf(row.logo_path),
      location: row.location,
      savedOn: row.saved_on,
      support: supportOf(row.apply_url, row.q_run),
      marker,
      ...(label !== undefined ? { label } : {}),
      ...(shown.length > 0 ? { reasons: shown } : {}),
      ...(row.p_id ? { prepareId: row.p_id } : {}),
      ...(row.q_id ? { queueId: row.q_id } : {}),
      // v30 INT-3: held for review, waiting for approval (14 §4.3).
      ...(row.held === true ? { held: true } : {}),
      // v31 INT-2: a job others do not see says why, as on Jobs and the Tracker (absent: everyone sees it).
      ...verificationOf(row),
      ...marks.get(row.job_id), // v30 FIX-B: credit, closed
    });
  }
  const last = page[page.length - 1];
  return {
    items,
    ...(rows.length > query.limit && last
      ? { nextCursor: encodeCursor({ k: keyText([last.sort_day, last.sort_at]), id: last.id, s: `saved:${query.filter}` }) }
      : {}),
  };
}
