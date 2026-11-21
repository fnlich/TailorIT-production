import type { MessageKey, MessageParams } from '@tailorit/shared';
import {
  NOTIFICATION_BODY_MAX,
  NOTIFICATION_KIND_GROUP,
  NOTIFICATION_LINK_MAX,
  NOTIFICATION_TITLE_MAX,
  type NotificationKind,
} from '@tailorit/shared/notifications';
import { constantsOf } from '../../core/constants/service';
import { nowIso, type AppDeps } from '../../core/context';
import type { DbQueries } from '../../core/db/types';

// v3.1 NOTIFY (docs/design/v3.1/24-notifications-usage.md; D8): writing a notification. Every emitter calls notify (one
// person) or notifyAdmins (every admin), where its event happens:
// - inside the event's own transaction (it joins it through a savepoint: the notification commits with the event and
//   rolls back with it), or after the event committed; never in a transaction that may roll back without the event;
// - it never breaks or slows the event: one INSERT ... SELECT (the person's switch for the kind's group and the dedupe
//   key are read by the same statement), and any failure is caught, logged once and counted (notifyStats), never thrown.
// The words are the kind's message constants, rendered now with `params` (an admin's edit changes new notifications).

export type NotifyDeps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** What one notify call did. `skipped`: the person turned the group off, or the dedupe key was taken. */
export type NotifyOutcome = 'written' | 'skipped' | 'failed';

export interface NotifyInput {
  kind: NotificationKind;
  /** The placeholders of the kind's title and body messages ({title}, {company}, {ready}, ...). */
  params?: MessageParams;
  /** The body's sentences, in order; default: the kind's body message. */
  body?: readonly MessageKey[];
  /** Words added after the body as they are (a sentence the event already has in people's words), or null. */
  bodyExtra?: string | null;
  /** The title's message, when the kind has a second form (a job that is gone); default: the kind's title. */
  title?: MessageKey;
  /** A path inside TailorIT ("/jobs?jobId=12"); anything else is dropped. */
  link?: string | null;
  /** One notification per person and key: a second write of the same key is skipped. */
  dedupeKey?: string | null;
}

/** The words of each kind: its title and its body messages. */
export const NOTIFICATION_WORDS: Readonly<Record<NotificationKind, { title: MessageKey; body: MessageKey }>> = {
  prepare_finished: { title: 'MSG_NOTIFY_PREPARE_FINISHED_TITLE', body: 'MSG_NOTIFY_PREPARE_FINISHED_BODY' },
  prepare_failed: { title: 'MSG_NOTIFY_PREPARE_FAILED_TITLE', body: 'MSG_NOTIFY_PREPARE_FAILED_BODY' },
  auto_apply_submitted: { title: 'MSG_NOTIFY_AUTO_APPLY_SUBMITTED_TITLE', body: 'MSG_NOTIFY_AUTO_APPLY_SUBMITTED_BODY' },
  auto_apply_needs_you: { title: 'MSG_NOTIFY_AUTO_APPLY_NEEDS_YOU_TITLE', body: 'MSG_NOTIFY_AUTO_APPLY_NEEDS_YOU_BODY' },
  auto_apply_failed: { title: 'MSG_NOTIFY_AUTO_APPLY_FAILED_TITLE', body: 'MSG_NOTIFY_AUTO_APPLY_FAILED_BODY' },
  job_verified: { title: 'MSG_NOTIFY_JOB_VERIFIED_TITLE', body: 'MSG_NOTIFY_JOB_VERIFIED_BODY' },
  job_waiting: { title: 'MSG_NOTIFY_JOB_WAITING_TITLE', body: 'MSG_NOTIFY_JOB_WAITING_BODY' },
  job_unverified: { title: 'MSG_NOTIFY_JOB_UNVERIFIED_TITLE', body: 'MSG_NOTIFY_JOB_UNVERIFIED_BODY' },
  job_refused: { title: 'MSG_NOTIFY_JOB_REFUSED_TITLE', body: 'MSG_NOTIFY_JOB_REFUSED_BODY' },
  ai_budget_reached: { title: 'MSG_NOTIFY_AI_DAY_USED_TITLE', body: 'MSG_NOTIFY_AI_DAY_USED_BODY' },
  credit_low: { title: 'MSG_NOTIFY_CREDIT_LOW_TITLE', body: 'MSG_NOTIFY_CREDIT_LOW_BODY' },
  credit_used_up: { title: 'MSG_NOTIFY_CREDIT_USED_UP_TITLE', body: 'MSG_NOTIFY_CREDIT_USED_UP_BODY' },
  paid_ending: { title: 'MSG_NOTIFY_PAID_ENDING_TITLE', body: 'MSG_NOTIFY_PAID_ENDING_BODY' },
  extension_disconnected: { title: 'MSG_NOTIFY_EXTENSION_DISCONNECTED_TITLE', body: 'MSG_NOTIFY_EXTENSION_DISCONNECTED_BODY' },
  // v33 SHARE-0: shared profiles ({name}: the other person; sharing_prepared also {count}). SHARE-2 and SHARE-5 write them.
  sharing_invited: { title: 'MSG_NOTIFY_SHARING_INVITED_TITLE', body: 'MSG_NOTIFY_SHARING_INVITED_BODY' },
  sharing_changed: { title: 'MSG_NOTIFY_SHARING_CHANGED_TITLE', body: 'MSG_NOTIFY_SHARING_CHANGED_BODY' },
  sharing_accepted: { title: 'MSG_NOTIFY_SHARING_ACCEPTED_TITLE', body: 'MSG_NOTIFY_SHARING_ACCEPTED_BODY' },
  sharing_declined: { title: 'MSG_NOTIFY_SHARING_DECLINED_TITLE', body: 'MSG_NOTIFY_SHARING_DECLINED_BODY' },
  sharing_prepared: { title: 'MSG_NOTIFY_SHARING_PREPARED_TITLE', body: 'MSG_NOTIFY_SHARING_PREPARED_BODY' },
  sharing_ended: { title: 'MSG_NOTIFY_SHARING_ENDED_TITLE', body: 'MSG_NOTIFY_SHARING_ENDED_BODY' },
  // end v33 SHARE-0
  admin_review_items: { title: 'MSG_NOTIFY_ADMIN_REVIEW_TITLE', body: 'MSG_NOTIFY_ADMIN_REVIEW_BODY' },
  admin_run_failed: { title: 'MSG_NOTIFY_ADMIN_RUN_FAILED_TITLE', body: 'MSG_NOTIFY_ADMIN_RUN_FAILED_BODY' },
  admin_source_disabled: { title: 'MSG_NOTIFY_ADMIN_SOURCE_DISABLED_TITLE', body: 'MSG_NOTIFY_ADMIN_SOURCE_DISABLED_BODY' },
  admin_runs_paused: { title: 'MSG_NOTIFY_ADMIN_RUNS_PAUSED_TITLE', body: 'MSG_NOTIFY_ADMIN_RUNS_BODY' },
  admin_runs_continued: { title: 'MSG_NOTIFY_ADMIN_RUNS_CONTINUED_TITLE', body: 'MSG_NOTIFY_ADMIN_RUNS_BODY' },
};

/** What the emitters did since the process started (a failure is also logged). Tests and the admin's log read it. */
export const notifyStats = { written: 0, skipped: 0, failed: 0 };

/** `text` within `max` characters: cut at the last word that fits, with an ellipsis. */
export function clampText(text: string, max: number): string {
  const flat = text.trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** A path inside TailorIT, or null (another site, a protocol, or too long). */
export function safeLink(link: string | null | undefined): string | null {
  if (!link) return null;
  if (!link.startsWith('/') || link.startsWith('//') || link.startsWith('/\\') || link.length > NOTIFICATION_LINK_MAX) return null;
  // No control character (a line break, a NUL): a link is one plain path.
  return [...link].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f) ? null : link;
}

/** The kind's title and body as stored, rendered from the constants now. */
export function renderNotification(deps: NotifyDeps, input: NotifyInput): { title: string; body: string } {
  const constants = constantsOf(deps);
  const words = NOTIFICATION_WORDS[input.kind];
  const params = input.params ?? {};
  const title = clampText(constants.message(input.title ?? words.title, params), NOTIFICATION_TITLE_MAX);
  const sentences = (input.body ?? [words.body]).map((key) => constants.message(key, params));
  if (input.bodyExtra?.trim()) sentences.push(input.bodyExtra.trim());
  const body = clampText(sentences.filter((sentence) => sentence.trim() !== '').join(' '), NOTIFICATION_BODY_MAX);
  return { title, body };
}

/** The INSERT of one person's notification; its group's switch and the dedupe key are read by the same statement. */
const INSERT_ONE = `INSERT INTO notifications(user_id, kind, title, body, link, dedupe_key, admin_only, created_at)
  SELECT @user, @kind, @title, @body, @link, @dedupe, false, CAST(@now AS timestamptz)
   WHERE NOT EXISTS (SELECT 1 FROM notification_prefs p WHERE p.user_id = @user AND p.kind_group = @group AND NOT p.enabled)
  ON CONFLICT DO NOTHING
  RETURNING id`;

/** The INSERT of one notification for every active admin (but `except`), each with their own switch. */
const INSERT_ADMINS = `INSERT INTO notifications(user_id, kind, title, body, link, dedupe_key, admin_only, created_at)
  SELECT u.id, @kind, @title, @body, @link, @dedupe, true, CAST(@now AS timestamptz)
    FROM users u
   WHERE u.role = 'admin' AND u.disabled_at IS NULL AND u.id IS DISTINCT FROM @except
     AND NOT EXISTS (SELECT 1 FROM notification_prefs p WHERE p.user_id = u.id AND p.kind_group = @group AND NOT p.enabled)
  ON CONFLICT DO NOTHING
  RETURNING id`;

type Params = Record<string, string | number | boolean | null>;

/**
 * Runs the insert so that its failure can never abort the caller's transaction: inside one, in a savepoint of it (the
 * notification commits and rolls back with the event); outside, on its own.
 */
async function insert(deps: NotifyDeps, sql: string, params: Params): Promise<number> {
  return (await guarded(deps, (db) => db.all(sql, params))).length;
}

/**
 * Runs an emitter's statements so that their failure can never abort the caller's transaction: inside one, in a
 * savepoint of it; outside, on the client. The caller still catches the error.
 */
export function guarded<T>(deps: Pick<NotifyDeps, 'db'>, fn: (db: DbQueries) => Promise<T>): Promise<T> {
  return deps.db.inTx() ? deps.db.atomic((t) => fn(t), { label: 'notify' }) : fn(deps.db);
}

async function write(deps: NotifyDeps, what: string, sql: string, input: NotifyInput, params: Params): Promise<number> {
  try {
    const { title, body } = renderNotification(deps, input);
    const written = await insert(deps, sql, {
      ...params,
      kind: input.kind,
      group: NOTIFICATION_KIND_GROUP[input.kind],
      title,
      body,
      link: safeLink(input.link),
      dedupe: input.dedupeKey?.slice(0, 200) || null,
      now: nowIso(deps),
    });
    if (written > 0) notifyStats.written += written;
    else notifyStats.skipped += 1;
    return written;
  } catch (error) {
    notifyStats.failed += 1;
    // The kind and whom it was for; never its words (they may quote a job or an amount).
    deps.log.warn(`[notifications] ${input.kind} for ${what} was not written (${notifyStats.failed} so far)`, error);
    return -1;
  }
}

/**
 * Writes one notification for `userId` (D8): skipped when the person turned the kind's group off or the dedupe key is
 * taken. Never throws; inside a transaction it joins it (see above).
 */
export async function notify(deps: NotifyDeps, userId: string, input: NotifyInput): Promise<NotifyOutcome> {
  const written = await write(deps, `account ${userId}`, INSERT_ONE, input, { user: userId });
  return written < 0 ? 'failed' : written > 0 ? 'written' : 'skipped';
}

/**
 * Writes one notification for every active admin (admin_only), each with their own switch for the `admin` group and the
 * dedupe key; `exceptUserId` leaves one out (the admin whose own action it reports). Answers how many were written
 * (-1: failed). Never throws.
 */
export async function notifyAdmins(deps: NotifyDeps, input: NotifyInput & { exceptUserId?: string | null }): Promise<number> {
  return write(deps, 'the admins', INSERT_ADMINS, input, { except: input.exceptUserId ?? null });
}
