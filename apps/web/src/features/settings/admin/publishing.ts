// v31 ADMINWEB: Admin › Constants' "How new jobs are published" (docs/design/v3.1/21-jobs-from-links.md §1, decisions
// D1-D3, D12): the switches that decide when a job someone added becomes one everyone sees, at the top of the page,
// each with what it does now. Pure, so the tests read it without a page.

/**
 * The switches, in the order a job meets them: the read, a page's job published without an admin (v31 FIX-WEB: D12's
 * PAGE_JOBS_AUTO_PUBLISH), the approval of every new job, the list of links TailorIT could not read. A key the server
 * does not list is left out of the card.
 */
export const PUBLISHING_KEYS = ['ADD_JOB_PAGE_READ', 'PAGE_JOBS_AUTO_PUBLISH', 'NEW_JOBS_ADMIN_APPROVAL', 'EXT_NEW_PAGE_JOBS_REVIEW'] as const;
export type PublishingKey = (typeof PUBLISHING_KEYS)[number];

/** The card's first sentence. */
export const PUBLISHING_INTRO =
  "A job becomes one everyone can find only after TailorIT's server reads the posting from the job's own link (an ATS's API, or the page's own job data). Nothing a person, an admin, a file or the extension types is ever published.";

/** What a switch does now, by its value: "Now: …". */
export function publishingNow(key: PublishingKey, on: boolean): string {
  switch (key) {
    case 'NEW_JOBS_ADMIN_APPROVAL':
      return on
        ? 'Now: every new job TailorIT reads waits in Review › New jobs until an admin approves it. Its adder sees it meanwhile.'
        : "Now: a new job TailorIT reads from an ATS's API is published at once; a page's job follows the switch above.";
    case 'PAGE_JOBS_AUTO_PUBLISH':
      return on
        ? "Now: a job TailorIT reads from a careers page is published at once, as an ATS's job is."
        : 'Now: a job TailorIT reads from a careers page (not an ATS) waits in Review › New jobs until an admin approves what TailorIT read.';
    case 'ADD_JOB_PAGE_READ':
      return on
        ? "Now: when no ATS API reads a link, TailorIT reads the page's own job data (once BOT_USER_AGENT is set in .env)."
        : 'Now: only links an ATS API reads are verified. Other added jobs stay with the person who added them.';
    case 'EXT_NEW_PAGE_JOBS_REVIEW':
      return on
        ? "Now: links TailorIT couldn't read are listed in Review › Couldn't verify, to read again or reject."
        : "Now: Review › Couldn't verify lists nothing.";
  }
}

/** Where each switch's jobs are reviewed (a Review lane), if anywhere. */
export const PUBLISHING_LANE: Partial<Record<PublishingKey, { href: string; label: string }>> = {
  PAGE_JOBS_AUTO_PUBLISH: { href: '/settings/admin?tab=review&lane=new_job', label: 'Open New jobs' },
  NEW_JOBS_ADMIN_APPROVAL: { href: '/settings/admin?tab=review&lane=new_job', label: 'Open New jobs' },
  EXT_NEW_PAGE_JOBS_REVIEW: { href: '/settings/admin?tab=review&lane=unverified', label: "Open Couldn't verify" },
};

/** The toast after a switch changed. */
export const PUBLISHING_WORDS = { on: 'Switched on', off: 'Switched off' } as const;
