import type { JobAddState, LinkBatchProgress, QueuedLinks } from '@tailorit/shared/jobs';
import type { BadgeTone } from '@/components/ui/Badge';
import { REASON_ADMIN_TEXT } from '../review/unverified';

// v31 ADMINWEB: an admin's links (docs/design/v3.1/21-jobs-from-links.md §5): pasted links queued for TailorIT's own
// read (POST /api/admin/jobs/add), an import's link column (its run's batch `run:<id>`), and their progress (GET
// /api/admin/jobs/add/:batchId). TailorIT reads each posting from its link; nothing else a list says is kept. The words
// and rules, apart from the components so the tests read them.

/** How often a batch's progress is read while links still wait. */
export const LINK_PROGRESS_POLL_MS = 3_000;
/** The progress table shows this many links (the server answers the first 500). */
export const LINK_PROGRESS_SHOWN = 50;

/**
 * The links in pasted text, in order: one per line, or separated by spaces, commas or semicolons; a link wrapped in
 * <…> or quotes is unwrapped. Repeats stay (the server counts them once and says so).
 */
export function parseLinks(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((part) => part.trim().replace(/^[<"'(]+|[>"')]+$/g, ''))
    .filter((part) => part.length > 0);
}

/** "1 link", "3 links". */
export const linksText = (count: number) => `${count.toLocaleString('en-US')} ${count === 1 ? 'link' : 'links'}`;

/** The batch id of an import run's links. */
export const runBatchId = (runId: number) => `run:${runId}`;

/** What the queue did with a pasted list, in sentences. */
export function queuedSummary(answer: Pick<QueuedLinks, 'queued' | 'alreadyQueued' | 'repeated' | 'refused'>): string {
  const parts = [`${linksText(answer.queued)} queued for reading.`];
  if (answer.alreadyQueued > 0) parts.push(`${linksText(answer.alreadyQueued)} ${answer.alreadyQueued === 1 ? 'was' : 'were'} already waiting.`);
  if (answer.repeated > 0) parts.push(`${answer.repeated.toLocaleString('en-US')} ${answer.repeated === 1 ? 'repeat was' : 'repeats were'} counted once.`);
  if (answer.refused.length > 0) {
    parts.push(`${linksText(answer.refused.length)} ${answer.refused.length === 1 ? 'is not a job link' : 'are not job links'} TailorIT may read.`);
  }
  return parts.join(' ');
}

/** A queued link's state in a progress table. */
export type LinkItemState = 'queued' | 'working' | JobAddState;

export const LINK_ITEM_LABEL: Record<LinkItemState, string> = {
  queued: 'Waiting',
  working: 'Reading',
  published: 'Published',
  waiting_admin: 'Waiting for approval',
  private_unverified: "Couldn't read",
  refused: 'Not added',
};

export const LINK_ITEM_TONE: Record<LinkItemState, BadgeTone> = {
  queued: 'sky',
  working: 'sky',
  published: 'success',
  waiting_admin: 'warning',
  private_unverified: 'neutral',
  refused: 'neutral',
};

/** An item's state: its result once read, else where it is in the queue. */
export function itemState(item: Pick<LinkBatchProgress['items'][number], 'state' | 'result'>): LinkItemState {
  return item.state === 'done' ? (item.result ?? 'refused') : item.state;
}

/** Why an item was not published, in an admin's words; null when it was (or is not read yet). */
export function itemReason(item: Pick<LinkBatchProgress['items'][number], 'state' | 'reason'>): string | null {
  return item.state === 'done' && item.reason ? REASON_ADMIN_TEXT[item.reason] : null;
}

/** The order the counts line names the results in. */
const COUNT_ORDER: readonly LinkItemState[] = ['published', 'waiting_admin', 'private_unverified', 'refused', 'working', 'queued'];

/** The batch's counts as a line: "2 published · 1 waiting for approval · 3 waiting"; empty counts left out. */
export function progressCountsText(counts: LinkBatchProgress['counts']): string {
  return COUNT_ORDER.filter((key) => (counts[key] ?? 0) > 0)
    .map((key) => `${(counts[key] ?? 0).toLocaleString('en-US')} ${LINK_ITEM_LABEL[key].toLowerCase()}`)
    .join(' · ');
}

/** "3 of 10 read". */
export function progressText(progress: Pick<LinkBatchProgress, 'done' | 'total'>): string {
  return `${progress.done.toLocaleString('en-US')} of ${progress.total.toLocaleString('en-US')} read`;
}

/** Whether the batch is still being read (its progress is read again). */
export const batchRunning = (progress: Pick<LinkBatchProgress, 'done' | 'total'> | undefined) => !progress || progress.done < progress.total;

/** The paste form's problem, or null: no link, or more than ADMIN_ADD_LINKS_MAX (its words: MSG_JOB_ADD_TOO_MANY_LINKS). */
export function pasteProblem(count: number, max: number): 'empty' | 'too_many' | null {
  if (count === 0) return 'empty';
  if (count > max) return 'too_many';
  return null;
}

/** The words of an empty paste. */
export const EMPTY_PASTE_TEXT = 'Paste at least one job link.';
