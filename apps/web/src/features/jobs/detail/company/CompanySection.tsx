'use client';

import type { CompanyDetail } from '@tailorit/shared';
import Link from 'next/link';
import { useState } from 'react';
import { BuildingsIcon, CaretRightIcon } from '@/components/ui/icons';
import { companyFacts, companyLinks } from '@/features/companies/format';
import { CompanyAbout, CompanyFactsGrid, CompanyLinksRow, ParentLine, SourcesLine } from '@/features/companies/parts';
import { companyHref } from '@/features/companies/routes';
import { usePublicConstants } from '@/lib/constants';
import { CompanyLogo } from '../../CompanyLogo';
import { FlagIcon } from '../../icons';
import { SectionHeading } from '../MatchSection';
import { CompanyReportDialog } from './CompanyReportDialog';

/** The link to the company page: "See all 12 jobs at Acme" (or "See the 1 job at Acme"), else "See Acme's company page". */
export function allJobsLabel(company: Pick<CompanyDetail, 'name' | 'jobCount'>): string {
  const count = company.jobCount;
  if (count === 1) return `See the 1 job at ${company.name}`;
  if (typeof count === 'number' && count > 1) return `See all ${count.toLocaleString('en-US')} jobs at ${company.name}`;
  return `See ${company.name}'s company page`;
}

/**
 * The detail's company section (v31 FIX-JOBS: "About {company}"; the drawer's Company jump scrolls here): about the company, its links and whichever stats are
 * known. v30 E0-WEB (13-company-enrichment.md §6.3, §10; 00-overview §1): the name opens the company page
 * (/companies/:id, owner question 24); "Part of {parent}"; the description's origin ("Summary written by AI from …");
 * "Incorporated" when a registry gave the year; no "Total Funding" (no licensed source); the LinkedIn page only when an
 * allowed source names it; the sources line; and, given the job's id, "Report company information" (the report reason
 * company_info_wrong, 13 §6.4).
 */
export function CompanySection({ company, jobId, className, id }: { company: CompanyDetail; jobId?: number; className?: string; id?: string }) {
  const { t } = usePublicConstants();
  const [reportOpen, setReportOpen] = useState(false);
  const facts = companyFacts({
    sizeBucket: company.sizeBucket,
    stage: company.stage,
    headquarters: company.headquarters,
    foundedYear: company.foundedYear,
    foundedKind: company.foundedKind,
    industry: company.industry,
  });
  const links = companyLinks({ website: company.website, linkedinUrl: company.linkedinUrl, links: company.links });
  const href = companyHref(company.id);

  return (
    <section id={id} aria-labelledby="about-the-company" className={className} data-company-section={company.id}>
      {/* v31 FIX-JOBS: "About {company}", a drawer section's heading (an h3 under the job's h2). */}
      <SectionHeading id="about-the-company" icon={<BuildingsIcon size={18} weight="bold" />}>
        {t('LABEL_JOB_ABOUT_COMPANY', { company: company.name })}
      </SectionHeading>
      <div className="mt-4 flex items-center gap-3">
        <CompanyLogo name={company.name} url={company.logoUrl} size={48} />
        <div className="min-w-0">
          <p className="truncate text-[15px] leading-6 font-semibold text-foreground">
            <Link href={href} className="rounded-tag hover:text-primary hover:underline">
              {company.name}
            </Link>
          </p>
          {company.tagline && <p className="truncate text-[13px] leading-5 text-muted-foreground">{company.tagline}</p>}
          <ParentLine parent={company.parent} />
        </div>
      </div>
      <CompanyLinksRow name={company.name} links={links} className="mt-4" />
      <CompanyAbout summary={company.about} origin={company.summaryOrigin} sources={company.sources} className="mt-4" />
      <CompanyFactsGrid facts={facts} className="mt-5" />
      <SourcesLine sources={company.sources} updatedAt={company.updatedAt} className="mt-3" />
      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <Link href={href} className="inline-flex min-h-6 items-center gap-1 rounded-tag text-sm font-medium text-primary hover:underline">
          {allJobsLabel(company)}
          <CaretRightIcon size={14} weight="bold" aria-hidden />
        </Link>
        {jobId !== undefined && (
          <button
            type="button"
            onClick={() => setReportOpen(true)}
            className="inline-flex min-h-6 items-center gap-1.5 rounded-control text-[13px] text-muted-foreground hover:text-foreground hover:underline"
          >
            <FlagIcon size={14} aria-hidden />
            Report company information
          </button>
        )}
      </div>
      {jobId !== undefined && <CompanyReportDialog jobId={jobId} company={company.name} open={reportOpen} onOpenChange={setReportOpen} />}
    </section>
  );
}
