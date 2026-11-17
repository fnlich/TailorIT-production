'use client';

import { ADMIN_COMPANY_FILTERS, type AdminCompaniesQuery, type AdminCompanyRow } from '@tailorit/shared/companies';
import { useInfiniteQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { AdminResourceTab, ShowMoreButton, type AdminColumn } from '@/components/admin';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ArrowSquareOutIcon, BuildingsIcon, MagnifyingGlassIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/Input';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { Tooltip } from '@/components/ui/Tooltip';
import { relativeTime } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { companyHref } from '@/features/companies/routes';
import { CompanyLogo } from '@/features/jobs/CompanyLogo';
import { companiesAdminKeys, fetchAdminCompanies } from './api';
import { CompanyEditor } from './CompanyEditor';
import { MatchReviews } from './MatchReviews';
import { OptOutList } from './OptOutList';

// v30 E0-WEB: Admin › Companies (13-company-enrichment.md §5.5, §6.4; 00-overview §1): the companies, server-paged,
// searched and filtered, each opening the company editor; the match review queue; and the opt-out list. The view and
// the open company live in the address (?tab=companies&view=reviews|opt-outs&company=<id>), so a link opens them.

/** Whether Admin › Companies is built: the registry draws it once true. */
export const COMPANIES_TAB_READY = true;

export const COMPANY_VIEWS = ['companies', 'reviews', 'opt-outs'] as const;
export type CompanyView = (typeof COMPANY_VIEWS)[number];
const VIEW_LABEL: Record<CompanyView, string> = { companies: 'Companies', reviews: 'Match reviews', 'opt-outs': 'Opt-out list' };

export const COMPANY_FILTER_LABEL: Record<AdminCompaniesQuery['filter'], string> = {
  all: 'All companies',
  open_jobs: 'With open jobs',
  needs_review: 'Needs review',
  opted_out: 'Opted out',
  merged: 'Merged',
};

/** The view of `?view=` (Companies when absent or unknown). */
export function readCompanyView(value: string | null): CompanyView {
  return (COMPANY_VIEWS as readonly string[]).includes(value ?? '') ? (value as CompanyView) : 'companies';
}

/** The company of `?company=` the editor shows, or null. */
export function readEditorCompany(value: string | null): number | null {
  if (!value || !/^\d{1,15}$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** How long the search box rests before the list is asked again. */
const SEARCH_DELAY_MS = 300;
const PAGE_SIZE = 50;

export function CompaniesTab() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const view = readCompanyView(params.get('view'));
  const editorId = readEditorCompany(params.get('company'));

  /** Changes the address's view and open company, keeping the tab. */
  const navigate = (next: { view?: CompanyView; company?: number | null }) => {
    const search = new URLSearchParams(params.toString());
    search.set('tab', 'companies');
    const nextView = next.view ?? view;
    if (nextView === 'companies') search.delete('view');
    else search.set('view', nextView);
    const company = next.company === undefined ? editorId : next.company;
    if (company === null) search.delete('company');
    else search.set('company', String(company));
    router.replace(`${pathname}?${search.toString()}`, { scroll: false });
  };
  const openCompany = (companyId: number) => navigate({ company: companyId });

  const viewSwitch = (
    <SegmentedControl<CompanyView>
      aria-label="Companies view"
      size="sm"
      items={COMPANY_VIEWS.map((value) => ({ value, label: VIEW_LABEL[value] }))}
      value={view}
      onValueChange={(next) => navigate({ view: next })}
    />
  );

  return (
    <>
      {view === 'reviews' ? (
        <MatchReviews viewSwitch={viewSwitch} onOpenCompany={openCompany} />
      ) : view === 'opt-outs' ? (
        <OptOutList viewSwitch={viewSwitch} onOpenCompany={openCompany} />
      ) : (
        <CompanyList viewSwitch={viewSwitch} onOpenCompany={openCompany} />
      )}
      {editorId !== null && (
        <CompanyEditor
          key={editorId}
          companyId={editorId}
          open
          onOpenChange={(open) => !open && navigate({ company: null })}
          onOpenCompany={openCompany}
        />
      )}
    </>
  );
}

function CompanyList({ viewSwitch, onOpenCompany }: { viewSwitch: ReactNode; onOpenCompany: (companyId: number) => void }) {
  const now = useNow();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<AdminCompaniesQuery['filter']>('all');

  useEffect(() => {
    const timer = window.setTimeout(() => setQ(search.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [search]);

  const companies = useInfiniteQuery({
    queryKey: companiesAdminKeys.list(q, filter),
    queryFn: ({ pageParam, signal }) => fetchAdminCompanies({ q, filter, cursor: pageParam, limit: PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
  });
  const items = companies.data?.pages.flatMap((page) => page.items);
  const total = companies.data?.pages[0]?.total;
  const narrowed = q !== '' || filter !== 'all';

  const columns: AdminColumn<AdminCompanyRow>[] = [
    {
      key: 'company',
      header: 'Company',
      cell: (row) => (
        <button
          type="button"
          onClick={() => onOpenCompany(row.id)}
          className="flex min-w-0 items-center gap-3 rounded-control text-left"
        >
          {/* v30 FIX-WEB (REV-UX UX-9): the name is the visible words after a hidden verb (Label in Name). */}
          <span className="sr-only">Edit </span>
          <CompanyLogo name={row.name} url={row.logoUrl} size={32} />
          <span className="min-w-0">
            <span className="block truncate font-semibold hover:underline">{row.name}</span>
            <span className="block truncate text-[13px] text-muted-foreground">{row.domain ?? `Company ${row.id}`}</span>
          </span>
        </button>
      ),
    },
    {
      key: 'jobs',
      header: 'Jobs',
      className: 'w-40 tabular-nums',
      cell: (row) => (
        <span className="flex flex-col text-[13px] leading-5">
          <span>{`${row.openJobs.toLocaleString('en-US')} open`}</span>
          <span className="text-muted-foreground">{`${row.closedJobs.toLocaleString('en-US')} closed`}</span>
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      className: 'w-44',
      cell: (row) => (
        <span className="flex flex-wrap gap-1.5">
          {row.openReviews > 0 && <Badge tone="warning">{`${row.openReviews} to review`}</Badge>}
          {row.doNotFetch && <Badge tone="destructive">Opted out</Badge>}
          {row.mergedIntoId !== null && <Badge tone="neutral">{`Merged into ${row.mergedIntoId}`}</Badge>}
          {row.openReviews === 0 && !row.doNotFetch && row.mergedIntoId === null && <span className="text-muted-foreground">-</span>}
        </span>
      ),
    },
    {
      key: 'updated',
      header: 'Updated',
      className: 'w-36',
      cell: (row) => (
        <Tooltip content={new Date(row.updatedAt).toLocaleString('en-US')}>
          <span className="text-[13px] text-muted-foreground">{relativeTime(row.updatedAt, now)}</span>
        </Tooltip>
      ),
    },
    {
      key: 'page',
      // A visible header, and the link's own label: an absolutely placed sr-only span in a cell would escape the
      // table's sideways scroll and widen the whole page on a phone.
      header: 'Page',
      className: 'w-28 text-right',
      cell: (row) => (
        <Link
          href={companyHref(row.id)}
          target="_blank"
          rel="noopener noreferrer"
          // v30 FIX-WEB (UX-9): the visible "Open" first (Label in Name).
          aria-label={`Open the company page of ${row.name} (opens in a new tab)`}
          className="inline-flex items-center gap-1 text-[13px] font-medium text-primary-ink hover:underline"
        >
          Open
          <ArrowSquareOutIcon size={12} aria-hidden />
        </Link>
      ),
    },
  ];

  return (
    <AdminResourceTab
      title="Companies"
      description="Company profiles and where each value came from. Open a company to correct a field (an admin's value is locked), merge or split it, refresh it, or opt it out."
      actions={viewSwitch}
      lead={
        <div className="mb-4 flex flex-wrap items-center gap-3" role="search" aria-label="Find companies">
          <Input
            type="search"
            aria-label="Search companies by name or domain"
            placeholder="Search by name or domain"
            leading={<MagnifyingGlassIcon size={16} />}
            className="pl-9"
            wrapperClassName="w-full max-w-sm"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Select
            aria-label="Which companies"
            options={ADMIN_COMPANY_FILTERS.map((value) => ({ value, label: COMPANY_FILTER_LABEL[value] }))}
            value={filter}
            onValueChange={setFilter}
            className="w-52"
          />
        </div>
      }
      items={items}
      error={companies.error}
      errorTitle="The companies could not be loaded"
      errorAction={
        <Button variant="outline" size="sm" onClick={() => void companies.refetch()}>
          Try again
        </Button>
      }
      empty={{
        icon: <BuildingsIcon size={22} />,
        title: narrowed ? 'No company matches' : 'No companies yet',
        description: narrowed ? 'Try another name, domain or view.' : 'Companies appear here as job sources bring in their jobs.',
      }}
      toolbar={
        total !== undefined && (
          <p className="mb-3 text-sm text-muted-foreground" data-company-total={total}>
            {`${total.toLocaleString('en-US')} ${total === 1 ? 'company' : 'companies'}`}
          </p>
        )
      }
      tableLabel="Companies"
      columns={columns}
      getKey={(row) => row.id}
      tableClassName={clsx(companies.isFetching && !companies.isFetchingNextPage && 'opacity-70')}
      footer={
        // v30 FIX-WEB (UX-4): focus stays on the button while the next page loads.
        <ShowMoreButton hasMore={companies.hasNextPage} loading={companies.isFetchingNextPage} onMore={() => void companies.fetchNextPage()} afterLast={['table[aria-label="Companies"] tbody tr:last-of-type button', 'table[aria-label="Companies"] tbody tr:last-of-type [role="checkbox"]']}>
          Show more companies
        </ShowMoreButton>
      }
    />
  );
}
