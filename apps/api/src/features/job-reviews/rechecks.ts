import { constantsOf } from '../../core/constants/service';
import { dayKeyAt } from '../../core/constants/day';
import type { AppDeps } from '../../core/context';
import { recheckPosting, type RecheckPostingResult } from '../../core/seams';
import { runsPaused } from '../ingest/pause-state'; // v31 FIX-LINK (BEH-9)
import { autoDecide } from './auto';
import { runFollowUps, type FollowUp } from './decide';
import { recountReview, reviewById } from './store';

// v30 X1-API: the re-check queue (docs/design/part2/14-extension-reports.md §5.1 step 3, §7): TailorIT's own read of a
// reported posting, where it can read one (recheckPosting: S1-API's seam, one per-posting read under the host's pace
// and today's identity, outside any transaction). A closed report queues its review's check (closed.ts queueCheck); a
// pass takes the queued reviews one at a time, oldest first, while today's reads (job_review_checks of this day key,
// those that made a request) stay under EXT_RECHECKS_PER_DAY, records each answer on the review and in the check
// history, and lets the automatic rules decide (auto.ts): in manual mode the answer is only recorded. A failed read is
// recorded `unreadable`. The worker hook runs a pass every RECHECK_PASS_EVERY_MS (the API process until S1-API's
// worker process exists); a review decided while its read was under way keeps its decision.
// v37 INT-A (SP v37 PLAN W4, CLOSED's open item): a read that has to wait (its host held, every Workday site paused, or
// nothing sent: recheckPosting's `retryAt`) is no answer: nothing is recorded (no check, no budget, no check time moved,
// so no automatic rule decides on it) and the review stays queued; this process asks again after `retryAt`, reading the
// other queued reviews meanwhile.

/** v37 INT-A: the reviews whose read waits, per app (review id -> when to ask again, ms). */
const WAITING = new WeakMap<object, Map<number, number>>();
function waitingOf(deps: object): Map<number, number> {
  let waiting = WAITING.get(deps);
  if (!waiting) {
    waiting = new Map();
    WAITING.set(deps, waiting);
  }
  return waiting;
}

/** How often the worker runs a pass. */
export const RECHECK_PASS_EVERY_MS = 30_000;
/** The most reviews one pass reads (the rest wait for the next pass). */
export const RECHECKS_PER_PASS = 20;

interface QueuedReview {
  id: number;
  job_id: number;
  link_source_id: number | null;
  link_source_job_id: string | null;
}

/** Today's re-checks that made a request (a `not_possible` answer makes none). */
async function readsToday(deps: AppDeps): Promise<number> {
  const row = await deps.db.one<{ n: number }>("SELECT count(*) AS n FROM job_review_checks WHERE day_key = ? AND state <> 'not_possible'", [
    dayKeyAt(deps),
  ]);
  return row?.n ?? 0;
}

/**
 * Re-checks one queued review (see above); answers null when the budget is spent or nothing is queued, `waits` when its
 * read has to wait (v37 INT-A: nothing recorded).
 */
async function checkOne(deps: AppDeps): Promise<'checked' | 'waits' | null> {
  if ((await readsToday(deps)) >= constantsOf(deps).get('EXT_RECHECKS_PER_DAY')) return null;
  const waiting = waitingOf(deps);
  const nowMs = deps.now().getTime();
  for (const [id, until] of waiting) if (until <= nowMs) waiting.delete(id);
  const next = await deps.db.one<QueuedReview>(
    `SELECT id, job_id, link_source_id, link_source_job_id FROM job_reviews WHERE state = 'pending' AND check_state = 'queued'
       AND id NOT IN (SELECT CAST(value AS bigint) FROM ${deps.db.dialect.jsonEach('?')})
     ORDER BY checked_at NULLS FIRST, id LIMIT 1`,
    [JSON.stringify([...waiting.keys()])],
  );
  if (!next) return null;
  const link =
    next.link_source_id !== null && next.link_source_job_id !== null
      ? { sourceId: next.link_source_id, sourceJobId: next.link_source_job_id }
      : undefined;
  let result: RecheckPostingResult;
  try {
    result = await recheckPosting(deps, { jobId: next.job_id, ...(link ? { link } : {}) });
  } catch (error) {
    // Never the error's own text (it can hold the posting's address).
    deps.log.warn('[job-reviews] a re-check failed; recorded as unreadable', error instanceof Error ? error.name : 'unknown');
    result = { state: 'unreadable', checkedAt: deps.now().toISOString(), link: null, sourceMadeDue: false };
  }
  // v37 INT-A (W4): a read that has to wait is asked again after its hold; nothing recorded.
  if (result.retryAt) {
    waiting.set(next.id, Math.max(Date.parse(result.retryAt), nowMs + 1));
    return 'waits';
  }
  const now = deps.now();
  const followUps = await deps.db.tx(
    async (t): Promise<FollowUp[]> => {
      const review = await reviewById(t, next.id, true);
      if (!review) return [];
      await t.run(
        `INSERT INTO job_review_checks(review_id, job_id, state, link_source_id, link_source_job_id, source_made_due, checked_at, day_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          review.id,
          review.job_id,
          result.state,
          result.link?.sourceId ?? null,
          result.link?.sourceJobId ?? null,
          result.sourceMadeDue,
          result.checkedAt,
          dayKeyAt(deps, now),
        ],
      );
      if (review.state !== 'pending' || review.check_state !== 'queued') return [];
      await t.run(
        `UPDATE job_reviews SET check_state = ?, checked_at = ?, link_source_id = COALESCE(link_source_id, ?),
           link_source_job_id = CASE WHEN link_source_id IS NULL THEN ? ELSE link_source_job_id END, updated_at = ? WHERE id = ?`,
        [result.state, result.checkedAt, result.link?.sourceId ?? null, result.link?.sourceJobId ?? null, now.toISOString(), review.id],
      );
      const tally = await recountReview(deps, t, review.id, now);
      return autoDecide(deps, t, review.id, tally, now);
    },
    { label: 'review re-check' },
  );
  await runFollowUps(deps, followUps);
  return 'checked';
}

/**
 * One pass of the re-check queue: at most `max` reviews. Answers how many were checked. v31 FIX-LINK (REV-BEH BEH-9):
 * each re-check reads an outside host, so Pause all stops the pass before the next one (v31 RUNS looked once a pass).
 */
export async function runRecheckPass(deps: AppDeps, max = RECHECKS_PER_PASS): Promise<number> {
  let checked = 0;
  // v37 INT-A: a review whose read waits takes a step too (at most `max` a pass), never a check.
  for (let steps = 0; steps < max && !(await runsPaused(deps)); steps += 1) {
    const done = await checkOne(deps);
    if (done === null) break;
    if (done === 'checked') checked += 1;
  }
  return checked;
}

/** How many pending reviews one sweep of the automatic rules reads (newest reports last, in id order across passes). */
export const AUTO_SWEEP_BATCH = 50;

/**
 * Tries the automatic rules on pending reviews of the kinds whose switch is on, AUTO_SWEEP_BATCH at a time after
 * `afterId` (an account that ages into trust, a switch an admin turned on later, a report window that passed). Answers
 * the last id read (0 to start over) and how many were decided.
 */
export async function runAutoSweep(deps: AppDeps, afterId: number): Promise<{ lastId: number; decided: number }> {
  const constants = constantsOf(deps);
  const kinds: string[] = [];
  if (constants.get('EXT_AUTO_APPROVE_CLOSED')) kinds.push('closed');
  if (constants.get('EXT_AUTO_APPROVE_NEW_ATS')) kinds.push('ats');
  if (constants.get('EXT_AUTO_APPROVE_NEW_PAGE')) kinds.push('page');
  if (kinds.length === 0) return { lastId: 0, decided: 0 };
  const rows = await deps.db.all<{ id: number }>(
    `SELECT id FROM job_reviews WHERE state = 'pending' AND id > ? AND COALESCE(origin, kind) IN (SELECT value FROM ${deps.db.dialect.jsonEach('?')})
     ORDER BY id LIMIT ${AUTO_SWEEP_BATCH}`,
    [afterId, JSON.stringify(kinds)],
  );
  let decided = 0;
  for (const { id } of rows) {
    const now = deps.now();
    const followUps = await deps.db.tx(
      async (t) => {
        const review = await reviewById(t, id, true);
        if (!review || review.state !== 'pending') return { decided: false, followUps: [] as FollowUp[] };
        const tally = await recountReview(deps, t, id, now);
        const made = await autoDecide(deps, t, id, tally, now);
        const after = await reviewById(t, id);
        return { decided: after?.state !== 'pending', followUps: made };
      },
      { label: 'review auto sweep' },
    );
    if (followUps.decided) decided += 1;
    await runFollowUps(deps, followUps.followUps);
  }
  return { lastId: rows.length < AUTO_SWEEP_BATCH ? 0 : rows[rows.length - 1]!.id, decided };
}
