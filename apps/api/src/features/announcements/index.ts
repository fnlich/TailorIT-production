import type { Feature } from '../../core/feature';
import { pruneExpiredAnnouncements } from './housekeeping';
import { createAdminAnnouncementsRouter, createAnnouncementsRouter } from './router';

// v2.0 (P6b; A19, 0826): the active announcements a person sees and their dismissals (session), and the admin's
// publish, edit and delete (admin only). v30 ST4: its daily step (housekeeping.ts) deletes expired ones after a while.
export const announcementsFeature: Feature = {
  name: 'announcements',
  routes: [
    { path: '/api/announcements', router: createAnnouncementsRouter },
    { path: '/api/admin/announcements', router: createAdminAnnouncementsRouter },
  ],
  daily: [pruneExpiredAnnouncements],
};
