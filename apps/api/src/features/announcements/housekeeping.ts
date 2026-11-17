import { constantsOf } from '../../core/constants/index';
import type { DailyStep } from '../../core/feature';
import { DAY_MS } from '@tailorit/shared';

// v30 ST4: the announcements' step of the daily housekeeping (Feature.daily; was a step of features/account's
// housekeeping in v2.0). An announcement is kept ANNOUNCEMENT_KEEP_DAYS after it expired (the admin's list shows it as
// Expired till then); its dismissals go with it (ON DELETE CASCADE).

/** Announcements expired more than ANNOUNCEMENT_KEEP_DAYS ago. */
export const pruneExpiredAnnouncements: DailyStep = {
  name: 'expired',
  run: async (deps) => {
    const before = new Date(deps.now().getTime() - constantsOf(deps).get('ANNOUNCEMENT_KEEP_DAYS') * DAY_MS).toISOString();
    return (await deps.db.run('DELETE FROM announcements WHERE expires_at IS NOT NULL AND expires_at < ?', [before])).changes;
  },
};
