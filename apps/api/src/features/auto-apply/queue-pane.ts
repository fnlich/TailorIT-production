import {
  QUEUE_PANE_DISPLAY_LABELS,
  STATUS,
  type PrepareJobState,
  type PrepareMode,
  type PrepareResumeMode,
  type PrepareStep,
  type PreparingItem,
  type QueuePane,
  type QueuePaneDisplay,
  type QueuePaneItem,
  type QueuePaneQuery,
  type QueueUsage,
} from '@tailorit/shared';
import { autoApplyUsage } from '../../core/accounts/usage';
import { constantsOf } from '../../core/constants/service';
import type { AppDeps } from '../../core/context';
import { logoUrlOf } from '../applications/store';
import { jobMarksOf } from '../jobs/credit'; // v30 FIX-B
import { orderedQueuePage, releaseStaleRuns, type PlacedItem } from '../autofill/agent/queue';
import { reasonOf, supportOf } from './saved';

// v2.0: the Auto-apply page's Queue pane (docs/design/v2.0/05-prepare-flow.md, "Read models for the web"; 08-ui.md,
// "The Queue pane"): the Prepares that are active, failed, or prepared but not queued (each Saved entry's newest), and
// the queue rows in the queue's order (running, then queued oldest first, then finished latest first; v1.5's
// orderedQueue, paged in SQL: orderedQueuePage), each with how it shows (`display`) and its words; and, for an account whose auto-apply is limited (a
// Free one), the window's usage ("3 of 7 used today"), `reached` turning the supported queued rows to "Waiting for daily
// reset". Manual rows never wait: the person applies to them by hand and they never count.
// v3.0 D2: async on deps.db.

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** The most Prepares the pane lists (newest first). */
export const PREPARING_SHOWN_MAX = 200;

interface PrepareRow {
  id: string;
  application_id: string;
  job_id: number | null;
  mode: PrepareMode;
  resume_mode: PrepareResumeMode;
  state: PrepareJobState;
  reason_code: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  title: string;
  company_name: string;
  logo_path: string | null;
  resume_status: string | null;
  letter_status: string | null;
  answers_status: string | null;
}

/** An active server Prepare's step, from its state and its kit's parts. */
function stepOf(row: PrepareRow): PrepareStep | null {
  if (row.mode !== 'server') return null;
  if (row.state === 'filtering') return 'filters';
  if (row.state === 'analyzing') return 'analysis';
  if (row.state !== 'building') return null;
  if (row.letter_status === 'building') return 'letter';
  if (row.answers_status === 'building') return 'answers';
  return 'resume';
}

async function preparingOf(deps: Deps, userId: string): Promise<PreparingItem[]> {
  const constants = constantsOf(deps);
  // v3.0 PG-D: prepare_jobs' insert order (`seq`) breaks ties of one created_at.
  const dialect = deps.db.dialect;
  const rows = await deps.db.all<PrepareRow>(
      `SELECT p.id, p.application_id, p.job_id, p.mode, p.resume_mode, p.state, p.reason_code, p.error, p.created_at,
         p.updated_at, a.title, a.company_name, (SELECT cp.logo_path FROM company_profiles cp WHERE cp.company_id = c.id) AS logo_path, d.resume_status, d.letter_status, d.answers_status
       FROM prepare_jobs p
       JOIN applications a ON a.id = p.application_id
       LEFT JOIN companies c ON c.id = a.company_id
       LEFT JOIN application_drafts d ON d.application_id = p.application_id
       WHERE p.user_id = ? AND p.state IN ('waiting', 'filtering', 'analyzing', 'building', 'failed', 'prepared')
         AND a.current_status = ${STATUS.saved} AND a.archived_at IS NULL
         AND p.id = (SELECT p2.id FROM prepare_jobs p2 WHERE p2.application_id = p.application_id
                     ORDER BY p2.created_at DESC, ${dialect.seq('p2')} DESC LIMIT 1)
       ORDER BY p.created_at DESC, ${dialect.seq('p')} DESC LIMIT ?`,
    [userId, PREPARING_SHOWN_MAX],
  );
  const marks = await jobMarksOf(deps.db, rows.map((row) => row.job_id)); // v30 FIX-B (REQ-1, UX-10)
  return rows.map((row) => {
    const label =
      row.state === 'failed'
        ? constants.message('STATE_PREPARE_FAILED')
        : row.state === 'prepared'
          ? constants.message('STATE_PREPARED')
          : constants.message(row.mode === 'mcp' ? 'STATE_PREPARING_OWN_AI' : 'STATE_PREPARING');
    return {
      prepareId: row.id,
      applicationId: row.application_id,
      jobId: row.job_id,
      title: row.title,
      company: row.company_name,
      logoUrl: logoUrlOf(row.logo_path),
      mode: row.mode,
      resumeMode: row.resume_mode,
      state: row.state,
      step: stepOf(row),
      label,
      reason: row.reason_code ? reasonOf(constants, { code: row.reason_code }) : null,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.job_id !== null ? marks.get(row.job_id) : {}), // v30 FIX-B: credit, closed
    };
  });
}

/** How a queue row shows in the pane (05's state table, rows 7-13). */
export function displayOf(placed: Pick<PlacedItem, 'item'>, reached: boolean): QueuePaneDisplay {
  const { state, run } = placed.item;
  switch (state) {
    case 'running':
      return 'applying';
    case 'submitted':
      return 'applied';
    case 'failed':
    case 'skipped':
      return 'failed';
    case 'needs-you':
      return 'needs_you';
    case 'queued':
      if (run === 'manual') return 'manual';
      return reached ? 'waiting_reset' : 'ready';
  }
}

/** GET /api/auto-apply/queue: the Queue pane (QueuePane). */
export async function queuePane(deps: Deps, userId: string, query: QueuePaneQuery): Promise<QueuePane> {
  await releaseStaleRuns(deps, userId);
  const constants = constantsOf(deps);
  const window = await autoApplyUsage(deps, userId);
  const usage: QueueUsage | null =
    window.limit === null
      ? null
      : { used: window.used, limit: window.limit, resetsAt: window.resetsAt, resetText: window.resetText, reached: window.reached };
  // v30 FIX-PERF (PG-LOAD PGL-12): the page in SQL; only its rows are read with their jobs (every row was, 5,000 for the
  // heavy account at mix B's size).
  const { page, nextCursor } = await orderedQueuePage(deps, userId, {}, query.cursor, query.limit, 'pane');
  const marks = await jobMarksOf(deps.db, page.map((placed) => placed.item.jobId)); // v30 FIX-B (REQ-1, UX-10)
  const items: QueuePaneItem[] = page.map((placed) => {
    const display = displayOf(placed, window.reached);
    const { item, extra } = placed;
    return {
      queueId: item.id,
      applicationId: extra.applicationId,
      jobId: item.jobId,
      prepareId: extra.prepareId,
      resumeMode: extra.resumeMode,
      title: item.title,
      company: item.company,
      logoUrl: logoUrlOf(extra.logoPath),
      location: item.location,
      url: item.url,
      state: item.state,
      display,
      label: constants.message(QUEUE_PANE_DISPLAY_LABELS[display]),
      support: supportOf(extra.applyUrl, item.run ?? null),
      reason: item.reason,
      run: item.run ?? null,
      source: item.source,
      attempts: item.attempts,
      aiGuesses: item.aiGuesses,
      createdAt: item.createdAt,
      startedAt: item.startedAt,
      finishedAt: item.finishedAt,
      ...marks.get(item.jobId), // v30 FIX-B: credit, closed
    };
  });
  return { preparing: query.cursor ? [] : await preparingOf(deps, userId), items, usage, ...(nextCursor ? { nextCursor } : {}) };
}
