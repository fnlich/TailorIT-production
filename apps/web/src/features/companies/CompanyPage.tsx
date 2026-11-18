'use client';

import type { CompanyPage as CompanyPageData } from '@tailorit/shared/companies';
import { clsx } from 'clsx';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { PAGE_GUTTER } from '@/components/shell/layout';
import { Button, buttonClasses } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { BuildingsIcon } from '@/components/ui/icons';
import { Notice } from '@/components/ui/Notice';
import { Skeleton, SkeletonText } from '@/components/ui/Skeleton';
import { isApiError, userMessage } from '@/lib/api';
import { CompanyLogo } from '../jobs/CompanyLogo';
import { ArrowLeftIcon } from '../jobs/icons';
import { jobsHref } from '../jobs/url';
import { useCompanyPage } from './api';
import { CompanyJobs } from './CompanyJobs';
import { companyFacts, companyLinks, headquartersOf } from './format';
import { CompanyAbout, CompanyFactsGrid, CompanyLinksRow, ParentLine, SourcesLine } from './parts';
import { companyHref } from './routes';

// v30 E0-WEB: the company page, /companies/:id (owner question 24; 13-company-enrichment.md §2, §6.3, §10): the full
// profile (logo, name, tagline, "Part of {parent}", the links, the description and its origin, the stats, the sources
// line), then its open positions and its closed history. A merged company answers its survivor, whose address replaces
// the old one.

/** The company id of the address's `[id]`, or null for one that is not a positive whole number. */
export function readCompanyId(value: string | null | undefined): number | null {
  if (!value || !/^\d{1,15}$/.test(value.trim())) return null;
  const id = Number(value.trim());
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** "12 open positions · 40 closed", the header's count line. */
export function countsLine(counts: Pick<CompanyPageData['counts'], 'openJobs' | 'closedJobs'>): string {
  const open = `${counts.openJobs.toLocaleString('en-US')} open ${counts.openJobs === 1 ? 'position' : 'positions'}`;
  return counts.closedJobs > 0 ? `${open} · ${counts.closedJobs.toLocaleString('en-US')} closed` : open;
}

export function CompanyPage({ idParam }: { idParam: string }) {
  const router = useRouter();
  const companyId = readCompanyId(idParam);
  const company = useCompanyPage(companyId);
  const data = company.data;

  // A merged company answers its survivor: the address follows it, so a reload or a shared link lands there.
  useEffect(() => {
    if (data && companyId !== null && data.id !== companyId) router.replace(companyHref(data.id), { scroll: false });
  }, [data, companyId, router]);
  useEffect(() => {
    if (data) document.title = `${data.name} · TailorIT`;
  }, [data]);

  const notFound = companyId === null || (isApiError(company.error) && company.error.status === 404);

  return (
    <div className={clsx('mx-auto w-full max-w-[1200px] pt-6 pb-20 sm:pt-9', PAGE_GUTTER)}>
      <Link href="/jobs" className="inline-flex min-h-6 items-center gap-1.5 rounded-tag text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeftIcon size={16} aria-hidden />
        Jobs
      </Link>
      {notFound ? (
        <div className="mt-6 rounded-card border border-border bg-surface shadow-card">
          <EmptyState
            icon={<BuildingsIcon size={22} />}
            title="That company was not found"
            description="It may have been removed, or the link is wrong."
            action={
              <Link href="/jobs" className={buttonClasses({ variant: 'primary' })}>
                Back to jobs
              </Link>
            }
          />
        </div>
      ) : company.error && !data ? (
        <Notice
          tone="error"
          className="mt-6"
          title="The company could not be loaded"
          action={
            <Button variant="outline" size="sm" onClick={() => void company.refetch()}>
              Try again
            </Button>
          }
        >
          {userMessage(company.error)}
        </Notice>
      ) : !data ? (
        <CompanyPageSkeleton />
      ) : (
        <CompanyProfileView company={data} />
      )}
    </div>
  );
}

function CompanyPageSkeleton() {
  return (
    <div className="mt-6" aria-busy="true" aria-label="Loading the company">
      <div className="flex items-center gap-4 rounded-card border border-border bg-surface shadow-card p-6">
        <Skeleton className="size-16 shrink-0" rounded="control" />
        <div className="flex-1">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="mt-2 h-4 w-80 max-w-full" />
        </div>
      </div>
      <div className="mt-8 rounded-card border border-border bg-surface shadow-card p-6">
        <SkeletonText lines={4} />
      </div>
    </div>
  );
}

function CompanyProfileView({ company }: { company: CompanyPageData }) {
  const profile = company.profile;
  const name = company.name;
  const facts = companyFacts({
    sizeBucket: profile.sizeBucket,
    employees: profile.employees,
    stage: profile.stage,
    ticker: profile.ticker,
    exchange: profile.exchange,
    headquarters: headquartersOf(profile),
    foundedYear: profile.foundedYear,
    foundedKind: profile.foundedKind,
    industry: profile.industry,
    legalName: profile.legalName,
    name,
  });
  const links = companyLinks({ website: profile.website, linkedinUrl: profile.linkedinUrl, links: profile.otherLinks });

  return (
    <article aria-labelledby="company-name" data-company-page={company.id}>
      <header className="mt-4 flex flex-col gap-4 rounded-card border border-border bg-surface shadow-card p-5 sm:flex-row sm:items-start sm:gap-5 sm:p-6">
        <CompanyLogo name={name} url={profile.logoUrl} size={64} />
        <div className="min-w-0 flex-1">
          <h1 id="company-name" className="page-title break-words text-foreground">
            {name}
          </h1>
          {profile.tagline && <p className="mt-1 text-sm leading-5 text-muted-foreground">{profile.tagline}</p>}
          <ParentLine parent={company.parent} className="mt-1" />
          <CompanyLinksRow name={name} links={links} className="mt-3" />
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:items-end">
          <p className="text-[13px] leading-5 font-medium text-muted-foreground" data-company-counts="">
            {countsLine(company.counts)}
          </p>
          {company.counts.openJobs > 0 && (
            <Link href={jobsHref({ companies: [String(company.id)] })} className={buttonClasses({ variant: 'outline', size: 'sm' })}>
              Search its jobs
            </Link>
          )}
        </div>
      </header>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <section aria-labelledby="company-about" className="min-w-0 rounded-card border border-border bg-surface shadow-card p-5 sm:p-6 lg:col-start-1">
          <h2 id="company-about" className="text-heading font-semibold text-foreground">
            About {name}
          </h2>
          <CompanyAbout summary={profile.summary} origin={profile.summaryOrigin} sources={company.sources} className="mt-3" />
        </section>

        <aside aria-labelledby="company-facts" className="min-w-0 rounded-card border border-border bg-surface shadow-card p-5 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <h2 id="company-facts" className="text-heading font-semibold text-foreground">
            Company facts
          </h2>
          {facts.length > 0 ? (
            <CompanyFactsGrid facts={facts} className="mt-3 lg:grid-cols-1" />
          ) : (
            <p className="mt-3 text-sm leading-5 text-muted-foreground">No facts about this company yet.</p>
          )}
          <SourcesLine sources={company.sources} updatedAt={company.updatedAt} className="mt-3" />
        </aside>

        <CompanyJobs company={company} className="min-w-0 lg:col-start-1" />
      </div>
    </article>
  );
}
