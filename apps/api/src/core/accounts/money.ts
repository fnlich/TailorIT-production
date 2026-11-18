import { formatUsd, UNLIMITED, type EntitlementSource, type Limit } from '@tailorit/shared';
import { dayKeyAt } from '../constants/day';
import type { AppDeps } from '../context';
import { notFound, validationFailed } from '../http/errors';
import { entitlementsOf } from './entitlements';
import { notifyChargeCrossings } from '../../features/notifications/emitters'; // v31 NOTIFY

// v2.0: server-AI money (docs/design/v2.0/03-ai-usage.md, "Spend order and overshoot"; 04-accounts-limits.md). The only
// code that writes ai_spend_daily and ai_credit_ledger: the AI queue's charge (P1) and the admin (P6b) call it. Money is
// whole micro-dollars ($1 = 1,000,000) everywhere, never summed as floats. Extra credit is an append-only ledger whose
// newest row's balance_after_micros is the balance; it never goes below 0 and never expires. A run's cost is taken
// from the day's budget first, then from extra credit down to 0; the rest is written off and logged for the admin.
// Nothing here is ever shown to the person but their credit balance. v31 NOTIFY (D9): and, in the header, their own
// day's spend against their own budget (features/notifications/header.ts reads them in one statement).
//
// v3.0 D2 (the concurrency audit, 11-database.md §9.3): a charge and a credit add read the newest balance and the day's
// spend, then append, so each starts with lockPerson(userId) inside its transaction. SQLite's single writer serialised
// them already; on PostgreSQL the lock (the person's user_counters row, FOR UPDATE) keeps two tasks finishing at once
// from spending the same credit. A purchase's payment reference is also unique in the ledger (idx_credit_payment, 0821).

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** The SQL of creditBalance. */
export const CREDIT_BALANCE_SQL =
  'SELECT balance_after_micros AS balance FROM ai_credit_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 1';

/** The person's extra-credit balance in micro-dollars: the newest ledger row's balance, 0 with none. */
export async function creditBalance(deps: Pick<AppDeps, 'db'>, userId: string): Promise<number> {
  return (await deps.db.one<{ balance: number }>(CREDIT_BALANCE_SQL, [userId]))?.balance ?? 0;
}

export interface AddCreditInput {
  userId: string;
  /** > 0 for a grant and a purchase; either sign for an adjustment (never 0). */
  amountMicros: number;
  kind: 'grant' | 'purchase' | 'adjustment';
  source: EntitlementSource;
  actorUserId?: string;
  /** A payment's id: required for a purchase; a second add with the same reference adds nothing (idempotent). */
  paymentRef?: string;
  note?: string;
}

/**
 * Adds a ledger row in one transaction (the person's lock first) and answers the new balance. 400 when the amount is
 * not whole micro-dollars of the right sign, when a purchase has no payment reference, or when the balance would go
 * below 0.
 */
export async function addCredit(deps: Deps, input: AddCreditInput): Promise<number> {
  const amount = input.amountMicros;
  if (!Number.isSafeInteger(amount) || amount === 0) throw validationFailed('Enter an amount other than $0.00.');
  if (input.kind !== 'adjustment' && amount < 0) throw validationFailed('A grant or a purchase adds credit: use an amount above 0.');
  const paymentRef = input.paymentRef?.trim() || undefined;
  if (input.kind === 'purchase' && paymentRef === undefined) throw validationFailed('A purchase needs its payment reference.');
  if (paymentRef !== undefined && paymentRef.length > 200) throw validationFailed('A payment reference is at most 200 characters.');
  const note = input.note?.trim() ? input.note.trim().slice(0, 500) : null;
  const balance = await deps.db.atomic(
    async (t) => {
      const exists = await t.one('SELECT 1 AS one FROM users WHERE id = ?', [input.userId]);
      if (!exists) throw notFound('That account');
      // The account exists, so its lock can be taken (PostgreSQL's lock row references it).
      await t.lockPerson(input.userId);
      // v3.0 PG-0: the payment's own check comes after the lock, so a purchase retried at once (same person) waits for
      // the first and then finds its row, instead of both passing the check and the second hitting idx_credit_payment.
      if (paymentRef !== undefined) {
        const seen = await t.one('SELECT 1 AS one FROM ai_credit_ledger WHERE payment_ref = ?', [paymentRef]);
        if (seen) return creditBalance(deps, input.userId);
      }
      const before = await creditBalance(deps, input.userId);
      const after = before + amount;
      if (after < 0) {
        throw validationFailed(`Extra credit cannot go below $0.00: the balance is ${formatUsd(before)}.`);
      }
      await t.run(
        `INSERT INTO ai_credit_ledger(user_id, kind, amount_micros, balance_after_micros, day_key, source, actor_user_id,
           payment_ref, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.userId, input.kind, amount, after, dayKeyAt(deps), input.source, input.actorUserId ?? null, paymentRef ?? null, note, deps.now().toISOString()],
      );
      return after;
    },
    { label: 'addCredit' },
  );
  deps.log.info(`[accounts] account ${input.userId}: credit ${input.kind} (${input.source})`);
  return balance;
}

/** The person's daily AI budget now: their override, else their effective type's constant (UNLIMITED: null). */
export async function aiDailyBudgetMicros(deps: Deps, userId: string): Promise<Limit> {
  return (await entitlementsOf(deps, userId)).aiDailyBudgetMicros;
}

export interface SpendOfDay {
  dailySpentMicros: number;
  creditSpentMicros: number;
  writtenOffMicros: number;
  runs: number;
}

/** What the person's server AI cost on `dayKey` (today) and where it was taken from. */
export async function spendToday(deps: Deps, userId: string, dayKey: string = dayKeyAt(deps)): Promise<SpendOfDay> {
  const row = await deps.db.one<{ daily: number; credit: number; writtenOff: number; runs: number }>(
    `SELECT daily_spent_micros AS daily, credit_spent_micros AS credit, written_off_micros AS "writtenOff", runs
       FROM ai_spend_daily WHERE user_id = ? AND day_key = ?`,
    [userId, dayKey],
  );
  return {
    dailySpentMicros: row?.daily ?? 0,
    creditSpentMicros: row?.credit ?? 0,
    writtenOffMicros: row?.writtenOff ?? 0,
    runs: row?.runs ?? 0,
  };
}

/** The person's AI budget now, for the gate (P1's serverAiRefusal) and the admin; never shown to the person. */
export interface AiBudgetState {
  dayKey: string;
  /** The day's budget; null: UNLIMITED. */
  budgetMicros: Limit;
  dailySpentMicros: number;
  /** budget - daily spent, never below 0; null: UNLIMITED. */
  dailyRemainingMicros: number | null;
  creditMicros: number;
  /** Daily remaining plus credit is at or below 0: a new server-AI action is refused (ai_usage_exhausted). */
  exhausted: boolean;
}

export async function aiBudgetState(deps: Deps, userId: string, at: Date = deps.now()): Promise<AiBudgetState> {
  const dayKey = dayKeyAt(deps, at);
  const budgetMicros = await aiDailyBudgetMicros(deps, userId);
  const { dailySpentMicros } = await spendToday(deps, userId, dayKey);
  const dailyRemainingMicros = budgetMicros === UNLIMITED ? null : Math.max(0, budgetMicros - dailySpentMicros);
  const creditMicros = await creditBalance(deps, userId);
  const exhausted = dailyRemainingMicros !== null && dailyRemainingMicros + creditMicros <= 0;
  return { dayKey, budgetMicros, dailySpentMicros, dailyRemainingMicros, creditMicros, exhausted };
}

export interface ChargeInput {
  userId: string;
  /** The run's cost, already rounded up once (ceil of USD × 1e6); 0 is a run that reported no cost. */
  micros: number;
  /** The day key the run is charged to (the day it finished). */
  dayKey: string;
  taskId: string;
}

export interface Charge {
  fromDaily: number;
  fromCredit: number;
  writtenOff: number;
}

/**
 * Charges one prompt run, in one transaction behind the person's lock (two tasks finishing at once cannot both spend
 * the same credit): the day's budget first (resolved now: an admin may change it mid-day), then extra credit down to
 * 0, the rest written off. A run with no cost is counted (runs + 1) and charges nothing. Inside a caller's transaction
 * (the AI queue's, with the task's charged_micros) it joins it.
 */
export async function chargeAi(deps: Deps, input: ChargeInput): Promise<Charge> {
  const micros = input.micros;
  if (!Number.isSafeInteger(micros) || micros < 0) throw new RangeError(`Not a charge in micro-dollars: ${micros}`);
  const charge = await deps.db.atomic(
    async (t) => {
      await t.lockPerson(input.userId);
      const budget = await aiDailyBudgetMicros(deps, input.userId);
      const spent = await spendToday(deps, input.userId, input.dayKey);
      const fromDaily = budget === UNLIMITED ? micros : Math.min(Math.max(budget - spent.dailySpentMicros, 0), micros);
      const rest = micros - fromDaily;
      const balance = await creditBalance(deps, input.userId);
      const fromCredit = Math.min(rest, balance);
      const writtenOff = rest - fromCredit;
      const now = deps.now().toISOString();
      await t.run(
        `INSERT INTO ai_spend_daily(user_id, day_key, daily_spent_micros, credit_spent_micros, written_off_micros, runs,
           updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(user_id, day_key) DO UPDATE SET
           daily_spent_micros = ai_spend_daily.daily_spent_micros + excluded.daily_spent_micros,
           credit_spent_micros = ai_spend_daily.credit_spent_micros + excluded.credit_spent_micros,
           written_off_micros = ai_spend_daily.written_off_micros + excluded.written_off_micros,
           runs = ai_spend_daily.runs + 1, updated_at = excluded.updated_at`,
        [input.userId, input.dayKey, fromDaily, fromCredit, writtenOff, now],
      );
      if (fromCredit > 0) {
        await t.run(
          `INSERT INTO ai_credit_ledger(user_id, kind, amount_micros, balance_after_micros, day_key, source, task_id,
             created_at) VALUES (?, 'spend', ?, ?, ?, 'system', ?, ?)`,
          [input.userId, -fromCredit, balance - fromCredit, input.dayKey, input.taskId, now],
        );
      }
      // v31 NOTIFY: the day's budget reached, extra credit low or used up, told in this charge's transaction (never
      // throws; nothing is read or written unless this charge crossed a line).
      await notifyChargeCrossings(deps, {
        userId: input.userId,
        dayKey: input.dayKey,
        budgetMicros: budget,
        dailyBeforeMicros: spent.dailySpentMicros,
        fromDailyMicros: fromDaily,
        creditBeforeMicros: balance,
        fromCreditMicros: fromCredit,
      });
      return { fromDaily, fromCredit, writtenOff };
    },
    { label: 'chargeAi' },
  );
  if (charge.writtenOff > 0) {
    deps.log.info(`[ai] account ${input.userId}: ${charge.writtenOff} micro-dollars written off (budget and credit used up)`);
  }
  return charge;
}
