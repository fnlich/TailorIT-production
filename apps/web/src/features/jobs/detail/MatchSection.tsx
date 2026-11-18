'use client';

import type { MatchedKeyword } from '@tailorit/shared';
import { clsx } from 'clsx';
import Link from 'next/link';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button, buttonClasses } from '@/components/ui/Button';
import { CaretDownIcon, CaretUpIcon, CheckCircleIcon, PlusIcon, SparkleIcon } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/Skeleton';
import { TapeMeter } from '@/components/ui/TapeMeter';
import { userMessage } from '@/lib/api';
import { usePublicConstants } from '@/lib/constants';
import type { JobMatch } from '../api';
import { showMoreLabel } from '../format';
import { TargetIcon } from '../icons';
import { STRONG_MATCH_PERCENT } from '../list/JobCard';
import { TailorDialog } from '../../tailor/TailorDialog';
import type { TailorTarget } from '../../tailor/tailor';
import { scoredWithLine } from './facets';

// v31 FIX-JOBS: the drawer's "Your match" and "Tailor for this job" (REV-UX UX-1: TailorIT's own sections and words in
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

/** A drawer section's heading: a 32 px denim-soft tile with its icon, then the title (an h3 under the job's h2). */
export function SectionHeading({ id, icon, children, aside }: { id: string; icon: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-control bg-primary-soft text-primary" aria-hidden="true">
          {icon}
        </span>
        <h3 id={id} className="text-heading font-semibold text-foreground">
          {children}
        </h3>
      </div>
      {aside}
    </div>
  );
}

/**
 * "Your match": the keyword match of the resume the detail scores (the one linked to the job's application while the
 * job is tracked, else the default resume; "Scored with {label}" says which). Without a resume it asks for one.
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
  let body: ReactNode;
  if (pending) {
    body = (
      <div className="flex flex-col gap-3" aria-hidden="true">
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-4 w-3/4" />
        <div className="flex flex-wrap gap-2">
          {[88, 72, 64, 80, 70].map((width) => (
            <span key={width} style={{ width }}>
              <Skeleton className="h-7 w-full" rounded="control" />
            </span>
          ))}
        </div>
      </div>
    );
  } else if (error || !match) {
    body = (
      <p className="text-sm text-muted-foreground">
        {userMessage(error, 'The keyword match could not be loaded.')}{' '}
        <button type="button" onClick={onRetry} className="rounded-tag font-medium text-primary hover:underline">
          Try again
        </button>
      </p>
    );
  } else if (match.state === 'no_resume') {
    body = (
      <div className="stitch flex flex-col gap-1 rounded-card bg-surface-low p-4" data-no-resume="">
        <p className="text-sm leading-5 font-semibold text-foreground">{t('MSG_JOB_ADD_RESUME_TITLE')}</p>
        <p className="text-sm leading-5 text-muted-foreground">{t('MSG_JOB_ADD_RESUME')}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link href="/resumes/new" className={buttonClasses({ variant: 'primary', size: 'sm' })}>
            Create a resume
          </Link>
          <Link href="/documents?tab=resumes" className={buttonClasses({ variant: 'outline', size: 'sm' })}>
            Upload a resume
          </Link>
        </div>
      </div>
    );
  } else if (match.total === 0) {
    body = <p className="text-sm leading-5 text-muted-foreground">{t('MSG_JOB_NO_SKILLS')}</p>;
  } else {
    const scoredWith = scoredWithLine(match);
    body = (
      <div className="flex flex-col gap-4">
        <div className="rounded-card border border-border bg-surface-low p-4">
          <TapeMeter
            label="Keyword match"
            value={match.percentage}
            size="lg"
            tone={match.percentage >= STRONG_MATCH_PERCENT ? 'success' : 'tape'}
            showLabel
          />
          <p className="mt-3 text-sm leading-5 text-foreground" data-testid="keyword-score">
            {t('MSG_JOB_KEYWORDS_FOUND', { matched: match.matchedCount, total: match.total })}
          </p>
          {scoredWith && (
            <p className="mt-1 text-xs leading-4 break-words text-muted-foreground" data-testid="scored-with">
              {scoredWith.lead} <span className="font-medium text-foreground">{scoredWith.label}</span>
              {scoredWith.note && ` ${scoredWith.note}`}
            </p>
          )}
        </div>
        <KeywordGroup title={t('LABEL_JOB_KEYWORDS_HAVE')} keywords={match.matched} matched />
        <KeywordGroup title={t('LABEL_JOB_KEYWORDS_MISSING')} keywords={match.missing} matched={false} />
      </div>
    );
  }

  return (
    <section aria-labelledby="job-your-match" className={className} data-match-section="">
      <SectionHeading id="job-your-match" icon={<TargetIcon size={18} weight="bold" />}>
        {t('LABEL_JOB_YOUR_MATCH')}
      </SectionHeading>
      <div className="mt-4">{body}</div>
    </section>
  );
}

/**
 * "Tailor for this job": what tailoring does, and the button that opens the tailoring dialog for this job. Hidden
 * while the match loads and without a resume to tailor.
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
      <SectionHeading id="job-tailor" icon={<SparkleIcon size={18} weight="fill" />}>
        {t('LABEL_JOB_TAILOR_TITLE')}
      </SectionHeading>
      <p className="mt-3 text-sm leading-5 text-foreground">{t('MSG_JOB_TAILOR_LEAD')}</p>
      <Button
        variant="outline"
        icon={<SparkleIcon size={16} weight="fill" className="text-primary" />}
        onClick={() => setTailoring(true)}
        className="mt-4"
        data-tailor-open=""
      >
        {t('LABEL_JOB_TAILOR_BUTTON')}
      </Button>
      <TailorDialog open={tailoring} onOpenChange={setTailoring} target={tailor} />
    </section>
  );
}
