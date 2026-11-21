import { UNLIMITED, aiUsePercent } from '@tailorit/shared';
import { NOTIFICATION_UNREAD_COUNT_CAP, type HeaderSummary } from '@tailorit/shared/notifications';
import { entitlementsFrom, overrideOf, type AccountRow } from '../../core/accounts/entitlements';
import { dayKeyAt, nextDailyResetAt } from '../../core/constants/index';
import type { AppDeps } from '../../core/context';
import { notFound } from '../../core/http/errors';
import type { Reader } from './store';
import { HEADER_INVITE_COLUMNS } from '../sharing/header-sql'; // v33 SHARE-2
import { headerInviteParams, noticeInvites } from '../sharing/invites'; // v33 SHARE-2

// v3.1 NOTIFY (D9): GET /api/me/header, what the top bar shows on every page (it asks every 60 s while the page is
// shown, and on focus): the unread count, today's server-AI use against the person's daily budget, the extra credit
// left ("Extra usage"), the plan. ONE statement: the account row, the budget override, today's spend, the newest credit
// row and the unread count are scalar reads by primary key or index; the budget and the plan are then resolved in
// memory exactly as aiBudgetState and entitlementsOf do (core/accounts), with the constants of this moment.
//
// D9 shows the person their own day's use against their budget (v2.0 kept the budget from people; the owner asked for
// the usage in the header). The budget constants stay out of the public subset: this answers the person's own numbers.
// v32 ADMINAPP (E7, the owner's "user can't see daily usage limit exact value (only can see percent)"): a person's
// answer carries the share only (`ai.percent`, aiUsePercent: as the header rounds it; null: no daily limit) and the
// reset; the amounts (`usedMicros`, `budgetMicros`) go to an admin's own header alone. Extra usage keeps its amount.

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

interface HeaderRow extends AccountRow {
  budget_override: string | null;
  daily_spent: number | null;
  credit: number | null;
  unread: number;
  // v33 SHARE-2: the sharing invites waiting for the reader, and those without their notice yet (HEADER_INVITE_COLUMNS).
  email: string;
  invites: number;
  invites_unnoticed: number;
  // end v33 SHARE-2
}

/** The header's one statement: @user, @admin, @day; v33 SHARE-2: @now, @sharing (headerInviteParams). */
export const HEADER_SQL = `SELECT u.account_type, u.paid_until, u.email,
    (SELECT CAST(o.value AS text) FROM user_limit_overrides o WHERE o.user_id = u.id AND o.limit_key = 'ai_daily_budget') AS budget_override,
    (SELECT s.daily_spent_micros FROM ai_spend_daily s WHERE s.user_id = u.id AND s.day_key = @day) AS daily_spent,
    -- creditBalance's read (CREDIT_BALANCE_SQL): the newest ledger row's balance.
    (SELECT l.balance_after_micros FROM ai_credit_ledger l WHERE l.user_id = u.id ORDER BY l.id DESC LIMIT 1) AS credit,
    (SELECT count(*) FROM (
       SELECT 1 FROM notifications n
        WHERE n.user_id = u.id AND n.read_at IS NULL AND (NOT n.admin_only OR CAST(@admin AS boolean))
        LIMIT ${NOTIFICATION_UNREAD_COUNT_CAP}) unread) AS unread,
    ${HEADER_INVITE_COLUMNS}
  FROM users u WHERE u.id = @user`;

/** The header's summary for the reader (one statement). 404 for an account that is gone. */
export async function headerSummary(deps: Deps, reader: Reader): Promise<HeaderSummary> {
  const now = deps.now();
  const sharing = headerInviteParams(deps); // v33 SHARE-2
  const row = await deps.db.one<HeaderRow>(HEADER_SQL, { user: reader.id, admin: reader.admin, day: dayKeyAt(deps, now), ...sharing });
  if (!row) throw notFound('That account');
  // v33 SHARE-2 (PLAN-sharing.md §2 "Invite notices"): an invite's notice is written the first time its person's header
  // counts it (never when it is sent: that would tell the sender who has an account).
  const noticed = Number(row.invites_unnoticed) > 0 ? await noticeInvites(deps, { id: reader.id, email: row.email }) : 0;
  // end v33 SHARE-2
  const override = overrideOf(row.budget_override === null ? undefined : { value: row.budget_override });
  const entitlements = entitlementsFrom(deps, row, override);
  const budget = entitlements.aiDailyBudgetMicros;
  const usedMicros = Math.max(0, row.daily_spent ?? 0);
  const budgetMicros = budget === UNLIMITED ? null : budget;
  return {
    unread: Math.min(NOTIFICATION_UNREAD_COUNT_CAP, row.unread + noticed), // v33 SHARE-2: + the notices just written
    ai: {
      ...(reader.admin ? { usedMicros, budgetMicros } : {}), // v32 ADMINAPP (E7): amounts for admins only
      percent: aiUsePercent(usedMicros, budgetMicros),
      resetsAt: nextDailyResetAt(deps, now).toISOString(),
    },
    extraCredit: { balanceMicros: Math.max(0, row.credit ?? 0) },
    plan: entitlements.type,
    paidUntil: entitlements.type === 'paid' ? row.paid_until : null,
    ...(sharing.sharing ? { invites: Number(row.invites) } : {}), // v33 SHARE-2: absent while sharing is off
  };
}
