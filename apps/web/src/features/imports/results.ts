import {
  JOB_IMPORT_ROW_RESULT_LABEL,
  type JobImportCounts,
  type JobImportRowOutcome,
  type JobImportRowResult,
  type JobImportSummary,
} from '@tailorit/shared';
import type { BadgeTone } from '@/components/ui/Badge';
import type { ImportAudience } from './api';

// v35 IMPORTWEB (SP v35 SPECS-W2.md IMPORTWEB §1 "The results"; PLAN H2, H5): what an import came to, apart from the
// components so the tests read them: the counts as chips (each filters the rows: the API's `?result=`), each row's
// result and reason, the progress while rows wait for TailorIT's read, and "Download these rows" (the API's cells,
// already formula-safe, written as CSV). Pure: no React, no network.

/** How often an import still being read is asked again. */
export const IMPORT_POLL_MS = 3_000;

export type ResultChipKey = 'added' | 'reposted' | 'known' | 'review' | 'needs_details' | 'closed' | 'failed';

export interface ResultChip {
  key: ResultChipKey;
  label: string;
  /** The row results it counts and shows. */
  results: readonly JobImportRowResult[];
  /** The counts it adds up. */
  counts: ReadonlyArray<Exclude<keyof JobImportCounts, 'rows'>>;
}

/**
 * The results' chips, in the spec's order. "To review" holds a person's own job waiting for review too ("Added for you;
 * waiting for review"); "Couldn't import" holds a row that repeats an earlier one (its reason names the row).
 */
export const RESULT_CHIPS: readonly ResultChip[] = [
  { key: 'added', label: 'Added', results: ['added'], counts: ['added'] },
  { key: 'reposted', label: 'Reposted', results: ['reposted'], counts: ['reposted'] },
  { key: 'known', label: 'Already in TailorIT', results: ['known'], counts: ['known'] },
  { key: 'review', label: 'To review', results: ['review', 'added_private'], counts: ['review', 'addedPrivate'] },
  { key: 'needs_details', label: 'Needs a title and company', results: ['needs_details'], counts: ['needsDetails'] },
  { key: 'closed', label: 'Closed', results: ['closed'], counts: ['closed'] },
  { key: 'failed', label: "Couldn't import", results: ['failed', 'repeated'], counts: ['failed', 'repeated'] },
];

/** A chip's count. */
export function chipCount(counts: JobImportCounts, chip: Pick<ResultChip, 'counts'>): number {
  return chip.counts.reduce((sum, key) => sum + (counts[key] ?? 0), 0);
}

/** The API's `?result=` of a chip (null: every row). */
export function chipQuery(key: ResultChipKey | null): string | null {
  const chip = key ? RESULT_CHIPS.find((entry) => entry.key === key) : undefined;
  return chip ? chip.results.join(',') : null;
}

/** The badge tone of each row result. */
export const RESULT_TONE: Record<JobImportRowResult, BadgeTone> = {
  queued: 'sky',
  working: 'sky',
  added: 'success',
  reposted: 'success',
  known: 'neutral',
  review: 'warning',
  added_private: 'warning',
  needs_details: 'warning',
  closed: 'neutral',
  failed: 'destructive',
  repeated: 'neutral',
};

/** A row's result in words. */
export const resultLabel = (result: JobImportRowResult): string => JOB_IMPORT_ROW_RESULT_LABEL[result];

/**
 * Why a row came to its result, in words, or '' when its result says it all: the API's message ("Couldn't import: This
 * site doesn't allow TailorIT to read it.") without the result's own words.
 */
export function rowReasonText(row: Pick<JobImportRowOutcome, 'result' | 'message'>): string {
  const label = resultLabel(row.result);
  const message = row.message.trim();
  if (message === label || message === `${label}.`) return '';
  if (message.startsWith(`${label}: `)) return message.slice(label.length + 2);
  return message;
}

/** Whether the import still has rows waiting for TailorIT's read (its GET is asked again every IMPORT_POLL_MS). */
export const importRunning = (summary: Pick<JobImportSummary, 'finishedAt'> | undefined): boolean => !summary || summary.finishedAt === null;

/** The progress of an import: rows read of rows. */
export function importProgress(counts: JobImportCounts): { done: number; total: number } {
  return { done: Math.max(0, counts.rows - counts.queued), total: counts.rows };
}

/** "18 of 24 rows read". */
export const progressText = ({ done, total }: { done: number; total: number }): string =>
  `${done.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} ${total === 1 ? 'row' : 'rows'} read`;

/** A link from an import as an address to open: only an http(s) one (anything else is shown as text, never a link). */
export function webLink(link: string | null | undefined): string | null {
  const text = (link ?? '').trim();
  return /^https?:\/\/[^\s/]+/i.test(text) ? text : null;
}

/** A link as a row shows it: host and path, no scheme, cut to `max` characters with an ellipsis. */
export function shortLink(link: string, max = 48): string {
  const bare = link.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
  return bare.length > max ? `${bare.slice(0, max - 1)}…` : bare;
}

// --------------------------------------------------------------------------------------- "Download these rows"

/** The file name of "Download these rows": tailorit-import-<name>-needs-details.csv. */
export function downloadFileName(importName: string): string {
  const slug = importName
    .toLowerCase()
    .replace(/\.(csv|tsv|txt|json|xlsx)\b/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return `tailorit-import-${slug || 'rows'}-needs-details.csv`;
}

/** Saves a file through a Blob (a browser download); the link is made, clicked and dropped. */
export function saveFile(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Kept a while: the browser reads the blob after the click returns.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

// --------------------------------------------------------------------------------------------- one line of counts

/** An import's counts as parts ("12 added", "3 to review", "4 need a title and company"), empty counts left out. */
export function countParts(counts: JobImportCounts): Array<{ key: ResultChipKey | 'queued'; count: number; text: string }> {
  const parts: Array<{ key: ResultChipKey | 'queued'; count: number; text: string }> = RESULT_CHIPS.map((chip) => ({ chip, count: chipCount(counts, chip) }))
    .filter(({ count }) => count > 0)
    .map(({ chip, count }) => {
      // "1 needs a title and company", "4 need a title and company".
      const words = chip.key === 'needs_details' && count !== 1 ? 'need a title and company' : `${chip.label.charAt(0).toLowerCase()}${chip.label.slice(1)}`;
      return { key: chip.key, count, text: `${count.toLocaleString('en-US')} ${words}` };
    });
  if (counts.queued > 0) parts.push({ key: 'queued', count: counts.queued, text: `${counts.queued.toLocaleString('en-US')} waiting` });
  return parts;
}

/**
 * An import's counts as a short line ("12 added · 3 to review · 1 needs a title and company"), empty counts left out.
 * v35 FIX-WEB (the ux review's L2): the one rule for counting an import's rows, on the results, Recent imports and
 * Runs alike: a repeated row is one of "Couldn't import" (its reason names the row it repeats).
 */
export function countsLine(counts: JobImportCounts): string {
  return countParts(counts).map((part) => part.text).join(' · ') || 'No rows';
}

/**
 * v35 FIX-WEB (the ux review's L8): what the results' polite status line says: the rows read while TailorIT reads them
 * ("12 of 24 rows read"), then what the import came to.
 */
export function resultsLiveText(summary: Pick<JobImportSummary, 'finishedAt' | 'counts'>): string {
  if (importRunning(summary)) return progressText(importProgress(summary.counts));
  return `Import finished: ${countsLine(summary.counts)}.`;
}

// ------------------------------------------------------------------------------------------------ a row's job

/**
 * v35 FIX-WEB (the ux review's M4): where a row's job leads. A job held for an admin's review is not in search, so an
 * admin's link goes to where it waits (the API's `heldIn`): Review › Couldn't verify or Review › New jobs, filtered to the
 * import's run when this import made, read or reopened it (To review, Added, Reposted); a held job found in TailorIT
 * already (Already in TailorIT) waits from someone else's add, so its lane opens unfiltered. A row not held, and every
 * row of a person's import, opens its job (the API gives a job id only when its viewer may open it).
 */
export type RowJob =
  | { kind: 'none' }
  | { kind: 'open'; jobId: number }
  | { kind: 'review'; lane: 'unverified' | 'new_job'; href: string };

/** The words of a held row's link, and of a job's. */
export const ROW_JOB_WORDS = { review: 'Review it', open: 'Open job' } as const;

/** Admin › Review on one lane, filtered to an import's run when given (the lanes read `run=`). */
export function reviewLaneHref(lane: 'unverified' | 'new_job', runId: number | null): string {
  const params = new URLSearchParams({ tab: 'review', lane });
  if (runId !== null) params.set('run', String(runId));
  return `/settings/admin?${params.toString()}`;
}

export function rowJob(row: Pick<JobImportRowOutcome, 'jobId' | 'result' | 'heldIn'>, audience: ImportAudience, runId: number | null): RowJob {
  if (row.jobId === null) return { kind: 'none' };
  if (audience === 'people' || row.heldIn === null) return { kind: 'open', jobId: row.jobId };
  const ofThisImport = row.result === 'review' || row.result === 'added' || row.result === 'reposted';
  return { kind: 'review', lane: row.heldIn, href: reviewLaneHref(row.heldIn, ofThisImport ? runId : null) };
}

/**
 * v35 FIX-WEB (L9, after FIX-PIPE's D4): Admin › Import's ways to Review for an import, no number that goes stale: Couldn't
 * verify while rows are To review (or a row shown waits there), and New jobs when a row shown waits there (a held read,
 * or a reopened New jobs review: such a row is To review too).
 */
export function importReviewLanes(
  counts: Pick<JobImportCounts, 'review'>,
  rows: ReadonlyArray<Pick<JobImportRowOutcome, 'heldIn' | 'result'>>,
): Array<'unverified' | 'new_job'> {
  const lanes: Array<'unverified' | 'new_job'> = [];
  const reviewRows = rows.filter((row) => row.result === 'review');
  const allReviewInNewJobs = reviewRows.length > 0 && reviewRows.length >= counts.review && reviewRows.every((row) => row.heldIn === 'new_job');
  if ((counts.review > 0 && !allReviewInNewJobs) || rows.some((row) => row.heldIn === 'unverified')) lanes.push('unverified');
  if (rows.some((row) => row.heldIn === 'new_job')) lanes.push('new_job');
  return lanes;
}
