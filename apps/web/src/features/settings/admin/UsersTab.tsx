'use client';

import type { AdminUser, AdminUserList, AdminUserTypeFilter } from '@tailorit/shared/accounts';
import { initialsOf } from '@tailorit/shared/auth';
import { formatUsd } from '@tailorit/shared/constants';
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useEffect, useId, useState } from 'react';
import type { AccountDeletionState } from '@tailorit/shared/account-deletion'; // v34 ACCTDEL
import { DELETE_COPY } from '@/features/account-deletion/copy'; // v34 ACCTDEL
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { MagnifyingGlassIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/Input';
import { LetterAvatar } from '@/components/ui/LetterAvatar';
import { Select } from '@/components/ui/Select';
import { useAuth } from '@/lib/auth';
import { useNow } from '@/lib/useNow';
import { usePublicConstants } from '@/lib/constants';
import { adminKeys, fetchUsers } from './api';
import { AdminResourceTab, type AdminColumn } from '@/components/admin';
import { UserSheet } from './UserSheet';
import { budgetCell, todayCell, typeCell, typeFilterOptions } from './users';

/** How long the search box rests before the list is asked again. */
const SEARCH_DELAY_MS = 300;
const PAGE_SIZE = 50;

/**
 * Admin › Users (v2.0, docs/design/v2.0/08-ui.md, "Users"): every account, server-paged (searched by email or name,
 * filtered by type), with its role, type and term, daily AI budget, today's use, extra credit and status. A row opens
 * the account sheet: type and term, AI budget, extra credit, history, role and sign-in.
 */
export function UsersTab() {
  const queryClient = useQueryClient();
  const now = useNow();
  const { account } = useAuth();
  const endingDays = usePublicConstants().get('PAID_ENDING_DAYS');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [type, setType] = useState<AdminUserTypeFilter>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const [opened, setOpened] = useState<AdminUser | null>(null);
  const tabId = useId(); // v34 ACCTDEL: the tab's section, whose heading takes the focus after a deletion

  useEffect(() => {
    const timer = window.setTimeout(() => setQ(search.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [search]);

  const users = useInfiniteQuery({
    queryKey: adminKeys.usersPage(q, type),
    queryFn: ({ pageParam, signal }) => fetchUsers({ q, type, cursor: pageParam, limit: PAGE_SIZE, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
  });
  const items = users.data?.pages.flatMap((page) => page.items) ?? [];

  /** A change made in the sheet goes into every page of the list at once. */
  const onChanged = (user: AdminUser) => {
    setOpened(user);
    queryClient.setQueriesData<InfiniteData<AdminUserList>>({ queryKey: [...adminKeys.users, 'page'] }, (current) =>
      current
        ? {
            ...current,
            pages: current.pages.map((page) => ({
              ...page,
              items: page.items.map((item) => (item.id === user.id ? { ...item, ...user } : item)),
            })),
          }
        : current,
    );
  };

  /**
   * v34 ACCTDEL: a deleted account leaves the sheet and every page of the list at once (then the list is read again);
   * one being deleted (`pending`) stays, read again as "Being deleted". The focus goes to the next row (else the one
   * before, else the list's heading); for one being deleted, back to its own row.
   */
  const onDeleted = (id: string, state: AccountDeletionState) => {
    const ids = items.map((item) => item.id);
    const at = ids.indexOf(id);
    const focusOn = state === 'pending' ? id : (ids[at + 1] ?? (at > 0 ? ids[at - 1] : undefined));
    setOpenId(null);
    setOpened(null);
    if (state === 'deleted') {
      queryClient.setQueriesData<InfiniteData<AdminUserList>>({ queryKey: [...adminKeys.users, 'page'] }, (current) =>
        current ? { ...current, pages: current.pages.map((page) => ({ ...page, items: page.items.filter((item) => item.id !== id) })) } : current,
      );
    }
    void queryClient.invalidateQueries({ queryKey: adminKeys.users });
    // After the sheet is gone (its own focus return finds no opener for a deleted row).
    window.setTimeout(() => {
      const row = focusOn ? document.querySelector<HTMLElement>(`[data-user-open="${CSS.escape(focusOn)}"]`) : null;
      const heading = document.getElementById(tabId)?.querySelector<HTMLElement>('h2');
      const target = row ?? heading;
      if (!target) return;
      if (target === heading) target.tabIndex = -1;
      target.focus();
    }, 0);
  };

  const columns: AdminColumn<AdminUser>[] = [
    {
      key: 'account',
      header: 'Account',
      cell: (user) => (
        <button
          type="button"
          onClick={() => {
            setOpened(user);
            setOpenId(user.id);
          }}
          className="flex min-w-0 items-center gap-3 rounded-control text-left"
          aria-label={`Open the account of ${user.email}`}
          data-user-open={user.id} // v34 ACCTDEL: the focus after a deletion
        >
          <LetterAvatar letters={initialsOf(user.name, user.email)} size={32} tone="brand" />
          <span className="min-w-0">
            <span className="block truncate font-semibold hover:underline">
              {user.name || user.email}
              {user.id === account?.id && <span className="ml-2 font-normal text-muted-foreground">(you)</span>}
            </span>
            {user.name && <span className="block truncate text-[13px] text-muted-foreground">{user.email}</span>}
          </span>
        </button>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      className: 'w-24',
      cell: (user) => <span className="text-muted-foreground">{user.role === 'admin' ? 'Admin' : 'User'}</span>,
    },
    {
      key: 'type',
      header: 'Type',
      className: 'w-44',
      cell: (user) => {
        const cell = typeCell(user, now, endingDays);
        return (
          <Badge tone={cell.ending ? 'warning' : user.effectiveType === 'paid' ? 'tint' : 'neutral'} data-type-cell={user.effectiveType}>
            {cell.text}
          </Badge>
        );
      },
    },
    // "Default" or an amount: words, so not the measurement face.
    { key: 'budget', header: 'AI budget', className: 'w-28 tabular-nums', cell: (user) => budgetCell(user) },
    {
      key: 'today',
      header: 'Today',
      className: 'w-44',
      cell: (user) => {
        const today = todayCell(user);
        return (
          <span className="flex flex-col text-[13px] leading-5 tabular-nums">
            <span>{today.ai}</span>
            {today.writtenOff && <span className="text-warning">{today.writtenOff}</span>}
            <span className="text-muted-foreground">{today.autoApplies}</span>
          </span>
        );
      },
    },
    { key: 'credit', header: 'Extra credit', className: 'w-28', numeric: true, cell: (user) => formatUsd(user.extraCreditMicros) },
    {
      key: 'status',
      header: 'Status',
      className: 'w-28',
      cell: (user) =>
        // v34 ACCTDEL: an account whose deletion finishes on its own.
        user.beingDeleted ? (
          <Badge tone="warning" data-being-deleted="">
            {DELETE_COPY.beingDeleted}
          </Badge>
        ) : user.disabled ? (
          <Badge tone="destructive">Disabled</Badge>
        ) : (
          <span className="text-muted-foreground">Active</span>
        ),
    },
  ];

  return (
    <AdminResourceTab
      sectionProps={{ id: tabId }} // v34 ACCTDEL
      title="Users"
      description="Accounts, their plan and today's use; open one to change it."
      lead={
        <div className="mb-4 flex flex-wrap items-center gap-3" role="search" aria-label="Find accounts">
          <Input
            type="search"
            aria-label="Search accounts by email or name"
            placeholder="Search by email or name"
            leading={<MagnifyingGlassIcon size={16} />}
            className="pl-9"
            wrapperClassName="w-full max-w-sm"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Select aria-label="Account type" options={typeFilterOptions(endingDays)} value={type} onValueChange={setType} className="w-56" />
        </div>
      }
      items={users.data ? items : undefined}
      error={users.error}
      errorTitle="Accounts didn't load."
      errorAction={
        <Button variant="outline" size="sm" onClick={() => void users.refetch()}>
          Try again
        </Button>
      }
      empty={{ title: 'No account matches', description: 'Try another email, name or type.', card: false }}
      tableLabel="Accounts"
      columns={columns}
      getKey={(user) => user.id}
      tableClassName={clsx(users.isFetching && !users.isFetchingNextPage && 'opacity-70')}
      footer={
        users.hasNextPage && (
          <div className="mt-4 flex justify-center">
            <Button variant="outline" loading={users.isFetchingNextPage} onClick={() => void users.fetchNextPage()}>
              Show more accounts
            </Button>
          </div>
        )
      }
    >
      {opened && (
        <UserSheet
          user={opened}
          isSelf={opened.id === account?.id}
          open={openId === opened.id}
          onOpenChange={(open) => !open && setOpenId(null)}
          onChanged={onChanged}
          onDeleted={onDeleted} // v34 ACCTDEL
        />
      )}
    </AdminResourceTab>
  );
}
