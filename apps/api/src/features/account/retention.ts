import { constantsOf } from '../../core/constants/index';
import type { AppDeps } from '../../core/context';
import type { DailyStep } from '../../core/feature';
import { DAY_MS } from '@tailorit/shared';
import { arrayLiteral } from '../jobs/search';

// v30 DB-JOBS (D1g; docs/design/part2/11-database.md §8.1-8.2): the retention rules that need no partition, as daily
// steps of the account feature. Each deletes in batches through an index on its age column (11 §8.1: "batches of
// 10,000"), one statement a batch outside any transaction, so no lock outlives a batch; each window is a constant an
// admin may change. The partitioned tables (job_postings_raw, ai_task_payloads, job_texts) are D5L's housekeeping.
//   viewMarks      user_job_state: a view mark older than USER_JOB_VIEW_KEEP_DAYS; a hidden job stays hidden forever
//   draftAnswers   application_draft_answers: DRAFT_ANSWERS_KEEP_DAYS_AFTER_APPLY after applying, once every record of
//                  the entry holds what was sent (submitted answers, or prepared ones copied into answers_used); and
//                  those of an entry taken out of Saved Jobs more than DRAFT_ANSWERS_KEEP_DAYS_UNSAVED ago
//   closedJobFacts job_facts, job_facts_certifications, job_facts_eligibility of a job closed more than
//                  JOB_ANALYSIS_CLOSED_KEEP_DAYS ago that no tracker entry names (recomputable; a reopened job's facts
//                  are built again with it)
//   closedJobAnalyses job_analyses of a text no open, recently closed or tracked job has, made more than
//                  JOB_ANALYSIS_CLOSED_KEEP_DAYS ago (an AI analysis costs money to redo, so only texts nobody needs)
// Kept forever (11 §8.2): jobs, their texts, links and keys; applications and their records; snapshots; ledgers.

/** Rows one statement deletes at most (11 §8.1). */
export const RETENTION_BATCH = 10_000;
/** Drafts one statement of draftAnswers looks at (each holds a form's answers, a few dozen at most). */
export const DRAFT_BATCH = 1_000;

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

const cutoffOf = (deps: Deps, days: number) => new Date(deps.now().getTime() - days * DAY_MS).toISOString();

/** Runs `step` until a pass deletes fewer than `batch` rows; answers the rows deleted. */
async function inBatches(step: () => Promise<number>, batch: number): Promise<number> {
  let total = 0;
  for (;;) {
    const deleted = await step();
    total += deleted;
    if (deleted < batch) return total;
  }
}

const VIEW_MARKS = `DELETE FROM user_job_state WHERE (user_id, job_id) IN (
    SELECT user_id, job_id FROM user_job_state WHERE hidden_at IS NULL AND viewed_at < ? LIMIT ?)`;

/** user_job_state: view marks past USER_JOB_VIEW_KEEP_DAYS (idx_user_job_state_viewed). Hidden jobs stay. */
export const pruneViewMarks: DailyStep = {
  name: 'viewMarks',
  run: async (deps) => {
    const cutoff = cutoffOf(deps, constantsOf(deps).get('USER_JOB_VIEW_KEEP_DAYS'));
    return inBatches(async () => (await deps.db.run(VIEW_MARKS, [cutoff, RETENTION_BATCH])).changes, RETENTION_BATCH);
  },
};

/** The drafts still holding answers, a page at a time (application_draft_answers' unique key leads with draft_id). */
const DRAFTS_WITH_ANSWERS = 'SELECT DISTINCT draft_id AS id FROM application_draft_answers WHERE draft_id > ? ORDER BY draft_id LIMIT ?';

/**
 * Of `ids`, the drafts whose answers go: an entry applied to (not Saved) whose records are all older than the cutoff
 * and each hold what was sent (no prepared record without its copied answers); or an entry still Saved but taken out of
 * Saved Jobs (archived) before the un-saved cutoff.
 */
const DUE_DRAFT_ANSWERS = (list: string) => `DELETE FROM application_draft_answers da USING application_drafts d, applications a
  WHERE da.draft_id = d.id AND a.id = d.application_id AND d.id IN (${list})
    AND (
      (a.current_status = 1 AND a.archived_at IS NOT NULL AND a.archived_at < @unsaved)
      OR (a.current_status <> 1
          AND EXISTS (SELECT 1 FROM application_apply_records r WHERE r.application_id = a.id)
          AND NOT EXISTS (SELECT 1 FROM application_apply_records r WHERE r.application_id = a.id
                            AND (r.applied_at >= @applied OR (r.answers = 'prepared' AND r.answers_used IS NULL)))))`;

/** application_draft_answers past their windows (11 §8.2). */
export const pruneDraftAnswers: DailyStep = {
  name: 'draftAnswers',
  run: async (deps) => {
    const constants = constantsOf(deps);
    const applied = cutoffOf(deps, constants.get('DRAFT_ANSWERS_KEEP_DAYS_AFTER_APPLY'));
    const unsaved = cutoffOf(deps, constants.get('DRAFT_ANSWERS_KEEP_DAYS_UNSAVED'));
    let after = '';
    let deleted = 0;
    for (;;) {
      const ids = (await deps.db.all<{ id: string }>(DRAFTS_WITH_ANSWERS, [after, DRAFT_BATCH])).map((row) => row.id);
      if (ids.length === 0) return deleted;
      const named = Object.fromEntries(ids.map((id, index) => [`d${index}`, id]));
      const list = ids.map((_, index) => `@d${index}`).join(', ');
      deleted += (await deps.db.run(DUE_DRAFT_ANSWERS(list), { ...named, applied, unsaved })).changes;
      if (ids.length < DRAFT_BATCH) return deleted;
      after = ids[ids.length - 1]!;
    }
  },
};

/** A job closed before the cutoff that no tracker entry names (jobs `j`; idx_app_job). */
const CLOSED_UNTRACKED = `NOT j.active AND j.closed_at < @cutoff
  AND NOT EXISTS (SELECT 1 FROM applications ap WHERE ap.job_id = j.id)`;

/** One page of facts to delete: job ids after `after`, in order (job_facts' primary key, the job's by id). */
const CLOSED_FACTS_PAGE = `SELECT f.job_id FROM job_facts f JOIN jobs j ON j.id = f.job_id
  WHERE f.job_id > @after AND ${CLOSED_UNTRACKED} ORDER BY f.job_id LIMIT @limit`;

/** job_facts* of closed jobs nobody tracks, past JOB_ANALYSIS_CLOSED_KEEP_DAYS. */
export const pruneClosedJobFacts: DailyStep = {
  name: 'closedJobFacts',
  run: async (deps) => {
    const cutoff = cutoffOf(deps, constantsOf(deps).get('JOB_ANALYSIS_CLOSED_KEEP_DAYS'));
    let after = 0;
    let deleted = 0;
    for (;;) {
      const ids = (await deps.db.all<{ job_id: number }>(CLOSED_FACTS_PAGE, { after, cutoff, limit: RETENTION_BATCH })).map(
        (row) => row.job_id,
      );
      if (ids.length === 0) return deleted;
      const list = deps.db.dialect.list(ids.length);
      deleted += await deps.db.tx(
        async (t) => {
          await t.run(`DELETE FROM job_facts_certifications WHERE job_id IN (${list})`, ids);
          await t.run(`DELETE FROM job_facts_eligibility WHERE job_id IN (${list})`, ids);
          return (await t.run(`DELETE FROM job_facts WHERE job_id IN (${list})`, ids)).changes;
        },
        { label: 'pruneClosedJobFacts' },
      );
      if (ids.length < RETENTION_BATCH) return deleted;
      after = ids[ids.length - 1]!;
    }
  },
};

// v3.0.1 FIX-PERF2 (PG-LOAD PGL-22, docs/design/part2/measurements.md §10.3): closedJobAnalyses walked job_analyses
// whole every night (its primary key from the start, each row's heap for created_at, a probe of jobs by hash for every
// row older than the window): when nothing was due, the first page read the table to answer none (461.6 s cold at mix
// B's base size, 6.5 M buffers warm). A pass now looks only where something can have become due since the last one
// (its marks in app_settings, CLOSED_ANALYSES_MARKS):
//   1. the analyses that turned older than the window since the last pass (created_at from its cutoff to this one's:
//      idx_job_analyses_created, migration 0038);
//   2. the analyses of the jobs whose closing turned older than the window since then (closed_at in that span:
//      idx_jobs_closed_at), by their texts;
//   3. ANALYSES_RECHECK_PER_PASS of the older analyses in turn, from where the last pass stopped (the same index): what
//      no time marks (a job whose text changed, an entry taken out of the Tracker, a job deleted) is found within one
//      round of them (the whole of them each pass while they are fewer: a small install deletes as before).
// The rule is the same (an analysis goes when it is older than the window and no open, recently closed or tracked job
// has its text); each statement runs outside a transaction, a page of RETENTION_BATCH at a time.

/** app_settings' key of closedJobAnalyses' marks (CLOSED_ANALYSES_MARKS' value: ClosedAnalysesMarks as JSON). */
export const CLOSED_ANALYSES_MARKS = 'v30:closed-job-analyses';
/** The older analyses one pass looks at again, in turn (step 3 above). */
export const ANALYSES_RECHECK_PER_PASS = 100_000;

/** Where the last pass stopped: its cutoff, and the last older analysis it looked at again (created_at as text, id). */
interface ClosedAnalysesMarks {
  since: string;
  recheck: { at: string; id: number } | null;
}

/** The analysis `a` is still needed: an open job, one closed since the cutoff, or one a tracker entry names has its text. */
const NEEDED = `EXISTS (SELECT 1 FROM jobs j WHERE j.content_hash = a.content_hash
      AND (j.active OR j.closed_at >= CAST(@cutoff AS timestamptz) OR EXISTS (SELECT 1 FROM applications ap WHERE ap.job_id = j.id)))`;

/**
 * A page of analyses older than `@until`, after (`@fromAt`, `@fromId`) in (created_at, id) order: idx_job_analyses_created
 * alone. created_at comes back as PostgreSQL's text (microseconds kept: the next page starts exactly after it).
 */
const ANALYSES_PAGE = `SELECT a.id, CAST(a.created_at AS text) AS at FROM job_analyses a
  WHERE a.created_at >= CAST(@fromAt AS timestamptz) AND a.created_at < CAST(@until AS timestamptz)
    AND (a.created_at, a.id) > (CAST(@fromAt AS timestamptz), CAST(@fromId AS bigint))
  ORDER BY a.created_at, a.id LIMIT @limit`;
/** Of a page's analyses, those no job needs. */
const DELETE_UNNEEDED = `DELETE FROM job_analyses a WHERE a.id = ANY(CAST(@ids AS bigint[])) AND NOT ${NEEDED}`;
/** A page of the jobs closed in [@fromAt, @until), after (`@fromAt`, `@fromId`): idx_jobs_closed_at. */
const CLOSED_JOBS_PAGE = `SELECT j.id, CAST(j.closed_at AS text) AS at, j.content_hash FROM jobs j
  WHERE NOT j.active AND j.closed_at >= CAST(@fromAt AS timestamptz) AND j.closed_at < CAST(@until AS timestamptz)
    AND (j.closed_at, j.id) > (CAST(@fromAt AS timestamptz), CAST(@fromId AS bigint))
  ORDER BY j.closed_at, j.id LIMIT @limit`;
/** The analyses of a page's texts that are older than the window and no job needs. */
const DELETE_UNNEEDED_OF_TEXTS = `DELETE FROM job_analyses a
  WHERE a.content_hash = ANY(CAST(@hashes AS text[])) AND a.created_at < CAST(@cutoff AS timestamptz) AND NOT ${NEEDED}`;

/** The earliest time: a walk from the start. */
const FROM_START = '-infinity';

async function readMarks(deps: Deps): Promise<ClosedAnalysesMarks | null> {
  const row = await deps.db.one<{ value: unknown }>('SELECT value FROM app_settings WHERE key = ?', [CLOSED_ANALYSES_MARKS]);
  try {
    const value = (typeof row?.value === 'string' ? JSON.parse(row.value) : row?.value) as Partial<ClosedAnalysesMarks> | null | undefined;
    if (!value || typeof value.since !== 'string' || Number.isNaN(Date.parse(value.since))) return null;
    const recheck = value.recheck && typeof value.recheck.at === 'string' && Number.isInteger(value.recheck.id) ? value.recheck : null;
    return { since: new Date(value.since).toISOString(), recheck };
  } catch {
    return null;
  }
}

async function writeMarks(deps: Deps, marks: ClosedAnalysesMarks): Promise<void> {
  const at = deps.now().toISOString();
  await deps.db.run(
    `INSERT INTO app_settings(key, value, updated_at) VALUES (?, CAST(? AS json), CAST(? AS timestamptz))
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [CLOSED_ANALYSES_MARKS, JSON.stringify(marks), at],
  );
}

/**
 * Walks the analyses older than `until` after `from`, a page at a time, deleting those no job needs, until `rows` were
 * looked at or none is left. Answers the rows deleted and where it stopped (null: at the end).
 */
async function walkAnalyses(
  deps: Deps,
  from: { at: string; id: number },
  until: string,
  cutoff: string,
  rows: number,
): Promise<{ deleted: number; last: { at: string; id: number } | null }> {
  let deleted = 0;
  let last = from;
  let seen = 0;
  while (seen < rows) {
    const limit = Math.min(RETENTION_BATCH, rows - seen);
    const page = await deps.db.all<{ id: number; at: string }>(ANALYSES_PAGE, { fromAt: last.at, fromId: last.id, until, limit });
    if (page.length === 0) return { deleted, last: null };
    // The jobs and facts naming one (closed, untracked) lose the reference (ON DELETE SET NULL).
    deleted += (await deps.db.run(DELETE_UNNEEDED, { ids: `{${page.map((row) => Number(row.id)).join(',')}}`, cutoff })).changes;
    seen += page.length;
    const end = page[page.length - 1]!;
    last = { at: end.at, id: Number(end.id) };
    if (page.length < limit) return { deleted, last: null };
  }
  return { deleted, last };
}

/** Deletes the unneeded older analyses of the jobs closed in [since, cutoff), a page of jobs at a time. */
async function pruneClosedSince(deps: Deps, since: string, cutoff: string): Promise<number> {
  let deleted = 0;
  let last = { at: since, id: 0 };
  for (;;) {
    const page = await deps.db.all<{ id: number; at: string; content_hash: string }>(CLOSED_JOBS_PAGE, {
      fromAt: last.at,
      fromId: last.id,
      until: cutoff,
      limit: RETENTION_BATCH,
    });
    if (page.length === 0) return deleted;
    const hashes = [...new Set(page.map((row) => row.content_hash))];
    deleted += (await deps.db.run(DELETE_UNNEEDED_OF_TEXTS, { hashes: arrayLiteral(hashes), cutoff })).changes;
    if (page.length < RETENTION_BATCH) return deleted;
    const end = page[page.length - 1]!;
    last = { at: end.at, id: Number(end.id) };
  }
}

/**
 * closedJobAnalyses' pass (see above): the analyses that turned older than the window since the last pass, those of the
 * jobs whose closing did, and `recheckRows` of the older ones in turn. Answers the rows deleted. The first pass of an
 * install takes the day before its cutoff as the last pass's (the older analyses wait for their turn in step 3).
 */
export async function pruneClosedAnalyses(deps: Deps, options: { recheckRows?: number } = {}): Promise<number> {
  const cutoff = cutoffOf(deps, constantsOf(deps).get('JOB_ANALYSIS_CLOSED_KEEP_DAYS'));
  const marks = (await readMarks(deps)) ?? { since: new Date(Date.parse(cutoff) - DAY_MS).toISOString(), recheck: null };
  let deleted = 0;
  if (Date.parse(marks.since) < Date.parse(cutoff)) {
    deleted += (await walkAnalyses(deps, { at: marks.since, id: 0 }, cutoff, cutoff, Number.POSITIVE_INFINITY)).deleted;
    deleted += await pruneClosedSince(deps, marks.since, cutoff);
  }
  const recheck = await walkAnalyses(deps, marks.recheck ?? { at: FROM_START, id: 0 }, cutoff, cutoff, options.recheckRows ?? ANALYSES_RECHECK_PER_PASS);
  deleted += recheck.deleted;
  await writeMarks(deps, { since: cutoff, recheck: recheck.last });
  return deleted;
}

/** job_analyses of texts only closed, untracked jobs have, past JOB_ANALYSIS_CLOSED_KEEP_DAYS. */
export const pruneClosedJobAnalyses: DailyStep = {
  name: 'closedJobAnalyses',
  run: (deps) => pruneClosedAnalyses(deps),
};

/** The account feature's retention steps (v30 DB-JOBS), after v2.0's. */
export const RETENTION_DAILY: readonly DailyStep[] = [pruneViewMarks, pruneDraftAnswers, pruneClosedJobFacts, pruneClosedJobAnalyses];
