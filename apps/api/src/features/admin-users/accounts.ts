import {
  ADMIN_USERS_PAGE_DEFAULT,
  DAY_MS,
  type AccountType,
  type AdminAccountHistory,
  type AdminUser,
  type AdminUserList,
  type AdminUserListQuery,
  type CreditKind,
  type CreditLedgerEntry,
  type EntitlementEvent,
  type EntitlementField,
  type EntitlementSource,
  type Limit,
} from '@tailorit/shared';
import { effectiveType } from '../../core/accounts/index';
import { decodeCursor, encodeCursor, likeText, pageOf, Where } from '../../core/admin/index';
import type { UserRow } from '../../core/auth/users';
import { constantsOf, dayKeyAt } from '../../core/constants/index';
import type { AppDeps } from '../../core/context';
import type { SqlParam } from '../../core/db/index';
import { notFound, validationFailed } from '../../core/http/errors';

// v2.0: Admin › Users' reads (docs/design/v2.0/04-accounts-limits.md, "Admin routes (accounts)"; 08-ui.md). The list is
// paged for 100k accounts (newest first, a keyset cursor), and each row carries the account's type and term, its daily
// AI budget override, its extra credit, and its day so far (AI spent, written off, auto-applies). These are for the
// admin only: none of it ever reaches the person's own answers (GET /api/account shows the credit balance alone).
// v30 ST4: its cursors, LIKE text, filter and page are the admin base's (core/admin/paging.ts, moved there from here).

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

interface AdminUserRow extends UserRow {
  account_type: AccountType;
  paid_until: string | null;
  budget_override: string | null;
  credit_micros: number;
  ai_spent_micros: number;
  written_off_micros: number;
  auto_applies: number;
}

/** The row with its v2.0 columns; `:day` is today's day key. */
const ROW_SELECT = `SELECT u.*,
    (SELECT o.value FROM user_limit_overrides o WHERE o.user_id = u.id AND o.limit_key = 'ai_daily_budget') AS budget_override,
    coalesce((SELECT c.balance_after_micros FROM ai_credit_ledger c WHERE c.user_id = u.id ORDER BY c.id DESC LIMIT 1), 0)
      AS credit_micros,
    coalesce(s.daily_spent_micros + s.credit_spent_micros, 0) AS ai_spent_micros,
    coalesce(s.written_off_micros, 0) AS written_off_micros,
    (SELECT count(*) FROM auto_apply_reservations r
      WHERE r.user_id = u.id AND r.day_key = @day AND r.state IN ('reserved', 'used')) AS auto_applies
  FROM users u LEFT JOIN ai_spend_daily s ON s.user_id = u.id AND s.day_key = @day`;

function toAdminUser(row: AdminUserRow, now: Date): AdminUser {
  const override = row.budget_override === null ? undefined : (JSON.parse(row.budget_override) as Limit);
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    disabled: row.disabled_at !== null,
    createdAt: row.created_at,
    lastSignInAt: row.last_sign_in_at,
    accountType: row.account_type,
    effectiveType: effectiveType(row, now),
    paidUntil: row.paid_until,
    ...(override !== undefined ? { aiBudget: { override } } : {}),
    extraCreditMicros: row.credit_micros,
    today: {
      aiSpentMicros: row.ai_spent_micros,
      writtenOffMicros: row.written_off_micros,
      autoApplies: row.auto_applies,
    },
  };
}

/** One account's row. 404 for an account that does not exist. */
export async function adminUserOf(deps: Deps, userId: string): Promise<AdminUser> {
  const row = await deps.db.one<AdminUserRow>(`${ROW_SELECT} WHERE u.id = @id`, { day: dayKeyAt(deps), id: userId });
  if (!row) throw notFound('That account');
  return toAdminUser(row, deps.now());
}

// ------------------------------------------------------------------------------------------------------- cursors

const STALE_CURSOR = 'That page of accounts is out of date. Reload the list and try again.';

/** GET /api/admin/users: one page, newest account first. */
export async function listAdminUsers(deps: Deps, query: AdminUserListQuery): Promise<AdminUserList> {
  const now = deps.now();
  const nowIso = now.toISOString();
  const where = new Where();
  const d = deps.db.dialect;
  // Case-insensitive on both engines (LIKE folds ASCII on SQLite; ILIKE on PostgreSQL).
  if (query.q) where.add(`${d.like('u.email', '@q')} OR ${d.like('u.name', '@q')}`, { q: likeText(query.q) });
  // Each filter reads the effective type: a lapsed term is Free whatever account_type still says.
  if (query.type === 'paid' || query.type === 'paid_ending') {
    where.add("u.account_type = 'paid' AND u.paid_until > @now", { now: nowIso });
    // "Paid ending": a Paid term that ends within PAID_ENDING_DAYS (v20 FIX-A, REQ-11: a constant, one source).
    where.addIf(query.type === 'paid_ending', 'u.paid_until <= @ending', {
      ending: new Date(now.getTime() + constantsOf(deps).get('PAID_ENDING_DAYS') * DAY_MS).toISOString(),
    });
  } else if (query.type === 'free') {
    where.add("NOT (u.account_type = 'paid' AND u.paid_until IS NOT NULL AND u.paid_until > @now)", { now: nowIso });
  }
  if (query.cursor) {
    const { c, id } = decodeCursor(query.cursor, STALE_CURSOR);
    if (typeof c !== 'string' || typeof id !== 'string') throw validationFailed(STALE_CURSOR);
    where.add('u.created_at < @cursorAt OR (u.created_at = @cursorAt AND u.id < @cursorId)', { cursorAt: c, cursorId: id });
  }
  const limit = query.limit ?? ADMIN_USERS_PAGE_DEFAULT;
  const rows = await deps.db.all<AdminUserRow>(`${ROW_SELECT} ${where.sql()} ORDER BY u.created_at DESC, u.id DESC LIMIT @limit`, {
    ...(where.params as Record<string, SqlParam>),
    day: dayKeyAt(deps),
    limit: limit + 1,
  });
  return pageOf(rows, limit, (last) => ({ c: last.created_at, id: last.id }), (row) => toAdminUser(row, now));
}

// ------------------------------------------------------------------------------------------------------- history

/** History rows per stream on one page. */
export const HISTORY_PAGE = 50;

interface EventRow {
  id: number;
  field: EntitlementField;
  old_value: string | null;
  new_value: string | null;
  source: EntitlementSource;
  actor_user_id: string | null;
  actor_name: string | null;
  payment_ref: string | null;
  note: string | null;
  created_at: string;
}

interface CreditRow {
  id: number;
  kind: CreditKind;
  amount_micros: number;
  balance_after_micros: number;
  day_key: string | null;
  source: EntitlementSource;
  actor_user_id: string | null;
  actor_name: string | null;
  payment_ref: string | null;
  task_id: string | null;
  note: string | null;
  created_at: string;
}

const parseJson = (text: string | null): unknown => (text === null ? null : (JSON.parse(text) as unknown));
/** An event's stored value: JSON, except a daily budget's SQL NULL (no override), which is 'default'. */
const budgetValue = (field: string, text: string | null): unknown =>
  field === 'ai_daily_budget' && text === null ? 'default' : parseJson(text);
const actorOf = (id: string | null, name: string | null) => (id !== null && name !== null ? { id, name } : null);

/**
 * GET /api/admin/users/:id/history: the account's entitlement events and its credit ledger, each newest first, one page
 * of each. The cursor holds where each list stopped; a list that ended stays ended.
 */
export async function accountHistory(deps: Deps, userId: string, cursor?: string): Promise<AdminAccountHistory> {
  const exists = await deps.db.one('SELECT 1 AS one FROM users WHERE id = ?', [userId]);
  if (!exists) throw notFound('That account');
  let beforeEvent = Number.MAX_SAFE_INTEGER;
  let beforeCredit = Number.MAX_SAFE_INTEGER;
  if (cursor) {
    const { e, c } = decodeCursor(cursor, STALE_CURSOR);
    if (!Number.isSafeInteger(e) || !Number.isSafeInteger(c)) throw validationFailed(STALE_CURSOR);
    beforeEvent = e as number;
    beforeCredit = c as number;
  }
  const events = await deps.db.all<EventRow>(
    `SELECT e.*, a.name AS actor_name FROM account_entitlement_events e LEFT JOIN users a ON a.id = e.actor_user_id
      WHERE e.user_id = ? AND e.id < ? ORDER BY e.id DESC LIMIT ?`,
    [userId, beforeEvent, HISTORY_PAGE + 1],
  );
  const credit = await deps.db.all<CreditRow>(
    `SELECT c.*, a.name AS actor_name FROM ai_credit_ledger c LEFT JOIN users a ON a.id = c.actor_user_id
      WHERE c.user_id = ? AND c.id < ? ORDER BY c.id DESC LIMIT ?`,
    [userId, beforeCredit, HISTORY_PAGE + 1],
  );
  const eventPage = events.slice(0, HISTORY_PAGE);
  const creditPage = credit.slice(0, HISTORY_PAGE);
  const more = events.length > HISTORY_PAGE || credit.length > HISTORY_PAGE;
  // A list with no more rows continues from 0: nothing is below it.
  const nextEvent = events.length > HISTORY_PAGE ? eventPage[eventPage.length - 1]!.id : 0;
  const nextCredit = credit.length > HISTORY_PAGE ? creditPage[creditPage.length - 1]!.id : 0;
  return {
    events: eventPage.map(
      (row): EntitlementEvent => ({
        id: row.id,
        field: row.field,
        // v2.0 (INT, P8): a budget event's SQL NULL is "no override" (the type's budget): 'default', so it never reads
        // as JSON null, an Unlimited override.
        oldValue: budgetValue(row.field, row.old_value),
        newValue: budgetValue(row.field, row.new_value),
        source: row.source,
        actor: actorOf(row.actor_user_id, row.actor_name),
        paymentRef: row.payment_ref,
        note: row.note,
        createdAt: row.created_at,
      }),
    ),
    credit: creditPage.map(
      (row): CreditLedgerEntry => ({
        id: row.id,
        kind: row.kind,
        amountMicros: row.amount_micros,
        balanceAfterMicros: row.balance_after_micros,
        dayKey: row.day_key,
        source: row.source,
        actor: actorOf(row.actor_user_id, row.actor_name),
        paymentRef: row.payment_ref,
        taskId: row.task_id,
        note: row.note,
        createdAt: row.created_at,
      }),
    ),
    ...(more ? { nextCursor: encodeCursor({ e: nextEvent, c: nextCredit }) } : {}),
  };
}
