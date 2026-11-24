import {
  AUTOFILL_AI_LIMITS,
  AutofillAnswerResultSchema,
  cutAtWord,
  TailorResultSchema,
  type AutofillAnswer,
  type AutofillAnswerRequest,
  type AutofillKnownQuestion,
  type AutofillSubmittedAnswerValue,
} from '@tailorit/shared/autofill';
import { isActivePrepareState, PREPARE_ANSWER_BATCH, HOUR_MS, UNLIMITED, type AiTaskView } from '@tailorit/shared';
import { liveTasksOfPrepare, PAYER_LIMIT_CODES } from '../../ai/queue'; // v33 INT-C: PAYER_LIMIT_CODES
import { hourlyLimitOf } from '../../core/accounts/entitlements';
import { payerOfRow, type PersonPayer } from '../../core/accounts/payer'; // v33 SHARE-5
import { assertGrantLive, grantHolds, liveGrantsByIds } from '../../core/auth/grants'; // v33 SHARE-5
import { constantsOf } from '../../core/constants/service';
import { nowIso, type AppDeps } from '../../core/context';
import { AppError } from '../../core/http/errors';
import { tailorOptionsFor } from './charge'; // v33 SHARE-5
import { answerTaskInput } from '../autofill/ai/answer';
import { autofillAnswerTask } from '../autofill/ai-tasks';
import { greenhousePostingOf, greenhouseReadsOf, readGreenhouseQuestionsLater } from '../autofill/forms/greenhouse';
import { formPlace } from '../autofill/forms/store';
import { applicationFacts } from '../cover-letters/context';
import { templateHasContent, unfilledVariables, type GenerateTaskInput } from '../cover-letters/generate';
import { letterProfile } from '../cover-letters/context';
import { createLetterRepository } from '../cover-letters/repository';
import { coverLetterTask, templateFillTask } from '../cover-letters/tasks';
import { getResumeEvidence } from '../resumes/evidence';
import { tailoredTitle } from '../tailor/output';
import { chooseTemplates } from '../tailor/source';
import { chooseResume } from './chosen-resume';
import {
  analysisNeeded,
  currentTarget,
  decideLetter,
  filterReasonOf,
  finishKit,
  kitLetterFits,
  knownQuestions,
  linkToApplication,
  restoreDraft,
  valueScreen,
  type DraftTarget,
} from './kit';
import { draftValueOf, planQuestions, type PlannedQuestion } from './questions';
import { notifyPrepareBatch } from '../notifications/emitters'; // v31 NOTIFY
import {
  answerRows,
  draftOf,
  isGranteeRow, // v33 SHARE-5
  prepareById,
  serverActiveRows,
  serverStartsSince,
  startedByOf, // v33 SHARE-5
  updateDraft,
  updatePrepare,
  waitingServerRows,
  writeAnswers,
  type DraftChanges,
  type DraftRow,
  type PrepareRow,
} from './store';

// v33 SHARE-5 (PLAN F9 "Prepare and the queue"; SP v33 PLAN-sharing.md §5, §6): Prepares on a shared profile. A Prepare
// names who started it (started_by: its payer) and the grant it runs under (grant_id), and the runner keeps it fair:
//   - one Prepare at a time per profile AND per payer (two in-flight sets; RUNNER_PARALLEL at most): B working on five
//     profiles runs one Prepare at a time, as on their own;
//   - within a profile, the owner's own rows first, then the payer that started a Prepare least recently (runnerOrder);
//   - a row someone else started that meets ai_busy (its payer's two tasks of a kind in flight) is parked for
//     BUSY_RETRY_MS, which frees both its slots; the pass takes it up again from its step;
//   - at every step's boundary, next to leftSaved, and before every AI request, its grant is read again
//     (assertGrantLive: `prepare:run`): a share that ended, lost the permission or whose account was disabled ends the
//     Prepare `cancelled`, `access_ended`, and no AI work it would have paid for starts;
//   - its AI steps are charged to its payer (chargeTo: payerOfRow), paced by the payer's Prepares an hour (hourWait(started_by)),
//     and a refusal of the payer's (their budget, their plan) is stored as `payer_limit` in neutral words; its own words
//     go to payer_error, which only the payer reads (kit.ts prepareErrorFor; the SHARE-5 review's decision 7).

/** The order the runner takes one profile's waiting Prepares in, and the profiles in (a pure choice). */
export interface RunnerCandidate {
  id: string;
  user_id: string;
  started_by?: string;
  state: PrepareRow['state'];
  created_at: string;
}

/**
 * The candidates of each profile in the order the runner takes them, and the profiles in the order they are looked at
 * (by their first candidate's place in `rows`, which serverActiveRows orders: rows under way first, then oldest). Within
 * a profile: rows under way first (a restart takes them up again), then the owner's own rows, then the rows of the payer
 * whose last start is the oldest (`lastStart`: when each payer last had a Prepare taken up; never first), each payer's
 * oldest first.
 */
export function runnerOrder<R extends RunnerCandidate>(rows: readonly R[], lastStart: (payerId: string) => number | undefined): R[][] {
  const byProfile = new Map<string, R[]>();
  for (const row of rows) {
    const list = byProfile.get(row.user_id) ?? [];
    list.push(row);
    byProfile.set(row.user_id, list);
  }
  const rank = (row: R) => {
    if (row.state !== 'waiting') return [0, 0] as const;
    if (startedByOf(row) === row.user_id) return [1, 0] as const;
    return [2, lastStart(startedByOf(row)) ?? -Infinity] as const;
  };
  return [...byProfile.values()].map((list) =>
    list
      .map((row, index) => ({ row, index, rank: rank(row) }))
      .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.index - b.index)
      .map(({ row }) => row),
  );
}

/** Why a step stopped short (thrown through the step's own catches to prepareOne). */
class RunnerSignal extends Error {
  constructor(readonly signal: 'parked' | 'ended') {
    super(signal);
  }
}

/** Rethrows a RunnerSignal (a step's own catch must never turn one into a failure). */
function passSignal(error: unknown): void {
  if (error instanceof RunnerSignal) throw error;
}

/**
 * The refusals that are the payer's own (their budget, their hourly limits, their plan): a grantee row stores
 * `payer_limit`. v33 INT-C: the AI queue's own list (SHARE-3's PAYER_LIMIT_CODES), so a Prepare and a task read alike.
 */
const PAYER_REFUSALS: ReadonlySet<string> = PAYER_LIMIT_CODES;

/** The permissions a Prepare's work needs under its grant (the runner runs `server` Prepares only). */
const RUN_PERMS = 'prepare:run' as const;
// end v33 SHARE-5

// The server path of Prepare (docs/design/v2.0/05-prepare-flow.md, "The runner"): TailorIT's AI prepares
// each `server` Prepare, one at a time per account (accounts side by side, oldest row first, RUNNER_PARALLEL at
// most), paced by the plan's Prepares an hour (FREE_/PAID_PREPARE_PER_HOUR, v32 FIX-PLAN: Paid's unlimited by default;
// Prepares started per account in the last hour, from prepare_jobs.started_at: it waits, it refuses nothing). For one
// Prepare:
//   a. `filtering`: the Custom filter, when it is on and the job has no fresh verdict: a batch of the account's waiting
//      jobs (CUSTOM_FILTER_BATCH) judged in one `custom_filter` task (P4's judgeOnServer, charged). A fail: `filtered`.
//   b. `analyzing`: the job read again by the AI when its analysis is older than the current version (A7: charged to
//      the person, `chargeTo`); then the filters again on the fresh facts. A fail: `filtered`.
//   c. `building`: the letter decision (A6), from the job's facts and its known questions (a shared Greenhouse job's
//      read from its board first when TailorIT knows none).
//   d. the resume, by the person's resume mode fixed on the Prepare (A29): `tailor` v1.4's tailoring (its letter
//      beside it); `default` / `similar` the resume chosen as it is (no AI), and the letter written from it with the
//      editor's letter generation. Either way the letter is written from the kit's resume.
//   e. the answers to the job's known questions, from the kit's resume (the answer task's facts read it), in batches
//      of PREPARE_ANSWER_BATCH; none known: not ready (made during the application).
//   f. the finishing rule (kit.ts finishKit): queued through insertPreparedRow, or failed, or prepared (queue full).
// An entry that leaves Saved meanwhile ends the Prepare `cancelled` (not_saved) at the next step's boundary, or at f.
// Every AI step goes through the AI queue (enqueue), which checks the person's budget; a refusal fails the Prepare with
// its message, the parts already made staying in the kit. A Prepare cancelled meanwhile (cancel ends it at once) is
// left as the cancel left it. After a restart the Prepares under way are taken up again from their step.
// v3.0 D2-F: on the async client; each AI step queues through its task's definition (enqueueOptions), as the kinds'
// own callers do.

/** How long a task the runner started may take before it gives up on it (it waits for the background slot). */
const TASK_WAIT_MS = 6 * HOUR_MS;
/** How long the runner waits before asking again when the account's two tasks of a kind are already in flight. */
const BUSY_RETRY_MS = 5_000;
const BUSY_RETRIES = 120;
/** The longest one wait for the hour lasts: the runner looks at the clock again at least this often. */
const MAX_SLEEP_MS = 60_000;
/** Accounts whose Prepares are under way at once (each account one at a time). Technical: the AI queue paces the CLI. */
export const RUNNER_PARALLEL = 3;
const LIMITS = AUTOFILL_AI_LIMITS.answer;
/** The AI refusals that end a Prepare with their own message (03-ai-usage.md). */
const REFUSALS: ReadonlySet<string> = new Set(['ai_unavailable', 'ai_usage_exhausted', 'resume_limit_reached']);

/** The letter a letter-writing task writes into (its input's `letterId`), or null. */
function letterIdOf(input: unknown): string | null {
  const id = typeof input === 'object' && input !== null ? (input as { letterId?: unknown }).letterId : null;
  return typeof id === 'string' && id ? id : null;
}

/** The question keys an `autofill_answer` task asks about (its input's items). */
function itemKeysOf(input: unknown): string[] {
  const items = typeof input === 'object' && input !== null ? (input as { items?: unknown }).items : null;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item: unknown) => {
    const key = typeof item === 'object' && item !== null ? (item as { key?: unknown }).key : null;
    return typeof key === 'string' ? [key] : [];
  });
}

/** A set of question keys as one comparable string. */
const sameKeys = (keys: readonly string[]) => JSON.stringify([...keys].sort());

export interface PrepareRunner {
  /** Looks for work now (after a start, a cancel, or a constant change). */
  kick(): void;
  /** Cancels the AI task the Prepare is waiting for, when it is the person's own (its cost so far is charged). */
  abort(prepareId: string): void;
  /** Takes up the server Prepares a previous process left; answers the stop. */
  start(): () => void;
  /** Resolves once nothing is under way (tests). */
  idle(): Promise<void>;
}

/** What one step came to: done, the Prepare ended (filtered, failed), or the server is stopping. */
type Step = 'go' | 'ended';

export function createPrepareRunner(deps: AppDeps): PrepareRunner {
  const { db } = deps;
  /** The Prepare under way of each profile (v33 SHARE-5: and, below, of each payer), by profile. */
  const inFlight = new Map<string, Promise<void>>();
  /** v33 SHARE-5: the payers (started_by) with a Prepare under way: one at a time per person, on every profile. */
  const payersInFlight = new Set<string>();
  /** v33 SHARE-5: when each payer last had a Prepare taken up (ms; the fairness between payers on one profile). */
  const lastStart = new Map<string, number>();
  /** v33 SHARE-5: grantee rows parked on ai_busy, and their payers, until (ms, the process clock). */
  const parkedRows = new Map<string, number>();
  const parkedPayers = new Map<string, number>();
  /** The person's own AI task each Prepare waits for (abort cancels it). */
  const waitingOn = new Map<string, { taskId: string; userId: string }>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopping = false;

  const now = () => nowIso(deps);
  const constants = () => constantsOf(deps);
  const priority = () => (deps.config.ai.backgroundSlots > 0 ? 'background' : 'interactive');
  const message = (key: Parameters<ReturnType<typeof constantsOf>['message']>[0]) => constants().message(key);
  const messageOf = (error: unknown) =>
    error instanceof AppError
      ? error.code === 'needs_editable_copy'
        ? message('MSG_PREPARE_NEEDS_COPY')
        : error.message
      : message('MSG_PREPARE_FAILED');
  /** A failed task's words: a refusal's own, else `fallback`. */
  const taskError = (view: AiTaskView, fallback: string) =>
    view.error && REFUSALS.has(view.error.code) ? view.error.message : fallback;

  // v33 SHARE-5: a refusal that is the payer's own (their budget, their limits) on a Prepare someone the profile is
  // shared with started is stored as `payer_limit` in neutral words (the owner sees the row and its kit too); the
  // refusal's own words are kept for the payer alone (payer_error: the review's decision 7).
  /** Whether `code` is a refusal of the payer's own on this row (marks it `payer_limit`, keeping `words` for the payer). */
  async function payerLimited(row: PrepareRow, code: string | undefined, words: string): Promise<boolean> {
    if (!code || !isGranteeRow(row) || !PAYER_REFUSALS.has(code)) return false;
    await updatePrepare(db, row.id, { reason_code: 'payer_limit', payer_error: words }, now());
    return true;
  }
  /** messageOf for a row (a payer's own refusal in neutral words). */
  const rowMessageOf = async (row: PrepareRow, error: unknown) =>
    (await payerLimited(row, error instanceof AppError ? error.code : undefined, messageOf(error))) ? message('MSG_PREPARE_PAYER_LIMIT') : messageOf(error);
  /** taskError for a row (a payer's own refusal in neutral words). */
  const rowTaskError = async (row: PrepareRow, view: AiTaskView, fallback: string) =>
    (await payerLimited(row, view.error?.code, view.error?.message ?? fallback)) ? message('MSG_PREPARE_PAYER_LIMIT') : taskError(view, fallback);

  /**
   * How long until the payer may start another Prepare (0: now), by the plan's Prepares an hour at this moment (v32
   * FIX-PLAN, E12: FREE_/PAID_PREPARE_PER_HOUR; a Paid term that ended is paced as Free). UNLIMITED: never waits. v33
   * SHARE-5: the payer's (started_by: B's plan and B's starts on every profile, counted once per person).
   */
  async function hourWait(payer: PersonPayer): Promise<number> {
    const max = await hourlyLimitOf(deps, payer, 'preparesPerHour'); // v33 INT-1: the Payer
    if (max === UNLIMITED) return 0;
    const nowMs = deps.now().getTime();
    const { n, first } = await serverStartsSince(db, payer.id, new Date(nowMs - HOUR_MS).toISOString());
    if (n < max) return 0;
    return Math.max(1000, (first ? Date.parse(first) : nowMs) + HOUR_MS - nowMs);
  }

  /**
   * v33 SHARE-5: a Prepare someone the profile is shared with started whose share no longer lets them prepare (it ended,
   * lost `prepare:run`, an account was disabled, sharing was turned off) ends `cancelled`, `access_ended`: true then.
   * The owner's own Prepares never end so.
   */
  async function accessEnded(row: PrepareRow): Promise<boolean> {
    if (!isGranteeRow(row)) return false;
    try {
      await assertGrantLive(deps, row.grant_id, RUN_PERMS);
      return false;
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      await end(row, 'cancelled', { reason: 'access_ended' });
      return true;
    }
  }

  /** v33 SHARE-5: before an AI request: the Prepare is still active and still allowed (else RunnerSignal 'ended'). */
  async function stillAllowed(row: PrepareRow): Promise<void> {
    const fresh = await stillActive(row.id);
    if (!fresh || (await accessEnded(fresh))) throw new RunnerSignal('ended');
  }

  /** v33 SHARE-5: who pays for the row's AI (payerOfRow: B under the grant; a row that lost its grant: access ended). */
  async function payerFor(row: PrepareRow): Promise<PersonPayer | null> {
    try {
      return payerOfRow(row, RUN_PERMS);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      await end(row, 'cancelled', { reason: 'access_ended' });
      return null;
    }
  }

  // -------------------------------------------------------------------------------------------------- scheduling

  /** The pass under way (one at a time: a pass reads the rows, then starts what it may), and whether to look again. */
  let pumping: Promise<void> | null = null;
  let pumpAgain = false;

  /** Looks for work: a pass now, or one more right after the pass under way. */
  function pump(): void {
    // v34 DIRKIT: never in a maintenance command's process (AppDeps.commandProcess): the running API's runner does it.
    if (deps.commandProcess) return;
    if (pumping) {
      pumpAgain = true;
      return;
    }
    pumping = pass()
      .catch((error: unknown) => deps.log.error('[prepare] the runner could not look for work', error))
      .finally(() => {
        pumping = null;
        if (pumpAgain) {
          pumpAgain = false;
          pump();
        }
      });
  }

  async function pass(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    if (stopping) return;
    let wakeIn: number | null = null;
    const wake = (ms: number) => {
      wakeIn = Math.min(wakeIn ?? ms, ms);
    };
    // v33 SHARE-5: one Prepare at a time per profile AND per payer; within a profile the owner's rows first, then the
    // payer that started least recently (runnerOrder); `looked` per (profile, payer): a payer's first row only.
    const looked = new Set<string>();
    const rows = await serverActiveRows(db);
    const grants = await liveGrantsByIds(deps, rows.filter(isGranteeRow).map((row) => row.grant_id));
    const clock = Date.now();
    for (const [id, until] of parkedRows) if (until <= clock) parkedRows.delete(id);
    for (const [id, until] of parkedPayers) if (until <= clock) parkedPayers.delete(id);
    for (const list of runnerOrder(rows, (payerId) => lastStart.get(payerId))) {
      if (inFlight.size >= RUNNER_PARALLEL) break;
      for (const row of list) {
        if (inFlight.has(row.user_id)) break;
        const payerId = startedByOf(row);
        const pair = `${row.user_id}>${payerId}`;
        if (payersInFlight.has(payerId) || looked.has(pair)) continue;
        looked.add(pair);
        // A share that no longer lets them prepare ends their Prepare before it takes anything up.
        if (isGranteeRow(row)) {
          const grant = grants.get(row.grant_id ?? '');
          if (!grant || !grantHolds(grant, RUN_PERMS)) {
            await end(row, 'cancelled', { reason: 'access_ended' });
            continue;
          }
        }
        const parked = Math.max(parkedRows.get(row.id) ?? 0, parkedPayers.get(payerId) ?? 0);
        if (parked > clock) {
          wake(parked - clock);
          continue;
        }
        if (row.state === 'waiting') {
          // v33 INT-1: the row's Payer (payerFor ends a row that lost its grant, as prepareOne would).
          const payer = await payerFor(row);
          if (!payer) continue;
          const wait = await hourWait(payer);
          if (wait > 0) {
            wake(wait);
            continue;
          }
        }
        lastStart.set(payerId, clock);
        payersInFlight.add(payerId);
        const running: Promise<void> = prepareOne(row)
          .catch((error: unknown) => {
            if (!(error instanceof RunnerSignal)) return failUnexpectedly(row, error);
            if (error.signal === 'parked') park(row);
          })
          .finally(() => {
            inFlight.delete(row.user_id);
            payersInFlight.delete(payerId);
            pump();
          });
        inFlight.set(row.user_id, running);
        break;
      }
    }
    if (wakeIn !== null) {
      timer = setTimeout(pump, Math.min(wakeIn, MAX_SLEEP_MS));
      timer.unref?.();
    }
  }

  /**
   * v33 SHARE-5: a grantee row met ai_busy (its payer's two tasks of a kind in flight): it waits BUSY_RETRY_MS out of the
   * runner (its profile's and its payer's slots free meanwhile), then the pass takes it up again from its step.
   */
  function park(row: PrepareRow): void {
    const until = Date.now() + BUSY_RETRY_MS;
    parkedRows.set(row.id, until);
    parkedPayers.set(startedByOf(row), until);
    deps.log.debug(`[prepare] Prepare ${row.id} waits for its payer's AI (parked ${BUSY_RETRY_MS} ms)`);
  }

  async function failUnexpectedly(row: PrepareRow, error: unknown): Promise<void> {
    deps.log.error(`[prepare] Prepare ${row.id} stopped on an error`, error);
    try {
      await db.tx(async () => {
        const fresh = await prepareById(db, row.id);
        if (!fresh || !isActivePrepareState(fresh.state)) return;
        await updatePrepare(db, row.id, { state: 'failed', error: message('MSG_PREPARE_FAILED'), finished_at: now() }, now());
        const draft = await draftOf(db, row.user_id, row.application_id);
        if (draft?.prepare_id === row.id) await restoreDraft(deps, draft, now());
      });
    } catch {
      /* the database is closed (shutdown) */
    }
  }

  // ------------------------------------------------------------------------------------------------- waiting on AI

  /** A task's finished view, or null when the server stops first (or it never finished in time: `late`). */
  async function finished(taskId: string): Promise<AiTaskView | 'late' | null> {
    try {
      const view = await deps.services.ai!.waitFor(taskId, TASK_WAIT_MS);
      return stopping ? null : view;
    } catch {
      return stopping ? null : 'late';
    }
  }

  /** Waits for the person's own task, which `abort` may cancel. */
  async function ownTask(prepareId: string, userId: string, taskId: string): Promise<AiTaskView | 'late' | null> {
    waitingOn.set(prepareId, { taskId, userId });
    try {
      return await finished(taskId);
    } finally {
      waitingOn.delete(prepareId);
    }
  }

  /**
   * Runs `start`, asking again while the account's two tasks of the kind are in flight (ai_busy). v33 SHARE-5: before
   * every request the Prepare must still be active and allowed (stillAllowed: RunnerSignal 'ended'), so no AI work a
   * share no longer allows starts; a grantee row's ai_busy parks it (RunnerSignal 'parked') instead of holding its slots.
   */
  async function whenFree<T>(row: PrepareRow, start: () => T): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      await stillAllowed(row);
      try {
        // v3.0 D2: awaited, so an async start's ai_busy is caught here too.
        return await start();
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'ai_busy' || stopping) throw error;
        if (isGranteeRow(row)) throw new RunnerSignal('parked');
        if (attempt >= BUSY_RETRIES) throw error;
        await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS).unref?.());
      }
    }
  }

  // ---------------------------------------------------------------------------------------------------- the steps

  /** The row while it is still active; null once it ended (a cancel ends it at once). */
  async function stillActive(id: string): Promise<PrepareRow | null> {
    const row = await prepareById(db, id);
    return row && isActivePrepareState(row.state) ? row : null;
  }

  /** Ends the Prepare in a transaction, its kit's open parts going back, unless a cancel ended it first. */
  async function end(row: PrepareRow, state: 'filtered' | 'failed' | 'cancelled', details: { error?: string; reason?: string }): Promise<void> {
    await db.tx(async () => {
      if (!await stillActive(row.id)) return;
      await updatePrepare(
        db,
        row.id,
        { state, finished_at: now(), ...(details.error ? { error: details.error } : {}), ...(details.reason ? { reason_code: details.reason } : {}) },
        now(),
      );
      const draft = await draftOf(db, row.user_id, row.application_id);
      if (draft?.prepare_id === row.id) await restoreDraft(deps, draft, now());
      await notifyPrepareBatch(deps, row); // v31 NOTIFY: the batch's summary when this was its last active Prepare
    });
    deps.log.debug(`[prepare] Prepare ${row.id} ${state}${details.reason ? ` (${details.reason})` : ''}`);
  }

  /**
   * v2.0 FIX-B (BEH-3): at each step's boundary, a Prepare whose entry left Saved meanwhile (Applied, archived, its job
   * gone) ends `cancelled` (not_saved), so no more AI is spent on it; step f's finishKit checks again. True then.
   */
  async function leftSaved(row: PrepareRow): Promise<boolean> {
    if (await currentTarget(deps, row.user_id, row.application_id)) return false;
    await end(row, 'cancelled', { reason: 'not_saved' });
    return true;
  }

  /** v33 SHARE-5: a step's boundary: the entry left Saved, or the share no longer lets its starter prepare. */
  const stopsHere = async (row: PrepareRow) => (await leftSaved(row)) || (await accessEnded(row));

  /** a. The Custom filter (P4's service; off without it). */
  async function customStep(row: PrepareRow, jobId: number, payer: PersonPayer): Promise<Step> {
    const filters = deps.services.prepareFilters;
    if (!filters || !(await filters.customPrompt(row.user_id))) return 'go';
    const check = (await filters.evaluate(row.user_id, [row.application_id]))[0];
    let verdict = check?.custom ?? 'off';
    if (verdict === 'pending') {
      const batch = constants().get('CUSTOM_FILTER_BATCH');
      // v33 SHARE-5: the batch takes the waiting jobs of the same payer only (they pay for it).
      const others = (await waitingServerRows(db, row.user_id)).flatMap((other) =>
        other.id !== row.id && other.job_id !== null && startedByOf(other) === payer.id ? [other.job_id] : [],
      );
      const jobIds = [...new Set([jobId, ...others])].slice(0, batch);
      try {
        await stillAllowed(row); // v33 SHARE-5
        verdict = (await filters.judgeOnServer(row.user_id, jobIds, row.id, payer)).get(jobId) ?? 'pass';
      } catch (error) {
        passSignal(error);
        if (stopping) return 'ended';
        // v33 SHARE-5: a grantee row's ai_busy parks it.
        if (error instanceof AppError && error.code === 'ai_busy' && isGranteeRow(row)) throw new RunnerSignal('parked');
        const limited = await payerLimited(row, error instanceof AppError ? error.code : undefined, messageOf(error));
        await end(row, 'failed', { error: limited ? message('MSG_PREPARE_PAYER_LIMIT') : messageOf(error) });
        return 'ended';
      }
    }
    if (verdict !== 'fail') return 'go';
    await end(row, 'filtered', { reason: 'custom' });
    return 'ended';
  }

  /** b. The job read again (charged to the person), then the filters on the fresh facts. */
  async function analysisStep(row: PrepareRow, jobId: number, payer: PersonPayer): Promise<Step> {
    const needed = await analysisNeeded(deps, jobId);
    const analyses = deps.services.jobAnalysis;
    if (needed && deps.services.ai && analyses?.forceAnalysis) {
      const force = analyses.forceAnalysis.bind(analyses);
      await updatePrepare(db, row.id, { state: 'analyzing' }, now());
      // v2.0 (INT): P4's forceAnalysis (A7): a system-owned task charged to the person (chargeTo, 03-ai-usage.md), its
      // input naming the Prepare (`prepare.id`) so prepare_jobs.cost_micros adds it up; one already queued or running
      // for the same text is joined, and then nobody pays twice. v33 SHARE-5: charged to the Prepare's payer.
      let taskId: string | null = null;
      try {
        taskId = (await whenFree(row, () => force(jobId, payer, { id: row.id })))?.taskId ?? null; // v33 INT-C: the Payer (public work, no grant)
      } catch (error) {
        passSignal(error);
        if (error instanceof AppError && REFUSALS.has(error.code)) {
          const limited = await payerLimited(row, error.code, error.message); // v33 SHARE-5
          await end(row, 'failed', { error: limited ? message('MSG_PREPARE_PAYER_LIMIT') : error.message });
          return 'ended';
        }
        // Paused, no background slot: the facts TailorIT has stand (unknown values pass).
      }
      if (taskId) {
        // Never cancelled for one Prepare: other people may be waiting for the same analysis.
        const view = await finished(taskId);
        if (view === null) return 'ended';
        if (view !== 'late' && view.status === 'failed' && view.error && REFUSALS.has(view.error.code)) {
          const limited = await payerLimited(row, view.error.code, view.error.message); // v33 SHARE-5
          await end(row, 'failed', { error: limited ? message('MSG_PREPARE_PAYER_LIMIT') : view.error.message });
          return 'ended';
        }
      }
      if (!await stillActive(row.id)) return 'ended';
    }
    const filters = deps.services.prepareFilters;
    if (!needed || !filters) return 'go';
    const check = (await filters.evaluate(row.user_id, [row.application_id], { record: true }))[0];
    const first = check?.verdict.verdict === 'fail' ? check.verdict.reasons[0] : undefined;
    if (!first) return 'go';
    await end(row, 'filtered', { reason: filterReasonOf(deps, first).code });
    return 'ended';
  }

  /** The job's known questions, a shared Greenhouse job's read from its board first when TailorIT knows none. */
  async function questionsOf(jobId: number): Promise<AutofillKnownQuestion[]> {
    const known = await knownQuestions(deps, jobId);
    if (known.length > 0) return known;
    const place = await formPlace(deps.db, jobId, null);
    const posting = place?.jobId != null ? await greenhousePostingOf(deps, null, jobId) : null;
    if (place && posting) await readGreenhouseQuestionsLater(deps, greenhouseReadsOf(deps), place, posting);
    return knownQuestions(deps, jobId);
  }

  /** d (`tailor`): v1.4's tailoring, marked as this Prepare's, its letter beside it when wanted. */
  async function tailorStep(
    row: PrepareRow,
    target: DraftTarget,
    letter: boolean,
    payer: PersonPayer,
  ): Promise<{ ok: true; resumeId: string; coverLetterId: string | null } | { ok: false; message: string } | null> {
    const tailor = deps.services.tailor;
    if (!tailor) return { ok: false, message: message('MSG_AI_UNAVAILABLE') };
    let taskId: string;
    try {
      taskId = (
        await whenFree(row, () =>
          tailor.start(
            row.user_id,
            { applicationId: target.applicationId, coverLetter: letter, force: deps.db.dialect.isTrue(row.rebuild) },
            tailorOptionsFor(row.id, payer), // v33 SHARE-5: the Prepare's payer pays
          ),
        )
      ).taskId;
    } catch (error) {
      passSignal(error);
      return { ok: false, message: await rowMessageOf(row, error) };
    }
    const view = await ownTask(row.id, row.user_id, taskId);
    if (view === null) return null;
    if (view === 'late') return { ok: false, message: message('MSG_PREPARE_TOOK_TOO_LONG') };
    const result = view.status === 'succeeded' ? TailorResultSchema.safeParse(view.result) : null;
    if (!result?.success) return { ok: false, message: await rowTaskError(row, view, message('MSG_PREPARE_RESUME_FAILED')) };
    return { ok: true, resumeId: result.data.resumeId, coverLetterId: result.data.coverLetterId };
  }

  /**
   * d (`default`, `similar`, and a kit whose resume was kept): the letter written from the kit's resume (A29) by the
   * editor's letter generation, on the profile's letter template (TailorIT's own layout when the template would leave
   * a detail of the person's unfilled), for the application. A letter whose writing fails is removed again.
   */
  async function letterStep(
    row: PrepareRow,
    target: DraftTarget,
    resumeId: string,
    payer: PersonPayer,
  ): Promise<{ ok: true; coverLetterId: string } | { ok: false; message: string } | null> {
    const ai = deps.services.ai;
    if (!ai) return { ok: false, message: message('MSG_AI_UNAVAILABLE') };
    const facts = await applicationFacts(deps, row.user_id, target.applicationId);
    const evidence = await getResumeEvidence(deps, row.user_id, resumeId);
    if (!evidence) return { ok: false, message: message('MSG_PREPARE_NO_RESUME') };
    let template = (await chooseTemplates(deps, row.user_id, {})).coverLetterTemplate;
    if (
      template &&
      templateHasContent(template.contentHtml) &&
      unfilledVariables(template, letterProfile(evidence), { companyName: target.companyName, jobTitle: target.title }, deps.now())
        .length > 0
    ) {
      template = null;
    }
    const letters = createLetterRepository(deps);
    // v2.0 FIX-B (BEH-5): the letter task this Prepare queued before a restart (the AI queue runs it again) is waited
    // for, its letter the kit's: never a second letter and a second charge.
    let left: { taskId: string; letterId: string | null } | undefined;
    for (const task of await liveTasksOfPrepare(deps, row.user_id, row.id, ['cover_letter', 'template_fill'])) {
      const letterId = letterIdOf(task.input);
      if (letterId !== null && (await letters.getRow(letterId, row.user_id)) !== undefined) {
        left = { taskId: task.id, letterId };
        break;
      }
    }
    let letterId: string;
    let taskId: string;
    if (left) {
      letterId = left.letterId!;
      taskId = left.taskId;
    } else {
      const letter = await letters.create(row.user_id, {
        title: tailoredTitle(target.companyName, target.title),
        origin: 'blank',
        applicationId: target.applicationId,
        jobId: target.jobId,
        companyName: target.companyName.slice(0, 200),
        jobTitle: target.title.slice(0, 200),
      });
      letterId = letter.id;
      const input: GenerateTaskInput = {
        letterId: letter.id,
        companyName: target.companyName,
        jobTitle: target.title,
        jobDescription: facts.jobDescription,
        templateId: template?.id ?? null,
        customPrompt: '',
        resumeId,
        onlyIfEmpty: true,
      };
      const task = template && templateHasContent(template.contentHtml) ? templateFillTask : coverLetterTask;
      // The Prepare's mark (P1: prepare_jobs.cost_micros adds up its tasks); the task's own parse leaves it out.
      const marked = { ...input, prepare: { id: row.id } };
      // v33 SHARE-5: the Prepare's payer pays (v33 INT-1: named at the enqueue).
      const options = task.enqueueOptions({ userId: row.user_id, input: marked, dedupeKey: `cover-letter:${letter.id}`, priority: priority(), chargeTo: payer });
      try {
        taskId = (await whenFree(row, () => ai.enqueue(options))).taskId;
      } catch (error) {
        await letters.remove(letter.id, row.user_id);
        passSignal(error);
        return { ok: false, message: await rowMessageOf(row, error) };
      }
    }
    const removeLetter = () => letters.remove(letterId, row.user_id);
    const view = await ownTask(row.id, row.user_id, taskId);
    if (view === null) return null;
    if (view === 'late' || view.status !== 'succeeded') {
      await removeLetter();
      return {
        ok: false,
        message: view === 'late' ? message('MSG_PREPARE_TOOK_TOO_LONG') : await rowTaskError(row, view, message('MSG_PREPARE_LETTER_FAILED')),
      };
    }
    return { ok: true, coverLetterId: letterId };
  }

  /** e. The answers, from the kit's resume. Null when the server stopped meanwhile. */
  async function answersStep(
    row: PrepareRow,
    target: DraftTarget,
    resumeId: string | null,
    planned: readonly PlannedQuestion[],
    payer: PersonPayer,
  ): Promise<{ values: Map<number, AutofillSubmittedAnswerValue | null>; failed: string | null } | null> {
    const values = new Map<number, AutofillSubmittedAnswerValue | null>();
    const asked = planned.filter((item) => item.state === 'draft');
    const ai = deps.services.ai;
    if (asked.length === 0) return { values, failed: null };
    if (!ai) return { values, failed: message('MSG_AI_UNAVAILABLE') };
    const screen = await valueScreen(deps, row.user_id);
    const facts = await applicationFacts(deps, row.user_id, target.applicationId);
    const batches: Array<readonly PlannedQuestion[]> = [];
    for (let at = 0; at < asked.length; at += PREPARE_ANSWER_BATCH) batches.push(asked.slice(at, at + PREPARE_ANSWER_BATCH));
    // v2.0 FIX-B (BEH-5): the answer batches this Prepare queued before a restart (the AI queue runs them again) are
    // waited for, each in place of the batch asking the same questions; one asking others is cancelled (it was only
    // queued, so nothing ran): no batch is asked, nor charged, twice.
    const left = await liveTasksOfPrepare(deps, row.user_id, row.id, ['autofill_answer']);
    const joined = new Map<number, string>();
    for (const [index, batch] of batches.entries()) {
      const keys = sameKeys(batch.map((item) => item.item!.key));
      const at = left.findIndex((task) => sameKeys(itemKeysOf(task.input)) === keys);
      if (at >= 0) joined.set(index, left.splice(at, 1)[0]!.id);
    }
    for (const task of left) await ai.cancel(task.id, row.user_id);
    let failed: string | null = null;
    for (const [index, batch] of batches.entries()) {
      const rejoined = joined.get(index);
      const request: AutofillAnswerRequest = {
        items: batch.map((item) => item.item!),
        scope: 'standard',
        jobText: cutAtWord(facts.jobDescription, LIMITS.jobText),
        company: cutAtWord(target.companyName, LIMITS.company),
        jobTitle: cutAtWord(target.title, LIMITS.jobTitle),
        // A29: the answer task's facts are read from the kit's resume (an upload's extracted text included).
        resumeId,
        canaries: [],
      };
      const { input } = answerTaskInput(request, screen);
      // The Prepare's mark, as the letter's (the task's own parse leaves it out).
      const marked = { ...input, prepare: { id: row.id } };
      // v33 SHARE-5: the Prepare's payer pays.
      const options = autofillAnswerTask.enqueueOptions({ userId: row.user_id, input: marked, priority: priority(), chargeTo: payer });
      let taskId: string;
      try {
        taskId = rejoined ?? (await whenFree(row, () => ai.enqueue(options))).taskId;
      } catch (error) {
        passSignal(error);
        failed = await rowMessageOf(row, error);
        if (error instanceof AppError && REFUSALS.has(error.code)) break;
        continue;
      }
      const view = await ownTask(row.id, row.user_id, taskId);
      if (view === null) return null;
      if (!await stillActive(row.id)) return { values, failed };
      const result = view !== 'late' && view.status === 'succeeded' ? AutofillAnswerResultSchema.safeParse(view.result) : null;
      if (!result?.success) {
        failed = view === 'late' ? message('MSG_PREPARE_TOOK_TOO_LONG') : await rowTaskError(row, view, message('MSG_PREPARE_ANSWERS_FAILED'));
        continue;
      }
      const byKey = new Map<string, AutofillAnswer>(result.data.answers.map((answer) => [answer.key, answer]));
      for (const item of batch) values.set(item.question.id, draftValueOf(item, byKey.get(item.item!.key)));
    }
    return { values, failed };
  }

  /** One Prepare, from its step (never throws for a job's failure: it is recorded). */
  async function prepareOne(initial: PrepareRow): Promise<void> {
    const id = initial.id;
    const userId = initial.user_id;
    const target = await currentTarget(deps, userId, initial.application_id);
    if (!target || initial.job_id === null) {
      // The entry left Saved, lost its job, or went, since it was started.
      await end(initial, 'cancelled', { reason: 'not_saved' });
      return;
    }
    const jobId = target.jobId;
    // v33 SHARE-5: who pays (B under the grant on a profile shared with them), and whether the share still allows it.
    const payer = await payerFor(initial);
    if (!payer || (await accessEnded(initial))) return;
    if (initial.state === 'waiting') await updatePrepare(db, id, { state: 'filtering', started_at: initial.started_at ?? now() }, now());
    // A kit queued at the start whose finish left a part to make (no start time): its work is taken up now.
    else if (initial.started_at === null) await updatePrepare(db, id, { started_at: now() }, now());
    let row = await stillActive(id);
    if (!row) return;

    // a, b: the filters (a restart past them does not ask again).
    if (row.state === 'filtering') {
      if ((await customStep(row, jobId, payer)) === 'ended') return;
      row = await stillActive(id);
      if (!row || (await accessEnded(row))) return; // v33 SHARE-5
    }
    if (row.state === 'filtering' || row.state === 'analyzing') {
      if ((await analysisStep(row, jobId, payer)) === 'ended') return;
      row = await stillActive(id);
      if (!row || (await accessEnded(row))) return; // v33 SHARE-5
    }

    // c: the letter decision.
    await updatePrepare(db, id, { state: 'building' }, now());
    const questions = await questionsOf(jobId);
    row = await stillActive(id);
    if (!row || stopping || await stopsHere(row)) return;
    const wanted = (await decideLetter(deps, row.letter_mode, jobId, questions)).wanted;
    await updatePrepare(db, id, { letter_wanted: wanted }, now());
    const errors: string[] = [];
    const kit = async () => {
      const draft = await draftOf(db, userId, target.applicationId);
      return draft?.prepare_id === id ? draft : null;
    };
    const write = async (changes: DraftChanges) => {
      const draft = await kit();
      if (draft && await stillActive(id)) await updateDraft(db, draft.id, changes, now());
    };
    if (!wanted) await write({ letter_status: 'off', cover_letter_id: null });

    // d: the resume (and the letter beside a tailoring).
    let draft = await kit();
    if (!draft) return;
    if (draft.resume_status !== 'ready' || !draft.resume_id) {
      if (row.resume_mode === 'tailor') {
        await write({ resume_status: 'building', ...(wanted ? { letter_status: 'building' as const } : {}) });
        const made = await tailorStep(row, target, wanted, payer);
        if (made === null || !await stillActive(id)) return;
        if (made.ok) {
          await db.tx(async () => {
            await linkToApplication(deps, userId, target.applicationId, { resumeId: made.resumeId, coverLetterId: made.coverLetterId }, now());
            await write({
              resume_id: made.resumeId,
              resume_status: 'ready',
              ...(made.coverLetterId ? { cover_letter_id: made.coverLetterId } : {}),
              ...(wanted ? { letter_status: made.coverLetterId ? 'ready' : 'failed' } : {}),
            });
            await updatePrepare(db, id, { resume_id: made.resumeId }, now());
          });
          if (wanted && !made.coverLetterId) errors.push(message('MSG_PREPARE_LETTER_FAILED'));
        } else {
          errors.push(made.message);
          await write({ resume_status: 'failed', ...(wanted ? { letter_status: 'failed' as const } : {}) });
        }
      } else {
        await write({ resume_status: 'building' });
        const chosen = await chooseResume(deps, userId, row.resume_mode, jobId);
        if (stopping || !await stillActive(id)) return;
        if (chosen) {
          await db.tx(async () => {
            await linkToApplication(deps, userId, target.applicationId, { resumeId: chosen }, now());
            await write({ resume_id: chosen, resume_status: 'ready' });
            await updatePrepare(db, id, { resume_id: chosen }, now());
          });
        } else {
          errors.push(message('MSG_PREPARE_NO_RESUME'));
          await write({ resume_status: 'failed' });
        }
      }
    }
    draft = await kit();
    if (!draft || await stopsHere(row)) return;
    // The letter, from the kit's resume, when one is wanted and the kit has none written from it.
    if (wanted && draft.resume_status === 'ready' && draft.resume_id && draft.letter_status !== 'failed' && !await kitLetterFits(deps, userId, draft)) {
      await write({ letter_status: 'building' });
      const made = await letterStep(row, target, draft.resume_id, payer);
      if (made === null || !await stillActive(id)) return;
      if (made.ok) {
        await db.tx(async () => {
          await linkToApplication(deps, userId, target.applicationId, { coverLetterId: made.coverLetterId }, now());
          await write({ cover_letter_id: made.coverLetterId, letter_status: 'ready' });
        });
      } else {
        errors.push(made.message);
        await write({ letter_status: 'failed' });
      }
    }

    // e: the answers (never when the resume failed: the Prepare fails).
    draft = await kit();
    if (!draft || await stopsHere(row)) return;
    if (draft.resume_status === 'ready' && (draft.answers_status === 'pending' || draft.answers_status === 'building')) {
      const planned = planQuestions(questions, await valueScreen(deps, userId));
      await write({ answers_status: 'building' });
      let made: Awaited<ReturnType<typeof answersStep>>;
      try {
        made = await answersStep(row, target, draft.resume_id, planned, payer);
      } catch (error) {
        passSignal(error); // v33 SHARE-5
        deps.log.warn(`[prepare] Prepare ${id}: its answers could not be prepared`, error instanceof Error ? error.name : 'unknown');
        made = { values: new Map(), failed: message('MSG_PREPARE_ANSWERS_FAILED') };
      }
      if (made === null || !await stillActive(id)) return;
      const { values, failed } = made;
      await db.tx(async () => {
        const current = await kit();
        if (!current || !await stillActive(id)) return;
        const rows = planned
          .filter((item) => item.state !== 'profile')
          .map((item) => ({ questionId: item.question.id, answer: values.get(item.question.id) ?? null }));
        await writeAnswers(db, current.id, rows, 'server-ai', now(), { replace: true });
        const ready = (await answerRows(db, current.id)).every((answer) => answer.status === 'ready');
        // Answers are never required: those not made are made during the application.
        const status = planned.length > 0 && ready && !failed ? 'ready' : 'not_ready';
        await updateDraft(db, current.id, { answers_status: status, questions_seen: planned.length }, now());
      });
      if (failed) errors.push(message('MSG_PREPARE_ANSWERS_FAILED'));
    } else if (draft.answers_status === 'pending' || draft.answers_status === 'building') {
      await write({ answers_status: 'skipped' });
    }

    // f: finish.
    let finishedAs: string | null = null;
    await db.tx(async () => {
      const fresh = await stillActive(id);
      const current = await kit();
      if (!fresh || !current) return;
      await updateDraft(db, current.id, { error: errors.length ? [...new Set(errors)].join(' ') : null }, now());
      finishedAs = (await finishKit(deps, fresh, (await draftOf(db, userId, target.applicationId))!, now()))?.state ?? null;
    });
    deps.log.debug(`[prepare] Prepare ${id} of account ${userId}: ${finishedAs ?? 'left as it was'}`);
  }

  const runner: PrepareRunner = {
    kick: () => pump(),

    abort(prepareId) {
      const task = waitingOn.get(prepareId);
      if (!task) return;
      // The task's own cancel: its waiter (ownTask) hears it, and the Prepare already ended (the cancel ended it).
      void deps.services.ai?.cancel(task.taskId, task.userId).catch((error: unknown) =>
        deps.log.warn(`[prepare] the AI task of Prepare ${prepareId} could not be cancelled`, error instanceof Error ? error.name : 'unknown'),
      );
    },

    start() {
      stopping = false;
      pump();
      // Never waits for a Prepare: it may be waiting for a task the AI queue's own stop (after this one) interrupts.
      return () => {
        stopping = true;
        if (timer) clearTimeout(timer);
        timer = null;
      };
    },

    async idle() {
      while (pumping || inFlight.size > 0) await Promise.allSettled([...(pumping ? [pumping] : []), ...inFlight.values()]);
    },
  };
  return runner;
}

/** For the routes and the tests: the draft's view of what an active server Prepare is making. */
export type { DraftRow };
