import { DAY_MS, HOUR_MS } from '@tailorit/shared';
import { constantsOf } from '../../core/constants/service';
import { nowIso, type AppDeps } from '../../core/context';
import type { DailyStep } from '../../core/feature';
import { notifyExtensionDisconnected } from './emitters';
import { notify, notifyAdmins, type NotifyDeps } from './service';
import { unverifiedLinkCounts } from '../jobs/add/verification'; // v31 INT-1: LINK's "Couldn't verify" links

// v3.1 NOTIFY: the notifications' own upkeep and the notices no request makes.
// - retention (daily): notifications older than NOTIFICATIONS_KEEP_DAYS go, read or not, in batches;
// - notifyPaidEnding (the account's daily housekeeping calls it): a Paid term that ends within PAID_ENDING_DAYS;
// - the hourly pass (Feature.start, the API process): Review's new items for the admins, and extension connections
//   that ran out. Each notice is deduped, so a second process or a restart in the same hour writes nothing twice.

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** Rows one retention statement deletes at most (11 §8.1's batch). */
export const NOTIFICATIONS_DELETE_BATCH = 10_000;
/** How often the hourly pass runs (a technical interval, beside its code). */
export const NOTIFICATIONS_PASS_EVERY_MS = HOUR_MS;
/** The app_settings key of the last Review summary: the new items are those after it. */
export const REVIEW_SUMMARY_KEY = 'notifications:review-summary-at';

const PRUNE = `DELETE FROM notifications WHERE id IN (
    SELECT id FROM notifications WHERE created_at < CAST(? AS timestamptz) LIMIT ?)`;

/** notifications older than NOTIFICATIONS_KEEP_DAYS (idx_notifications_created), in batches outside any transaction. */
export const pruneNotifications: DailyStep = {
  name: 'retention',
  run: async (deps) => {
    const cutoff = new Date(deps.now().getTime() - constantsOf(deps).get('NOTIFICATIONS_KEEP_DAYS') * DAY_MS).toISOString();
    let total = 0;
    for (;;) {
      const deleted = (await deps.db.run(PRUNE, [cutoff, NOTIFICATIONS_DELETE_BATCH])).changes;
      total += deleted;
      if (deleted < NOTIFICATIONS_DELETE_BATCH) return total;
    }
  },
};

/** A day as people read it, in TailorIT's day zone: "November 24, 2026". */
function dateText(deps: Deps, iso: string): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: constantsOf(deps).get('DAY_RESET_TIME_ZONE') }).format(
    new Date(iso),
  );
}

/**
 * Paid terms that end within PAID_ENDING_DAYS (the account's daily step `paidEnding` calls it): one notice per term
 * (dedupe `paid-ending:<paid_until>`: an extended term gets its own when it nears its end). Answers how many were
 * written.
 */
export async function notifyPaidEnding(deps: Deps): Promise<number> {
  const now = deps.now();
  const until = new Date(now.getTime() + constantsOf(deps).get('PAID_ENDING_DAYS') * DAY_MS).toISOString();
  const ending = await deps.db.all<{ id: string; paid_until: string }>(
    `SELECT id, paid_until FROM users
      WHERE account_type = 'paid' AND disabled_at IS NULL AND paid_until > ? AND paid_until <= ?
      ORDER BY paid_until, id`,
    [now.toISOString(), until],
  );
  let written = 0;
  for (const { id, paid_until: paidUntil } of ending) {
    const days = Math.max(1, Math.ceil((Date.parse(paidUntil) - now.getTime()) / DAY_MS));
    const outcome = await notify(deps, id, {
      kind: 'paid_ending',
      params: { days, date: dateText(deps, paidUntil) },
      link: '/settings#account',
      dedupeKey: `paid-ending:${new Date(paidUntil).toISOString()}`,
    });
    if (outcome === 'written') written += 1;
  }
  return written;
}

/**
 * Review's items that arrived since the last summary, for the admins (`admin_review_items`); answers how many arrived.
 * The items: pending reviews, open reports and (v31 INT-1) LINK's "Couldn't verify" links (job_verifications: v31
 * FIX-LINK, a link counts when it is new to the list, not when it was checked again).
 */
export async function summarizeReviewItems(deps: NotifyDeps): Promise<number> {
  const now = nowIso(deps);
  const mark = await deps.db.one<{ at: string | null }>(
    `SELECT ${deps.db.dialect.jsonText('value', '$.at')} AS at FROM app_settings WHERE key = ?`,
    [REVIEW_SUMMARY_KEY],
  );
  const since = mark?.at ?? null;
  let arrived = 0;
  if (since !== null) {
    const counts = await deps.db.one<{ arrived: number; pending: number }>(
      `SELECT (SELECT count(*) FROM job_reviews WHERE state = 'pending' AND created_at > CAST(@since AS timestamptz))
            + (SELECT count(*) FROM job_reports WHERE status = 'open' AND created_at > CAST(@since AS timestamptz)) AS arrived,
              (SELECT count(*) FROM job_reviews WHERE state = 'pending')
            + (SELECT count(*) FROM job_reports WHERE status = 'open') AS pending`,
      { since },
    );
    const links = await unverifiedLinkCounts(deps, since);
    arrived = Number(counts?.arrived ?? 0) + links.arrived;
    const pending = Number(counts?.pending ?? 0) + links.pending;
    if (arrived > 0) {
      await notifyAdmins(deps, {
        kind: 'admin_review_items',
        params: { count: arrived, pending },
        link: '/settings/admin?tab=review',
        // v31 FIX-LINK (REV-BEH BEH-7): one notice per pass mark, so a second pass in one clock hour (a restart) that
        // counted new items still tells them; two processes passing from the same mark still write one.
        dedupeKey: `review:${since}`,
      });
    }
  }
  // The first pass only sets the mark: nothing that came before notifications existed is announced.
  await deps.db.run(
    `INSERT INTO app_settings(key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [REVIEW_SUMMARY_KEY, JSON.stringify({ at: now }), now],
  );
  return arrived;
}

/**
 * Extension connections that ran out since the last pass (within two passes, so a pass that missed its hour still
 * finds them), not revoked: one notice each (dedupe per connection). Answers how many were written.
 */
export async function notifyExpiredConnections(deps: NotifyDeps): Promise<number> {
  const now = deps.now();
  const rows = await deps.db.all<{ id: string; user_id: string; label: string }>(
    `SELECT t.id, t.user_id, t.label FROM extension_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.revoked_at IS NULL AND t.expires_at <= ? AND t.expires_at > ? AND u.disabled_at IS NULL`,
    [now.toISOString(), new Date(now.getTime() - 2 * NOTIFICATIONS_PASS_EVERY_MS).toISOString()],
  );
  let written = 0;
  for (const row of rows) {
    const outcome = await notifyExtensionDisconnected(deps, { userId: row.user_id, tokenId: row.id, label: row.label, expired: true });
    if (outcome === 'written') written += 1;
  }
  return written;
}

/** One hourly pass: each part on its own (one that throws is logged; the next still runs). */
export async function runHourlyPass(deps: NotifyDeps): Promise<void> {
  for (const [name, part] of [
    ['review summary', summarizeReviewItems],
    ['expired connections', notifyExpiredConnections],
  ] as const) {
    try {
      await part(deps);
    } catch (error) {
      deps.log.warn(`[notifications] the hourly ${name} failed; it runs again in an hour`, error);
    }
  }
}

/** Feature.start: the hourly pass, first an hour after start (the first review summary only sets its mark). */
export function startHourlyPass(deps: NotifyDeps): () => void {
  let running = false;
  const pass = () => {
    if (running) return;
    running = true;
    // runHourlyPass catches each part's error itself.
    void runHourlyPass(deps).finally(() => {
      running = false;
    });
  };
  // The review summary's mark is set at once, so its first hour counts from the start.
  void summarizeReviewItems(deps).catch((error: unknown) => deps.log.warn('[notifications] the review summary failed', error));
  const timer = setInterval(pass, NOTIFICATIONS_PASS_EVERY_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
