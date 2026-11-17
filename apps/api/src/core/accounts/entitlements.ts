import {
  addCalendarDuration,
  USD_MICROS_MAX,
  UNLIMITED,
  type AccountFeature,
  type AccountState,
  type AccountType,
  type EntitlementField,
  type EntitlementSource,
  type Entitlements,
  type Limit,
} from '@tailorit/shared';
import { constantsOf } from '../constants/service';
import type { AppDeps } from '../context';
import { AppError, notFound, validationFailed } from '../http/errors';
import { refuse } from '../http/refuse';
import { creditBalance } from './money';

// v2.0: the account type and its entitlements (docs/design/v2.0/04-accounts-limits.md). This module is the only code
// that writes users.account_type, users.paid_until and user_limit_overrides: the admin routes call changeEntitlement
// today, a payment provider will later (source 'payment' with its reference, which makes a retried change a no-op).
// Every change is audited in account_entitlement_events, one row per field it changed. Every check reads the effective
// type: 'paid' only while paid_until is in the future, so a lapse is Free at that instant with no job to run.
// v3.0 D2: on the async client (deps.db).

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

export interface AccountRow {
  account_type: AccountType;
  paid_until: string | null;
}

/** 'paid' when account_type is 'paid' and paid_until is after `now`; otherwise 'free'. */
export function effectiveType(row: AccountRow, now: Date): AccountType {
  return row.account_type === 'paid' && row.paid_until !== null && row.paid_until > now.toISOString() ? 'paid' : 'free';
}

/** The SQL of the account row and of the AI budget override. */
export const ACCOUNT_ROW_SQL = 'SELECT account_type, paid_until FROM users WHERE id = ?';
export const AI_BUDGET_OVERRIDE_SQL = "SELECT value FROM user_limit_overrides WHERE user_id = ? AND limit_key = 'ai_daily_budget'";

async function accountRow(deps: Pick<AppDeps, 'db'>, userId: string): Promise<AccountRow | null> {
  return (await deps.db.one<AccountRow>(ACCOUNT_ROW_SQL, [userId])) ?? null;
}

/** An override row's value as a limit. */
export function overrideOf(row: { value: string } | undefined): { micros: Limit } | undefined {
  return row ? { micros: JSON.parse(row.value) as Limit } : undefined;
}

/** The person's daily AI budget override: absent (the type's constant applies), or micro-dollars / UNLIMITED. */
export async function aiBudgetOverride(deps: Pick<AppDeps, 'db'>, userId: string): Promise<{ micros: Limit } | undefined> {
  return overrideOf(await deps.db.one<{ value: string }>(AI_BUDGET_OVERRIDE_SQL, [userId]));
}

/** The resolved limits from the account's row and override (entitlementsOf). */
export function entitlementsFrom(deps: Deps, row: AccountRow, override: { micros: Limit } | undefined): Entitlements {
  const constants = constantsOf(deps);
  const type = effectiveType(row, deps.now());
  const paid = type === 'paid';
  return {
    type,
    paidUntil: row.paid_until,
    autoApplyPerWindow: constants.get(paid ? 'PAID_AUTO_APPLY_PER_DAY' : 'FREE_AUTO_APPLY_PER_DAY'),
    resumes: constants.get(paid ? 'PAID_RESUME_LIMIT' : 'FREE_RESUME_LIMIT'),
    aiDailyBudgetMicros: override ? override.micros : constants.get(paid ? 'PAID_AI_DAILY_BUDGET_USD' : 'FREE_AI_DAILY_BUDGET_USD'),
    aiJobSearch: constants.get(paid ? 'PAID_AI_JOB_SEARCH' : 'FREE_AI_JOB_SEARCH'),
    mcp: constants.get(paid ? 'PAID_MCP' : 'FREE_MCP'),
    batchDownload: constants.get(paid ? 'PAID_BATCH_DOWNLOAD' : 'FREE_BATCH_DOWNLOAD'),
  };
}

/**
 * The resolved limits of one person, read per request (two primary-key reads and the constants), so an admin's change
 * applies to the next request. 404 for an account that does not exist.
 */
export async function entitlementsOf(deps: Deps, userId: string): Promise<Entitlements> {
  const row = await accountRow(deps, userId);
  if (!row) throw notFound('That account');
  return entitlementsFrom(deps, row, await aiBudgetOverride(deps, userId));
}

/** The account's entitlement state (changeEntitlement's answer, the admin's routes). */
export async function accountStateOf(deps: Deps, userId: string): Promise<AccountState> {
  const row = await accountRow(deps, userId);
  if (!row) throw notFound('That account');
  const override = await aiBudgetOverride(deps, userId);
  return {
    userId,
    accountType: row.account_type,
    effectiveType: effectiveType(row, deps.now()),
    paidUntil: row.paid_until,
    ...(override ? { aiBudgetOverride: override } : {}),
    extraCreditMicros: await creditBalance(deps, userId),
  };
}

const FEATURE_FLAGS: Record<AccountFeature, keyof Entitlements> = {
  ai_job_search: 'aiJobSearch',
  mcp: 'mcp',
  batch_download: 'batchDownload',
};

/** assertFeature's decision on resolved entitlements (assertFeature). */
export function assertFeatureOf(deps: Deps, entitlements: Entitlements, feature: AccountFeature): void {
  if (entitlements[FEATURE_FLAGS[feature]] === true) return;
  const free = entitlements.type === 'free';
  const options = free ? { subscribe: true } : {};
  // v30 ST4: each through refuse() (core/http/refuse.ts), but MCP's to a Free account, which is two constants, one after
  // the other.
  if (feature === 'ai_job_search') throw refuse(deps, 'paid_feature', 'MSG_PAID_AI_SEARCH', undefined, options);
  if (feature === 'batch_download') throw refuse(deps, 'paid_feature', 'MSG_BATCH_DOWNLOAD_PAID', undefined, options);
  if (!free) throw refuse(deps, 'paid_feature', 'MSG_MCP_OFF');
  const constants = constantsOf(deps);
  const message = [constants.message('MSG_MCP_OFF'), constants.message('MSG_SUBSCRIBE_CONTACT')].filter(Boolean).join(' ');
  throw new AppError('paid_feature', message, options);
}

/**
 * 403 `paid_feature` when the feature is off for the person's plan, with the feature's message and, for a Free account,
 * the Subscribe button. v20 FIX-A (REQ-3): MCP's own words are MSG_MCP_OFF, followed for a Free account by
 * MSG_SUBSCRIBE_CONTACT (both plans have MCP by default; an admin may turn it off for either).
 */
export async function assertFeature(deps: Deps, userId: string, feature: AccountFeature): Promise<void> {
  assertFeatureOf(deps, await entitlementsOf(deps, userId), feature);
}

// ---------------------------------------------------------------------------------------------- changeEntitlement

export interface EntitlementChange {
  userId: string;
  source: EntitlementSource;
  /** The admin; absent for a payment and for TailorIT itself. */
  actorUserId?: string;
  /** A payment's id: a second change with the same reference changes nothing (idempotent). */
  paymentRef?: string;
  note?: string;
  accountType?: AccountType;
  /** An exact end (admin "Set end date"); a date makes the account Paid until it, null makes it Free. */
  paidUntil?: string | null;
  /** Adds n × PAID_TERM to the later of now and paid_until (admin "Extend", a renewal); a Free account is Paid from now. */
  extendTerms?: number;
  /** Sets the daily AI budget override (UNLIMITED allowed), or removes it. */
  aiDailyBudget?: { micros: Limit } | 'clear';
}

const json = (value: unknown) => JSON.stringify(value);

/**
 * Applies the change in one transaction (the person's lock first: v3.0 D2) and writes one account_entitlement_events
 * row per field it changed. Answers the account's new state. 400 for an impossible change (Paid with an end in the past,
 * Free with a term), 404 for an account that does not exist. Inside a caller's transaction it joins it (a savepoint).
 */
export async function changeEntitlement(deps: Deps, change: EntitlementChange): Promise<AccountState> {
  const paymentRef = change.paymentRef?.trim() || undefined;
  if (paymentRef !== undefined && paymentRef.length > 200) throw validationFailed('A payment reference is at most 200 characters.');
  const note = change.note?.trim() ? change.note.trim().slice(0, 500) : null;
  const write = await deps.db.atomic(
    async (t) => {
      await t.lockPerson(change.userId);
      const row = await accountRow(deps, change.userId);
      if (!row) throw notFound('That account');
      // A payment's change is applied once: a retried webhook finds its earlier event and changes nothing.
      if (paymentRef !== undefined) {
        const seen = await t.one('SELECT 1 AS one FROM account_entitlement_events WHERE payment_ref = ? LIMIT 1', [paymentRef]);
        if (seen) return [] as EntitlementField[];
      }
      const now = deps.now();
      const nowIso = now.toISOString();
      const term = constantsOf(deps).get('PAID_TERM');
      let type = row.account_type;
      let until = row.paid_until;

      if (change.accountType === 'free') {
        if (change.extendTerms !== undefined || (change.paidUntil !== undefined && change.paidUntil !== null)) {
          throw validationFailed('A Free account has no Paid term: change the type or the term, not both.');
        }
        type = 'free';
        until = null;
      } else if (change.paidUntil !== undefined) {
        if (change.paidUntil === null) {
          if (change.accountType === 'paid') throw validationFailed('A Paid account needs an end date.');
          type = 'free';
          until = null;
        } else {
          const end = Date.parse(change.paidUntil);
          if (!Number.isFinite(end)) throw validationFailed('The end date is not a date.');
          if (change.extendTerms !== undefined) throw validationFailed('Set an end date or extend by terms, not both.');
          if (end <= now.getTime()) throw validationFailed('A Paid account cannot end in the past.');
          type = 'paid';
          until = new Date(end).toISOString();
        }
      }
      if (change.extendTerms !== undefined && change.accountType !== 'free') {
        if (!Number.isInteger(change.extendTerms) || change.extendTerms < 1) {
          throw validationFailed('Extend by a whole number of terms, 1 or more.');
        }
        const from = type === 'paid' && until !== null && until > nowIso ? until : nowIso;
        type = 'paid';
        until = addCalendarDuration(from, term, change.extendTerms).toISOString();
      } else if (change.accountType === 'paid' && change.paidUntil === undefined) {
        // Paid with neither an end nor terms: one term from now, unless a future end is there already.
        if (until === null || until <= nowIso) until = addCalendarDuration(nowIso, term).toISOString();
        type = 'paid';
      }

      const changed: EntitlementField[] = [];
      const record = async (field: EntitlementField, oldValue: string | null, newValue: string | null) => {
        await t.run(
          `INSERT INTO account_entitlement_events(user_id, field, old_value, new_value, source, actor_user_id, payment_ref,
             note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [change.userId, field, oldValue, newValue, change.source, change.actorUserId ?? null, paymentRef ?? null, note, nowIso],
        );
        changed.push(field);
      };
      if (type !== row.account_type || until !== row.paid_until) {
        await t.run('UPDATE users SET account_type = ?, paid_until = ?, updated_at = ? WHERE id = ?', [type, until, nowIso, change.userId]);
        if (type !== row.account_type) await record('account_type', json(row.account_type), json(type));
        if (until !== row.paid_until) await record('paid_until', json(row.paid_until), json(until));
      }

      if (change.aiDailyBudget !== undefined) {
        const before = await aiBudgetOverride(deps, change.userId);
        if (change.aiDailyBudget === 'clear') {
          if (before) {
            await t.run("DELETE FROM user_limit_overrides WHERE user_id = ? AND limit_key = 'ai_daily_budget'", [change.userId]);
            await record('ai_daily_budget', json(before.micros), null);
          }
        } else {
          const micros = change.aiDailyBudget.micros;
          if (micros !== UNLIMITED && (!Number.isSafeInteger(micros) || micros < 0 || micros > USD_MICROS_MAX)) {
            throw validationFailed('A daily AI budget is a dollar amount of 0 or more, or Unlimited.');
          }
          if (!before || before.micros !== micros) {
            await t.run(
              `INSERT INTO user_limit_overrides(user_id, limit_key, value, set_by, note, updated_at)
               VALUES (?, 'ai_daily_budget', ?, ?, ?, ?)
               ON CONFLICT(user_id, limit_key) DO UPDATE SET value = excluded.value, set_by = excluded.set_by,
                 note = excluded.note, updated_at = excluded.updated_at`,
              [change.userId, json(micros), change.actorUserId ?? null, note, nowIso],
            );
            await record('ai_daily_budget', before ? json(before.micros) : null, json(micros));
          }
        }
      }
      return changed;
    },
    { label: 'changeEntitlement' },
  );
  if (write.length > 0) {
    deps.log.info(
      `[accounts] account ${change.userId}: ${write.join(', ')} changed (${change.source}` +
        `${change.actorUserId ? `, admin ${change.actorUserId}` : ''})`,
    );
  }
  return accountStateOf(deps, change.userId);
}
