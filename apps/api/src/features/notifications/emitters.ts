import { formatUsd, UNLIMITED, type Limit } from '@tailorit/shared';
import { constantsOf } from '../../core/constants/service';
import type { DbQueries } from '../../core/db/types';
import { guarded, notify, notifyAdmins, notifyStats, type NotifyDeps, type NotifyOutcome } from './service';

// v3.1 NOTIFY: the emitters, one per event, each called by one line where its event happens (build plan §4 NOTIFY):
//   notifyPrepareBatch       prepare/kit.ts finishKit, prepare/runner.ts end()   (the batch's last Prepare ended)
//   notifyAutoApplyResult    autofill/agent/queue.ts finishRun                     (submitted / needs you / failed)
//   notifyChargeCrossings    core/accounts/money.ts chargeAi                       (budget reached, credit low / used up)
//   notifyExtensionDisconnected  autofill/connect-router.ts DELETE /session; the hourly pass (a connection ran out)
//   notifyRunFinished        ingest/service.ts finish()                            (a run failed; a source turned off)
//   notifyRunsControl        RUNS's pause and continue routes (INT wires it)       (another admin paused or continued)
// Each reads what its words need and calls notify / notifyAdmins; none throws or aborts the caller's transaction (a
// read runs through `guarded`, a savepoint inside a transaction). Called inside the event's transaction, the
// notification commits with it.

/** The Prepare states that are still at work (shared's isActivePrepareState). */
const ACTIVE_PREPARE = "('waiting','filtering','analyzing','building')";

/** Reads for an emitter: failures are logged and counted, and the emitter writes nothing. */
async function read<T>(deps: NotifyDeps, what: string, fn: (db: DbQueries) => Promise<T>): Promise<T | undefined> {
  try {
    return await guarded(deps, fn);
  } catch (error) {
    notifyStats.failed += 1;
    deps.log.warn(`[notifications] ${what}: its facts could not be read, so nothing was written`, error);
    return undefined;
  }
}

// ------------------------------------------------------------------------------------------------------ Prepare

/**
 * A Prepare ended: when it was the last active one of its batch (the Prepares one start made, which share created_at)
 * and the batch did work in the background (a Prepare was taken up: started_at set), one summary for the batch:
 * `prepare_finished` with how many are ready (queued or prepared) and how many failed, or `prepare_failed` when none
 * is ready. Nothing for a batch that was all filtered or cancelled, or that the start queued at once (the person saw
 * it). Dedupe `prepare:<created_at>`. Call it in the transaction that ended the Prepare.
 */
export async function notifyPrepareBatch(deps: NotifyDeps, prepare: { user_id: string; created_at: string }): Promise<NotifyOutcome> {
  const batch = await read(deps, 'prepare batch', (db) =>
    db.one<{ active: number; ready: number; failed: number; started: number }>(
      `SELECT count(*) FILTER (WHERE state IN ${ACTIVE_PREPARE}) AS active,
              count(*) FILTER (WHERE state IN ('queued','prepared')) AS ready,
              count(*) FILTER (WHERE state = 'failed') AS failed,
              count(*) FILTER (WHERE started_at IS NOT NULL) AS started
         FROM prepare_jobs WHERE user_id = ? AND created_at = CAST(? AS timestamptz)`,
      [prepare.user_id, prepare.created_at],
    ),
  );
  if (!batch) return 'failed';
  if (batch.active > 0 || batch.started === 0 || batch.ready + batch.failed === 0) return 'skipped';
  const ready = batch.ready > 0;
  return notify(deps, prepare.user_id, {
    kind: ready ? 'prepare_finished' : 'prepare_failed',
    params: { ready: batch.ready, failed: batch.failed },
    ...(ready && batch.failed > 0 ? { body: ['MSG_NOTIFY_PREPARE_FINISHED_BODY', 'MSG_NOTIFY_PREPARE_SOME_FAILED'] as const } : {}),
    link: '/auto-apply',
    dedupeKey: `prepare:${new Date(prepare.created_at).toISOString()}`,
  });
}

// --------------------------------------------------------------------------------------------------- auto-apply

const AUTO_APPLY_KIND = {
  submitted: 'auto_apply_submitted',
  'needs-you': 'auto_apply_needs_you',
  failed: 'auto_apply_failed',
} as const;

/**
 * The auto-apply agent reported a run: sent, needs the person, or failed (a skipped job tells nothing). One per queue
 * row and state (dedupe `auto-apply:<row>:<state>`: a retried report writes nothing). Call it in finishRun's transaction.
 */
export async function notifyAutoApplyResult(
  deps: NotifyDeps,
  result: { userId: string; queueId: string; state: string },
): Promise<NotifyOutcome> {
  const kind = AUTO_APPLY_KIND[result.state as keyof typeof AUTO_APPLY_KIND];
  if (!kind) return 'skipped';
  const job = await read(deps, kind, (db) =>
    db.one<{ title: string; company: string }>(
      `SELECT j.title, c.name AS company FROM autofill_agent_queue q JOIN jobs j ON j.id = q.job_id
         JOIN companies c ON c.id = j.company_id WHERE q.id = ? AND q.user_id = ?`,
      [result.queueId, result.userId],
    ),
  );
  // A row that is gone (or could not be read: counted) tells nothing.
  if (!job) return 'skipped';
  return notify(deps, result.userId, {
    kind,
    params: { title: job.title, company: job.company },
    link: '/auto-apply',
    dedupeKey: `auto-apply:${result.queueId}:${result.state}`,
  });
}

// ------------------------------------------------------------------------------------------------------- money

export interface ChargeCrossing {
  userId: string;
  dayKey: string;
  /** The day's budget when charged; UNLIMITED: none to reach. */
  budgetMicros: Limit;
  /** The day's spend before this charge, and what this charge took from the budget. */
  dailyBeforeMicros: number;
  fromDailyMicros: number;
  /** Extra credit before this charge, and what this charge took from it. */
  creditBeforeMicros: number;
  fromCreditMicros: number;
}

/**
 * After one AI charge (chargeAi, in its transaction): the day's budget reached by this charge (`ai_budget_reached`,
 * once a day), extra credit dropping below CREDIT_LOW_USD (`credit_low`) or to $0 (`credit_used_up`), each once a day.
 * A charge that crosses nothing reads nothing and writes nothing.
 */
export async function notifyChargeCrossings(deps: NotifyDeps, charge: ChargeCrossing): Promise<void> {
  const budget = charge.budgetMicros;
  const dailyAfter = charge.dailyBeforeMicros + charge.fromDailyMicros;
  const creditAfter = charge.creditBeforeMicros - charge.fromCreditMicros;
  if (budget !== UNLIMITED && budget > 0 && charge.dailyBeforeMicros < budget && dailyAfter >= budget) {
    await notify(deps, charge.userId, {
      kind: 'ai_budget_reached',
      params: { credit: formatUsd(creditAfter) },
      body: [creditAfter > 0 ? 'MSG_NOTIFY_AI_DAY_USED_BODY' : 'MSG_NOTIFY_AI_DAY_USED_NO_CREDIT'],
      link: '/settings#account',
      dedupeKey: `ai-budget:${charge.dayKey}`,
    });
  }
  if (charge.fromCreditMicros <= 0) return;
  if (creditAfter <= 0) {
    await notify(deps, charge.userId, { kind: 'credit_used_up', link: '/settings#account', dedupeKey: `credit-used-up:${charge.dayKey}` });
    return;
  }
  const low = constantsOf(deps).get('CREDIT_LOW_USD');
  if (charge.creditBeforeMicros >= low && creditAfter < low) {
    await notify(deps, charge.userId, {
      kind: 'credit_low',
      params: { credit: formatUsd(creditAfter) },
      link: '/settings#account',
      dedupeKey: `credit-low:${charge.dayKey}`,
    });
  }
}

// --------------------------------------------------------------------------------------------------- extension

/**
 * A browser extension's connection ended without the person ending it in Settings: the extension disconnected itself
 * (DELETE /api/autofill/session) or the connection ran out (`expired`, the hourly pass). One per connection.
 */
export async function notifyExtensionDisconnected(
  deps: NotifyDeps,
  connection: { userId: string; tokenId: string; label?: string; expired?: boolean },
): Promise<NotifyOutcome> {
  const label =
    connection.label ??
    (await read(deps, 'extension_disconnected', (db) =>
      db.one<{ label: string }>('SELECT label FROM extension_tokens WHERE id = ? AND user_id = ?', [connection.tokenId, connection.userId]),
    ))?.label ??
    '';
  return notify(deps, connection.userId, {
    kind: 'extension_disconnected',
    params: { browser: label.trim() || constantsOf(deps).message('MSG_NOTIFY_EXTENSION_UNNAMED') },
    ...(connection.expired ? { body: ['MSG_NOTIFY_EXTENSION_EXPIRED_BODY'] as const } : {}),
    link: '/settings/autofill',
    dedupeKey: `extension:${connection.tokenId}`,
  });
}

// ------------------------------------------------------------------------------------------------------ ingest

/** The hour a time falls in, as a dedupe key's part (UTC): `2026-11-17T16`. */
const hourOf = (iso: string) => iso.slice(0, 13);

/**
 * A run ended (ingest/service.ts finish(), in its transaction): failed → `admin_run_failed`; the source turned off
 * after its failures → `admin_source_disabled`. Each tells the admins once an hour at most (dedupe by the hour): a
 * failing network fails many runs at once, and the runs list holds them all.
 */
export async function notifyRunFinished(
  deps: NotifyDeps,
  run: { sourceId: number; sourceName: string; failed: boolean; disabled: boolean; failures: number },
): Promise<void> {
  const hour = hourOf(deps.now().toISOString());
  if (run.disabled) {
    await notifyAdmins(deps, {
      kind: 'admin_source_disabled',
      params: { source: run.sourceName, failures: run.failures },
      link: `/settings/admin?tab=sources&source=${run.sourceId}`,
      dedupeKey: `source-off:${hour}`,
    });
  } else if (run.failed) {
    await notifyAdmins(deps, {
      kind: 'admin_run_failed',
      params: { source: run.sourceName },
      link: `/settings/admin?tab=runs&source=${run.sourceId}`,
      dedupeKey: `run-failed:${hour}`,
    });
  }
}

/** What an admin paused or continued (RUNS: build plan §4 RUNS). */
export type RunsControlScope = { kind: 'all' } | { kind: 'source'; sourceName: string };

/**
 * An admin paused or continued runs (RUNS's routes, after the change committed): every other admin is told. Never
 * the admin who did it.
 */
export async function notifyRunsControl(
  deps: NotifyDeps,
  control: { actorId: string; actorName: string | null; action: 'paused' | 'continued'; scope: RunsControlScope },
): Promise<number> {
  const constants = constantsOf(deps);
  const what =
    control.scope.kind === 'all'
      ? constants.message('MSG_NOTIFY_ADMIN_RUNS_ALL')
      : constants.message('MSG_NOTIFY_ADMIN_RUNS_SOURCE', { source: control.scope.sourceName });
  return notifyAdmins(deps, {
    kind: control.action === 'paused' ? 'admin_runs_paused' : 'admin_runs_continued',
    params: { admin: control.actorName?.trim() || constants.message('MSG_NOTIFY_ADMIN_SOMEONE'), what },
    link: '/settings/admin?tab=runs',
    exceptUserId: control.actorId,
  });
}
