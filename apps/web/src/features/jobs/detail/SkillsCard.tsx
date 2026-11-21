'use client';

import type { MatchedKeyword } from '@tailorit/shared';
import { clsx } from 'clsx';
import Link from 'next/link';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { buttonClasses } from '@/components/ui/Button';
import { HelpTip } from '@/components/ui/HelpTip';
import { CaretDownIcon, CaretUpIcon, CheckIcon, FileTextIcon } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/Skeleton';
import { TapeMeter } from '@/components/ui/TapeMeter';
import { userMessage } from '@/lib/api';
import { usePublicConstants } from '@/lib/constants';
import type { JobMatch } from '../api';
import { showMoreLabel } from '../format';
import { STRONG_MATCH_PERCENT } from '../list/JobCard';
import { DetailCard } from './DetailCard';
import { scoredWithLine, scoredWithText } from './facets';

// v33 JOBDETAIL (F2): the job's Skills (v31-v32 "Your match"): the tape meter and "5 of 12 keywords are in your resume.",
// then the posting's skills as one list of pills, the central ones first, in each part what the resume has (filled with
// the tape, a check) before what it lacks (outlined), collapsed to SKILL_ROWS rows: what is in and what is missed show at
// once (v33 FIX-1: three rows). Without a resume, every skill is plain and the card asks for one.

/**
 * How many rows of skills show before "Show N more". v33 FIX-1: 3 (was 5), so Skills and Tailor my resume are in the
 * first screen beside the posting at 1440 x 900 (the owner's "see job details at once"); the central skills come first.
 */
export const SKILL_ROWS = 3;

/** A skill pill's look: highlighted (in the resume) or outlined (not yet). */
export const SKILL_PILL = {
  matched: 'border-tape-strong/70 bg-tape-soft text-foreground',
  missing: 'border-border-strong bg-surface text-foreground',
} as const;

/**
 * The skills, collapsed to SKILL_ROWS rows. N in "Show N more" is how many pills those rows leave out, measured after
 * layout (and again when the pane resizes). Each pill says to a screen reader whether the resume has it.
 */
function SkillPills({ keywords, label }: { keywords: ReadonlyArray<MatchedKeyword & { matched: boolean }>; label: string }) {
  const { t } = usePublicConstants();
  const listRef = useRef<HTMLUListElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [fit, setFit] = useState<{ height: number | null; clipped: number[] }>({ height: null, clipped: [] });

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const items = Array.from(list.children) as HTMLElement[];
      const rowTops = [...new Set(items.map((item) => item.offsetTop))].sort((a, b) => a - b);
      if (rowTops.length <= SKILL_ROWS) {
        setFit((previous) => (previous.height === null && previous.clipped.length === 0 ? previous : { height: null, clipped: [] }));
        return;
      }
      const lastTop = rowTops[SKILL_ROWS - 1]!;
      const lastRow = items.find((item) => item.offsetTop === lastTop)!;
      const clipped = items.flatMap((item, index) => (item.offsetTop > lastTop ? [index] : []));
      const height = lastTop + lastRow.offsetHeight - rowTops[0]!;
      setFit((previous) => (previous.height === height && previous.clipped.join() === clipped.join() ? previous : { height, clipped }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [keywords]);

  const clipped = new Set(expanded ? [] : fit.clipped);
  const have = t('LABEL_JOB_KEYWORDS_HAVE');
  const lack = t('LABEL_JOB_KEYWORDS_MISSING');
  return (
    <>
      <ul
        ref={listRef}
        aria-label={label}
        className="relative flex flex-wrap gap-x-1.5 gap-y-2 overflow-hidden"
        style={!expanded && fit.height !== null ? { maxHeight: fit.height } : undefined}
        data-skill-list=""
      >
        {keywords.map((keyword, index) => (
          <li
            key={keyword.term}
            aria-hidden={clipped.has(index) || undefined}
            data-keyword={keyword.matched ? 'matched' : 'missing'}
            data-priority={keyword.priority}
            className={clsx(
              'inline-flex h-7 max-w-full items-center gap-1 rounded-full border px-2.5 text-[13px] font-medium whitespace-nowrap',
              keyword.matched ? SKILL_PILL.matched : SKILL_PILL.missing,
            )}
          >
            {keyword.matched && <CheckIcon size={13} weight="bold" aria-hidden="true" className="-ml-0.5 shrink-0 text-success-ink" />}
            <span className="truncate">
              <span className="sr-only">{keyword.matched ? have : lack}: </span>
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
          data-skills-more=""
        >
          {showMoreLabel(fit.clipped.length, expanded)}
          {expanded ? <CaretUpIcon size={14} /> : <CaretDownIcon size={14} />}
        </button>
      )}
    </>
  );
}

/**
 * The skills in the card's order: the posting's central ones (high) before the ones it mentions (low); in each, what the
 * resume has before what it lacks, each in the posting's order. A missed central skill is never behind "Show N more"
 * while a mentioned one shows.
 */
export function skillsInOrder(match: Pick<JobMatch, 'matched' | 'missing'>): Array<MatchedKeyword & { matched: boolean }> {
  const part = (priority: MatchedKeyword['priority']) => [
    ...match.matched.filter((keyword) => keyword.priority === priority).map((keyword) => ({ ...keyword, matched: true })),
    ...match.missing.filter((keyword) => keyword.priority === priority).map((keyword) => ({ ...keyword, matched: false })),
  ];
  return [...part('high'), ...part('low')];
}

/**
 * v33 JOBDETAIL (F2): Skills. While the match loads, a skeleton; a match that fails to load says so with Try again; no
 * resume asks for one (and shows the posting's skills plain); a posting with no skills says so.
 */
export function SkillsCard({
  match,
  pending,
  error,
  onRetry,
}: {
  match: JobMatch | undefined;
  pending: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const { t } = usePublicConstants();
  const title = t('LABEL_JOB_SKILLS');
  // v33 FIX-1 (the owner's "see job details at once"): which resume was scored sits beside the card's title, cut to the
  // room there (its whole words for a screen reader and in its tooltip); as a line of its own under the skills it pushed
  // Tailor my resume below the first screen at 1440 x 900.
  const scoredWith = !pending && !error && match && match.state !== 'no_resume' && match.total > 0 ? scoredWithLine(match) : null;
  const aside = scoredWith ? (
    <p
      className="flex min-w-0 flex-1 basis-0 items-center justify-end gap-1 text-xs leading-4 text-muted-foreground"
      title={scoredWithText(scoredWith)}
      data-testid="scored-with"
    >
      <span className="sr-only">{scoredWith.lead} </span>
      <FileTextIcon size={14} aria-hidden="true" className="shrink-0" />
      <span className="truncate font-medium text-foreground">{scoredWith.label}</span>
      {scoredWith.note && <span className="sr-only"> {scoredWith.note}</span>}
    </p>
  ) : undefined;
  let body: ReactNode;
  if (pending) {
    body = (
      <div className="flex flex-col gap-3" aria-hidden="true">
        <Skeleton className="h-3.5 w-48" />
        <div className="flex flex-wrap gap-2">
          {['w-16', 'w-20', 'w-14', 'w-24', 'w-[72px]'].map((width) => (
            <Skeleton key={width} className={clsx('h-7', width)} rounded="full" />
          ))}
        </div>
      </div>
    );
  } else if (error || !match) {
    body = (
      <p className="text-sm text-muted-foreground" role="alert">
        {/* v32 FIX-UX (UXREQ-13): the load error's one pattern, its reason in view. */}
        {`Skills didn't load. ${userMessage(error, '')}`.trim()}{' '}
        <button type="button" onClick={onRetry} className="rounded-tag font-medium text-primary hover:underline">
          Try again
        </button>
      </p>
    );
  } else if (match.state === 'no_resume') {
    body = (
      <div className="flex flex-col gap-3" data-no-resume="">
        <p className="inline-flex items-center gap-1.5 text-sm leading-5 font-medium text-foreground">
          {t('MSG_JOB_ADD_RESUME_TITLE')}
          {/* v32 JOBS2 (E5): what a resume gives, behind the "?". */}
          <HelpTip label={t('MSG_JOB_ADD_RESUME_TITLE')}>{t('MSG_JOB_ADD_RESUME')}</HelpTip>
        </p>
        <span className="flex flex-wrap gap-2">
          <Link href="/resumes/new" className={buttonClasses({ variant: 'primary', size: 'sm' })}>
            Create a resume
          </Link>
          <Link href="/documents?tab=resumes" className={buttonClasses({ variant: 'outline', size: 'sm' })}>
            Upload a resume
          </Link>
        </span>
        {match.total > 0 && <SkillPills keywords={skillsInOrder(match)} label={title} />}
      </div>
    );
  } else if (match.total === 0) {
    body = <p className="text-sm leading-5 text-muted-foreground">{t('MSG_JOB_NO_SKILLS')}</p>;
  } else {
    body = (
      <div className="flex flex-col">
        <div className="flex flex-col gap-2">
          <TapeMeter
            label="Keyword match"
            value={match.percentage}
            size="sm"
            layout="inline"
            tone={match.percentage >= STRONG_MATCH_PERCENT ? 'success' : 'tape'}
            className="w-full"
          />
          <p className="text-sm leading-5 text-foreground" data-testid="keyword-score">
            {t('MSG_JOB_KEYWORDS_FOUND', { matched: match.matchedCount, total: match.total })}
          </p>
        </div>
        <p className="mt-2 mb-2 flex items-center gap-1.5 text-xs leading-4 text-muted-foreground" data-skills-legend="">
          <span aria-hidden="true" className={clsx('inline-block h-2.5 w-4 rounded-full border', SKILL_PILL.matched)} />
          {t('MSG_JOB_SKILLS_HIGHLIGHT')}
        </p>
        <SkillPills keywords={skillsInOrder(match)} label={title} />
      </div>
    );
  }

  return (
    <DetailCard id="job-skills" title={title} tip={t('MSG_JOB_MATCH_TIP')} aside={aside} data-match-section="">
      {body}
    </DetailCard>
  );
}
