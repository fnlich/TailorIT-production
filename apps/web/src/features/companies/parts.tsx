'use client';

import type { CompanyParentRef, CompanySourceLine, CompanySummaryOrigin } from '@tailorit/shared';
import { clsx } from 'clsx';
import Link from 'next/link';
import { Fragment, type ReactNode } from 'react';
import { ArrowSquareOutIcon, SparkleIcon } from '@/components/ui/icons';
import { GlobeSimpleIcon, LinkSimpleIcon, LinkedinLogoIcon } from '../jobs/icons';
import { sourceNames, summaryOriginLine, updatedMonth, type CompanyFact, type CompanyLinkItem } from './format';
import { companyHref } from './routes';

// v30 E0-WEB: the pieces the job detail's Company section and the company page draw alike: the links row, the
// description with its origin line, the stats grid, the sources line and "Part of {parent}".

const LINK_ICON: Record<CompanyLinkItem['kind'], ReactNode> = {
  website: <GlobeSimpleIcon size={16} />,
  linkedin: <LinkedinLogoIcon size={16} />,
  other: <LinkSimpleIcon size={16} />,
};

/** The links row: the website, the LinkedIn page (only from an allowed source), the other links; each opens a tab. */
export function CompanyLinksRow({ name, links, className }: { name: string; links: readonly CompanyLinkItem[]; className?: string }) {
  if (links.length === 0) return null;
  return (
    <ul className={clsx('flex flex-wrap gap-x-5 gap-y-2', className)} aria-label={`${name} links`}>
      {links.map((link) => (
        <li key={link.url}>
          <a
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            data-company-link={link.kind}
            className="inline-flex min-h-6 items-center gap-1.5 rounded-tag text-sm font-medium text-primary hover:underline"
          >
            {LINK_ICON[link.kind]}
            {link.label}
            <ArrowSquareOutIcon size={12} aria-hidden />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/** "Part of {parent}" (13 §5.4: a subsidiary keeps its own jobs and profile), linking to the parent's page. */
export function ParentLine({ parent, className }: { parent: CompanyParentRef | null | undefined; className?: string }) {
  if (!parent) return null;
  return (
    <p className={clsx('text-sm leading-5 text-muted-foreground', className)} data-company-parent={parent.id}>
      Part of{' '}
      <Link href={companyHref(parent.id)} className="rounded-tag font-medium text-primary hover:underline">
        {parent.name}
      </Link>
    </p>
  );
}

/**
 * The description, then the line saying where it came from: "Summary written by AI from …" (13 §8), or "In the
 * company's own words …" (owner question 22); an admin's text has none.
 */
export function CompanyAbout({
  summary,
  origin,
  sources,
  className,
}: {
  summary: string | null | undefined;
  origin: CompanySummaryOrigin | null | undefined;
  sources: readonly CompanySourceLine[] | null | undefined;
  className?: string;
}) {
  if (!summary) {
    return <p className={clsx('text-[15px] leading-6 text-muted-foreground', className)}>There is no description of this company yet.</p>;
  }
  const label = summaryOriginLine(origin, sources);
  return (
    <div className={className}>
      <p className="text-[15px] leading-6 whitespace-pre-line text-foreground">{summary}</p>
      {label && (
        <p className="mt-2 flex items-start gap-1.5 text-[13px] leading-5 text-muted-foreground" data-summary-origin={origin}>
          {origin === 'ai' && <SparkleIcon size={14} className="mt-[3px] shrink-0" aria-hidden />}
          <span>{label}</span>
        </p>
      )}
    </div>
  );
}

/** The stats grid (Company Size, Company Stage, Headquarters, Founded or Incorporated, Industry, …). */
export function CompanyFactsGrid({ facts, className, columns = 3 }: { facts: readonly CompanyFact[]; className?: string; columns?: 2 | 3 }) {
  if (facts.length === 0) return null;
  return (
    <dl
      className={clsx(
        'grid grid-cols-2 gap-x-6 gap-y-4 rounded-card border border-border bg-surface-low p-4',
        columns === 3 && 'sm:grid-cols-3',
        className,
      )}
    >
      {facts.map((fact) => (
        <div key={fact.key} className="flex min-w-0 flex-col gap-0.5" data-company-fact={fact.key}>
          <dt className="text-[13px] leading-5 text-muted-foreground">{fact.label}</dt>
          <dd className="text-sm leading-5 font-medium break-words text-foreground">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * "Sources: the company's website, Wikidata, SEC EDGAR. Updated November 2026." (13 §6.3), a source's name linking to
 * its page when it has one. Nothing when there is neither a source nor a date.
 */
export function SourcesLine({
  sources,
  updatedAt,
  className,
}: {
  sources: readonly CompanySourceLine[] | null | undefined;
  updatedAt: string | null | undefined;
  className?: string;
}) {
  const names = sourceNames(sources);
  const month = updatedMonth(updatedAt);
  if (names.length === 0 && !month) return null;
  return (
    <p className={clsx('text-[13px] leading-5 text-muted-foreground', className)} data-company-sources="">
      {names.length > 0 && (
        <>
          Sources:{' '}
          {names.map((source, index) => (
            <Fragment key={source.label}>
              {index > 0 && ', '}
              {source.url ? (
                <a href={source.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">
                  {source.label}
                </a>
              ) : (
                source.label
              )}
            </Fragment>
          ))}
          .
        </>
      )}
      {names.length > 0 && month && ' '}
      {month && `Updated ${month}.`}
    </p>
  );
}
