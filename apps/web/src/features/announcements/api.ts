import {
  AdminAnnouncementListSchema,
  AdminAnnouncementSchema,
  AnnouncementListSchema,
  type AdminAnnouncement,
  type AdminAnnouncementList,
  type AnnouncementBodyInput,
  type AnnouncementList,
} from '@tailorit/shared/announcements';
// Relative, not '@/': the web tests read these.
import { api } from '../../lib/api';

// v2.0: the announcements' routes (docs/design/v2.0/08-ui.md, "The announcement banner"; A19). Everyone reads the
// active ones they have not dismissed; admins write them in Admin › Announcements.

export const announcementKeys = {
  /** GET /api/announcements: the signed-in person's banner. */
  active: ['announcements', 'active'] as const,
  /** GET /api/admin/announcements: every announcement, expired ones too. */
  admin: ['admin', 'announcements'] as const,
};

/** How long the banner's read is fresh (08: React Query, 5 minutes, and again on focus). */
export const ANNOUNCEMENTS_STALE_MS = 5 * 60_000;

/** GET /api/announcements: active and not dismissed, most severe first, at most ANNOUNCEMENTS_SHOWN_MAX. */
export function fetchAnnouncements(signal?: AbortSignal): Promise<AnnouncementList> {
  return api.get<AnnouncementList>('/api/announcements', { signal, schema: AnnouncementListSchema });
}

/** POST /api/announcements/:id/dismiss: gone for this person only. */
export async function dismissAnnouncement(id: string): Promise<void> {
  await api.post(`/api/announcements/${encodeURIComponent(id)}/dismiss`);
}

/** GET /api/admin/announcements (admin). */
export function fetchAdminAnnouncements(signal?: AbortSignal): Promise<AdminAnnouncementList> {
  return api.get<AdminAnnouncementList>('/api/admin/announcements', { signal, schema: AdminAnnouncementListSchema });
}

/** POST /api/admin/announcements (admin): published to everyone at once. */
export function createAnnouncement(body: AnnouncementBodyInput): Promise<AdminAnnouncement> {
  return api.post<AdminAnnouncement>('/api/admin/announcements', body, { schema: AdminAnnouncementSchema });
}

/** PUT /api/admin/announcements/:id (admin). */
export function updateAnnouncement(id: string, body: AnnouncementBodyInput): Promise<AdminAnnouncement> {
  return api.put<AdminAnnouncement>(`/api/admin/announcements/${encodeURIComponent(id)}`, body, {
    schema: AdminAnnouncementSchema,
  });
}

/** DELETE /api/admin/announcements/:id (admin). */
export async function deleteAnnouncement(id: string): Promise<void> {
  await api.delete(`/api/admin/announcements/${encodeURIComponent(id)}`);
}
