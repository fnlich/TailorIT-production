import { ATS_NAMES, type AtsKind } from '@tailorit/shared/autofill';
import {
  ADMIN_BULK_MAX,
  REVIEW_CHECK_LABEL,
  REVIEW_DECIDER_LABEL,
  REVIEW_GROUP_LABEL,
  REVIEW_GROUPS,
  REVIEW_LANE_LABEL,
  REVIEW_LANES,
  REVIEW_SIGNAL_LABEL,
  REVIEW_STATE_FILTER_LABEL,
  REVIEW_STATE_FILTERS,
  REVIEW_STATE_LABEL,
  type AdminFlag,
  type AdminReviewCounts,
  type AdminReviewRow,
  type JobReviewStrength,
  type JobReviewVia,
  type ReviewGroup,
  type ReviewLane,
  type ReviewStateFilter,
} from '@tailorit/shared/reviews';
import { JOB_SOURCE_KIND_LABEL, type JobSourceKind } from '@tailorit/shared/sourcing';
import type { StateIconName, StateTone } from '../../../../components/queue';

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
 * The lane the address opens: `?tab=reports` (Admin › Reports' old address) opens Flags; `?lane=` names one; else
 * Closed links.
 */
export function laneFromAddress(tab: string | null, lane: string | null): ReviewLane {
  if (tab === 'reports') return 'flags';
  return (REVIEW_LANES as readonly string[]).includes(lane ?? '') ? (lane as ReviewLane) : 'closed';
}

/** A lane's count of items needing a decision. */
export function laneCount(counts: AdminReviewCounts | undefined, lane: ReviewLane): number | null {
  if (!counts) return null;
  return lane === 'closed' ? counts.closed : lane === 'new_job' ? counts.newJob : counts.flags;
}

/** Every lane's items needing a decision: the header's count. */
export function totalNeedingDecision(counts: AdminReviewCounts | undefined): number | null {
  return counts ? counts.closed + counts.newJob + counts.flags : null;
}

/** v30 FIX-WEB (REQ-8): the admin nav's "Review (3)": the label alone while the counts load, or when nothing waits. */
export function reviewTabLabel(label: string, counts: AdminReviewCounts | undefined): string {
  const total = totalNeedingDecision(counts);
  return total ? `${label} (${total.toLocaleString('en-US')})` : label;
}

/** "Closed links (3)", or the label alone while the counts load. */
export function laneLabel(lane: ReviewLane, counts: AdminReviewCounts | undefined): string {
  const count = laneCount(counts, lane);
  return count === null ? REVIEW_LANE_LABEL[lane] : `${REVIEW_LANE_LABEL[lane]} (${count})`;
}

/** The header's count in words: "3 need a decision", "1 needs a decision", "Nothing to decide". */
export function needingText(total: number): string {
  if (total === 0) return 'Nothing to decide';
  return `${total} ${total === 1 ? 'needs' : 'need'} a decision`;
}

/** The state filters a lane offers: Flags has no TailorIT check, so no Checking. */
export function stateFiltersOf(lane: ReviewLane): readonly ReviewStateFilter[] {
  return lane === 'flags' ? REVIEW_STATE_FILTERS.filter((state) => state !== 'checking') : REVIEW_STATE_FILTERS;
}

/** The state filter kept on a lane change: Checking falls back to Needs review on Flags. */
export function stateForLane(lane: ReviewLane, state: ReviewStateFilter): ReviewStateFilter {
  return stateFiltersOf(lane).includes(state) ? state : 'needs_review';
}

export const stateFilterLabel = (state: ReviewStateFilter) => REVIEW_STATE_FILTER_LABEL[state];

/** A lane's empty state, by its filter and search. */
export function emptyText(lane: ReviewLane, state: ReviewStateFilter, searching: boolean): { title: string; description?: string } {
  const things = lane === 'closed' ? 'closed links' : lane === 'new_job' ? 'new jobs' : 'flags';
  if (searching) return { title: `No ${things} match your search`, description: 'Search by job title or company.' };
  if (state === 'needs_review' || state === 'checking') {
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

/** A new job's origin: "Read from Greenhouse", "From a page on careers.example.com"; null for a closed link. */
export function originLine(row: Pick<AdminReviewRow, 'origin' | 'platform' | 'pageHost'>): string | null {
  if (row.origin === 'ats') return row.platform ? `Read from ${platformName(row.platform)}` : 'Read from an ATS board';
  if (row.origin === 'page') return row.pageHost ? `From a page on ${row.pageHost}` : 'From a page';
  return null;
}

/** Who and what: "3 people · The page says it expired" (closed), "Added by 2 people" (new job). */
export function evidenceLine(row: Pick<AdminReviewRow, 'kind' | 'reporters' | 'strongestSignal'>): string {
  if (row.kind === 'new_job') return `Added by ${peopleText(row.reporters)}`;
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

/** A review row's state line (components/queue's StateLine): its group's icon, its words, TailorIT's check. */
export function reviewStateLine(row: AdminReviewRow): ReviewStateLine {
  const check = checkLine(row);
  switch (row.state) {
    case 'pending':
      if (row.group === 'checking') return { icon: 'spinner', text: REVIEW_GROUP_LABEL.checking, detail: check, tone: 'muted' };
      if (row.group === 'server_live') return { icon: 'warning', text: REVIEW_GROUP_LABEL.server_live, detail: check, tone: 'warning' };
      return { icon: 'hand', text: REVIEW_STATE_LABEL.pending, detail: check, tone: 'muted' };
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

/** A flag's state line: open (needs review), resolved or dismissed, and by whom. */
export function flagStateLine(flag: Pick<AdminFlag, 'status' | 'resolvedBy'>): ReviewStateLine {
  if (flag.status === 'open') return { icon: 'hand', text: REVIEW_STATE_LABEL.pending, detail: null, tone: 'muted' };
  const by = flag.resolvedBy ? `by ${flag.resolvedBy}` : null;
  return { icon: flag.status === 'resolved' ? 'check' : 'x', text: flag.status === 'resolved' ? 'Resolved' : 'Dismissed', detail: by, tone: 'muted' };
}

/** "The Graphic Designer at Acme". */
export const rowName = (job: { title: string; companyName: string }) => `${job.title} at ${job.companyName}`;

// Groups -----------------------------------------------------------------------------------------------------------------

export interface RowGroup<T> {
  group: ReviewGroup;
  title: string;
  rows: T[];
}

/** Review rows in their groups (Needs review, Checking, Server says live, Decided today, Decided), in that order. */
export function groupReviewRows(rows: readonly AdminReviewRow[]): RowGroup<AdminReviewRow>[] {
  return REVIEW_GROUPS.map((group) => ({ group, title: REVIEW_GROUP_LABEL[group], rows: rows.filter((row) => row.group === group) })).filter(
    (entry) => entry.rows.length > 0,
  );
}

/** Flags in two groups: open ones (Needs review), then the decided ones (today's first, as the server orders them). */
export function groupFlagRows(flags: readonly AdminFlag[], now: number): RowGroup<AdminFlag>[] {
  const today = new Date(now).toDateString();
  const groupOf = (flag: AdminFlag): ReviewGroup =>
    flag.status === 'open' ? 'needs_review' : flag.resolvedAt && new Date(flag.resolvedAt).toDateString() === today ? 'decided_today' : 'decided';
  return (['needs_review', 'decided_today', 'decided'] as const)
    .map((group) => ({ group, title: REVIEW_GROUP_LABEL[group], rows: flags.filter((flag) => groupOf(flag) === group) }))
    .filter((entry) => entry.rows.length > 0);
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

// The auto-approve switches ---------------------------------------------------------------------------------------------

/** The switches each lane shows, by constant (14 §6.2, §7): all off by default. */
export const AUTO_APPROVE_KEYS = {
  closed: ['EXT_AUTO_APPROVE_CLOSED'],
  new_job: ['EXT_AUTO_APPROVE_NEW_ATS', 'EXT_AUTO_APPROVE_NEW_PAGE'],
  flags: [],
} as const satisfies Record<ReviewLane, readonly string[]>;
export type AutoApproveKey = (typeof AUTO_APPROVE_KEYS)[ReviewLane][number];

/** A switch's one-line rule, with the number its guard constant holds. */
export function autoApproveRule(key: AutoApproveKey, numbers: { minReporters: number; minPageAccounts: number }): string {
  switch (key) {
    case 'EXT_AUTO_APPROVE_CLOSED':
      return `Re-checked by TailorIT, or reported by ${peopleText(numbers.minReporters)}`;
    case 'EXT_AUTO_APPROVE_NEW_ATS':
      return 'Once its company and duplicate checks pass';
    case 'EXT_AUTO_APPROVE_NEW_PAGE':
      return `When ${peopleText(numbers.minPageAccounts)} captured the same text`;
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
