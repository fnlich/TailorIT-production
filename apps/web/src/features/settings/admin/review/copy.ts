import { ATS_NAMES, type AtsKind } from '@tailorit/shared/autofill';
import {
  ADMIN_BULK_MAX,
  firstReviewLane,
  REVIEW_CHECK_LABEL,
  REVIEW_DECIDER_LABEL,
  REVIEW_GROUP_LABEL,
  REVIEW_SIGNAL_LABEL,
  REVIEW_STATE_DEFAULT,
  REVIEW_STATE_FILTER_LABEL,
  REVIEW_STATE_FILTERS,
  REVIEW_STATE_LABEL,
  reviewStateBase,
  type AdminFlag,
  type AdminReviewCounts,
  type AdminReviewRow,
  type JobReviewStrength,
  type JobReviewVia,
  type ReviewLane,
  type ReviewStateFilter,
} from '@tailorit/shared/reviews';
import { JOB_SOURCE_KIND_LABEL, type JobSourceKind } from '@tailorit/shared/sourcing';
import type { StateIconName, StateTone } from '../../../../components/queue';
import { ADMIN_REVIEW_LANES, ADMIN_REVIEW_LANE_LABEL, REASON_ADMIN_TEXT, type AdminReviewLane } from './unverified'; // v31 ADMINWEB
import type { JobVerifyReason } from '@tailorit/shared/jobs'; // v32 ADMINAPP (E6)

// v30 X1-WEB: Admin › Review's words and rules, apart from its components so the tests read them (docs/design/part2/
// 14-extension-reports.md §6.2): the lanes and their counts, a row's lines (origin, people, signal, check, state),
// the groups, the bulk actions' requests and their summary, the auto-approve switches' rules, the sheet's words.
// The vocabulary is CT's (@tailorit/shared/reviews); the words here are the page's own.

/** How often the open lane is read again while the tab is visible (14 §6.2), paused while an action is in flight. */
export const REVIEW_POLL_MS = 30_000;
/** A search waits this long after the last key before it is sent. */
export const REVIEW_SEARCH_DEBOUNCE_MS = 300;

// The lanes ------------------------------------------------------------------------------------------------------------

/**
 * The lane the address opens: `?tab=reports` (Admin › Reports' old address) opens Flags; `?lane=` names one (v31
 * ADMINWEB: `unverified` too). v37 REVIEW (SP v37 PLAN.md R4): else none (null): the page opens on the first lane with
 * items (openingLane).
 */
export function laneFromAddress(tab: string | null, lane: string | null): AdminReviewLane | null {
  if (tab === 'reports') return 'flags';
  return (ADMIN_REVIEW_LANES as readonly string[]).includes(lane ?? '') ? (lane as AdminReviewLane) : null;
}

/**
 * v37 REVIEW (R4): the lane Review opens on: the address's, else the first lane with items (Closed links, New jobs,
 * Flags, Couldn't verify: shared firstReviewLane, the admins' bell's link too), once the counts are read (null until
 * then; Closed links when they could not be read).
 */
export function openingLane(
  address: AdminReviewLane | null,
  counts: AdminReviewCounts | undefined,
  unverified: number | null,
  unreadable = false,
): AdminReviewLane | null {
  if (address) return address;
  if (counts && unverified !== null) return firstReviewLane({ ...counts, unverified });
  return unreadable ? 'closed' : null;
}

/**
 * A lane's count of items needing a decision. v31 ADMINWEB: "Couldn't verify" counts its links (`unverified`, from
 * GET /api/admin/jobs/unverified/count; null while it loads).
 */
export function laneCount(counts: AdminReviewCounts | undefined, lane: AdminReviewLane, unverified: number | null = null): number | null {
  if (lane === 'unverified') return unverified;
  if (!counts) return null;
  return lane === 'closed' ? counts.closed : lane === 'new_job' ? counts.newJob : counts.flags;
}

/** Every lane's items needing a decision: the header's count (v31 ADMINWEB: "Couldn't verify"'s links added once known). */
export function totalNeedingDecision(counts: AdminReviewCounts | undefined, unverified: number | null = null): number | null {
  return counts ? counts.closed + counts.newJob + counts.flags + (unverified ?? 0) : null;
}

/** v30 FIX-WEB (REQ-8): the admin nav's "Review (3)": the label alone while the counts load, or when nothing waits. */
export function reviewTabLabel(label: string, counts: AdminReviewCounts | undefined, unverified: number | null = null): string {
  const total = totalNeedingDecision(counts, unverified);
  return total ? `${label} (${total.toLocaleString('en-US')})` : label;
}

/** "Closed links (3)", or the label alone while the counts load. */
export function laneLabel(lane: AdminReviewLane, counts: AdminReviewCounts | undefined, unverified: number | null = null): string {
  const count = laneCount(counts, lane, unverified);
  // v37 REVIEW: thousands written as the nav writes them ("New jobs (1,240)").
  return count === null ? ADMIN_REVIEW_LANE_LABEL[lane] : `${ADMIN_REVIEW_LANE_LABEL[lane]} (${count.toLocaleString('en-US')})`;
}

/** The header's count in words: "3 need a decision", "1 needs a decision", "Nothing to decide". */
export function needingText(total: number): string {
  if (total === 0) return 'Nothing to decide';
  return `${total.toLocaleString('en-US')} ${total === 1 ? 'needs' : 'need'} a decision`; // v37 REVIEW: "1,000 need a decision"
}

/**
 * The state filters a lane offers: Flags has no TailorIT check, so no Checking ("Couldn't verify" shows none). v37
 * REVIEW (R2): Waiting first (every pending one, the default); on Flags it is the open flags, so no Needs review apart.
 */
export function stateFiltersOf(lane: AdminReviewLane): readonly ReviewStateFilter[] {
  return lane === 'flags' ? REVIEW_STATE_FILTERS.filter((state) => state !== 'checking' && state !== 'needs_review') : REVIEW_STATE_FILTERS;
}

/** The state filter kept on a lane change: one the lane has no filter for falls back to Waiting. */
export function stateForLane(lane: AdminReviewLane, state: ReviewStateFilter): ReviewStateFilter {
  return stateFiltersOf(lane).includes(state) ? state : REVIEW_STATE_DEFAULT;
}

/**
 * v37 REVIEW (R2): whether a lane's view is narrowed (a search, New jobs' From filter, or Needs review / Checking within
 * Waiting): its header then says "12 of 340".
 */
export function viewNarrowed(state: ReviewStateFilter, q: string, fromFiltered: boolean): boolean {
  return q.trim() !== '' || fromFiltered || reviewStateBase(state) !== state;
}

/**
 * v37 REVIEW (R2): a lane's header count: what its list can show (`total`), and while the view is narrowed "12 of 340"
 * (the view's rows without the search or the From filter: `unfiltered`). Null while the list loads.
 */
export function laneHeadCount(
  page: { total: number; unfiltered: number } | undefined,
  narrowed: boolean,
): { count: number | null; text: string | null } {
  if (!page) return { count: null, text: null };
  if (!narrowed) return { count: page.total, text: null };
  return { count: null, text: `${page.total.toLocaleString('en-US')} of ${page.unfiltered.toLocaleString('en-US')}` };
}

export const stateFilterLabel = (state: ReviewStateFilter) => REVIEW_STATE_FILTER_LABEL[state];

/** A lane's empty state, by its filter and search. */
export function emptyText(lane: ReviewLane, state: ReviewStateFilter, searching: boolean): { title: string; description?: string } {
  const things = lane === 'closed' ? 'closed links' : lane === 'new_job' ? 'new jobs' : 'flags';
  if (searching) return { title: `No ${things} match your search`, description: 'Search by job title or company.' };
  if (state === 'waiting' || state === 'needs_review' || state === 'checking') {
    const descriptions: Record<ReviewLane, string> = {
      closed: 'When the extension or the Jobs page reports a posting as closed, it shows up here.',
      new_job: 'When someone adds a job TailorIT did not have, it waits here before others can find it.',
      flags: 'When someone flags a job on the Jobs page, it shows up here.',
    };
    return { title: state === 'checking' ? `TailorIT is not checking any ${things}` : `No ${things} to review`, description: descriptions[lane] };
  }
  return { title: state === 'decided' ? `No decided ${things} yet` : `No ${things} yet` };
}

// A row's lines ---------------------------------------------------------------------------------------------------------

/** "1 person", "3 people". */
export function peopleText(count: number): string {
  return `${count} ${count === 1 ? 'person' : 'people'}`;
}

/** A platform's name ("Greenhouse"), from the extension's names, else the source kind's, else as written. */
export function platformName(platform: string): string {
  return ATS_NAMES[platform as AtsKind] ?? JOB_SOURCE_KIND_LABEL[platform as JobSourceKind] ?? platform;
}

/** The apply platforms that are no ATS: a company's own page (`site`), or no link to tell (`unknown`). */
const PAGE_PLATFORMS: ReadonlySet<string> = new Set(['site', 'unknown']);

/** A link's host ("careers.example.com"), or null for no readable link. */
function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/**
 * A new job's origin: "Read from Greenhouse", "Read from its page on careers.example.com", "From a page on
 * careers.example.com"; null for a closed link. v31 FIX-WEB (D12): a job TailorIT read from a careers page waits here as
 * an `ats` row whose platform is no ATS (the page's own job data): it says the page it was read from, never "Read from"
 * a platform name that is not one.
 */
export function originLine(
  row: Pick<AdminReviewRow, 'origin' | 'platform' | 'pageHost'> &
    Partial<Pick<AdminReviewRow, 'imported' | 'importName'>> & { job?: Pick<AdminReviewRow['job'], 'applyUrl'> },
): string | null {
  // v35 OPSWEB (PLAN H3): a job an admin's import read and held: which import. v35 FIX-WEB (L4): named as Couldn't
  // verify names an import's row ("Import · jobs.csv", rowOriginText).
  if (row.imported) return row.importName ? `Import · ${row.importName}` : 'Import';
  if (row.origin === 'ats') {
    if (!row.platform) return 'Read from an ATS board';
    if (!PAGE_PLATFORMS.has(row.platform)) return `Read from ${platformName(row.platform)}`;
    const host = hostOf(row.job?.applyUrl) ?? row.pageHost;
    return host ? `Read from its page on ${host}` : 'Read from its page';
  }
  if (row.origin === 'page') return row.pageHost ? `From a page on ${row.pageHost}` : 'From a page';
  return null;
}

/**
 * Who and what: "3 people · The page says it expired" (closed), "Added by 2 people" (new job). v35 FIX-WEB (L4): a new
 * job an admin's import read says "Imported" (no one added it), as Couldn't verify's row does.
 */
export function evidenceLine(row: Pick<AdminReviewRow, 'kind' | 'reporters' | 'strongestSignal'> & Partial<Pick<AdminReviewRow, 'imported'>>): string {
  if (row.kind === 'new_job') return row.imported ? 'Imported' : `Added by ${peopleText(row.reporters)}`;
  const signal = row.strongestSignal ? REVIEW_SIGNAL_LABEL[row.strongestSignal] : null;
  return signal ? `${peopleText(row.reporters)} · ${signal}` : peopleText(row.reporters);
}

/** TailorIT's check in words, or null when there is nothing to say (a new job never checked). */
export function checkLine(row: Pick<AdminReviewRow, 'kind' | 'checkState'>): string | null {
  if (row.checkState === 'none') return row.kind === 'closed' ? REVIEW_CHECK_LABEL.none : null;
  return REVIEW_CHECK_LABEL[row.checkState];
}

/** "Approved by an admin", "Rejected automatically", "Listed by its source", "Expired". */
export function decisionText(row: Pick<AdminReviewRow, 'state' | 'decidedBy'>): string {
  const words = REVIEW_STATE_LABEL[row.state];
  if (row.state === 'approved' || row.state === 'rejected') return row.decidedBy ? `${words} ${REVIEW_DECIDER_LABEL[row.decidedBy]}` : words;
  return words;
}

export interface ReviewStateLine {
  icon: StateIconName;
  text: string;
  detail: string | null;
  tone: StateTone;
}

/** v32 FIX-API (UXREQ-9): "Needs review", where no group heading says it (the detail sheet). */
export const PENDING_LINE: ReviewStateLine = { icon: 'hand', text: REVIEW_STATE_LABEL.pending, detail: null, tone: 'muted' };

/**
 * A review row's state line (components/queue's StateLine): its group's icon, its words, TailorIT's check. v32 FIX-API
 * (UXREQ-9): a row waiting in the Needs review group does not say "Needs review" again (its group heading and the
 * filter say it): only TailorIT's check, else nothing (null). v37 REVIEW (R2): a checking row's "Checking" is its tag
 * (ReviewRows' badge): its line says TailorIT's check alone.
 */
export function reviewStateLine(row: AdminReviewRow): ReviewStateLine | null {
  const check = checkLine(row);
  switch (row.state) {
    case 'pending':
      if (row.group === 'checking') return { icon: 'spinner', text: check ?? REVIEW_GROUP_LABEL.checking, detail: null, tone: 'muted' };
      if (row.group === 'server_live') return { icon: 'warning', text: REVIEW_GROUP_LABEL.server_live, detail: check, tone: 'warning' };
      return check ? { icon: 'hand', text: check, detail: null, tone: 'muted' } : null;
    case 'approved':
      return { icon: 'check', text: decisionText(row), detail: row.note, tone: 'muted' };
    case 'rejected':
      return { icon: 'x', text: decisionText(row), detail: row.note, tone: 'muted' };
    case 'superseded':
      return { icon: 'info', text: decisionText(row), detail: null, tone: 'muted' };
    case 'expired':
      return { icon: 'clock', text: decisionText(row), detail: 'No new report in time', tone: 'muted' };
  }
}

/** v37 FIX-REV (SP v37 FIXES-361.md D1): a flag TailorIT resolved because its job closed, in words. */
export const FLAG_JOB_CLOSED = { text: 'Resolved by TailorIT', detail: 'The job closed' } as const;

/**
 * A flag's state line: resolved or dismissed, and by whom. v32 FIX-API (UXREQ-9): none for an open flag (its Needs
 * review group says it). v37 FIX-REV (D1): a flag TailorIT resolved because its job closed says so.
 */
export function flagStateLine(flag: Pick<AdminFlag, 'status' | 'resolvedBy'> & Partial<Pick<AdminFlag, 'jobClosed'>>): ReviewStateLine | null {
  if (flag.status === 'open') return null;
  if (flag.jobClosed) return { icon: 'check', text: FLAG_JOB_CLOSED.text, detail: FLAG_JOB_CLOSED.detail, tone: 'muted' };
  const by = flag.resolvedBy ? `by ${flag.resolvedBy}` : null;
  return { icon: flag.status === 'resolved' ? 'check' : 'x', text: flag.status === 'resolved' ? 'Resolved' : 'Dismissed', detail: by, tone: 'muted' };
}

/** "The Graphic Designer at Acme". */
export const rowName = (job: { title: string; companyName: string }) => `${job.title} at ${job.companyName}`;

// v37 REVIEW (SP v37 PLAN.md R1, R2): a lane is one list in the server's order (newest first), loaded as you scroll; its
// rows were drawn in groups with loaded counts (v3.0), which a list that grows page by page cannot keep: a later page's
// rows landed in the groups above, and a group said "50" of 340. Each row says its own state now: a "Checking" tag,
// "Server says live", its decision.

/** v37 REVIEW (R2): whether a row carries the "Checking" tag (TailorIT's check is queued). */
export function isChecking(row: Pick<AdminReviewRow, 'state' | 'group'>): boolean {
  return row.state === 'pending' && row.group === 'checking';
}

// Bulk actions ------------------------------------------------------------------------------------------------------------

/** The ids in requests of at most ADMIN_BULK_MAX (14 §6.2: "one request per 100 items"). */
export function chunkIds<T>(ids: readonly T[], size: number = ADMIN_BULK_MAX): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < ids.length; start += size) chunks.push(ids.slice(start, start + size));
  return chunks;
}

export interface BulkRowResult {
  id: number | string;
  outcome: string;
  message?: string;
}

export interface BulkAnswer {
  results: BulkRowResult[];
  counts: Partial<Record<string, number>>;
}

/** Several bulk answers as one: every row's result, and the counts added up. */
export function mergeBulkAnswers(answers: readonly BulkAnswer[]): BulkAnswer {
  const counts: Record<string, number> = {};
  for (const answer of answers) {
    for (const [outcome, count] of Object.entries(answer.counts)) counts[outcome] = (counts[outcome] ?? 0) + (count ?? 0);
  }
  return { results: answers.flatMap((answer) => answer.results), counts };
}

/** The outcomes in the order the summary names them. */
const OUTCOME_ORDER = ['approved', 'rejected', 'resolved', 'dismissed', 'skipped', 'failed'] as const;

/** "3 approved, 1 skipped": what a bulk action did, for the toast and the live region. */
export function bulkSummary(counts: Partial<Record<string, number>>): string {
  const parts = OUTCOME_ORDER.filter((outcome) => (counts[outcome] ?? 0) > 0).map((outcome) => `${counts[outcome]} ${outcome}`);
  return parts.length > 0 ? parts.join(', ') : 'Nothing changed';
}

/** A row's own result after a bulk action ("Skipped: decided already"); null for one that went as asked. */
export function rowOutcomeText(result: BulkRowResult | undefined): string | null {
  if (!result || result.outcome === 'approved' || result.outcome === 'rejected' || result.outcome === 'resolved' || result.outcome === 'dismissed') {
    return null;
  }
  const words = result.outcome === 'skipped' ? 'Skipped' : 'Failed';
  return result.message ? `${words}: ${result.message}` : words;
}

/** The words after one decision: "Approved", "Rejected", "Reopened". */
export function decidedText(decision: 'approve' | 'reject' | 'reopen'): string {
  return decision === 'approve' ? 'Approved' : decision === 'reject' ? 'Rejected' : 'Reopened';
}

/**
 * v32 ADMINAPP (E6): whether approving the row may publish what browsers captured: a v3.0 page review still pending
 * (TailorIT reads its page first; when it cannot, the approval publishes the captured job, after the admin's yes).
 */
export function approvesCaptured(row: Pick<AdminReviewRow, 'kind' | 'origin' | 'state'>): boolean {
  return row.kind === 'new_job' && row.origin === 'page' && row.state === 'pending';
}

/**
 * v32 ADMINAPP (E6): whether a row offers Retry read: a new job waiting for approval that a read made (an ATS's, or a
 * page's under D12). A v3.0 page review is read by its approval; a closed link has nothing to read again.
 */
export function retriesRead(row: Pick<AdminReviewRow, 'kind' | 'origin' | 'state'>): boolean {
  return row.kind === 'new_job' && row.origin === 'ats' && row.state === 'pending';
}

/** v32 ADMINAPP (E6): what a New jobs Retry read came to, for the toast and the live region. */
export function reviewRetryText(result: { state: 'read' | 'closed' | 'unreadable'; reason: JobVerifyReason | null }): {
  tone: 'success' | 'info';
  title: string;
  body: string;
} {
  if (result.state === 'read') return { tone: 'success', title: 'Read again', body: 'Approve publishes what TailorIT just read.' };
  if (result.state === 'closed') return { tone: 'info', title: 'The posting has closed', body: 'Reject it, so it is not published.' };
  return { tone: 'info', title: "Couldn't read it now", body: result.reason ? REASON_ADMIN_TEXT[result.reason] : 'Try again later.' };
}

/** v32 ADMINAPP (E6): the confirm before such an approval, brief. */
export const CAPTURED_APPROVE_COPY = {
  title: 'Approve this page job?',
  description: 'TailorIT reads the page first. If it can\'t, the job is published as people\'s browsers captured it, marked "Approved by an admin".',
  confirm: 'Approve',
} as const;

// The auto-approve switches ---------------------------------------------------------------------------------------------

/**
 * The switches each lane shows, by constant (14 §6.2, §7): all off by default. v31 FIX-WEB (REV-REQ REQ-6): New jobs
 * shows D12's PAGE_JOBS_AUTO_PUBLISH (publish a job TailorIT read from a page's own job data without an admin) in place
 * of EXT_AUTO_APPROVE_NEW_PAGE, which publishes nothing since v3.1 (D2: a browser's text is never published). A key the
 * server does not list is left out of the strip.
 */
export const AUTO_APPROVE_KEYS = {
  closed: ['EXT_AUTO_APPROVE_CLOSED'],
  new_job: ['EXT_AUTO_APPROVE_NEW_ATS', 'PAGE_JOBS_AUTO_PUBLISH'],
  flags: [],
} as const satisfies Record<ReviewLane, readonly string[]>;
export type AutoApproveKey = (typeof AUTO_APPROVE_KEYS)[ReviewLane][number];

/** A switch's one-line rule, with the number its guard constant holds. */
export function autoApproveRule(key: AutoApproveKey, numbers: { minReporters: number }): string {
  switch (key) {
    case 'EXT_AUTO_APPROVE_CLOSED':
      // v37 INT-A (CLOSED's C6): a re-check that finds the posting gone closes it whatever the switch says; the switch
      // adds the rest (job-reviews/auto.ts).
      return `A re-check that finds it open rejects it; reported by ${peopleText(numbers.minReporters)} approves it`;
    case 'EXT_AUTO_APPROVE_NEW_ATS':
      return 'Once its company and duplicate checks pass';
    case 'PAGE_JOBS_AUTO_PUBLISH':
      return 'As soon as TailorIT reads it from a careers page, without waiting here';
  }
}

// The detail sheet ---------------------------------------------------------------------------------------------------------

/** How a report came, in words. */
export const VIA_LABEL: Record<JobReviewVia, string> = {
  page: 'Seen on a posting someone opened',
  agent: 'Seen by the auto-apply agent',
  queue: "Seen from the extension's Queue tab",
  person: 'Report as closed, in the extension',
  web: "The Jobs page's flag",
  add: 'Added with the extension',
};

/** A report's strength, in words. */
export const STRENGTH_LABEL: Record<JobReviewStrength, string> = {
  strong: 'Strong signal',
  person: 'A person said so',
  weak: 'Weak signal',
};

/** A link's state in words: "Live", "Missing since 2 days ago (2 misses)". */
export function linkStateText(link: { state: 'live' | 'missing'; missCount: number }, missingAgo: string | null): string {
  if (link.state === 'live') return 'Live';
  const misses = link.missCount > 0 ? ` (${link.missCount} ${link.missCount === 1 ? 'miss' : 'misses'})` : '';
  return missingAgo ? `Missing since ${missingAgo}${misses}` : `Missing${misses}`;
}

/** How a new job's company resolved, in words. */
export const COMPANY_MATCH_LABEL: Record<'board' | 'domain' | 'name' | 'new', string> = {
  board: 'Matched by its job board',
  domain: 'Matched by its website',
  name: 'Matched by its name only',
  new: 'A new company',
};

/** "Approving offers this board to discovery: Greenhouse acme". */
export function offerText(offer: { kind: JobSourceKind; name: string }): string {
  return `Approving offers this board to discovery: ${JOB_SOURCE_KIND_LABEL[offer.kind]} ${offer.name}`;
}

/** The fingerprints' distance: "3 bits apart", or nothing when either has none. */
export function distanceText(bits: number | null): string | null {
  if (bits === null) return null;
  return bits === 0 ? 'Same text' : `${bits} ${bits === 1 ? 'bit' : 'bits'} apart`;
}

/** A note's problem, or null: it is optional, at most `max` characters (MSG_TEXT_TOO_LONG's words from the page). */
export function noteProblem(note: string, max: number, tooLong: (max: number) => string): string | null {
  return note.trim().length > max ? tooLong(max) : null;
}
