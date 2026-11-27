import { repostedAgo, toDate, type JobSort, type JobSummary } from '@tailorit/shared';
import { cardAge, type PostedDateKnown } from '../format'; // v38 FIX-APP (D7): PostedDateKnown

// v35 OPSWEB (PLAN H5): a list row's time. A job an admin's import reposted after it was posted shows "Reposted 1 hour
// ago" in place of its posted time; sorted by Recently updated, an update later than the repost still reads "Updated".

/** The row's age: its repost when there is one, else the card's own ("5 months ago", "Updated 3 days ago"). */
export function rowAge(job: Pick<JobSummary, 'postedAt' | 'updatedAt' | 'repostedAt'> & PostedDateKnown, sort: JobSort, now: number): { text: string; reposted: boolean } {
  const reposted = repostedAgo(job, now);
  if (reposted) {
    const updated = toDate(job.updatedAt ?? null)?.getTime() ?? 0;
    const repost = toDate(job.repostedAt ?? null)?.getTime() ?? 0;
    if (!(sort === 'updated' && updated > repost)) return { text: reposted, reposted: true };
  }
  return { text: cardAge(job, sort, now), reposted: false };
}
