import {
  ADMIN_NOTIFICATION_GROUPS,
  NOTIFICATION_GROUPS,
  NOTIFICATION_KIND_GROUP,
  NOTIFICATION_KIND_TONE,
  NOTIFICATION_KINDS,
  NOTIFICATION_UNREAD_COUNT_CAP,
  type Notification,
  type NotificationGroup,
  type NotificationKind,
  type NotificationList,
  type NotificationListQuery,
  type NotificationPrefs,
  type NotificationPrefsUpdate,
} from '@tailorit/shared/notifications';
import { nowIso, type AppDeps } from '../../core/context';
import { notFound, validationFailed } from '../../core/http/errors';

// v3.1 NOTIFY: a person's notifications and switches (the bell, the /notifications page, Settings › Notifications).
// Every read names the person; an admin_only notification shows while its person is an admin.

type Deps = Pick<AppDeps, 'db' | 'now'>;

/** Who reads: their id and whether they are an admin now. */
export interface Reader {
  id: string;
  admin: boolean;
}

interface NotificationRow {
  id: number;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  created_at: string;
  read_at: string | null;
}

const isKind = (kind: string): kind is NotificationKind => (NOTIFICATION_KINDS as readonly string[]).includes(kind);

function toNotification(row: NotificationRow): Notification | null {
  // A kind this version no longer knows (a row from a newer or older build) is left out, never shown half-read.
  if (!isKind(row.kind)) return null;
  return {
    id: String(row.id),
    kind: row.kind,
    group: NOTIFICATION_KIND_GROUP[row.kind],
    tone: NOTIFICATION_KIND_TONE[row.kind],
    title: row.title,
    body: row.body,
    link: row.link,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

/** The reader's rows: theirs, and an admin's notification only while they are an admin. */
const MINE = '(n.user_id = @user AND (NOT n.admin_only OR CAST(@admin AS boolean)))';

/** The SQL of the unread count (at most NOTIFICATION_UNREAD_COUNT_CAP): one read of the unread index. */
export const UNREAD_COUNT_SQL = `SELECT count(*) AS n FROM (
    SELECT 1 FROM notifications n WHERE ${MINE} AND n.read_at IS NULL LIMIT ${NOTIFICATION_UNREAD_COUNT_CAP}
  ) unread`;

/** Unread notifications, at most NOTIFICATION_UNREAD_COUNT_CAP (the bell says "99+" from it on). */
export async function unreadCount(deps: Deps, reader: Reader): Promise<number> {
  return (await deps.db.one<{ n: number }>(UNREAD_COUNT_SQL, { user: reader.id, admin: reader.admin }))?.n ?? 0;
}

/** A page's cursor: the last notification's id, as digits. */
function cursorOf(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  if (!/^\d{1,18}$/.test(raw)) throw validationFailed('That page of notifications is out of date: reload the list.');
  return Number(raw);
}

/** GET /api/notifications: one page, newest first; `unread` lists only unread ones. */
export async function listNotifications(deps: Deps, reader: Reader, query: NotificationListQuery): Promise<NotificationList> {
  const after = cursorOf(query.cursor);
  const rows = await deps.db.all<NotificationRow>(
    `SELECT n.id, n.kind, n.title, n.body, n.link, n.created_at, n.read_at FROM notifications n
      WHERE ${MINE}${query.unread ? ' AND n.read_at IS NULL' : ''}${after !== null ? ' AND n.id < CAST(@after AS bigint)' : ''}
      ORDER BY n.id DESC LIMIT ${query.limit + 1}`,
    { user: reader.id, admin: reader.admin, after },
  );
  const page = rows.slice(0, query.limit);
  const items = page.map(toNotification).filter((item): item is Notification => item !== null);
  return {
    items,
    nextCursor: rows.length > query.limit ? String(page[page.length - 1]!.id) : null,
    unread: await unreadCount(deps, reader),
  };
}

/** A notification id as stored (digits), or 404: a malformed id names no notification. */
export function notificationIdOf(raw: string | undefined): number {
  if (!raw || !/^\d{1,18}$/.test(raw)) throw notFound('That notification');
  return Number(raw);
}

/** POST /api/notifications/:id/read: marks one read (already read: nothing changes). 404 when it is not the reader's. */
export async function markRead(deps: Deps, reader: Reader, id: number): Promise<void> {
  const row = await deps.db.one<{ id: number }>(
    `UPDATE notifications n SET read_at = coalesce(n.read_at, CAST(@now AS timestamptz))
      WHERE n.id = CAST(@id AS bigint) AND ${MINE} RETURNING n.id`,
    { id, user: reader.id, admin: reader.admin, now: nowIso(deps) },
  );
  if (!row) throw notFound('That notification');
}

/** POST /api/notifications/read-all: every unread notification of the reader's read now. Answers how many. */
export async function markAllRead(deps: Deps, reader: Reader): Promise<number> {
  return (
    await deps.db.run(`UPDATE notifications n SET read_at = CAST(@now AS timestamptz) WHERE ${MINE} AND n.read_at IS NULL`, {
      user: reader.id,
      admin: reader.admin,
      now: nowIso(deps),
    })
  ).changes;
}

/** The groups the reader may get: every group, `admin` for admins only. */
export const groupsOf = (reader: Reader): NotificationGroup[] =>
  NOTIFICATION_GROUPS.filter((group) => reader.admin || !ADMIN_NOTIFICATION_GROUPS.includes(group));

/** GET /api/notifications/prefs: each group the reader may get, on unless they turned it off. */
export async function prefsOf(deps: Deps, reader: Reader): Promise<NotificationPrefs> {
  const rows = await deps.db.all<{ kind_group: NotificationGroup; enabled: boolean }>(
    'SELECT kind_group, enabled FROM notification_prefs WHERE user_id = ?',
    [reader.id],
  );
  const off = new Set(rows.filter((row) => !deps.db.dialect.isTrue(row.enabled)).map((row) => row.kind_group));
  return { groups: groupsOf(reader).map((group) => ({ group, enabled: !off.has(group) })) };
}

/** PUT /api/notifications/prefs: sets the named groups' switches. 400 for a group the reader may not get. */
export async function updatePrefs(deps: Deps, reader: Reader, update: NotificationPrefsUpdate): Promise<NotificationPrefs> {
  const allowed = new Set(groupsOf(reader));
  const refused = update.groups.find((pref) => !allowed.has(pref.group));
  if (refused) throw validationFailed('Only admins get admin notifications.', { groups: 'Only admins get admin notifications.' });
  const now = nowIso(deps);
  await deps.db.tx(
    async (t) => {
      for (const pref of update.groups) {
        await t.run(
          `INSERT INTO notification_prefs(user_id, kind_group, enabled, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id, kind_group) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
          [reader.id, pref.group, t.dialect.bool(pref.enabled), now],
        );
      }
    },
    { label: 'notification prefs' },
  );
  return prefsOf(deps, reader);
}
