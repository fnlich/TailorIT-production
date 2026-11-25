import type { AdminReviewCounts } from '@tailorit/shared';
import type { DbQueries } from '../../core/db/types';

// v37 REVIEW (SP v37 PLAN.md R2: "the nav, header and bell counts equal the lanes' lists"): each review lane's items
// waiting for a decision, read the way the lanes list them (admin.ts listReviews, flags.ts listFlags: a review or a
// flag with its job and company), so a count never says more than its list can show. The counts route, every lane's
// page and the admins' hourly bell (notifications/housekeeping.ts) read this one query. A module of its own, free of
// the decisions' imports, so the notifications' housekeeping can read it.

/** A pending review of the lane `r`, with its job `j` and company `c` (the lanes' own joins). */
export const REVIEW_LANE_FROM = 'FROM job_reviews r JOIN jobs j ON j.id = r.job_id JOIN companies c ON c.id = j.company_id';
/** A flag `r` with its reporter `u`, its job `j` and company `c` (the Flags lane's own joins). */
export const FLAG_LANE_FROM =
  'FROM job_reports r JOIN users u ON u.id = r.user_id JOIN jobs j ON j.id = r.job_id JOIN companies c ON c.id = j.company_id';

/** Each lane's items needing a decision: pending reviews of each kind (Waiting: checking ones too), open flags. */
export async function reviewLaneCounts(db: DbQueries): Promise<AdminReviewCounts> {
  const row = await db.one<{ closed: number; new_job: number; flags: number }>(
    `SELECT (SELECT count(*) ${REVIEW_LANE_FROM} WHERE r.kind = 'closed' AND r.state = 'pending') AS closed,
       (SELECT count(*) ${REVIEW_LANE_FROM} WHERE r.kind = 'new_job' AND r.state = 'pending') AS new_job,
       (SELECT count(*) ${FLAG_LANE_FROM} WHERE r.status = 'open') AS flags`,
  );
  return { closed: Number(row?.closed ?? 0), newJob: Number(row?.new_job ?? 0), flags: Number(row?.flags ?? 0) };
}
