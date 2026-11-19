'use client';

import type { MatchedKeyword } from '@tailorit/shared';
import { clsx } from 'clsx';
import Link from 'next/link';
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button, buttonClasses } from '@/components/ui/Button';
import { CaretDownIcon, CaretUpIcon, CheckCircleIcon, PlusIcon, SparkleIcon } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/Skeleton';
import { TapeMeter } from '@/components/ui/TapeMeter';
import { userMessage } from '@/lib/api';
import { usePublicConstants } from '@/lib/constants';
import type { JobMatch } from '../api';
import { showMoreLabel } from '../format';
import { HelpTip } from '@/components/ui/HelpTip';
import { TargetIcon } from '../icons';
import { STRONG_MATCH_PERCENT } from '../list/JobCard';
import { TailorDialog } from '../../tailor/TailorDialog';
import type { TailorTarget } from '../../tailor/tailor';
import { scoredWithLine } from './facets';

// v31 FIX-JOBS: the detail's "Your match" and "Tailor for this job" (REV-UX UX-1: TailorIT's own sections and words in
// place of the old keyword card). Your match measures the resume against the posting's keywords with the tape meter,
// says it in a sentence, and lists what the resume has and what it lacks, each list collapsed to two rows. Tailor for
// this job says what tailoring does and opens the tailoring dialog (v1.4 E, decision 16).

/** How many rows a keyword list shows before "Show N more". */
const COLLAPSED_ROWS = 2;

/**
 * Keyword chips, collapsed to two rows. N in "Show N more" is how many chips the two rows leave out, measured after
 * layout (and again when the drawer resizes). `matched` chips are tinted with a check; missing ones are plain.
 */
function KeywordChips({ keywords, matched, label }: { keywords: readonly MatchedKeyword[]; matched: boolean; label: string }) {
  const listRef = useRef<HTMLUListElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [fit, setFit] = useState<{ height: number | null; clipped: number[] }>({ height: null, clipped: [] });

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const items = Array.from(list.children) as HTMLElement[];
      const rowTops = [...new Set(items.map((item) => item.offsetTop))].sort((a, b) => a - b);
      if (rowTops.length <= COLLAPSED_ROWS) {
        setFit((previous) => (previous.height === null && previous.clipped.length === 0 ? previous : { height: null, clipped: [] }));
        return;
      }
      const lastTop = rowTops[COLLAPSED_ROWS - 1]!;
      const lastRow = items.find((item) => item.offsetTop === lastTop)!;
      const clipped = items.flatMap((item, index) => (item.offsetTop > lastTop ? [index] : []));
      const height = lastTop + lastRow.offsetHeight - rowTops[0]!;
      setFit((previous) =>
        previous.height === height && previous.clipped.join() === clipped.join() ? previous : { height, clipped },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [keywords]);

  const clipped = new Set(expanded ? [] : fit.clipped);
  return (
    <>
      <ul
        ref={listRef}
        aria-label={label}
        className="relative flex flex-wrap gap-x-2 gap-y-1.5 overflow-hidden"
        style={!expanded && fit.height !== null ? { maxHeight: fit.height } : undefined}
      >
        {keywords.map((keyword, index) => (
          <li
            key={keyword.term}
            aria-hidden={clipped.has(index) || undefined}
            data-keyword={matched ? 'matched' : 'missing'}
            className={clsx(
              'inline-flex h-7 max-w-full items-center gap-1.5 rounded-control px-2.5 text-[13px] font-medium whitespace-nowrap',
              // A keyword still to be worked into the resume is stitched in, not sewn yet (the identity's stitch).
              matched ? 'border border-success/30 bg-success-soft text-success-ink' : 'stitch bg-surface text-foreground',
            )}
          >
            {matched ? <CheckCircleIcon size={14} weight="fill" aria-hidden="true" /> : <PlusIcon size={12} weight="bold" aria-hidden="true" />}
            <span className="truncate">
              {matched && <span className="sr-only">Found: </span>}
              {keyword.term}
            </span>
          </li>
        ))}
      </ul>
      {fit.clipped.length > 0 && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
          className="mt-2 inline-flex items-center gap-1 self-start rounded-tag text-sm leading-5 font-medium text-primary hover:underline"
        >
          {showMoreLabel(fit.clipped.length, expanded)}
          {expanded ? <CaretUpIcon size={14} /> : <CaretDownIcon size={14} />}
        </button>
      )}
    </>
  );
}

/** One labelled keyword list ("In your resume (8)"); nothing when it is empty. */
function KeywordGroup({ title, keywords, matched }: { title: string; keywords: readonly MatchedKeyword[]; matched: boolean }) {
  if (keywords.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-keyword-group={matched ? 'matched' : 'missing'}>
      <p className="text-[11px] leading-4 font-semibold tracking-[0.06em] text-subtle-foreground uppercase">
        {title} <span className="num tracking-normal">({keywords.length})</span>
      </p>
      <KeywordChips keywords={keywords} matched={matched} label={title} />
    </div>
  );
}

/**
 * A detail section's heading: a 32 px denim-soft tile with its icon, then the title (an h3 under the job's h2). v32
 * JOBS2 (E5): what the section is for sits behind the "?" after the title (`tip`), never a paragraph under it.
 */
export function SectionHeading({
  id,
  icon,
  children,
  aside,
  tip,
}: {
  id: string;
  icon: ReactNode;
  children: ReactNode;
  aside?: ReactNode;
  tip?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-control bg-primary-soft text-primary" aria-hidden="true">
          {icon}
        </span>
        <h3 id={id} className="text-heading font-semibold text-foreground">
          {children}
        </h3>
        {tip && <HelpTip label={typeof children === 'string' ? children : undefined}>{tip}</HelpTip>}
      </div>
      {aside}
    </div>
  );
}

/**
 * "Your match", v32 FIX-UX (UXREQ-1, coordinator: "a one-line match summary, details on demand"): one line under the
 * job's facts, before About the role: the title and its "?", the tape meter, "5 of 12 keywords are in your resume."
 * and "Keywords", which opens the lists of what the resume has and what it lacks (and the resume it scored: the one
 * linked to the job's application while the job is tracked, else the default resume, "Scored with {label}"). Without
 * a resume it asks for one, on the same line.
 */
export function MatchSection({
  match,
  pending,
  error,
  onRetry,
  className,
}: {
  match: JobMatch | undefined;
  pending: boolean;
  error: unknown;
  onRetry: () => void;
  className?: string;
}) {
  const { t } = usePublicConstants();
  const detailsId = useId();
  const [open, setOpen] = useState(false);
  let line: ReactNode;
  let details: ReactNode = null;
  if (pending) {
    line = (
      <span className="flex min-w-0 flex-1 items-center gap-3" aria-hidden="true">
        <Skeleton className="h-1.5 w-28" />
        <Skeleton className="h-3.5 w-48" />
      </span>
    );
  } else if (error || !match) {
    line = (
      <p className="text-sm text-muted-foreground" role="alert">
        {/* v32 FIX-UX (UXREQ-13): the load error's one pattern, its reason in view. */}
        {`Your match didn't load. ${userMessage(error, '')}`.trim()}{' '}
        <button type="button" onClick={onRetry} className="rounded-tag font-medium text-primary hover:underline">
          Try again
        </button>
      </p>
    );
  } else if (match.state === 'no_resume') {
    line = (
      <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2" data-no-resume="">
        <span className="inline-flex items-center gap-1.5 text-sm leading-5 text-foreground">
          {t('MSG_JOB_ADD_RESUME_TITLE')}
          {/* v32 JOBS2 (E5): what a resume gives, behind the "?". */}
          <HelpTip label={t('MSG_JOB_ADD_RESUME_TITLE')}>{t('MSG_JOB_ADD_RESUME')}</HelpTip>
        </span>
        <span className="flex flex-wrap gap-2">
          <Link href="/resumes/new" className={buttonClasses({ variant: 'primary', size: 'sm' })}>
            Create a resume
          </Link>
          <Link href="/documents?tab=resumes" className={buttonClasses({ variant: 'outline', size: 'sm' })}>
            Upload a resume
          </Link>
        </span>
      </span>
    );
  } else if (match.total === 0) {
    line = <p className="text-sm leading-5 text-muted-foreground">{t('MSG_JOB_NO_SKILLS')}</p>;
  } else {
    const scoredWith = scoredWithLine(match);
    line = (
      <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        <TapeMeter
          label="Keyword match"
          value={match.percentage}
          size="sm"
          layout="inline"
          tone={match.percentage >= STRONG_MATCH_PERCENT ? 'success' : 'tape'}
          className="w-32 shrink-0"
        />
        <p className="text-sm leading-5 text-foreground" data-testid="keyword-score">
          {t('MSG_JOB_KEYWORDS_FOUND', { matched: match.matchedCount, total: match.total })}
        </p>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => setOpen((was) => !was)}
          className="inline-flex h-7 items-center gap-1 rounded-control px-1.5 text-sm font-medium text-primary hover:bg-primary-50"
          data-keywords-toggle=""
        >
          {KEYWORDS_LABEL}
          {open ? <CaretUpIcon size={14} aria-hidden="true" /> : <CaretDownIcon size={14} aria-hidden="true" />}
        </button>
      </span>
    );
    details = (
      // Kept in the page while closed (its words stay readable to tests and the find bar); shown on demand.
      <div id={detailsId} hidden={!open} className="mt-3 flex flex-col gap-4" data-keyword-details="">
        {scoredWith && (
          <p className="text-xs leading-4 break-words text-muted-foreground" data-testid="scored-with">
            {scoredWith.lead} <span className="font-medium text-foreground">{scoredWith.label}</span>
            {scoredWith.note && ` ${scoredWith.note}`}
          </p>
        )}
        <KeywordGroup title={t('LABEL_JOB_KEYWORDS_HAVE')} keywords={match.matched} matched />
        <KeywordGroup title={t('LABEL_JOB_KEYWORDS_MISSING')} keywords={match.missing} matched={false} />
      </div>
    );
  }

  return (
    <section aria-labelledby="job-your-match" className={className} data-match-section="">
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
        <span className="inline-flex shrink-0 items-center gap-1.5">
          <TargetIcon size={16} weight="bold" className="text-primary" aria-hidden="true" />
          <h3 id="job-your-match" className="text-sm leading-5 font-semibold text-foreground">
            {t('LABEL_JOB_YOUR_MATCH')}
          </h3>
          <HelpTip label={t('LABEL_JOB_YOUR_MATCH')}>{t('MSG_JOB_MATCH_TIP')}</HelpTip>
        </span>
        {line}
      </div>
      {details}
    </section>
  );
}

/** The words of the match line's button that opens its keyword lists. */
const KEYWORDS_LABEL = 'Keywords';

/**
 * "Tailor for this job": what tailoring does (its "?"), and the button that opens the tailoring dialog for this job.
 * Hidden while the match loads and without a resume to tailor.
 */
export function TailorSection({ tailor, className }: { tailor: TailorTarget; className?: string }) {
  const { t } = usePublicConstants();
  const [tailoring, setTailoring] = useState(false);
  return (
    <section
      aria-labelledby="job-tailor"
      className={clsx('relative overflow-hidden rounded-card border border-tape-strong/40 bg-tape-soft p-5', className)}
      data-tailor-section=""
    >
      {/* The tailor's tape along the card's top edge. */}
      <span aria-hidden="true" className="tape-ticks absolute inset-x-0 top-0 h-1.5 bg-tape" />
      <SectionHeading
        id="job-tailor"
        icon={<SparkleIcon size={18} weight="fill" />}
        tip={t('MSG_JOB_TAILOR_LEAD')}
        aside={
          <Button
            variant="outline"
            icon={<SparkleIcon size={16} weight="fill" className="text-primary" />}
            onClick={() => setTailoring(true)}
            data-tailor-open=""
          >
            {t('LABEL_JOB_TAILOR_BUTTON')}
          </Button>
        }
      >
        {t('LABEL_JOB_TAILOR_TITLE')}
      </SectionHeading>
      <TailorDialog open={tailoring} onOpenChange={setTailoring} target={tailor} />
    </section>
  );
}
