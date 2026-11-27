import {
  AddJobResultSchema,
  JOB_VERIFY_REASON_ADMIN_TEXT,
  UNVERIFIED_BULK_MAX,
  UnverifiedApprovalSchema,
  UnverifiedBulkResultSchema,
  UnverifiedCountSchema,
  UnverifiedLinkDetailSchema,
  UnverifiedLinksResponseSchema,
  type AddJobResult,
  type UnverifiedBulkResult,
  type UnverifiedFrom,
  type JobVerifyReason,
  type UnverifiedApproval,
  type UnverifiedCount,
  type UnverifiedLink,
  type UnverifiedLinkDetail,
  type UnverifiedLinksResponse,
  type UnverifiedVersion,
} from '@tailorit/shared/jobs';
import { isNeverRead } from '@/features/jobs/verification/copy'; // v38 FIX-APP (ux L3)
import { REVIEW_LANE_LABEL, REVIEW_PAGE_LANES, REVIEW_PAGE_SIZE, type ReviewPageLane } from '@tailorit/shared/reviews';
import { z } from 'zod';
import { api } from '@/lib/api';
import { relativeTime } from '@/lib/format';

// v31 ADMINWEB: Admin › Review's fourth lane, "Couldn't verify" (docs/design/v3.1/21-jobs-from-links.md §6, decision
// D2): the links TailorIT could not read that someone keeps as their own job. An admin may ask TailorIT to read a link
// again (Retry read) or reject it (never published, whoever adds it); an admin never types or publishes a job's
// content. The lane is the web's own: the shared lanes (REVIEW_LANES) are the review queue's, this one reads LINK's
// routes. Pure, so the tests read it without a page.
// v32 ADMINAPP (E6, the owner's "admin should be able to approve manually"): Approve publishes the row's job as it was
// captured (the admin types nothing), marked approved by an admin, after a short confirm.
// v32 FIX-API (REV-SECBEH SB-1, SB-4, SB-6; REV-UXREQ UXREQ-9): the admin reads what is published before approving it:
// the row opens its job in full (every version its adders captured: GET .../unverified/:jobId), the confirm draws the
// version to publish (a pick when they differ) and the approval names it ({version}). A row TailorIT found opted out
// or closed has no Approve. "Page reads are off" is said once for the lane, not on every row.

/** LINK's routes (apps/api/src/features/jobs/add/router.ts), in one place. */
export const UNVERIFIED_ROUTES = {
  list: '/api/admin/jobs/unverified',
  count: '/api/admin/jobs/unverified/count',
  retry: (jobId: number) => `/api/admin/jobs/unverified/${jobId}/retry`,
  reject: (jobId: number) => `/api/admin/jobs/unverified/${jobId}/reject`,
  approve: (jobId: number) => `/api/admin/jobs/unverified/${jobId}/approve`, // v32 ADMINAPP (E6)
  detail: (jobId: number) => `/api/admin/jobs/unverified/${jobId}`, // v32 FIX-API (SB-1)
  bulk: '/api/admin/jobs/unverified/bulk', // v35 OPSWEB (IMPORT's route)
  all: '/api/admin/jobs/unverified/all', // v35 OPSWEB (IMPORT's route)
} as const;

// v35 OPSWEB (PLAN H3, IMPORT's routes): the From filter (All, Imports, People's adds, one import by its run), and the
// selection's and the filter's Approve and Reject.

/** The lane's From filter: where its rows came from, or one import (its run: Runs' and Import's id of it). */
export interface UnverifiedFilter {
  from: UnverifiedFrom;
  runId: number | null;
}
export const ALL_UNVERIFIED: UnverifiedFilter = { from: 'all', runId: null };

/** The From filter's words. */
export const UNVERIFIED_FROM_LABEL: Record<UnverifiedFrom, string> = { all: 'All', imports: 'Imports', adds: "People's adds" };

/** The filter as the list, its count and "all" read it (one import implies its rows only). */
export function unverifiedFilterQuery(filter: UnverifiedFilter): { from?: UnverifiedFrom; runId?: number } {
  if (filter.runId) return { from: 'imports', runId: filter.runId };
  return filter.from === 'all' ? {} : { from: filter.from };
}

/** The filter an address opens the lane with: `run=<runId>` (Import's "To review" link), else All. */
export function unverifiedFilterFromAddress(params: { get(name: string): string | null }): UnverifiedFilter {
  const run = Number(params.get('run'));
  return Number.isInteger(run) && run > 0 ? { from: 'imports', runId: run } : ALL_UNVERIFIED;
}

/** A page of the list (the server's cap). v37 REVIEW (R1): 100, the lanes' page, loaded as you scroll. */
export const UNVERIFIED_PAGE_SIZE = REVIEW_PAGE_SIZE;

// v35 FIX-WEB (the final review's S6): the lane's count (the header's) reads `count`; Approve all / Reject all read the
// whole answer (UnverifiedCountSchema: `upTo`, what was counted) and send `upTo` back, so they decide nothing beyond it.
const CountSchema = UnverifiedCountSchema.pick({ count: true });
const RejectSchema = z.object({ rejected: z.boolean(), jobs: z.number().int().nonnegative() });
export type RejectLinkResult = z.infer<typeof RejectSchema>;

/** GET /api/admin/jobs/unverified: one page, newest check first (v35 OPSWEB: of the From filter). */
export function fetchUnverified(cursor: string | undefined, signal?: AbortSignal, filter: UnverifiedFilter = ALL_UNVERIFIED): Promise<UnverifiedLinksResponse> {
  return api.get<UnverifiedLinksResponse>(UNVERIFIED_ROUTES.list, {
    signal,
    query: { cursor, limit: UNVERIFIED_PAGE_SIZE, ...unverifiedFilterQuery(filter) },
    schema: UnverifiedLinksResponseSchema,
  });
}

/** GET /api/admin/jobs/unverified/count: how many links the list holds (0 while the list is off); v35: of a filter. */
export function fetchUnverifiedCount(signal?: AbortSignal, filter: UnverifiedFilter = ALL_UNVERIFIED): Promise<number> {
  return api
    .get<{ count: number }>(UNVERIFIED_ROUTES.count, { signal, query: unverifiedFilterQuery(filter), schema: CountSchema })
    .then((answer) => answer.count);
}

/** v35 FIX-WEB (S6): the filter's count for Approve all / Reject all, and `upTo` (what was counted, opaque). */
export function fetchUnverifiedAllCount(filter: UnverifiedFilter, signal?: AbortSignal): Promise<UnverifiedCount> {
  return api.get<UnverifiedCount>(UNVERIFIED_ROUTES.count, { signal, query: unverifiedFilterQuery(filter), schema: UnverifiedCountSchema });
}

/** v35 FIX-WEB (L5): the lane's header while a From filter is on: "2 of 7" (the filter's count of the lane's), else null. */
export function filteredHeadCount(filtered: number | null, total: number | null): string | null {
  if (filtered === null || total === null) return null;
  return `${filtered.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`;
}

/** v35 OPSWEB: POST …/unverified/bulk: Approve or Reject the rows chosen (at most UNVERIFIED_BULK_MAX a request). */
export function bulkUnverified(action: 'approve' | 'reject', jobIds: readonly number[]): Promise<UnverifiedBulkResult> {
  return api.post<UnverifiedBulkResult>(UNVERIFIED_ROUTES.bulk, { action, jobIds }, { schema: UnverifiedBulkResultSchema });
}

/**
 * v35 OPSWEB: POST …/unverified/all: Approve all or Reject all for the filter (call again while `left` > 0). v35 FIX-WEB
 * (S6): with the count's `upTo`, so a row that arrives after the confirm counted waits for the next decision.
 */
export function allUnverified(action: 'approve' | 'reject', filter: UnverifiedFilter, upTo?: string): Promise<UnverifiedBulkResult> {
  return api.post<UnverifiedBulkResult>(
    UNVERIFIED_ROUTES.all,
    { action, ...unverifiedFilterQuery(filter), ...(upTo ? { upTo } : {}) },
    { schema: UnverifiedBulkResultSchema },
  );
}

/** POST …/:jobId/retry: TailorIT reads the link again now. */
export function retryUnverified(jobId: number): Promise<AddJobResult> {
  return api.post<AddJobResult>(UNVERIFIED_ROUTES.retry(jobId), {}, { schema: AddJobResultSchema });
}

/** POST …/:jobId/reject: the link is never published (each adder keeps their own job). */
export function rejectUnverified(jobId: number): Promise<RejectLinkResult> {
  return api.post<RejectLinkResult>(UNVERIFIED_ROUTES.reject(jobId), {}, { schema: RejectSchema });
}

/**
 * v32 ADMINAPP (E6) POST …/:jobId/approve: the job published as it was captured (the same answer again once approved).
 * v32 FIX-API (SB-1): the version the admin read; 409 when it changed since.
 */
export function approveUnverified(jobId: number, version: string): Promise<UnverifiedApproval> {
  return api.post<UnverifiedApproval>(UNVERIFIED_ROUTES.approve(jobId), { version }, { schema: UnverifiedApprovalSchema });
}

/** v32 FIX-API (SB-1) GET …/:jobId: the row's link and every version of its job, in full. */
export function fetchUnverifiedDetail(jobId: number, signal?: AbortSignal): Promise<UnverifiedLinkDetail> {
  return api.get<UnverifiedLinkDetail>(UNVERIFIED_ROUTES.detail(jobId), { signal, schema: UnverifiedLinkDetailSchema });
}

// The lanes ------------------------------------------------------------------------------------------------------------

/** The Review page's lanes: the review queue's three and "Couldn't verify" (v37 REVIEW: shared REVIEW_PAGE_LANES). */
export type AdminReviewLane = ReviewPageLane;
export const ADMIN_REVIEW_LANES: readonly AdminReviewLane[] = REVIEW_PAGE_LANES;
export const ADMIN_REVIEW_LANE_LABEL: Record<AdminReviewLane, string> = { ...REVIEW_LANE_LABEL, unverified: "Couldn't verify" };

/** Whether a lane is one of the review queue's (the shared routes), not "Couldn't verify". */
export function isQueueLane(lane: AdminReviewLane): lane is Exclude<AdminReviewLane, 'unverified'> {
  return lane !== 'unverified';
}

// A row's words --------------------------------------------------------------------------------------------------------

/**
 * Why TailorIT could not read a link, in an admin's words (the constants' MSG_JOB_VERIFY_* speak to the person who
 * added the job: "the job stays yours"), each saying what an admin may do about it. v35 FIX-WEB: the shared map
 * (JOB_VERIFY_REASON_ADMIN_TEXT, FIX-STORE's), the words Admin › Import's results get from the API too.
 */
export const REASON_ADMIN_TEXT: Record<JobVerifyReason, string> = JOB_VERIFY_REASON_ADMIN_TEXT;

/** A link's short name for buttons and messages: its host and path, without https:// ("careers.acme.com/jobs/7"). */
export function linkName(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '');
    const short = `${parsed.hostname}${path}`;
    return short.length > 80 ? `${short.slice(0, 77)}...` : short;
  } catch {
    return url;
  }
}

/** "1 person", "3 people". */
const people = (count: number) => `${count} ${count === 1 ? 'person' : 'people'}`;

/**
 * "Added by 2 people · first 3 days ago · checked 1 hour ago · 3 tries". v35 OPSWEB: an admin import's row has no adder:
 * "Imported 1 hour ago · checked … · 1 try".
 */
export function unverifiedMetaLine(row: Pick<UnverifiedLink, 'adders' | 'firstAddedAt' | 'checkedAt' | 'attempts' | 'from'>, now: number): string {
  const parts =
    row.from === 'import'
      ? [`Imported ${relativeTime(row.firstAddedAt, now)}`, `checked ${relativeTime(row.checkedAt, now)}`]
      : [`Added by ${people(row.adders)}`, `first ${relativeTime(row.firstAddedAt, now)}`, `checked ${relativeTime(row.checkedAt, now)}`];
  if (row.attempts > 0) parts.push(`${row.attempts} ${row.attempts === 1 ? 'try' : 'tries'}`);
  return parts.join(' · ');
}

/**
 * The lane's empty state: the list is off, or nothing waits. v37 REVIEW (R5): while the switch is off the lane still
 * lists an admin import's held jobs; empty, it says people's links are not listed.
 */
export function unverifiedEmptyText(listOn: boolean | null): { title: string; description: string } {
  if (listOn === false) {
    return {
      title: "People's links are not listed",
      description: "Turn on the switch above to list the links people added that TailorIT couldn't read. Your imports' jobs are listed either way.",
    };
  }
  return {
    title: 'No links to verify',
    description: "When TailorIT can't read a job someone added from its link, the link waits here. Only the people who added it see that job.",
  };
}

/** What a Retry read came to, for the toast (title, body) and the live region. */
export function retryOutcomeText(result: Pick<AddJobResult, 'state' | 'reason'>): { tone: 'success' | 'info'; title: string; body: string } {
  switch (result.state) {
    case 'published':
      return { tone: 'success', title: 'Read and published', body: "It is in everyone's job search, and the people who added it see the shared job." };
    case 'waiting_admin':
      return {
        tone: 'success',
        title: 'Read: waiting for approval',
        body: "New jobs need an admin's approval here, so it waits in Review › New jobs.",
      };
    case 'private_unverified':
      return { tone: 'info', title: "Still couldn't read it", body: result.reason ? REASON_ADMIN_TEXT[result.reason] : 'TailorIT will list it again.' };
    case 'refused':
      return { tone: 'info', title: 'Not published', body: result.reason ? REASON_ADMIN_TEXT[result.reason] : 'TailorIT did not add it.' };
  }
}

/**
 * v32 ADMINAPP (E6): the row's job as captured ("Data Engineer · Nodata Labs · Austin, TX"), what Approve publishes;
 * null when unknown. v32 FIX-API: with its place.
 */
export function capturedLine(row: Pick<UnverifiedLink, 'title' | 'companyName' | 'location'>): string | null {
  const parts = [row.title, row.companyName, row.location].filter((part): part is string => typeof part === 'string' && part.trim() !== '');
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * v32 ADMINAPP (E6): the Approve confirm's words, brief: what is published. v32 FIX-API (SB-1): the version drawn below
 * it (picked when the adders' differ); its "?" says who hears it (the others keep their own copies).
 */
export function approveText(row: Pick<UnverifiedLink, 'adders' | 'versions'>): { title: string; description: string; tip: string; confirm: string } {
  const several = (row.versions ?? 1) > 1;
  return {
    title: 'Approve and publish this job?',
    description: several
      ? 'Pick the version to publish: everyone will see it as added; only admins see it marked "Approved by an admin".'
      : 'Everyone will see the job below as added; only admins see it marked "Approved by an admin".',
    tip:
      row.adders === 1
        ? 'The person who added it is told.'
        : 'Its adder is told; the others who added it keep their own copy and hear a version is published.',
    confirm: 'Approve and publish',
  };
}

/** v32 FIX-API (SB-6): a row TailorIT found opted out or closed is never published, so it has no Approve. */
export function canApprove(row: Pick<UnverifiedLink, 'reason'>): boolean {
  return row.reason !== 'opted_out' && row.reason !== 'closed';
}

/** v32 FIX-API (SB-1): "2 versions" when the link's adders captured different words; null for one. */
export function versionsText(row: Pick<UnverifiedLink, 'versions'>): string | null {
  return (row.versions ?? 1) > 1 ? `${row.versions} versions` : null;
}

/** v32 FIX-API (SB-1): a version's name in the pick ("Version 1 · added by 2 people"), and its marks. */
export function versionLabel(version: Pick<UnverifiedVersion, 'adders' | 'yours' | 'published'>, index: number): string {
  const parts = [`Version ${index + 1}`, `added by ${people(version.adders)}`];
  if (version.published) parts.push('published before');
  if (version.yours) parts.push('yours: another admin approves it');
  return parts.join(' · ');
}

/**
 * v32 FIX-API (UXREQ-9): the reason a row shows, or null when the lane says it once ("Page reads are off": a server
 * setting, the same for every row).
 */
export function rowReasonText(row: Pick<UnverifiedLink, 'reason'> & Partial<Pick<UnverifiedLink, 'url'>>): string | null {
  if (row.reason === 'not_set_up') return null;
  // v38 FIX-APP (REVIEW38-ux L3): a site TailorIT never reads: what the admin can do (no Retry read is offered).
  return isNeverRead(row.reason, row.url) ? `${REASON_ADMIN_TEXT[row.reason]} ${NEVER_READ_ADMIN_NEXT}` : REASON_ADMIN_TEXT[row.reason];
}

/** v38 FIX-APP (REVIEW38-ux L3): a never-read site's row: its two ways on. */
export const NEVER_READ_ADMIN_NEXT = "Approve to publish the person's version, or Reject.";

/** v32 FIX-API (UXREQ-9): the lane's one "Page reads are off" mark and its "?", when any row says so. */
export const PAGE_READS_OFF = {
  label: 'Page reads are off',
  tip: 'Set BOT_USER_AGENT in .env and keep "Read job pages on add" on in Constants.',
} as const;

/** v32 ADMINAPP (E6): what an approval came to, for the toast and the live region. */
export function approveOutcomeText(result: Pick<UnverifiedApproval, 'already'>): { title: string; body: string } {
  return result.already
    ? { title: 'Already approved', body: 'Another approval published it first.' }
    : { title: 'Approved and published', body: 'Everyone can find it now.' };
}

// v35 OPSWEB: where a row came from, and the words of the selection's and the filter's Approve and Reject.

/**
 * Where an import's row came from: "Import · jobs.csv, row 12"; null for a person's add (its line says "Added by 2
 * people") and an older job.
 */
export function rowOriginText(row: Pick<UnverifiedLink, 'from' | 'importName' | 'importRow'>): string | null {
  if (row.from !== 'import') return null;
  const where = [row.importName, row.importRow ? `row ${row.importRow}` : null].filter(Boolean).join(', ');
  return where ? `Import · ${where}` : 'Import';
}

/** "1,240 jobs". */
const jobsText = (count: number) => `${count.toLocaleString('en-US')} ${count === 1 ? 'job' : 'jobs'}`;

/** The confirm of the bar's Approve / Reject, on the chosen rows or on "Select all N" (with the filter's count). */
export function unverifiedBulkConfirm(action: 'approve' | 'reject', count: number, all: boolean): { title: string; description: string; confirm: string } {
  const verb = action === 'approve' ? 'Approve' : 'Reject';
  return {
    title: `${verb} ${jobsText(count)}?`,
    description:
      action === 'approve'
        ? `Each is published as it was given, marked "Approved by an admin".${all ? ' TailorIT works through them in turns and says when it is done.' : ''} A job TailorIT may not publish is skipped with why.`
        : `TailorIT never publishes a job from these links, whoever adds them. People who added one keep their own copy.${all ? ' TailorIT works through them in turns.' : ''}`,
    confirm: `${verb} ${jobsText(count)}`,
  };
}

/** The selection in turns of UNVERIFIED_BULK_MAX. */
export function unverifiedTurns(jobIds: readonly number[]): number[][] {
  const turns: number[][] = [];
  for (let start = 0; start < jobIds.length; start += UNVERIFIED_BULK_MAX) turns.push(jobIds.slice(start, start + UNVERIFIED_BULK_MAX));
  return turns;
}

/** What a bulk or "all" action came to, added up over its requests. */
export interface UnverifiedOutcome {
  action: 'approve' | 'reject';
  done: number;
  skipped: number;
  left: number;
  /** The last answer's words ("Approved 1,240 jobs. 3 could not be approved."), or a request's failure. */
  message: string;
  items: UnverifiedBulkResult['items'];
  /** v37 FIX-REV (REVIEW361-ux L6): the admin stopped it after a turn. */
  stopped?: boolean;
}

/**
 * v37 FIX-REV (REVIEW361-ux M2): the line under the list switch while it is off: the lane is not empty then (an admin
 * import's jobs are always listed), so the switch does not look broken.
 */
export const LIST_OFF_NOTE = "Off: only jobs from admins' imports are listed here.";

/** v37 FIX-REV (REVIEW361-ux L3): the bar's words, as every other lane's bar says them. */
export const UNVERIFIED_BAR_WORDS = { approve: 'Approve', reject: 'Reject', cancel: 'Cancel' } as const;

/**
 * Approve all / Reject all: the request again while rows are `left` and the last request did something (the hour's
 * approvals of people's adds can stop it: the rest wait for later), up to `maxTurns`; `onTurn` hears the running total.
 */
export async function runUnverifiedAll(
  send: () => Promise<UnverifiedBulkResult>,
  onTurn: (sofar: UnverifiedOutcome) => void = () => undefined,
  maxTurns = 200, // v37 REVIEW (R3): each request works ADMIN_BULK_ALL_SECONDS (v3.5: 150 s and 40 turns)
  stop: () => boolean = () => false, // v37 FIX-REV (REVIEW361-ux L6): true after a turn ends it there
): Promise<UnverifiedOutcome> {
  let done = 0;
  let last: UnverifiedBulkResult | null = null;
  let stopped = false;
  for (let turn = 0; turn < maxTurns; turn += 1) {
    last = await send();
    done += last.done;
    onTurn({ action: last.action, done, skipped: last.skipped, left: last.left, message: last.message, items: [] });
    if (last.left === 0 || last.done === 0) break;
    if (stop()) {
      stopped = true;
      break;
    }
  }
  const message = stopped ? stoppedLine(last!.action, done, last!.left) : allLine(last!.action, done, last!.skipped, last!.left, last!);
  return { action: last!.action, done, skipped: last!.skipped, left: last!.left, message, items: [], ...(stopped ? { stopped } : {}) };
}

/** v37 FIX-REV (L6): "Stopped: approved 200 jobs. 60 still wait." */
function stoppedLine(action: 'approve' | 'reject', done: number, left: number): string {
  const verb = action === 'approve' ? 'approved' : 'rejected';
  return `Stopped: ${verb} ${jobsText(done)}.${left > 0 ? ` ${left.toLocaleString('en-US')} still wait.` : ''}`;
}

/** One line for an "all" that took several requests (the server's own words when it took one). */
function allLine(action: 'approve' | 'reject', done: number, skipped: number, left: number, last: UnverifiedBulkResult): string {
  if (done === last.done) return last.message;
  const verb = action === 'approve' ? 'Approved' : 'Rejected';
  const parts = [`${verb} ${jobsText(done)}.`];
  if (skipped > 0) parts.push(`${skipped.toLocaleString('en-US')} could not be ${action === 'approve' ? 'approved' : 'rejected'}.`);
  if (left > 0) parts.push(`${left.toLocaleString('en-US')} left: run it again later to go on.`);
  return parts.join(' ');
}

/**
 * The selection's Approve or Reject: one request per turn of UNVERIFIED_BULK_MAX, a turn that fails counting its rows
 * skipped with the failure's words.
 */
export async function runUnverifiedBulk(
  action: 'approve' | 'reject',
  jobIds: readonly number[],
  send: (jobIds: readonly number[]) => Promise<UnverifiedBulkResult>,
  failure: (error: unknown) => string,
): Promise<UnverifiedOutcome> {
  let done = 0;
  let skipped = 0;
  const items: UnverifiedBulkResult['items'] = [];
  for (const turn of unverifiedTurns(jobIds)) {
    try {
      const answer = await send(turn);
      done += answer.done;
      skipped += answer.skipped;
      items.push(...answer.items);
    } catch (error) {
      const words = failure(error);
      skipped += turn.length;
      items.push(...turn.map((jobId) => ({ jobId, outcome: 'skipped' as const, message: words })));
    }
  }
  const verb = action === 'approve' ? 'Approved' : 'Rejected';
  const line = [`${verb} ${jobsText(done)}.`, skipped > 0 ? `${skipped.toLocaleString('en-US')} could not be ${action === 'approve' ? 'approved' : 'rejected'}.` : '']
    .filter(Boolean)
    .join(' ');
  return { action, done, skipped, left: 0, message: line, items };
}

/** The few character references a stored description holds (the API escapes captured text). */
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'" };

/**
 * v35 OPSWEB (SPECS-W2 "Imported text is shown as text"): an imported job's stored description (the API's sanitised HTML
 * of the row's text) as plain paragraphs for React text nodes: block ends and line breaks become paragraph breaks, every
 * tag goes, the character references are read. Never drawn as HTML.
 */
export function descriptionParagraphs(html: string): string[] {
  const text = html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|h[1-6]|ul|ol|blockquote|tr)\s*>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
      const known = ENTITIES[name.toLowerCase()];
      if (known !== undefined) return known;
      const code = /^#x/i.test(name) ? Number.parseInt(name.slice(2), 16) : /^#/.test(name) ? Number.parseInt(name.slice(1), 10) : Number.NaN;
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    });
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim())
    .filter(Boolean);
}

/** The Reject confirm's sentence. */
export function rejectText(row: Pick<UnverifiedLink, 'adders'>): string {
  const keep = row.adders === 1 ? 'The person who added it keeps their own copy.' : `The ${row.adders} people who added it keep their own copies.`;
  return `TailorIT will never publish a job from this link, whoever adds it. ${keep}`;
}
