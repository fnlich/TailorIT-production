'use client';

import type { CompanyJobItem, CompanyJobState, CompanyPage } from '@tailorit/shared/companies';
import { clsx } from 'clsx';
import Link from 'next/link';
import { useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { BriefcaseIcon, WarningCircleIcon } from '@/components/ui/icons';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Skeleton } from '@/components/ui/Skeleton';
import { userMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { RowCredit } from '../jobs/credits/JobCredit'; // v30 FIX-WEB (REQ-1)
import { cardLocationLine, cardMetaLine } from '../jobs/format';
import { jobHrefBuilder } from '../jobs/url';
import { useCompanyJobs } from './api';

// v30 E0-WEB: the company page's positions (owner question 24; 11-database.md §5.4's two lists): its open positions,
// newest first, and its closed history, latest closed first, a page at a time. A row opens the job on the Jobs page,
// filtered to this company.

/** The words of the two lists. */
export const POSITION_WORDS: Record<CompanyJobState, { tab: string; list: string; empty: string; emptyHint: (name: string) => string }> = {
  open: {
    tab: 'Open',
    list: 'Open positions',
    empty: 'No open positions right now',
    emptyHint: (name) => `${name}'s new jobs show here.`,
  },
  closed: {
    tab: 'Closed',
    list: 'Closed positions',
    empty: 'No closed positions yet',
    emptyHint: (name) => `Jobs ${name} took down show here.`,
  },
};

/** The list shown first: the open positions, unless there are none and there is a history. */
export function firstPositionList(counts: Pick<CompanyPage['counts'], 'openJobs' | 'closedJobs'>): CompanyJobState {
  return counts.openJobs === 0 && counts.closedJobs > 0 ? 'closed' : 'open';
}

/** One position: its title, place, salary and age, or the day it closed; Saved and Applied from the tracker. */
export function CompanyJobRow({ job, href, now }: { job: CompanyJobItem; href: string; now: number }) {
  const place = cardLocationLine(job);
  const meta = job.closedAt ? `Closed ${formatDate(job.closedAt)}` : cardMetaLine(job, 'posted', now);
  return (
    <li data-company-job={job.id}>
      <Link href={href} className="flex min-h-11 items-start gap-3 px-4 py-3.5 outline-offset-[-2px] transition-colors hover:bg-surface-low sm:px-5">
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-[15px] leading-5 font-semibold text-foreground">{job.title}</p>
          {place && <p className="mt-0.5 truncate text-[13px] leading-5 text-muted-foreground">{place}</p>}
          {meta && <p className="mt-1 truncate text-xs leading-4 text-muted-foreground">{meta}</p>}
        </div>
        {(job.appliedOn || job.saved) && (
          <Badge tone={job.appliedOn ? 'success' : 'tint'} className="mt-0.5 shrink-0">
            {job.appliedOn ? 'Applied' : 'Saved'}
          </Badge>
        )}
      </Link>
      {/* v30 FIX-WEB (REV-REQ REQ-1): the credit its source asks for, under the row's link (a link may not hold another). */}
      <RowCredit credit={job.credit} className="-mt-2 px-4 pb-3 sm:px-5" />
    </li>
  );
}

export function CompanyJobs({ company, className }: { company: Pick<CompanyPage, 'id' | 'name' | 'counts'>; className?: string }) {
  const [state, setState] = useState<CompanyJobState>(() => firstPositionList(company.counts));
  const jobs = useCompanyJobs(company.id, state);
  const now = useNow();
  const href = jobHrefBuilder({ companies: [String(company.id)] });
  const items = jobs.data?.pages.flatMap((page) => page.items);
  const words = POSITION_WORDS[state];
  const count = (value: number) => value.toLocaleString('en-US');

  return (
    <section aria-labelledby="company-positions" className={className} data-company-positions={state}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="company-positions" className="text-heading font-semibold text-foreground">
          Positions
        </h2>
        <SegmentedControl<CompanyJobState>
          aria-label="Which positions"
          size="sm"
          value={state}
          onValueChange={setState}
          items={[
            { value: 'open', label: `${POSITION_WORDS.open.tab} (${count(company.counts.openJobs)})` },
            { value: 'closed', label: `${POSITION_WORDS.closed.tab} (${count(company.counts.closedJobs)})` },
          ]}
        />
      </div>
      <div className="mt-4">
        {jobs.error && !items ? (
          // v32 JOBS2 (E4): the list's state with its next step, not a banner.
          <div className="rounded-card border border-border bg-surface shadow-card">
            <EmptyState
              icon={<WarningCircleIcon size={22} />}
              title="The positions didn't load."
              description={userMessage(jobs.error)}
              size="sm"
              action={
                <Button variant="outline" size="sm" onClick={() => void jobs.refetch()}>
                  Try again
                </Button>
              }
            />
          </div>
        ) : items === undefined ? (
          <div className="flex flex-col gap-4 rounded-card border border-border bg-surface shadow-card p-5" aria-busy="true">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-card border border-border bg-surface shadow-card">
            <EmptyState icon={<BriefcaseIcon size={22} />} title={words.empty} description={words.emptyHint(company.name)} size="sm" />
          </div>
        ) : (
          <>
            <ul
              aria-label={words.list}
              className={clsx(
                'divide-y divide-divider-soft overflow-hidden rounded-card border border-border bg-surface shadow-card',
                jobs.isFetching && !jobs.isFetchingNextPage && 'opacity-70',
              )}
            >
              {items.map((job) => (
                <CompanyJobRow key={job.id} job={job} href={href(job.id)} now={now} />
              ))}
            </ul>
            {jobs.hasNextPage && (
              <div className="mt-4 flex justify-center">
                <Button variant="outline" loading={jobs.isFetchingNextPage} onClick={() => void jobs.fetchNextPage()}>
                  Show more positions
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
