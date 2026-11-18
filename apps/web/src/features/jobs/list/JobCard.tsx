'use client';

import { EMPLOYMENT_TYPE_LABEL, appliedChipLabel, type JobRowMatch, type JobSort } from '@tailorit/shared';
import { clsx } from 'clsx';
import { memo, useId, type MouseEvent } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { BookmarkSimpleIcon, CheckCircleIcon, ClockIcon, MapPinIcon } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/Skeleton';
import { TapeMeter } from '@/components/ui/TapeMeter';
import { Tooltip } from '@/components/ui/Tooltip';
import { usePublicConstants } from '@/lib/constants';
import type { JobListItem } from '../api';
import { CompanyLogo } from '../CompanyLogo';
import { CardCredit } from '../credits/JobCredit'; // v30 S4
import { cardAge, cardCompanyFacts, cardLocationLine, cardSalary } from '../format'; // v30 WEB-JOBS: cardCompanyFacts
import { MoneyIcon } from '../icons';
import { VerificationBadge } from '../verification/VerificationBadge'; // v31 JOBSWEB
import { verificationMark } from '../verification/copy';
import { saveBlockReason } from './useSaveSelected';

export interface JobCardProps {
  job: JobListItem;
  href: string;
  /** The job open in the drawer. */
  selected: boolean;
  sort: JobSort;
  now: number;
  /** v31 FIX-JOBS: the row's keyword match; undefined while it loads, null when it cannot be measured. */
  match: JobRowMatch | null | undefined;
  onSelect: (jobId: number) => void;
  onToggleSave: (job: JobListItem) => void;
  /** v31 FIX-JOBS: the row's quick Apply (opens the job and its posting). */
  onApply: (jobId: number) => void;
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

/**
 * The wide feed's columns (from a 56 rem feed card, `@container/feed`): the job, where and pay, the match, the
 * actions. The feed's column heads (JobList) use the same template.
 */
export const FEED_COLUMNS = '@min-[56rem]/feed:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)_176px_112px]';

/** The row's measure: a small tape meter of how much of the posting's keywords the person's resume has. */
export function RowMatch({
  match,
  showLabel = true,
  className,
}: {
  match: JobRowMatch | null | undefined;
  /** Draws "Match" before the bar (the narrow row; the wide feed's column head says it). */
  showLabel?: boolean;
  className?: string;
}) {
  const { t } = usePublicConstants();
  if (match === undefined) {
    return (
      <span className={clsx('flex items-center gap-2.5', className)} aria-hidden="true" data-row-match="loading">
        <Skeleton className="h-1.5 flex-1" />
        <Skeleton className="h-3 w-7" />
      </span>
    );
  }
  if (match === null || match.state !== 'ok') return null;
  if (match.total === 0) {
    return (
      <span className={clsx('text-xs leading-4 text-subtle-foreground', className)} data-row-match="none">
        {t('LABEL_JOBS_ROW_NO_SKILLS')}
      </span>
    );
  }
  return (
    <span className={clsx('block', className)} data-row-match={match.percentage}>
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

/** A quick action that shows on the row's hover and keyboard focus (and stays while its job is open). */
const QUICK = 'sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100 sm:focus-visible:opacity-100';

/**
 * v31 FIX-JOBS: one job of the feed (a full-width row, not a card beside a detail pane). In a wide feed its parts sit
 * in aligned columns, like a ledger: the job (a 44 px company monogram, the title as the row's one link stretched over
 * the row, the company with its industry and size, its state as tags: job type, Saved, Applied, a job others do not
 * see), where and pay (place, salary, age), the match (a tape meter of the posting's keywords the resume has) and the
 * quick actions (Apply, and the bookmark, always shown once saved; both show on hover and keyboard focus). In a
 * narrow feed the place, pay and age follow the company and the match sits under the words. While jobs are chosen to
 * save, a box sits before the monogram.
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
  const companyFacts = cardCompanyFacts(job.company); // v30 WEB-JOBS: "Energy & Utilities · 1,001-5,000 employees"
  const saveLabel = job.saved ? `Remove ${job.title} from saved jobs` : `Save ${job.title}`;
  const blocked = selectable ? saveBlockReason(job) : null;
  const marked = verificationMark(job) !== null;
  const markId = useId();
  const canApply = job.active && !job.appliedOn;
  const facts = [place, salary, age].filter(Boolean);

  return (
    <li
      data-job-card={job.id}
      className={clsx(
        'group relative grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 px-4 py-4 transition-colors duration-100 sm:px-5',
        FEED_COLUMNS,
        '@min-[56rem]/feed:items-center',
        selected ? 'bg-primary-soft' : 'hover:bg-surface-low',
      )}
    >
      <div className="flex min-w-0 items-start gap-3 sm:gap-4">
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
        <CompanyLogo name={job.company.name} url={job.company.logoUrl} size={44} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] leading-5 font-semibold text-foreground">
            {/* The row's one link: its ::after covers the row, so a click anywhere opens the job (the buttons sit above it). */}
            <a
              href={href}
              aria-current={selected ? 'true' : undefined}
              aria-describedby={marked ? markId : undefined}
              onClick={(event) => {
                if (!isPlainClick(event)) return;
                event.preventDefault();
                onSelect(job.id);
              }}
              className={clsx(
                'line-clamp-2 rounded-tag underline-offset-2 group-hover:underline',
                'after:absolute after:inset-0 after:content-[""] focus-visible:outline-none',
                'focus-visible:after:shadow-[inset_0_0_0_2px_var(--color-focus)]',
              )}
            >
              {job.title}
            </a>
          </h3>
          <p className="mt-0.5 truncate text-[13px] leading-5 text-muted-foreground">
            <span className="font-medium text-foreground" data-card-company="">
              {job.company.name}
            </span>
            {/* v30 WEB-JOBS: the company's industry and size (features/companies/format.ts' words). */}
            {companyFacts && (
              <span className="max-sm:hidden" data-card-company-facts="">
                {' · '}
                {companyFacts}
              </span>
            )}
          </p>
          {facts.length > 0 && (
            <p className="mt-0.5 line-clamp-2 text-[13px] leading-5 text-muted-foreground @min-[56rem]/feed:hidden">{facts.join(' · ')}</p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5 empty:hidden">
            {job.employmentType && <Badge tone="neutral">{EMPLOYMENT_TYPE_LABEL[job.employmentType]}</Badge>}
            {job.appliedOn ? (
              <Badge tone="success" icon={<CheckCircleIcon size={12} weight="fill" aria-hidden="true" />} data-row-applied="">
                {appliedChipLabel(job.appliedOn)}
              </Badge>
            ) : job.saved ? (
              <Badge tone="tint" data-row-saved="">
                Saved
              </Badge>
            ) : null}
            {marked && <VerificationBadge held={job.held} verification={job.verification} sentenceId={markId} />}
          </div>
          {/* v30 S4: the credit line its source asks for ("Source: Himalayas"), above the row's link so it stays its own. */}
          <CardCredit credit={job.credit} className="mt-1.5" />
        </div>
      </div>

      {/* Where and pay: its own column in the wide feed (the narrow row says it under the company). */}
      <dl className="hidden min-w-0 flex-col gap-1 text-[13px] leading-5 text-muted-foreground @min-[56rem]/feed:flex" data-row-facts="">
        {place && (
          <div className="min-w-0">
            <dt className="sr-only">Where</dt>
            <dd className="flex min-w-0 items-center gap-1.5">
              <MapPinIcon size={14} aria-hidden="true" className="shrink-0 text-subtle-foreground" />
              <span className="truncate">{place}</span>
            </dd>
          </div>
        )}
        {salary && (
          <div className="min-w-0">
            <dt className="sr-only">Pay</dt>
            <dd className="flex min-w-0 items-center gap-1.5">
              <MoneyIcon size={14} aria-hidden="true" className="shrink-0 text-subtle-foreground" />
              <span className="truncate font-medium text-foreground">{salary}</span>
            </dd>
          </div>
        )}
        {age && (
          <div className="min-w-0">
            <dt className="sr-only">Posted</dt>
            <dd className="flex min-w-0 items-center gap-1.5">
              <ClockIcon size={14} aria-hidden="true" className="shrink-0 text-subtle-foreground" />
              <span className="truncate">{age}</span>
            </dd>
          </div>
        )}
      </dl>

      <RowMatch match={match} showLabel={false} className="hidden w-full @min-[56rem]/feed:block" />

      <div className="relative z-10 col-start-2 row-start-1 flex items-start justify-end gap-1.5 @min-[56rem]/feed:col-start-auto @min-[56rem]/feed:row-start-auto @min-[56rem]/feed:items-center">
        {canApply && (
          <Button
            size="sm"
            variant="outline"
            aria-label={t('LABEL_JOBS_ROW_APPLY', { title: job.title })}
            onClick={() => onApply(job.id)}
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
              'inline-flex size-8 shrink-0 items-center justify-center rounded-control border transition-[background-color,border-color,color,opacity] duration-150',
              job.saved
                ? 'border-primary-200 bg-primary-soft text-primary hover:bg-primary-50'
                : clsx('border-border-strong bg-surface text-muted-foreground hover:border-control-hover hover:text-foreground', !selected && QUICK),
            )}
          >
            <BookmarkSimpleIcon size={16} weight={job.saved ? 'fill' : 'bold'} />
          </button>
        </Tooltip>
      </div>

      {/* The narrow row's measure, under its words. */}
      <RowMatch match={match} className="col-span-2 mt-3 max-w-[320px] pl-14 sm:pl-[60px] @min-[56rem]/feed:hidden" />
    </li>
  );
});
