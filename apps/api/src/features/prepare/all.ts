import {
  PREPARE_ALL_HELD_MESSAGES,
  UNLIMITED,
  aiUsePercent,
  type PrepareAllHeld,
  type PrepareAllHeldReason,
  type PrepareAllPlan,
  type PrepareAllResponse,
} from '@tailorit/shared';
import { entitlementsOf, resumeLimitError } from '../../core/accounts/index';
import { aiBudgetState } from '../../core/accounts/money';
import { liveGrantById } from '../../core/auth/grants'; // v33 INT-1
import { constantsOf } from '../../core/constants/service';
import type { AppDeps } from '../../core/context';
import { refuse } from '../../core/http/refuse';
import { toPrepareEntries } from '../auto-apply/saved';
import { resumeCount } from '../resumes/counters';
import { keptFromOf, liveQueueJobs, type PrepareServiceImpl, type StartOptions } from './service'; // v33 INT-1: keptFromOf, liveQueueJobs
import { resumeModeOf } from './settings';

// v31 AUTO (decision D10): Prepare All, the Auto-apply page's button beside Filters and Select, and the filters
// dialog's "Filter and Prepare". It prepares every saved job in To prepare (no Prepare yet, filtered, or preparation
// failed; the job still open) that passes the person's saved filters now, newest saved first, within the caps that
// already hold for Prepare & Queue:
//   - one request's batch, PREPARE_BATCH_MAX;
//   - the room left in the auto-apply queue, QUEUE_SIZE_MAX (a job whose finished row is replaced takes none);
//   - in the `tailor` resume mode, the plan's resume storage (one new resume per job, counted conservatively: a kit
//     whose tailored resume still fits makes none).
// The server chooses the jobs. v31 FIX-AUTH (BEH-8): the plan names them (applicationIds) and the confirm sends them
// back; POST takes only those, intersected with what still qualifies now (To prepare, open, passing, within the caps),
// so jobs saved or changed while the confirm was open are never prepared unasked. What it leaves for later is said in words
// (MSG_PREPARE_ALL_HELD_*). When nothing fits at all, it refuses as Prepare & Queue does: 409 MSG_PREPARE_QUEUE_FULL,
// or 403 resume_limit_reached. The taken jobs then go through startPrepare, whose checks still decide (the filters
// again, the AI gate: 429 ai_usage_exhausted, 503 ai_unavailable; the resume room; the queue room). A daily budget
// that runs out while the runner works ends the remaining Prepares failed with its message, as for any Prepare.
//   GET  /api/prepare/all → PrepareAllPlan (the confirm's count and AI budget note; verdicts recorded, nothing starts)
//   POST /api/prepare/all → PrepareAllResponse
// v33 SHARE-5 (PLAN F9; SP v33 PLAN-sharing.md §5, §6): on a profile shared with them, B's Prepare All is B's: the AI
// budget shown and charged is B's (the payer), and the caps keep the owner's last SHARING_QUEUE_RESERVE queue places and
// SHARING_RESUME_RESERVE resume places (B's room there is that much smaller).

/** v33 SHARE-5: who runs Prepare All (StartOptions: the payer and what the answer shows). */
export type PrepareAllOptions = StartOptions;

/** v33 SHARE-5: the owner's places a Prepare All by someone else keeps (0 for the owner's own). */
function reservesOf(deps: AppDeps, userId: string, options: PrepareAllOptions): { queue: number; resumes: number } {
  if (options.payer.id === userId) return { queue: 0, resumes: 0 };
  const constants = constantsOf(deps);
  return { queue: constants.get('SHARING_QUEUE_RESERVE'), resumes: constants.get('SHARING_RESUME_RESERVE') };
}

/** The most To prepare entries one Prepare All reads (newest first): a technical bound, far above any person's list. */
export const PREPARE_ALL_READ_MAX = 5000;

interface Choice {
  toPrepare: number;
  passing: number;
  /** The application ids taken, in the pane's order. */
  taking: string[];
  held?: PrepareAllHeld;
  /** The caps that bound it, for the refusals. */
  queueLimit: number;
  resumes: { limit: number; free: boolean } | null;
  /** v33 SHARE-5: the owner's places kept from someone else's Prepare All. */
  reserves: { queue: number; resumes: number };
}

/**
 * Chooses Prepare All's jobs: the To prepare entries, their fresh verdicts (recorded), then the caps in order.
 * v31 FIX-AUTH (BEH-8) `confirmed`: only these entries are taken (the ones the confirm named). The caps see them first,
 * then the other passing entries (saved while the confirm was open) as if taken, so the counts and what the caps hold
 * for another press are said of the whole list, while no entry the person was not asked about starts.
 */
async function choose(
  deps: AppDeps,
  userId: string,
  confirmed: ReadonlySet<string> | undefined,
  options: PrepareAllOptions, // v33 SHARE-5
): Promise<Choice> {
  const constants = constantsOf(deps);
  const reserves = reservesOf(deps, userId, options);
  const entries = await toPrepareEntries(deps, userId, PREPARE_ALL_READ_MAX);
  // The saved filters' verdicts, computed now (no AI) and recorded, so the Saved pane's labels agree with the count. A
  // job the service has no verdict for passes, as in startPrepare; a pending Custom verdict passes too (the runner's
  // first step judges it, and a fail ends that Prepare `filtered`).
  const filters = deps.services.prepareFilters;
  const checks = new Map(
    (filters && entries.length > 0
      ? await filters.evaluate(userId, entries.map((entry) => entry.applicationId), { record: true })
      : []
    ).map((check) => [check.applicationId, check]),
  );
  const filtered = entries.filter((entry) => {
    const check = checks.get(entry.applicationId);
    return !check || (check.verdict.verdict !== 'fail' && check.custom !== 'fail');
  });
  // v33 INT-1 (SHARE-5's open item): someone the profile is shared with, without Queue changes, never prepares over a
  // finished queue row they did not prepare there (startPrepare skips it `already_queued`): those jobs are not counted
  // or taken, so the plan's count is what starts.
  const keptFrom = options.payer.grantId ? keptFromOf(await liveGrantById(deps, options.payer.grantId), options.payer.id) : null;
  const kept = keptFrom ? await liveQueueJobs(deps, userId, filtered.map((entry) => entry.jobId), keptFrom) : null;
  const passing = kept ? filtered.filter((entry) => !kept.has(entry.jobId)) : filtered;

  const batch = constants.get('PREPARE_BATCH_MAX');
  const queueLimit = constants.get('QUEUE_SIZE_MAX');
  const queued = await deps.db.all<{ job_id: number }>('SELECT job_id FROM autofill_agent_queue WHERE user_id = ?', [userId]);
  const hasRow = new Set(queued.map((row) => row.job_id));
  let queueRoom = queueLimit - reserves.queue - queued.length; // v33 SHARE-5: the owner's last places kept
  let resumes: Choice['resumes'] = null;
  let resumeRoom: number | null = null;
  if ((await resumeModeOf(deps, userId)) === 'tailor') {
    const entitlements = await entitlementsOf(deps, userId);
    if (entitlements.resumes !== null) {
      resumes = { limit: entitlements.resumes, free: entitlements.type === 'free' };
      resumeRoom = Math.max(0, entitlements.resumes - reserves.resumes - (await resumeCount(deps.db, userId))); // v33 SHARE-5
    }
  }

  const named = (entry: { applicationId: string }) => !confirmed || confirmed.has(entry.applicationId);
  const order = confirmed ? [...passing.filter(named), ...passing.filter((entry) => !named(entry))] : passing;
  const taking: string[] = [];
  /** The entries the caps let through: the ones taken, and (v31 FIX-AUTH) the passing ones the confirm did not name. */
  let through = 0;
  let stop: PrepareAllHeldReason | null = null;
  for (const entry of order) {
    if (through >= batch) {
      stop = 'batch';
      break;
    }
    if (resumeRoom !== null && through >= resumeRoom) {
      stop = 'resumes';
      break;
    }
    const takesRoom = !hasRow.has(entry.jobId);
    if (takesRoom && queueRoom <= 0) {
      stop = 'queue';
      break;
    }
    if (takesRoom) queueRoom -= 1;
    through += 1;
    if (named(entry)) taking.push(entry.applicationId);
  }

  const left = passing.length - through;
  const held: PrepareAllHeld | undefined =
    stop && left > 0
      ? {
          count: left,
          reason: stop,
          message: constants.message(PREPARE_ALL_HELD_MESSAGES[stop], {
            count: left,
            max: batch,
            limit: stop === 'queue' ? queueLimit - reserves.queue : Math.max(0, (resumes?.limit ?? 0) - reserves.resumes),
          }),
        }
      : undefined;
  return { toPrepare: entries.length, passing: passing.length, taking, ...(held ? { held } : {}), queueLimit, resumes, reserves };
}

/**
 * GET /api/prepare/all: what Prepare All would take now, with today's AI budget (nothing starts). v32 ADMINAPP (E7): a
 * person sees the day's use as a share only (`ai.percent`); the amounts are sent to an admin alone (`admin`). v33
 * SHARE-5: the budget is the payer's (B's on a profile shared with them; `admin` is the signed-in person's role).
 */
export async function prepareAllPlan(
  deps: AppDeps,
  userId: string,
  options: { admin?: boolean } & PrepareAllOptions,
): Promise<PrepareAllPlan> {
  const choice = await choose(deps, userId, undefined, options);
  const budget = await aiBudgetState(deps, options.payer); // v33 SHARE-5: the payer's budget (v33 INT-C: the Payer, SHARE-3's)
  const budgetMicros = budget.budgetMicros === UNLIMITED ? null : budget.budgetMicros;
  return {
    toPrepare: choice.toPrepare,
    passing: choice.passing,
    taking: choice.taking.length,
    applicationIds: choice.taking, // v31 FIX-AUTH (BEH-8)
    ...(choice.held ? { held: choice.held } : {}),
    ai: {
      ...(options.admin ? { usedMicros: budget.dailySpentMicros, budgetMicros } : {}),
      percent: aiUsePercent(budget.dailySpentMicros, budgetMicros),
      creditMicros: budget.creditMicros,
    },
  };
}

/**
 * POST /api/prepare/all: Prepare & Queue the jobs `choose` takes of `confirmed`, the ones the confirm named (startPrepare,
 * mode `server`). Nothing passing: an empty answer. Passing jobs but no room at all: the cap's refusal for the whole
 * request.
 */
export async function prepareAll(
  deps: AppDeps,
  userId: string,
  service: Pick<PrepareServiceImpl, 'startPrepare'>,
  confirmed: readonly string[],
  options: PrepareAllOptions, // v33 SHARE-5: the payer required (the review's decision 4)
): Promise<PrepareAllResponse> {
  const choice = await choose(deps, userId, new Set(confirmed), options);
  const counts = { toPrepare: choice.toPrepare, passing: choice.passing, ...(choice.held ? { held: choice.held } : {}) };
  if (choice.taking.length === 0) {
    // v33 SHARE-5: on a profile shared with them, the refusal says the owner's last places are kept.
    if (choice.held?.reason === 'queue') {
      throw choice.reserves.queue > 0
        ? refuse(deps, 'conflict', 'MSG_PREPARE_SHARED_QUEUE_FULL', { reserve: choice.reserves.queue })
        : refuse(deps, 'conflict', 'MSG_PREPARE_QUEUE_FULL', { limit: choice.queueLimit });
    }
    if (choice.held?.reason === 'resumes' && choice.resumes) {
      if (choice.reserves.resumes > 0) {
        throw refuse(deps, 'resume_limit_reached', 'MSG_SHARING_RESUME_RESERVE', { reserve: choice.reserves.resumes }); // v33 INT-C: one rule
      }
      throw resumeLimitError(deps, choice.resumes.limit, { free: choice.resumes.free });
    }
    return { results: [], ...counts };
  }
  const answer = await service.startPrepare(userId, { applicationIds: choice.taking, rebuild: false }, 'server', options);
  const outcomes = answer.results.reduce<Record<string, number>>((all, result) => {
    all[result.outcome] = (all[result.outcome] ?? 0) + 1;
    return all;
  }, {});
  deps.log.debug(
    `[prepare] account ${userId} Prepare All: ${choice.toPrepare} to prepare, ${choice.passing} passing, ` +
      `${choice.taking.length} taken${choice.held ? ` (${choice.held.count} held: ${choice.held.reason})` : ''}; ` +
      Object.entries(outcomes)
        .map(([outcome, n]) => `${n} ${outcome}`)
        .join(', '),
  );
  return { ...answer, ...counts };
}
