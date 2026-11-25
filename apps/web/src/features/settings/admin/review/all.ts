import {
  AdminFlagsAllCountSchema,
  AdminFlagsAllResultSchema,
  AdminReviewsAllCountSchema,
  AdminReviewsAllResultSchema,
  type AdminFlagsAllBody,
  type AdminFlagsAllResult,
  type AdminFlagsFilter,
  type AdminReviewsAllBody,
  type AdminReviewsAllResult,
  type ReviewStateFilter,
} from '@tailorit/shared/reviews';
import { api } from '@/lib/api';
import { REVIEW_ROUTES } from './api';
import { newJobFilterQuery, type NewJobFilter } from './from';

// v37 REVIEW (SP v37 PLAN.md R3, the owner's "admin currently can't see the whole jobs for review"): "Select all N" on
// every review-queue lane selects every item the lane's filter matches, loaded or not, and its decision runs on the
// server (the reviews' /api/admin/reviews/all on Closed links and New jobs, /api/admin/flags/all on Flags): a count
// first (the confirm's "Approve 340 jobs?", with `upTo`, what was counted), then requests continued with `after` while
// the answer is not `done` (each works for at most ADMIN_BULK_ALL_SECONDS), summed into one result line. Pure but for
// the requests, so the web tests read it without a page. (Couldn't verify keeps LINK's "all", review/unverified.ts.)

/** A review-queue lane whose items "Select all N" can take. */
export type AllLane = 'closed' | 'new_job' | 'flags';
/** A decision on every selected item: the reviews' Approve and Reject, the flags' Resolve and Dismiss. */
export type AllAction = 'approve' | 'reject' | 'resolved' | 'dismissed';

/** What "all" decides: a reviews lane and its filter, or the Flags lane and its filter. */
export type AllScope = { lane: 'closed' | 'new_job'; filter: AdminReviewsAllBody['filter'] } | { lane: 'flags'; filter: AdminFlagsFilter };

/** The filter "all" reads for a lane: its state filter and search, and New jobs' From filter. */
export function allScopeOf(lane: AllLane, state: ReviewStateFilter, q: string, newJobs: NewJobFilter): AllScope {
  const text = q.trim();
  const search = text ? { q: text } : {};
  if (lane === 'flags') return { lane, filter: { state: state === 'checking' ? 'waiting' : state, ...search } };
  return { lane, filter: { lane, state, ...search, ...(lane === 'new_job' ? newJobFilterQuery(newJobs) : {}) } };
}

/** The count of what "all" would decide now, and `upTo` (opaque), which its requests send back. */
export interface AllCount {
  pending: number;
  upTo: string;
}

/** GET …/all/count: the items the scope's filter matches that a decision can take. */
export function fetchAllCount(scope: AllScope, signal?: AbortSignal): Promise<AllCount> {
  if (scope.lane === 'flags') return api.get<AllCount>(REVIEW_ROUTES.flagsAllCount, { signal, query: { ...scope.filter }, schema: AdminFlagsAllCountSchema });
  return api.get<AllCount>(REVIEW_ROUTES.reviewsAllCount, { signal, query: { ...scope.filter }, schema: AdminReviewsAllCountSchema });
}

/** One "all" answer, whatever the lane: each outcome's count, the first failures, whether it is done, where it stopped. */
export interface AllAnswer {
  counts: Partial<Record<string, number>>;
  failures: Array<{ id: number; message: string }>;
  done: boolean;
  after: number;
}

/** POST …/all: one request (`after`: go on past the last answer's rows; `upTo`: the count's; `note`: the reviews'). */
export async function sendAll(scope: AllScope, action: AllAction, options: { after?: number; upTo?: string; note?: string }): Promise<AllAnswer> {
  const more = { ...(options.after !== undefined ? { after: options.after } : {}), ...(options.upTo ? { upTo: options.upTo } : {}) };
  if (scope.lane === 'flags') {
    const status = action === 'resolved' || action === 'dismissed' ? action : 'resolved';
    const body: AdminFlagsAllBody = { status, filter: scope.filter, ...more };
    return api.post<AdminFlagsAllResult>(REVIEW_ROUTES.flagsAll, body, { schema: AdminFlagsAllResultSchema });
  }
  const decision = action === 'reject' ? 'reject' : 'approve';
  const body: AdminReviewsAllBody = { decision, filter: scope.filter, ...more, ...(options.note ? { note: options.note } : {}) };
  return api.post<AdminReviewsAllResult>(REVIEW_ROUTES.reviewsAll, body, { schema: AdminReviewsAllResultSchema });
}

/**
 * Every request's answer added up: the counts, the first failures (20), and whether it finished. v37 FIX-REV (L6):
 * `stopped`, the admin stopped it after a turn (the rest still wait).
 */
export interface AllOutcome {
  action: AllAction;
  counts: Partial<Record<string, number>>;
  failures: Array<{ id: number; message: string }>;
  done: boolean;
  stopped?: boolean;
}

/**
 * The requests of one "all": `send(after)` again with the last answer's `after` while it is not `done` (up to
 * `maxTurns`; an answer that took nothing new ends it too); `onTurn` hears the running total. v37 FIX-REV
 * (REVIEW361-ux L6): `stop()` true after a turn ends it there (the turn under way always finishes on the server).
 */
export async function runAllTurns(
  action: AllAction,
  send: (after: number | undefined) => Promise<AllAnswer>,
  onTurn: (sofar: AllOutcome) => void = () => undefined,
  maxTurns = 200,
  stop: () => boolean = () => false,
): Promise<AllOutcome> {
  const total: AllOutcome = { action, counts: {}, failures: [], done: false };
  let after: number | undefined;
  for (let turn = 0; turn < maxTurns; turn += 1) {
    const answer = await send(after);
    for (const [outcome, count] of Object.entries(answer.counts)) {
      if (count) total.counts[outcome] = (total.counts[outcome] ?? 0) + count;
    }
    total.failures = [...total.failures, ...answer.failures].slice(0, 20);
    total.done = answer.done;
    onTurn({ ...total, counts: { ...total.counts } });
    if (answer.done || answer.after === after) break;
    if (stop()) {
      total.stopped = true;
      break;
    }
    after = answer.after;
  }
  return total;
}

// The words ----------------------------------------------------------------------------------------------------------

const THINGS: Record<AllLane, [one: string, many: string]> = {
  closed: ['closed link', 'closed links'],
  new_job: ['job', 'jobs'],
  flags: ['flag', 'flags'],
};
const VERB: Record<AllAction, [ask: string, did: string]> = {
  approve: ['Approve', 'Approved'],
  reject: ['Reject', 'Rejected'],
  resolved: ['Resolve', 'Resolved'],
  dismissed: ['Dismiss', 'Dismissed'],
};
/** The outcome each action counts as done. */
const DONE_OUTCOME: Record<AllAction, string> = { approve: 'approved', reject: 'rejected', resolved: 'resolved', dismissed: 'dismissed' };

/** "1,240 jobs", "1 closed link". */
export function thingsText(lane: AllLane, count: number): string {
  const [one, many] = THINGS[lane];
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
}

/** "Select all 340": the select-all button's words (every item the lane's filter matches), and its "Deselect all". */
export function selectAllWords(count: number): { select: string; deselect: string } {
  return { select: `Select all ${count.toLocaleString('en-US')}`, deselect: 'Deselect all' };
}

/**
 * The select-all button's tip: what it takes. v37 FIX-REV (REVIEW361-ux L4): Couldn't verify has no search, only its From
 * filter.
 */
export function selectAllTip(lane: AllLane | 'unverified'): string {
  if (lane === 'unverified') return 'Every link the From filter matches, loaded or not';
  const things = lane === 'new_job' ? 'new job' : lane === 'closed' ? 'closed link' : 'open flag';
  return `Every ${things} the filter and search match, loaded or not`;
}

/**
 * v37 FIX-REV (REVIEW361-ux L5): the bar's words once a row is unticked under "Select all N": the selection is the rows
 * loaded so far now, not every row the filter matches.
 */
export const LOADED_ROWS_NOTE = 'the rows loaded so far';

/**
 * "Approved 1,240 jobs; 3 skipped, 1 failed." (one result line). v37 FIX-REV (REVIEW361-ux L6): "Stopped: approved 120
 * jobs; the rest still wait." when the admin stopped it.
 */
export function allLine(lane: AllLane, outcome: Pick<AllOutcome, 'action' | 'counts' | 'done'> & Partial<Pick<AllOutcome, 'stopped'>>): string {
  const decided = outcome.counts[DONE_OUTCOME[outcome.action]] ?? 0;
  const verb = VERB[outcome.action][1];
  const head = outcome.stopped ? `Stopped: ${verb.toLowerCase()} ${thingsText(lane, decided)}` : `${verb} ${thingsText(lane, decided)}`;
  const rest = [
    outcome.counts.skipped ? `${outcome.counts.skipped.toLocaleString('en-US')} skipped` : '',
    outcome.counts.failed ? `${outcome.counts.failed.toLocaleString('en-US')} failed` : '',
    outcome.done ? '' : outcome.stopped ? 'the rest still wait' : 'more are left: run it again',
  ]
    .filter(Boolean)
    .join(', ');
  return rest ? `${head}; ${rest}.` : `${head}.`;
}

/** "Approved 120 so far...": the confirm's progress line. */
export function allProgressText(outcome: Pick<AllOutcome, 'action' | 'counts'>): string {
  const decided = outcome.counts[DONE_OUTCOME[outcome.action]] ?? 0;
  return `${VERB[outcome.action][1]} ${decided.toLocaleString('en-US')} so far...`;
}

/** What each decision does, in a sentence, by lane. */
const WHAT: Record<AllLane, Partial<Record<AllAction, string>>> = {
  closed: {
    approve: 'Each job closes, as if TailorIT\'s own read found its link gone.',
    reject: 'The jobs stay open; the reports are kept as rejected.',
  },
  new_job: {
    approve: 'Each is published for everyone to find.',
    reject: 'None of them is published; their links are remembered as rejected.',
  },
  // v37 FIX-REV (REVIEW361-ux L8): what each decision does, before it does it; the job is never touched.
  flags: { resolved: 'Each flag is marked resolved; its job is not changed.', dismissed: 'Each flag is marked dismissed; its job is not changed.' },
};

/**
 * The confirm of a decision on every selected item: "Approve 340 jobs?" with the server's count (null while it is
 * read), what the decision does, and its button.
 */
export function allConfirmText(lane: AllLane, action: AllAction, count: number | null): { title: string; description: string; confirm: string } {
  const verb = VERB[action][0];
  const [one, many] = THINGS[lane];
  if (count === null) return { title: `${verb} every ${one} selected?`, description: `Counting the ${many}...`, confirm: verb };
  if (count === 0) return { title: `${verb} ${thingsText(lane, 0)}?`, description: `Nothing to decide: no ${one} matches now.`, confirm: verb };
  return {
    title: `${verb} ${thingsText(lane, count)}?`,
    description: `${WHAT[lane][action] ?? ''} TailorIT works through them in turns and says when it is done.`.trim(),
    confirm: `${verb} ${thingsText(lane, count)}`,
  };
}
