import { randomUUID } from 'node:crypto';
import type { AdminAnnouncement, Announcement, AnnouncementBody, AnnouncementSeverity } from '@tailorit/shared';
import { constantsOf } from '../../core/constants/index';
import type { AppDeps } from '../../core/context';
import { notFound, validationFailed } from '../../core/http/errors';

// v2.0: admin announcements (A19; docs/design/v2.0/01-data-model.md 0826, 08-ui.md). Plain text, shown to every
// signed-in person until it expires or they dismiss it; a dismissal is theirs alone. This module is the only writer of
// announcements and announcement_dismissals. The daily housekeeping deletes one ANNOUNCEMENT_KEEP_DAYS after it expired.

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** Admin › Announcements lists at most this many, newest first (expired ones are deleted after a while anyway). */
export const ADMIN_ANNOUNCEMENTS_MAX = 500;

interface AnnouncementRow {
  id: string;
  title: string;
  body: string;
  severity: AnnouncementSeverity;
  expires_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function toAnnouncement(row: AnnouncementRow): Announcement {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    severity: row.severity,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The person's banner: the announcements that have not expired and that they have not dismissed, the most severe
 * first, then the newest, at most ANNOUNCEMENTS_SHOWN_MAX.
 */
export async function activeAnnouncements(deps: Deps, userId: string): Promise<Announcement[]> {
  const rows = await deps.db.all<AnnouncementRow>(
    `SELECT a.* FROM announcements a
      WHERE (a.expires_at IS NULL OR a.expires_at > ?)
        AND NOT EXISTS (SELECT 1 FROM announcement_dismissals d WHERE d.announcement_id = a.id AND d.user_id = ?)
      ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, a.created_at DESC, a.id
      LIMIT ?`,
    [deps.now().toISOString(), userId, constantsOf(deps).get('ANNOUNCEMENTS_SHOWN_MAX')],
  );
  return rows.map(toAnnouncement);
}

/** The person dismisses one announcement, for themselves only. 404 when there is no such announcement. */
export async function dismissAnnouncement(deps: Deps, userId: string, id: string): Promise<void> {
  await deps.db.tx(
    async (t) => {
      const exists = await t.one('SELECT 1 AS one FROM announcements WHERE id = ?', [id]);
      if (!exists) throw notFound('That announcement');
      // A second dismissal (two tabs at once) finds the key taken and changes nothing.
      await t.run(t.dialect.insertOrIgnore('announcement_dismissals(user_id, announcement_id, dismissed_at) VALUES (?, ?, ?)'), [
        userId,
        id,
        deps.now().toISOString(),
      ]);
    },
    { label: 'dismissAnnouncement' },
  );
}

interface AdminRow extends AnnouncementRow {
  dismissed_count: number;
  creator_name: string | null;
}

function toAdminAnnouncement(row: AdminRow, now: string): AdminAnnouncement {
  return {
    ...toAnnouncement(row),
    active: row.expires_at === null || row.expires_at > now,
    dismissedCount: row.dismissed_count,
    createdBy: row.created_by !== null && row.creator_name !== null ? { id: row.created_by, name: row.creator_name } : null,
  };
}

const ADMIN_SELECT = `SELECT a.*, u.name AS creator_name,
    (SELECT count(*) FROM announcement_dismissals d WHERE d.announcement_id = a.id) AS dismissed_count
  FROM announcements a LEFT JOIN users u ON u.id = a.created_by`;

async function adminRow(deps: Deps, id: string): Promise<AdminAnnouncement> {
  const row = await deps.db.one<AdminRow>(`${ADMIN_SELECT} WHERE a.id = ?`, [id]);
  if (!row) throw notFound('That announcement');
  return toAdminAnnouncement(row, deps.now().toISOString());
}

/** Admin › Announcements: every announcement, expired ones too, newest first. */
export async function adminAnnouncements(deps: Deps): Promise<AdminAnnouncement[]> {
  const now = deps.now().toISOString();
  const rows = await deps.db.all<AdminRow>(`${ADMIN_SELECT} ORDER BY a.created_at DESC, a.id LIMIT ?`, [ADMIN_ANNOUNCEMENTS_MAX]);
  return rows.map((row) => toAdminAnnouncement(row, now));
}

const EXPIRY_IN_PAST = 'Choose an expiry in the future, or no expiry.';

/** The expiry as stored (ISO-8601 UTC): 400 when it is not after now. */
function futureExpiry(deps: Deps, expiresAt: string | null): string | null {
  if (expiresAt === null) return null;
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at) || at <= deps.now().getTime()) throw validationFailed(EXPIRY_IN_PAST, { expiresAt: EXPIRY_IN_PAST });
  return new Date(at).toISOString();
}

/** Publishes an announcement to everyone at once. */
export async function createAnnouncement(deps: Deps, adminId: string, body: AnnouncementBody): Promise<AdminAnnouncement> {
  const expiresAt = futureExpiry(deps, body.expiresAt);
  const id = randomUUID();
  const now = deps.now().toISOString();
  await deps.db.run(
    `INSERT INTO announcements(id, title, body, severity, expires_at, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, body.title, body.body, body.severity, expiresAt, adminId, now, now],
  );
  deps.log.info(`[announcements] ${id} published by admin ${adminId}`);
  return adminRow(deps, id);
}

/**
 * Edits one. A new expiry must be in the future; an unchanged one is kept as it is (an expired announcement's text can
 * still be corrected). Dismissals are kept: a person who dismissed it does not see it again.
 */
export async function updateAnnouncement(
  deps: Deps,
  adminId: string,
  id: string,
  body: AnnouncementBody,
): Promise<AdminAnnouncement> {
  await deps.db.tx(
    async (t) => {
      const row = await t.one<{ expires_at: string | null }>('SELECT expires_at FROM announcements WHERE id = ?', [id]);
      if (!row) throw notFound('That announcement');
      const unchanged =
        body.expiresAt !== null && row.expires_at !== null && Date.parse(body.expiresAt) === Date.parse(row.expires_at);
      const expiresAt = unchanged ? row.expires_at : futureExpiry(deps, body.expiresAt);
      await t.run('UPDATE announcements SET title = ?, body = ?, severity = ?, expires_at = ?, updated_at = ? WHERE id = ?', [
        body.title,
        body.body,
        body.severity,
        expiresAt,
        deps.now().toISOString(),
        id,
      ]);
    },
    { label: 'updateAnnouncement' },
  );
  deps.log.info(`[announcements] ${id} edited by admin ${adminId}`);
  return adminRow(deps, id);
}

/** Deletes one, with its dismissals. 404 when there is none. */
export async function deleteAnnouncement(deps: Deps, adminId: string, id: string): Promise<void> {
  const deleted = (await deps.db.run('DELETE FROM announcements WHERE id = ?', [id])).changes;
  if (deleted === 0) throw notFound('That announcement');
  deps.log.info(`[announcements] ${id} deleted by admin ${adminId}`);
}
