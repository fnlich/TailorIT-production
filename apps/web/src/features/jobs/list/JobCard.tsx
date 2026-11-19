'use client';

import { EMPLOYMENT_TYPE_LABEL, appliedChipLabel, type JobRowMatch, type JobSort } from '@tailorit/shared';
import { clsx } from 'clsx';
import { memo, useId, type MouseEvent } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { BookmarkSimpleIcon, CheckCircleIcon } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/Skeleton';
import { TapeMeter } from '@/components/ui/TapeMeter';
import { Tooltip } from '@/components/ui/Tooltip';
import { usePublicConstants } from '@/lib/constants';
import type { JobListItem } from '../api';
import { CompanyLogo } from '../CompanyLogo';
import { CardCredit } from '../credits/JobCredit'; // v30 S4
import { cardAge, cardLocationLine, cardSalary } from '../format';
import { VerificationBadge } from '../verification/VerificationBadge'; // v31 JOBSWEB
import { verificationMark } from '../verification/copy';
import { saveBlockReason } from './useSaveSelected';

/** How a row was opened: by a pointer, or by the keyboard (Enter on its link), which moves focus to the job. */
export interface OpenHow {
  keyboard: boolean;
}

export interface JobCardProps {
  job: JobListItem;
  href: string;
  /** The job shown in the detail. */
  selected: boolean;
  sort: JobSort;
  now: number;
  /** v31 FIX-JOBS: the row's keyword match; undefined while it loads, null when it cannot be measured. */
  match: JobRowMatch | null | undefined;
  onSelect: (jobId: number, how: OpenHow) => void;
  onToggleSave: (job: JobListItem) => void;
  /**
   * v31 FIX-JOBS: the row's quick Apply (opens the job and its posting). v32 JOBS2: only while the list fills the page
   * (below 1024 px, from 640 px): beside the list, the job's own Apply is one look away.
   */
  onApply?: (jobId: number) => void;
  /** Choosing jobs to save (v2.0): the row shows its box. */
  selectable?: boolean;
  checked?: boolean;
  onToggleChecked?: (job: JobListItem, checked: boolean) => void;
}

/** A plain click opens the job here; modified clicks (new tab, new window) keep the browser's own behaviour. */
function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** The share of keywords from which a match turns green (a strong match). */
export const STRONG_MATCH_PERCENT = 70;

/** The row's measure: a small tape meter of how much of the posting's keywords the person's resume has. */
export function RowMatch({
  match,
  showLabel = true,
  className,
  meterClassName,
}: {
  match: JobRowMatch | null | undefined;
  /** Draws "Match" before the bar. */
  showLabel?: boolean;
  className?: string;
  /** The bar's own classes (its width), not the words of a posting with nothing to measure. */
  meterClassName?: string;
}) {
  const { t } = usePublicConstants();
  if (match === undefined) {
    return (
      <span className={clsx('flex items-center gap-2.5', className, meterClassName)} aria-hidden="true" data-row-match="loading">
        <Skeleton className="h-1.5 flex-1" />
        <Skeleton className="h-3 w-7" />
      </span>
    );
  }
  if (match === null || match.state !== 'ok') return null;
  if (match.total === 0) {
    return (
      <span className={clsx('text-xs leading-4 whitespace-nowrap text-muted-foreground', className)} data-row-match="none">
        {t('LABEL_JOBS_ROW_NO_SKILLS')}
      </span>
    );
  }
  return (
    <span className={clsx('block', className, meterClassName)} data-row-match={match.percentage}>
      <TapeMeter
        label={t('LABEL_JOBS_ROW_MATCH')}
        showLabel={showLabel}
        value={match.percentage}
        size="sm"
        layout="inline"
        tone={match.percentage >= STRONG_MATCH_PERCENT ? 'success' : 'tape'}
      />
    </span>
  );
}

/** The facts line's separator, its spaces unbreakable (a flex item's edge would drop plain ones). */
const SEP = ' · ';

/** A quick action that shows on the row's hover and keyboard focus (and stays while its job is open). */
const QUICK = 'sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100 sm:focus-visible:opacity-100';

/**
 * v32 FIX-UX (UXREQ-1, coordinator: "compact two-line rows, 7-8 jobs at 1440 x 900"): one job of the list, a row made
 * to be scanned down a column, about 73 px tall:
 *   - line 1: the title (the row's one link, stretched over the row; one line, cut with an ellipsis, its words in its
 *     title), the Applied mark, the match (a small tape meter of the posting's keywords the resume has), the quick
 *     Apply (below 1024 px) and the bookmark (filled once saved);
 *   - line 2: the company, where (the place gives way first: its full words are its title), the pay (in ink, never
 *     cut), the job type when it is not full time, and the age.
 * The company's industry and size are the job pane's (its header), not the row's. A job others do not see (held,
 * only you, approved by an admin) and a source's credit add a line under it. In a narrow list (below 30 rem: the split
 * at 1024-1279 px, a phone; the list card is a size container) the title takes up to two lines and line 2 splits in
 * two (company and place with the match at its end; pay, kind and age), the Applied mark under them. The open job's
 * row is tinted with a denim edge. While jobs are chosen to save, a box sits before the monogram.
 */
export const JobCard = memo(function JobCard({
  job,
  href,
  selected,
  sort,
  now,
  match,
  onSelect,
  onToggleSave,
  onApply,
  selectable = false,
  checked = false,
  onToggleChecked,
}: JobCardProps) {
  const { t } = usePublicConstants();
  const place = cardLocationLine(job);
  const salary = cardSalary(job);
  const age = cardAge(job, sort, now);
  // Full time is what a job is unless it says otherwise: the row names the other kinds (Contract, Part-Time, ...).
  const kind = job.employmentType && job.employmentType !== 'full_time' ? EMPLOYMENT_TYPE_LABEL[job.employmentType] : '';
  const saveLabel = job.saved ? `Remove ${job.title} from saved jobs` : `Save ${job.title}`;
  const blocked = selectable ? saveBlockReason(job) : null;
  const marked = verificationMark(job) !== null;
  const markId = useId();
  const canApply = Boolean(onApply) && job.active && !job.appliedOn;
  const hasWhen = Boolean(salary || kind || age);
  // The Applied mark: by the title in a wide list, under the facts in a narrow one (CSS shows one of the two).
  const appliedMark = (where: 'wide' | 'narrow') =>
    job.appliedOn ? (
      <Badge
        tone="success"
        icon={<CheckCircleIcon size={12} weight="fill" aria-hidden="true" />}
        className="shrink-0"
        {...(where === 'wide' ? { 'data-row-applied': '' } : { 'data-row-applied-narrow': '' })}
      >
        {appliedChipLabel(job.appliedOn)}
      </Badge>
    ) : null;
  const applied = Boolean(job.appliedOn);

  return (
    <li
      data-job-card={job.id}
      className={clsx(
        'group relative flex scroll-mt-[calc(var(--spacing-topbar)_+_56px)] items-start gap-3 py-3.5 pr-3 pl-4 transition-colors duration-100 sm:pr-4',
        // The open job: a denim edge on a denim-soft row.
        selected
          ? 'bg-primary-soft before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-primary before:content-[""]'
          : 'hover:bg-surface-low',
      )}
      data-selected={selected ? '' : undefined}
    >
      {selectable &&
        (blocked === null ? (
          <span className="relative z-10 flex self-center">
            <Checkbox
              checked={checked}
              aria-label={`Select ${job.title} at ${job.company.name}`}
              onCheckedChange={(next) => onToggleChecked?.(job, next)}
            />
          </span>
        ) : (
          // Saved or applied to already: the box cannot be ticked, and says why.
          <Tooltip content={blocked}>
            <span className="relative z-10 flex self-center" data-not-selectable="">
              <Checkbox
                checked={false}
                disabled
                aria-label={`${job.title} at ${job.company.name}: ${blocked}`}
                onCheckedChange={() => undefined}
              />
            </span>
          </Tooltip>
        ))}
      {/* On the open job's tinted row the monogram keeps its tile (a white ground under its denim-soft one). */}
      <CompanyLogo name={job.company.name} url={job.company.logoUrl} size={36} className={clsx('mt-0.5', selected && 'ring-1 ring-primary-200')} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-start gap-2 @min-[30rem]/job-list:items-center">
          <h3 className="min-w-0 flex-1 text-[15px] leading-5 font-semibold text-foreground">
            {/* The row's one link: its ::after covers the row, so a click anywhere opens the job (the buttons sit above it). */}
            <a
              href={href}
              title={job.title}
              aria-current={selected ? 'true' : undefined}
              aria-describedby={marked ? markId : undefined}
              onClick={(event) => {
                if (!isPlainClick(event)) return;
                event.preventDefault();
                // A click the keyboard made (Enter) has no pointer: `detail` is 0.
                onSelect(job.id, { keyboard: event.detail === 0 });
              }}
              className={clsx(
                // A 24 px target (WCAG 2.5.8) on its 20 px line: two pixels above and below, taken back by the margins.
                '-my-0.5 block rounded-tag py-0.5 underline-offset-2 group-hover:underline',
                '@max-[30rem]/job-list:line-clamp-2 @min-[30rem]/job-list:truncate',
                'after:absolute after:inset-0 after:content-[""] focus-visible:outline-none',
                'focus-visible:after:shadow-[inset_0_0_0_2px_var(--color-focus)]',
              )}
            >
              {job.title}
            </a>
          </h3>
          {applied && <span className="flex shrink-0 @max-[30rem]/job-list:hidden">{appliedMark('wide')}</span>}
          {match !== null && (
            // The bar and its share, named "Match" (the job's pane says it in words beside the list).
            <RowMatch match={match} showLabel={false} meterClassName="w-[84px]" className="shrink-0 text-right @max-[30rem]/job-list:hidden" />
          )}
          <div className="relative z-10 -my-1.5 flex shrink-0 items-center gap-1.5">
            {canApply && (
              <Button
                size="sm"
                variant="outline"
                aria-label={t('LABEL_JOBS_ROW_APPLY', { title: job.title })}
                onClick={() => onApply?.(job.id)}
                className={clsx('max-sm:hidden', !selected && QUICK)}
                data-row-apply=""
              >
                Apply
              </Button>
            )}
            <Tooltip content={job.saved ? 'Saved' : 'Save'}>
              <button
                type="button"
                aria-label={saveLabel}
                aria-pressed={job.saved}
                onClick={() => onToggleSave(job)}
                className={clsx(
                  'inline-flex size-8 shrink-0 items-center justify-center rounded-control transition-[background-color,color] duration-150',
                  job.saved ? 'text-primary hover:bg-primary-50' : 'text-subtle-foreground hover:bg-hover hover:text-foreground',
                )}
                data-row-save=""
              >
                <BookmarkSimpleIcon size={18} weight={job.saved ? 'fill' : 'bold'} />
              </button>
            </Tooltip>
          </div>
        </div>
        {/* The company, where, the pay, the kind and the age: the place gives way first, the pay is never cut. v32 INT-2:
            the company never shrinks; it is capped at 55 % of the list (cqw), and at its wrapper only when the line has
            no room left (55 % of its own wrapper, whose width is the company's, cut a row with no place in half). */}
        <div className="mt-1 flex min-w-0 items-start gap-3">
          <p
            className="flex min-w-0 flex-1 text-[13px] leading-5 text-muted-foreground @max-[30rem]/job-list:flex-col @min-[30rem]/job-list:items-baseline @min-[30rem]/job-list:whitespace-nowrap"
            data-row-facts=""
          >
            <span className="flex min-w-0 items-baseline whitespace-nowrap">
              <span className="max-w-[min(55cqw,100%)] shrink-0 truncate font-medium text-foreground" data-card-company="">
                {job.company.name}
              </span>
              {place && (
                <span className="min-w-0 shrink truncate" title={place} data-row-place="">
                  {SEP}
                  {place}
                </span>
              )}
            </span>
            {hasWhen && (
              <span className="flex shrink-0 items-baseline whitespace-nowrap" data-row-when="">
                {salary && (
                  <span className="font-medium text-foreground" data-row-pay="">
                    <span className="font-normal text-muted-foreground @max-[30rem]/job-list:hidden">{SEP}</span>
                    {salary}
                  </span>
                )}
                {kind && (
                  <span data-row-kind="">
                    <span className={clsx(!salary && '@max-[30rem]/job-list:hidden')}>{SEP}</span>
                    {kind}
                  </span>
                )}
                {age && (
                  <span>
                    <span className={clsx(!salary && !kind && '@max-[30rem]/job-list:hidden')}>{SEP}</span>
                    {age}
                  </span>
                )}
              </span>
            )}
          </p>
          {/* A narrow list's row: the match at the end of the company's line (the pay's line keeps its width). */}
          {match !== null && (
            <span className="flex h-5 shrink-0 items-center @min-[30rem]/job-list:hidden" data-row-narrow-end="">
              <RowMatch match={match} showLabel={false} meterClassName="w-[84px]" className="text-right" />
            </span>
          )}
        </div>
        {(marked || applied) && (
          // The marks of a job others do not see; in a narrow list the Applied mark too (the wide row has it by the title).
          <div className={clsx('mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5', !marked && '@min-[30rem]/job-list:hidden')}>
            {applied && <span className="flex @min-[30rem]/job-list:hidden">{appliedMark('narrow')}</span>}
            {marked && <VerificationBadge held={job.held} verification={job.verification} sentenceId={markId} />}
          </div>
        )}
        {/* v30 S4: the credit line its source asks for ("Source: Himalayas"), above the row's link so it stays its own. */}
        <CardCredit credit={job.credit} className="mt-1" />
      </div>
    </li>
  );
});
