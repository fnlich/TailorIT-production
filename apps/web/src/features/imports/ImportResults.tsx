'use client';

import type { JobImportDetail, JobImportRowOutcome } from '@tailorit/shared';
import { keepPreviousData, useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ScrollRegion, ShowMoreButton } from '@/components/admin';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { HelpTip } from '@/components/ui/HelpTip';
import { DownloadSimpleIcon } from '@/components/ui/icons';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { TapeMeter } from '@/components/ui/TapeMeter';
import { isApiError, userMessage } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { downloadNeedsDetails, fetchImportDetail, importKeys, type ImportAudience } from './api';
import {
  IMPORT_POLL_MS,
  RESULT_CHIPS,
  RESULT_TONE,
  ROW_JOB_WORDS,
  chipCount,
  chipQuery,
  downloadFileName,
  importProgress,
  importRunning,
  progressText,
  resultLabel,
  resultsLiveText,
  rowJob,
  rowReasonText,
  saveFile,
  shortLink,
  webLink,
  type ResultChipKey,
} from './results';

// v35 IMPORTWEB (SP v35 SPECS-W2.md IMPORTWEB §1 "The results"; PLAN H2, H5): what an import came to. Its counts as
// chips (each filters the rows below through the API's `?result=`), a table of rows (row number, link shortened and
// opened in a new tab, result, reason, the job), paging, progress while rows wait for TailorIT's read (the import's GET
// asked every IMPORT_POLL_MS until it finished; leaving the dialog or the page stops it), and "Download these rows" when
// rows need a title and company. Every word from an import is drawn as text.
// v35 FIX-WEB (the final review): "Download these rows" saves the API's CSV (GET …/needs-details.csv: escaped cells, at
// most 10 MB; a refusal said in an alert); each row's reason is the API's words for every viewer (an admin's too); a
// row whose job is held for review links to where it waits (M4: Review it); a polite status line says the rows read,
// then what the import came to (L8); an import that is not there says so, with the caller's ways on (L11).

export interface ImportResultsProps {
  audience: ImportAudience;
  /** An admin's import: its run; a person's: its id. */
  id: number;
  /** A person's dialog opens the job there (and closes); absent, the job opens in a new tab on Jobs. */
  onOpenJob?: (jobId: number) => void;
  /** Beside the heading (the import's other places), given the import and the rows shown (v35 FIX-WEB: where they wait). */
  actions?: (detail: JobImportDetail, rows: readonly JobImportRowOutcome[]) => ReactNode;
  /** The heading's level in its page. */
  headingLevel?: 2 | 3;
  /** Once the last row is read (the lists that show its jobs are read again). */
  onFinished?: (detail: JobImportDetail) => void;
  /** The import is not there (404: another profile's, or gone). */
  onGone?: () => void;
  /** v35 FIX-WEB (L11): the ways on beside "That import was not found." (New import, Recent imports). */
  goneActions?: ReactNode;
  /** Focus goes to the heading once the results are drawn (an import just started or opened). */
  focusHeading?: boolean;
}

/** v35 FIX-WEB (L11): the words of an import that is not there (404). */
export const IMPORT_NOT_FOUND = 'That import was not found.';

/** Where focus goes when "Show more rows" leaves with the last page: the last row's link, else the table. */
const AFTER_LAST = ['[data-import-rows] tbody tr:last-child a', '[data-import-rows]'];

export function ImportResults({
  audience,
  id,
  onOpenJob,
  actions,
  headingLevel = 3,
  onFinished,
  onGone,
  goneActions,
  focusHeading = false,
}: ImportResultsProps) {
  const now = useNow();
  const headingId = useId();
  const [chip, setChip] = useState<ResultChipKey | null>(null);
  const result = chipQuery(chip);
  const detail = useInfiniteQuery({
    queryKey: importKeys.detail(audience, id, result),
    queryFn: ({ pageParam, signal }) => fetchImportDetail(audience, id, { cursor: pageParam, result }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
    refetchInterval: (query) => (importRunning(query.state.data?.pages[0]) ? IMPORT_POLL_MS : false),
  });
  // Told once when an import seen running has finished.
  const latest = detail.data?.pages[0];
  const seenRunning = useRef(false);
  const finished = useRef(onFinished);
  const gone = useRef(onGone);
  useEffect(() => {
    finished.current = onFinished;
    gone.current = onGone;
  });
  const missing = detail.isError && isApiError(detail.error) && detail.error.status === 404;
  useEffect(() => {
    if (missing) gone.current?.();
  }, [missing]);
  // Once, when the heading is first drawn.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focused = useRef(!focusHeading);
  const drawn = Boolean(latest);
  useEffect(() => {
    if (!drawn || focused.current) return;
    focused.current = true;
    headingRef.current?.focus();
  }, [drawn]);
  useEffect(() => {
    if (!latest) return;
    if (importRunning(latest)) seenRunning.current = true;
    else if (seenRunning.current) {
      seenRunning.current = false;
      finished.current?.(latest);
    }
  }, [latest]);

  // v35 FIX-WEB (S4): "Download these rows", the API's CSV saved under its own name; a refusal (413) says its words.
  const download = useMutation({
    mutationFn: (name: string) => downloadNeedsDetails(audience, id, downloadFileName(name)),
    onSuccess: (file) => saveFile(file.fileName, file.blob),
  });

  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const first = detail.data?.pages[0];
  if (!first) {
    // v35 FIX-WEB (L11): an import that is not there is said plainly, with the caller's ways on (no Try again).
    if (missing) {
      return (
        <div data-import-missing="">
          <Notice tone="warning" title={IMPORT_NOT_FOUND} action={goneActions ? <div className="flex flex-wrap gap-2">{goneActions}</div> : undefined} />
        </div>
      );
    }
    if (detail.isError) {
      return (
        <Notice
          tone="error"
          title="The results didn't load."
          action={
            <Button variant="outline" size="sm" onClick={() => void detail.refetch()}>
              Try again
            </Button>
          }
        >
          {userMessage(detail.error)}
        </Notice>
      );
    }
    return (
      <div className="flex flex-col gap-3" aria-busy="true" data-import-results-loading="">
        <Skeleton className="h-5 w-56" />
        <Skeleton className="h-8 w-full" rounded="control" />
        <Skeleton className="h-40 w-full" rounded="surface" />
      </div>
    );
  }

  const running = importRunning(first);
  const progress = importProgress(first.counts);
  const rows = (detail.data?.pages ?? []).flatMap((page) => page.rows);
  const needs = first.counts.needsDetails; // v35 FIX-WEB (S4): the counts only; the rows are the CSV route's
  const chips = RESULT_CHIPS.filter((entry) => audience === 'admin' || entry.key !== 'reposted');
  const shownChip = chips.find((entry) => entry.key === chip) ?? null;
  const when = relativeTime(first.finishedAt ?? first.createdAt, now);
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-4" data-import-results={id} data-import-running={running || undefined}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Heading ref={headingRef} id={headingId} tabIndex={-1} className="text-[15px] leading-5 font-semibold break-words text-foreground outline-none">
            {first.name}
          </Heading>
          <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground" data-import-meta="">
            {[first.startedBy ? `Started by ${first.startedBy}` : null, running ? `Started ${relativeTime(first.createdAt, now)}` : `Finished ${when}`]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions(first, rows)}</div>}
      </div>

      {/* v35 FIX-WEB (L8): heard, not seen (the bar and the chips show it): the rows read, then what it came to. */}
      <p className="sr-only" role="status" aria-live="polite" data-import-live="">
        {resultsLiveText(first)}
      </p>

      {running && (
        <div className="flex flex-col gap-2" data-import-progress="">
          <TapeMeter label="Rows read" showLabel value={progress.done} max={Math.max(1, progress.total)} valueText={progressText(progress)} kind="progress" tone="primary" />
          <p className="text-[13px] leading-5 text-muted-foreground">
            TailorIT reads a few links per site at a time, so a long list takes a while. You can leave this page.
          </p>
        </div>
      )}

      <div role="group" aria-label="Show rows" className="flex flex-wrap gap-2" data-import-chips="">
        <Chip size="sm" selected={chip === null} onClick={() => setChip(null)}>
          {`All ${first.counts.rows.toLocaleString('en-US')}`}
        </Chip>
        {chips.map((entry) => {
          const count = chipCount(first.counts, entry);
          return (
            <Chip
              key={entry.key}
              size="sm"
              selected={chip === entry.key}
              disabled={count === 0 && chip !== entry.key}
              onClick={() => setChip(chip === entry.key ? null : entry.key)}
            >
              {`${entry.label} ${count.toLocaleString('en-US')}`}
            </Chip>
          );
        })}
      </div>

      {needs > 0 && (
        <div className="flex flex-col gap-2" data-import-download="">
          <span className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              icon={<DownloadSimpleIcon size={14} />}
              loading={download.isPending}
              onClick={() => download.mutate(first.name)}
            >
              Download these rows
            </Button>
            <HelpTip label="Download these rows">
              {`A CSV of the ${needs.toLocaleString('en-US')} ${needs === 1 ? 'row' : 'rows'} to fill in with a title and company, then import again.`}
            </HelpTip>
          </span>
          {download.isError && (
            <div data-import-download-error="">
              <Notice tone="error">{userMessage(download.error)}</Notice>
            </div>
          )}
        </div>
      )}

      {rows.length === 0 ? (
        <p className="rounded-card border border-border bg-surface px-4 py-6 text-center text-sm text-muted-foreground" data-import-rows-empty="">
          {shownChip ? `No row is "${shownChip.label}".` : running ? 'The rows are being queued.' : 'This import has no rows.'}
        </p>
      ) : (
        <ScrollRegion label={`Rows of ${first.name}`} className="rounded-card border border-border bg-surface shadow-card">
          <table className="w-full min-w-[36rem] border-collapse text-left" aria-label={`Rows of ${first.name}`} data-import-rows="" aria-busy={detail.isFetching && detail.isPlaceholderData ? true : undefined}>
            <thead>
              <tr className="h-10 border-b border-border bg-surface-low">
                {['Row', 'Link', 'Result', 'Reason', 'Job'].map((head) => (
                  <th key={head} scope="col" className="px-3 text-[11px] leading-4 font-semibold tracking-[0.06em] whitespace-nowrap text-subtle-foreground uppercase">
                    {head}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-divider-soft">
              {rows.map((row) => (
                <ResultRow key={row.row} row={row} audience={audience} runId={audience === 'admin' ? id : null} onOpenJob={onOpenJob} />
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      )}
      <ShowMoreButton
        hasMore={Boolean(detail.hasNextPage)}
        loading={detail.isFetchingNextPage}
        onMore={() => void detail.fetchNextPage()}
        afterLast={AFTER_LAST}
        className="flex justify-center"
      >
        Show more rows
      </ShowMoreButton>
    </section>
  );
}

function ResultRow({
  row,
  audience,
  runId,
  onOpenJob,
}: {
  row: JobImportRowOutcome;
  audience: ImportAudience;
  runId: number | null;
  onOpenJob?: (jobId: number) => void;
}) {
  const named = [row.title, row.company].filter(Boolean).join(' · ');
  const href = webLink(row.link);
  // v35 FIX-WEB (the fix list's item 10): the API's words for every viewer (an admin's import: Review's wording).
  const reason = rowReasonText(row);
  const job = rowJob(row, audience, runId);
  return (
    <tr className="align-top" data-import-row={row.row} data-import-result={row.result}>
      <th scope="row" className="num px-3 py-2.5 text-[13px] leading-5 font-normal text-muted-foreground">
        {row.row}
      </th>
      <td className="max-w-56 px-3 py-2.5 text-[13px] leading-5">
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer nofollow" title={href} className="break-all text-primary hover:underline">
            {shortLink(href)}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        ) : row.link ? (
          <span className="break-all text-foreground">{shortLink(row.link)}</span>
        ) : (
          <span className="text-muted-foreground">No link</span>
        )}
        {named && <span className="mt-0.5 block break-words text-xs leading-4 text-muted-foreground">{named}</span>}
      </td>
      <td className="px-3 py-2.5">
        <Badge tone={RESULT_TONE[row.result]} wrap>
          {resultLabel(row.result)}
        </Badge>
      </td>
      <td className="max-w-64 px-3 py-2.5 text-[13px] leading-5 break-words text-muted-foreground">{reason || '-'}</td>
      <td className="px-3 py-2.5 text-[13px] leading-5 whitespace-nowrap">
        {job.kind === 'none' ? (
          <span className="text-muted-foreground">-</span>
        ) : job.kind === 'review' ? (
          // v35 FIX-WEB (M4): a held job is not in search: Review's lane where it waits, filtered to this import.
          <a href={job.href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline" data-import-row-review={job.lane}>
            {ROW_JOB_WORDS.review}
            <span className="sr-only">{` (row ${row.row}, in ${job.lane === 'unverified' ? "Couldn't verify" : 'New jobs'}; opens in a new tab)`}</span>
          </a>
        ) : onOpenJob ? (
          <Button variant="link" onClick={() => onOpenJob(job.jobId)} aria-label={`Open job: row ${row.row}`}>
            {ROW_JOB_WORDS.open}
          </Button>
        ) : (
          <a href={`/jobs?jobId=${job.jobId}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
            {ROW_JOB_WORDS.open}
            <span className="sr-only">{` of row ${row.row} (opens in a new tab)`}</span>
          </a>
        )}
      </td>
    </tr>
  );
}
