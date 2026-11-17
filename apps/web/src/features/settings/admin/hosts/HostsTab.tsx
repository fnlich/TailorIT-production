'use client';

import { AdminHostRowSchema, CRAWL_HOST_HOLD_LABEL, type AdminHost, type AdminHostRow } from '@tailorit/shared/sourcing';
import { keepPreviousData, useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { AdminResourceTab, ShowMoreButton, type AdminColumn } from '@/components/admin';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { ArrowsClockwiseIcon, MagnifyingGlassIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/Input';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Tooltip } from '@/components/ui/Tooltip';
import { useNow } from '@/lib/useNow';
import { useAdminLink } from '../sources/links';
import { formatCount } from '../sources/sources';
import { fetchHostsPage, hostKeys, type AdminHostsPage, type HostFilters, type HostShow } from './api';
import { HostSheet } from './HostSheet';
import { clockText, holdLeftText, isHeld, lastStatusText, paceText, sourcesText } from './hosts';

// v30 S1-WEB: Admin › Hosts (docs/design/part2/12-job-sourcing.md §9.2, §9.4, §9.8): every host the readers pace
// (crawl_hosts), server-paged and searched, held or failing ones on their own; a host's sheet shows its pace, hold,
// failures and robots.txt with the content signals, and holds or releases it. SCH's stub, built.

/** Whether Admin › Hosts is built: the registry draws it once true. */
export const HOSTS_TAB_READY = true;

const SEARCH_DELAY_MS = 300;
const SHOW_ITEMS: ReadonlyArray<{ value: HostShow; label: string }> = [
  { value: 'all', label: 'All hosts' },
  { value: 'held', label: 'Held' },
  { value: 'failing', label: 'Failing' },
];

export function HostsTab() {
  const now = useNow();
  const link = useAdminLink();
  const queryClient = useQueryClient();
  // The address names a host to open (a source's "Open its host", the daily report's failing hosts).
  const named = useSearchParams().get('host')?.trim().toLowerCase() || null;
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<HostFilters>({ q: '', show: 'all' });
  // The sheet's host, kept while it slides out; before any is opened, the host the address names.
  const [sheet, setSheet] = useState<{ row: AdminHostRow | { host: string }; open: boolean } | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const q = search.trim();
      setFilters((previous) => (previous.q === q ? previous : { ...previous, q }));
    }, SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [search]);

  const hosts = useInfiniteQuery({
    queryKey: hostKeys.page(filters),
    queryFn: ({ pageParam, signal }) => fetchHostsPage(filters, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
  });
  const items = useMemo(() => hosts.data?.pages.flatMap((page) => page.items) ?? [], [hosts.data]);
  const total = hosts.data?.pages[0]?.total ?? 0;

  const namedRow = named ? (items.find((item) => item.host === named) ?? { host: named }) : null;
  const shown = sheet?.row ?? namedRow;
  const open = sheet ? sheet.open : namedRow !== null;
  const openRow = (row: AdminHostRow) => setSheet({ row, open: true });
  const close = () => {
    if (shown) setSheet({ row: shown, open: false });
    if (named) link({ tab: 'hosts' });
  };

  /** A held or released host goes into every page shown. */
  const onChanged = (host: AdminHost) => {
    const row: AdminHostRow = AdminHostRowSchema.parse(host);
    queryClient.setQueriesData<InfiniteData<AdminHostsPage>>({ queryKey: [...hostKeys.all, 'page'] }, (current) =>
      current ? { ...current, pages: current.pages.map((page) => ({ ...page, items: page.items.map((item) => (item.host === row.host ? row : item)) })) } : current,
    );
    setSheet((current) => (current && current.row.host === row.host ? { ...current, row } : current));
  };

  const columns: AdminColumn<AdminHostRow>[] = [
    {
      key: 'host',
      header: 'Host',
      cell: (host) => (
        <button type="button" onClick={() => openRow(host)} className="block min-w-0 max-w-full rounded-control text-left">
          {/* v30 FIX-WEB (REV-UX UX-9): the name is the visible words after a hidden verb (Label in Name). */}
          <span className="sr-only">Open </span>
          <span className="block truncate font-semibold hover:underline">{host.host}</span>
          <span className="block truncate text-[13px] text-muted-foreground">{sourcesText(host)}</span>
        </button>
      ),
    },
    { key: 'pace', header: 'Pace', className: 'w-52', cell: (host) => <span className="text-[13px]">{paceText(host.minIntervalMs)}</span> },
    {
      key: 'hold',
      header: 'Hold',
      className: 'w-56',
      cell: (host) =>
        isHeld(host, now) && host.holdUntil ? (
          <Tooltip content={`${host.holdReason ? CRAWL_HOST_HOLD_LABEL[host.holdReason] : 'Held'}, until ${clockText(host.holdUntil, now)}`}>
            <Badge tone={host.holdReason === 'admin' ? 'neutral' : 'warning'}>{holdLeftText(host.holdUntil, now)}</Badge>
          </Tooltip>
        ) : (
          <span className="text-muted-foreground">Not held</span>
        ),
    },
    {
      key: 'failures',
      header: 'Failures in a row',
      className: 'w-36 tabular-nums',
      cell: (host) => <span className={clsx(host.consecutiveFailures > 0 && 'font-semibold text-[#c62a29]')}>{host.consecutiveFailures}</span>,
    },
    { key: 'last', header: 'Last answer', className: 'w-28 tabular-nums', cell: (host) => lastStatusText(host.lastStatus) },
    {
      key: 'optout',
      header: 'Opt-out',
      className: 'w-28',
      cell: (host) => (host.optedOut ? <Badge tone="warning">Opted out</Badge> : <span className="text-muted-foreground">No</span>),
    },
  ];

  const narrowed = filters.q !== '' || filters.show !== 'all';

  return (
    <AdminResourceTab
      title="Hosts"
      description="Every host the readers ask: one request at a time, at least its pace apart, shared by every process. A host that asks to wait, keeps failing or shows a bot check is held, and its sources wait."
      actions={<IconButton label="Refresh the hosts" icon={<ArrowsClockwiseIcon size={16} />} variant="outline" onClick={() => void hosts.refetch()} />}
      lead={
        <div className="mb-4 flex flex-wrap items-center gap-3" role="search" aria-label="Find hosts">
          <Input
            type="search"
            aria-label="Search hosts"
            placeholder="Search hosts"
            leading={<MagnifyingGlassIcon size={16} />}
            className="pl-9"
            wrapperClassName="w-full max-w-sm"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <SegmentedControl aria-label="Show" size="sm" items={SHOW_ITEMS} value={filters.show} onValueChange={(show) => setFilters((previous) => ({ ...previous, show }))} />
        </div>
      }
      items={hosts.data ? items : undefined}
      error={hosts.error}
      errorTitle="The hosts could not be loaded"
      errorAction={
        <Button variant="outline" size="sm" onClick={() => void hosts.refetch()}>
          Try again
        </Button>
      }
      empty={
        narrowed
          ? { title: 'No host matches', description: 'Try another search, or show every host.', card: false }
          : { size: 'sm', title: 'No hosts yet', description: 'A host is listed once a reader first asks it for something.' }
      }
      toolbar={
        <p className="mb-3 text-sm text-muted-foreground" aria-live="polite">
          {formatCount(total)} {total === 1 ? 'host' : 'hosts'}
          {items.length < total ? `, ${formatCount(items.length)} shown` : ''}
        </p>
      }
      footer={
        // v30 FIX-WEB (UX-4): focus stays on the button while the next page loads.
        <ShowMoreButton hasMore={hosts.hasNextPage} loading={hosts.isFetchingNextPage} onMore={() => void hosts.fetchNextPage()} afterLast={['table[aria-label="Hosts"] tbody tr:last-of-type button', 'table[aria-label="Hosts"] tbody tr:last-of-type [role="checkbox"]']}>
          Show more hosts
        </ShowMoreButton>
      }
      tableLabel="Hosts"
      columns={columns}
      getKey={(host) => host.host}
      tableClassName={clsx(hosts.isPlaceholderData && 'opacity-70')}
    >
      <HostSheet
        row={shown}
        open={open}
        onOpenChange={(next) => !next && close()}
        now={now}
        onShowSources={(host) => link({ tab: 'sources', host })}
        onChanged={onChanged}
      />
    </AdminResourceTab>
  );
}
