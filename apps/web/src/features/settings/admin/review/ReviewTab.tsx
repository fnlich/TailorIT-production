'use client';

import type { AdminReviewCounts } from '@tailorit/shared/reviews';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { AdminResourceTab } from '@/components/admin';
import { fetchReviewCounts, reviewKeys } from './api';
import { needingText, REVIEW_POLL_MS, reviewTabLabel, totalNeedingDecision } from './copy';
import { ReviewPane } from './ReviewPane';

// v30 X1-WEB: Admin › Review (docs/design/part2/14-extension-reports.md §6), replacing Admin › Reports: one queue "like
// Queue" (the owner's words) for the extension's closed-link reports and new jobs, and the Jobs page's flags, in three
// lanes (Closed links, New jobs, Flags) with their evidence, Approve and Reject, bulk actions and the auto-approve
// switches. The registry draws it in place of Reports once REVIEW_TAB_READY is true, and `?tab=reports` opens it on
// its Flags lane (ReviewPane reads the address).

/** Whether Admin › Review is built: the registry draws it (and stops drawing Reports) once true. */
export const REVIEW_TAB_READY = true;

/**
 * v30 FIX-WEB (REV-REQ REQ-8, 14 §15): the Review tab's name in the admin nav with what waits for a decision ("Review
 * (3)"), read every REVIEW_POLL_MS while the page is visible, so a report queue never piles up unseen.
 */
export function ReviewTabLabel({ label }: { label: string }) {
  const counts = useQuery({ queryKey: reviewKeys.counts, queryFn: ({ signal }) => fetchReviewCounts(signal), refetchInterval: REVIEW_POLL_MS });
  return <span data-review-nav-count={totalNeedingDecision(counts.data) ?? undefined}>{reviewTabLabel(label, counts.data)}</span>;
}

export function ReviewTab() {
  const [counts, setCounts] = useState<AdminReviewCounts | undefined>(undefined);
  const total = totalNeedingDecision(counts);
  return (
    <AdminResourceTab
      title="Review"
      description="Closed links and new jobs reported from the extension, and people's flags on postings. Approving a closed link closes it as a source's own read would; approving a new job puts it in everyone's job search."
      actions={
        total !== null && (
          <p className="text-sm font-medium text-foreground tabular-nums" data-review-total="">
            {needingText(total)}
          </p>
        )
      }
      sectionProps={{ 'data-review-tab': '' }}
      body={<ReviewPane onCounts={setCounts} />}
    />
  );
}
