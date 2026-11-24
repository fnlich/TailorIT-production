'use client';

import type { QueuePaneItem, SavedJobSupport } from '@tailorit/shared/prepare';
import { useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { autoApplyLimit, LimitNotice } from '@/components/limits';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconButton } from '@/components/ui/IconButton';
import { Menu, MenuContent, MenuItem, MenuLinkItem, MenuTrigger } from '@/components/ui/Menu';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { ArrowSquareOutIcon, CheckIcon, DotsThreeIcon, HandPointingIcon, RobotIcon } from '@/components/ui/icons';
import { ApiError, userMessage } from '@/lib/api';
import { useAccount } from '@/lib/account';
import { usePublicConstants } from '@/lib/constants';
import { useNow } from '@/lib/useNow';
import { cancelPrepare } from '../prepare/api';
import type { PrepareAndQueue } from '../prepare/usePrepareAndQueue';
import { autoApplyKeys, clearFinished, removeQueueItem } from './api';
import {
  ACTION_LABEL,
  LIVE_THROTTLE_MS,
  QUEUE_FILTERS,
  QUEUE_FILTER_LABEL,
  changedRows,
  groupRows,
  kitResumeText,
  liveSummary,
  postingHref,
  queueEditOf, // v33 INT-1
  queueGroupTitle,
  rowActions,
  rowKey,
  rowStates,
  stateLine,
  supportKind,
  upNextPlaces,
  upNextTitle,
  waitingNoticeLine,
  type QueueAction,
  type QueueFilter,
  type QueueRow,
} from './copy';
import type { useQueuePane } from './data';
import { Pane, ROW_ACTION, StateLine, useReducedMotion, useRowFocus, useThrottled } from '../../components/queue';
import { PaneLoadFailed, PaneOutOfDate } from '../../components/queue/PaneStates';
import { RowCredit } from '../jobs/credits/JobCredit'; // v30 FIX-WEB (REQ-1)
import { creditOf } from '../jobs/credits/credit';
import { useTabProfile } from '../sharing/access'; // v33 SHARE-7
import { heldLine } from './held'; // v33 SHARE-7

// v2.0: the Queue pane, the right of the Auto-apply page (docs/design/v2.0/08-ui.md, "The Queue pane"): what is being
// prepared, what is up next (supported jobs, in the order the extension takes them), what is applied to by hand, what
// needs attention and what is done, each group with its count; every row's state line, its kit line (which resume it
// uses, v20 A29) and its actions; the Free daily limit's notice; one polite live summary.
// v32 LAYOUT (E4): a queue that could not be read is the pane's own state; one that could not be refreshed a small
// "Out of date" mark beside the title (no banner). The daily limit stays LimitNotice (COPY: a chip with a "?").

/** How long a row that changed state flashes. */
const FLASH_MS = 1_500;
/** How long after Try again focus may still move to the new Preparing row (UX-3's tail): a refused one never comes. */
const FOCUS_AFTER_MS = 60_000;

const isFinishedItem = (item: QueuePaneItem) =>
  item.display === 'applied' || item.display === 'failed' || item.display === 'needs_you';

/** The job a row names. */
const rowName = (row: QueueRow) => `${row.item.title} at ${row.item.company}`;

export interface QueuePaneProps {
  queue: ReturnType<typeof useQueuePane>;
  filter: QueueFilter;
  onFilterChange: (filter: QueueFilter) => void;
  prepare: PrepareAndQueue;
  scroll: boolean;
  /** v36 APPLYWEB (PLAN A1): the pane fills the page's measured frame and its list scrolls inside it (Pane's `fill`). */
  fill?: boolean;
  /** A saved job's support, when the Saved pane knows it (a Prepare row's accent and icon). */
  supportOf: (applicationId: string) => SavedJobSupport | undefined;
  /** View kit, a kit line, or Open job page on a manual row. */
  onOpenKit: (item: QueuePaneItem) => void;
  /** Mark as applied (the page's confirm). */
  onMarkApplied: (item: QueuePaneItem) => void;
  /** The row "View in queue" asked for: it flashes once. */
  highlight: string | null;
  /** Prepares dismissed on this device ("Dismiss" on a failed preparation). */
  dismissed: ReadonlySet<string>;
  onDismiss: (key: string) => void;
}

export function QueuePane({
  queue,
  filter,
  onFilterChange,
  prepare,
  scroll,
  fill = false,
  supportOf,
  onOpenKit,
  onMarkApplied,
  highlight,
  dismissed,
  onDismiss,
}: QueuePaneProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { t, get } = usePublicConstants();
  const account = useAccount().data;
  // v33 SHARE-7: on a shared profile, the rows the person prepared that wait for its owner's OK say so.
  const { key: tabKey, ownerName, profile: tabProfile } = useTabProfile();
  // v33 SHARE-6: Remove, Clear finished and Mark as applied are the owner's Queue changes box on a shared profile.
  const queueEdit = queueEditOf(tabKey, tabProfile);
  const now = useNow();
  const reduced = useReducedMotion();
  const [clearing, setClearing] = useState(false);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const data = queue.data;
  const groups = useMemo(
    () => (data ? groupRows(data.preparing, data.items, filter, dismissed) : []),
    [data, filter, dismissed],
  );
  const allRows = useMemo(() => (data ? groupRows(data.preparing, data.items, 'all', dismissed).flatMap((group) => group.rows) : []), [
    data,
    dismissed,
  ]);
  const places = useMemo(() => upNextPlaces(data?.items ?? []), [data]);
  const finished = (data?.items ?? []).filter(isFinishedItem).length;
  const usage = data?.usage ?? null;
  const resetText = usage?.resetText ?? t('STATE_WAITING_RESET');
  const waiting = (data?.items ?? []).some((item) => item.display === 'waiting_reset') || Boolean(usage?.reached);

  // A row that changed state since the last read flashes (none with reduced motion).
  const states = useRef<Map<string, string> | null>(null);
  const [flashing, setFlashing] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!data) return;
    const before = states.current;
    states.current = rowStates(allRows);
    if (!before || reduced) return;
    const changed = changedRows(before, allRows);
    if (changed.length === 0) return;
    const on = window.setTimeout(() => setFlashing(new Set(changed)), 0);
    const off = window.setTimeout(() => setFlashing(new Set()), FLASH_MS);
    return () => {
      window.clearTimeout(on);
      window.clearTimeout(off);
    };
  }, [allRows, data, reduced]);

  // One polite summary, at most every 10 s, never a row at a time.
  const summary = data ? liveSummary(data.preparing, data.items) : '';
  const live = useThrottled(summary, LIVE_THROTTLE_MS);

  // v2.0 FIX-INT (UX-3's tail): Try again (or Prepare) on a Queue row starts a new Prepare, whose row has another key,
  // so the pressed row leaves the pane and focus would drop to <body>. The pressed row is kept here; once the new
  // Preparing row of the same saved job is drawn, focus goes to its action, unless the person moved focus meanwhile.
  const focusAfter = useRef<{ applicationId: string; from: string } | null>(null);
  useEffect(() => {
    const want = focusAfter.current;
    if (!want) return;
    const active = document.activeElement;
    // The confirm (or the limit dialog) is open: wait until it closes.
    if (active?.closest('[role="dialog"], [role="alertdialog"]')) return;
    if (active && active !== document.body && !active.closest(`[data-queue-row="${CSS.escape(want.from)}"]`)) {
      focusAfter.current = null;
      return;
    }
    const next = allRows.find(
      (row) => row.kind === 'prepare' && row.item.applicationId === want.applicationId && rowKey(row) !== want.from,
    );
    const element = next ? document.querySelector<HTMLElement>(`[data-queue-row="${CSS.escape(rowKey(next))}"]`) : null;
    if (!element) return;
    focusAfter.current = null;
    (element.querySelector<HTMLElement>('[data-row-action]') ?? element.querySelector<HTMLElement>('button'))?.focus();
  }, [allRows]);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: autoApplyKeys.all });
  const withBusy = async (key: string, work: () => Promise<void>) => {
    if (busy.has(key)) return;
    setBusy((current) => new Set(current).add(key));
    try {
      await work();
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      refresh();
    }
  };

  const act = (row: QueueRow, action: QueueAction) => {
    const key = rowKey(row);
    switch (action) {
      case 'cancel':
        if (row.kind === 'prepare') {
          void withBusy(key, async () => {
            try {
              await cancelPrepare(row.item.prepareId);
              toast.success('Preparation cancelled', rowName(row));
            } catch (error) {
              toast.error('It could not be cancelled', userMessage(error, 'Please try again.'));
            }
          });
        }
        return;
      case 'remove':
        if (row.kind === 'queue') {
          void withBusy(key, async () => {
            try {
              await removeQueueItem(row.item.queueId);
              toast.success('Removed from the queue', rowName(row));
            } catch (error) {
              if (error instanceof ApiError && error.status === 404) return;
              if (error instanceof ApiError && error.status === 409) {
                // v30 INT-0 (audit C57): the API's words for a job being applied to, MSG_QUEUE_JOB_APPLYING.
                toast.info('It is being applied to now', t('MSG_QUEUE_JOB_APPLYING'));
                return;
              }
              toast.error('It could not be removed', userMessage(error, 'Please try again.'));
            }
          });
        }
        return;
      case 'try_again':
      case 'prepare':
        if (row.item.applicationId) {
          const want = { applicationId: row.item.applicationId, from: key };
          focusAfter.current = want;
          window.setTimeout(() => {
            if (focusAfter.current === want) focusAfter.current = null;
          }, FOCUS_AFTER_MS);
          prepare.prepare({
            applicationIds: [row.item.applicationId],
            names: new Map([[row.item.applicationId, { title: row.item.title, company: row.item.company }]]),
          });
        }
        return;
      case 'dismiss':
        onDismiss(key);
        return;
      case 'view_kit':
        if (row.kind === 'queue') onOpenKit(row.item);
        return;
      case 'mark_applied':
        if (row.kind === 'queue') onMarkApplied(row.item);
        return;
      case 'open_job':
        // A manual row's kit opens beside the posting's new tab.
        if (row.kind === 'queue' && row.item.display === 'manual') onOpenKit(row.item);
        return;
      case 'open_tracker':
        return;
    }
  };

  const controls = (
    <div className="flex flex-wrap items-center gap-2">
      <SegmentedControl
        aria-label="Show queue rows"
        listClassName="max-sm:h-11 max-sm:*:min-w-11"
        value={filter}
        onValueChange={onFilterChange}
        items={QUEUE_FILTERS.map((value) => ({ value, label: QUEUE_FILTER_LABEL[value] }))}
      />
      {queueEdit && (
        <Button
          variant="outline"
          className="ml-auto max-sm:h-11"
          disabled={finished === 0}
          onClick={() => setClearing(true)}
        >
          Clear finished
        </Button>
      )}
    </div>
  );

  let body: ReactNode;
  if (queue.isError && !data) {
    body = <PaneLoadFailed title="The auto-apply queue didn't load." message={userMessage(queue.error)} onRetry={() => void queue.refetch()} />;
  } else if (!data) {
    body = (
      <ul aria-busy="true" aria-label="Loading the auto-apply queue" className="divide-y divide-divider-soft">
        {Array.from({ length: 6 }, (_unused, index) => (
          <li key={index} aria-hidden="true" className="flex min-h-16 items-center gap-3 px-4 py-3 sm:px-5">
            <Skeleton className="size-8" rounded="control" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Skeleton className="h-3.5 w-1/2" />
              <Skeleton className="h-3 w-1/3" />
            </div>
            <Skeleton className="h-5.5 w-20" />
          </li>
        ))}
      </ul>
    );
  } else if (allRows.length === 0) {
    body = (
      <EmptyState
        icon={<RobotIcon size={22} />}
        title="Nothing in the queue"
        // v32 FIX-UX (UXREQ-8): the next step in view, not in the "?".
        nextStep="Prepare a saved job and it shows up here, ready to apply."
      />
    );
  } else {
    body = (
      <>
        {groups.length === 0 ? (
          <EmptyState
            size="sm"
            title={filter === 'active' ? 'Nothing active in the queue' : 'Nothing finished yet'}
            action={
              <Button variant="outline" size="sm" onClick={() => onFilterChange('all')}>
                Show the whole queue
              </Button>
            }
          />
        ) : (
          groups.map(({ group, rows }) => (
            <section key={group} aria-labelledby={`queue-group-${group}`} data-queue-group={group}>
              <h3
                id={`queue-group-${group}`}
                className={clsx(
                  'flex items-center gap-2 border-y border-border bg-surface-low px-4 py-1.5 text-[11px] leading-5 font-semibold tracking-[0.06em] text-subtle-foreground uppercase sm:px-5',
                  scroll && 'sticky top-0 z-1',
                )}
              >
                <span>{group === 'up_next' ? upNextTitle(waiting, resetText) : queueGroupTitle(group, t)}</span>
                <span className="num">{rows.length}</span>
              </h3>
              <ul className="divide-y divide-divider-soft" aria-labelledby={`queue-group-${group}`}>
                {rows.map((row) => (
                  <QueueRowView
                    key={rowKey(row)}
                    row={row}
                    support={row.kind === 'queue' ? row.item.support : row.item.applicationId ? supportOf(row.item.applicationId) : undefined}
                    line={
                      heldLine(row, { acting: tabKey !== null, ownerName }) ??
                      stateLine(row, {
                        t,
                        now,
                        resetText,
                        queueMax: get('QUEUE_SIZE_MAX'),
                        place: row.kind === 'queue' ? places.get(row.item.queueId) : undefined,
                      })
                    }
                    actions={rowActions(row, queueEdit)}
                    busy={busy.has(rowKey(row)) || (row.item.applicationId !== null && prepare.pending.has(row.item.applicationId))}
                    flash={flashing.has(rowKey(row)) || highlight === rowKey(row)}
                    onAction={(action) => act(row, action)}
                    onOpenKit={row.kind === 'queue' ? () => onOpenKit(row.item) : undefined}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </>
    );
  }

  return (
    <>
      <Pane
        id="queue-pane-title"
        title="Auto-apply queue"
        count={data ? allRows.length : null}
        controls={controls}
        status={queue.isError && data ? <PaneOutOfDate onRetry={() => void queue.refetch()} /> : undefined}
        scroll={scroll}
        fill={fill}
      >
        {usage?.reached && (
          <div className="px-4 pt-3 sm:px-5" data-waiting-reset="">
            <LimitNotice limit={autoApplyLimit(t, usage.limit, usage.resetsAt, account?.type)}>{waitingNoticeLine(t, resetText)}</LimitNotice>
          </div>
        )}
        {body}
        <p className="sr-only" role="status" aria-live="polite" data-queue-live="">
          {live}
        </p>
      </Pane>
      <ConfirmDialog
        open={clearing}
        onOpenChange={setClearing}
        tone="primary"
        title={`Clear ${finished} finished ${finished === 1 ? 'job' : 'jobs'}?`}
        description="They leave this list. A job you applied to stays Applied in your Job Tracker."
        confirmLabel="Clear finished"
        busyLabel="Clearing..."
        onConfirm={async () => {
          try {
            const { removed } = await clearFinished();
            toast.success(`Cleared ${removed} finished ${removed === 1 ? 'job' : 'jobs'}`);
          } catch (error) {
            if (!(error instanceof ApiError && error.status === 409)) throw error;
            toast.info('Nothing was cleared', 'The queue changed meanwhile. Look again, then clear the finished jobs.');
          } finally {
            refresh();
          }
        }}
      />
    </>
  );
}

function QueueRowView({
  row,
  support,
  line,
  actions,
  busy,
  flash,
  onAction,
  onOpenKit,
}: {
  row: QueueRow;
  support: SavedJobSupport | undefined;
  line: ReturnType<typeof stateLine>;
  actions: QueueAction[];
  busy: boolean;
  flash: boolean;
  onAction: (action: QueueAction) => void;
  onOpenKit?: () => void;
}) {
  const kind = support ? supportKind(support) : null;
  const name = rowName(row);
  const [primary, ...rest] = actions;
  const href = row.kind === 'queue' ? postingHref(row.item.url) : null;
  const kitText = row.kind === 'queue' ? kitResumeText(row.item) : null;
  const [rowRef, rowFocus] = useRowFocus<HTMLLIElement>(actions.join(','));
  return (
    <li
      ref={rowRef}
      {...rowFocus}
      data-queue-row={rowKey(row)}
      data-application={row.item.applicationId ?? undefined}
      data-display={row.kind === 'queue' ? row.item.display : `prepare-${row.item.state}`}
      className={clsx(
        'relative flex min-h-16 items-start gap-3 py-3 pr-4 pl-5 transition-colors duration-300 @lg/pane:pr-5 @lg/pane:pl-6',
        flash ? 'bg-primary-soft' : 'hover:bg-surface-low',
      )}
    >
      {/* The accent bar (decorative: the icon and the words carry the meaning). */}
      <span
        aria-hidden="true"
        className={clsx(
          'absolute inset-y-0 left-0 w-0.75',
          kind === 'manual' ? 'bg-warning' : kind === 'auto' ? 'bg-primary' : 'bg-border',
        )}
      />
      {kind && (
        <span
          role="img"
          aria-label={kind === 'manual' ? 'Apply manually' : 'Auto-apply supported'}
          className="mt-0.5 flex shrink-0 text-muted-foreground"
          data-support={kind}
        >
          {kind === 'manual' ? <HandPointingIcon size={16} aria-hidden="true" /> : <RobotIcon size={16} aria-hidden="true" />}
        </span>
      )}
      {/* v2.0 fix (UX-2): the actions sit beside the text only when the pane has room for them (by the pane's width,
          not the viewport's): one or two from a 32rem pane, three or four from 56rem. Otherwise they go on their own
          line under the text, so the title, the state words and the kit line keep the row's full width. */}
      <div
        className={clsx(
          'flex min-w-0 flex-1 flex-col gap-2',
          actions.length <= 2
            ? '@lg/pane:flex-row @lg/pane:items-start @lg/pane:gap-3'
            : '@4xl/pane:flex-row @4xl/pane:items-start @4xl/pane:gap-3',
        )}
      >
        <div className="min-w-0 flex-1" data-queue-text="">
          <p className="truncate text-[15px] leading-5 font-semibold text-foreground" title={row.item.title}>
            {row.item.title}
          </p>
          <p className="truncate text-[13px] leading-5 text-muted-foreground">{row.item.company}</p>
          {/* v30 FIX-WEB (REQ-1): the credit its source asks for. */}
          <RowCredit credit={creditOf(row.item)} />
          {/* v30 ST5: the state line is components/queue's (its icon by name, the words, the detail in its tone). */}
          <StateLine icon={line.icon} text={line.text} detail={line.detail} tone={line.tone} />
          {kitText && (
            <p className="mt-1.5 flex flex-wrap items-center gap-1.5" data-kit-line="">
              {onOpenKit && row.kind === 'queue' && row.item.prepareId ? (
                <Chip
                  size="sm"
                  tone="tint"
                  className="max-sm:h-11"
                  icon={<CheckIcon size={12} weight="bold" aria-hidden="true" />}
                  onClick={onOpenKit}
                >
                  <span className="sr-only">Resume: </span>
                  {kitText}
                  <span className="sr-only">. View the kit of {name}</span>
                </Chip>
              ) : (
                <span className="text-xs text-muted-foreground">{kitText}</span>
              )}
            </p>
          )}
        </div>
        {actions.length > 0 && (
          <div className="flex shrink-0 flex-wrap items-center gap-1" data-queue-actions="">
            {primary && <ActionButton action={primary} primary row={row} href={href} busy={busy} onAction={onAction} name={name} />}
            {/* The rest beside it on wider screens; in the ⋯ menu on a phone. */}
            {rest.map((action) => (
              <span key={action} className="max-sm:hidden">
                <ActionButton action={action} row={row} href={href} busy={busy} onAction={onAction} name={name} />
              </span>
            ))}
            {rest.length > 0 && (
              <span className="sm:hidden">
                <Menu>
                  <MenuTrigger
                    render={
                      <IconButton
                        label={`More actions for ${name}`}
                        tooltip="More actions"
                        className="size-11"
                        icon={<DotsThreeIcon size={16} weight="bold" />}
                      />
                    }
                  />
                  <MenuContent width="w-56" align="end">
                    {rest.map((action) =>
                      action === 'open_job' && href ? (
                        <MenuLinkItem
                          key={action}
                          href={href}
                          icon={<ArrowSquareOutIcon size={16} />}
                          render={<a href={href} target="_blank" rel="noopener noreferrer" onClick={() => onAction(action)} />}
                        >
                          {ACTION_LABEL[action]}
                        </MenuLinkItem>
                      ) : action === 'open_tracker' && row.item.applicationId ? (
                        <MenuLinkItem
                          key={action}
                          href={`/tracker?app=${encodeURIComponent(row.item.applicationId)}`}
                          render={<Link href={`/tracker?app=${encodeURIComponent(row.item.applicationId)}`} />}
                        >
                          {ACTION_LABEL[action]}
                        </MenuLinkItem>
                      ) : (
                        <MenuItem key={action} disabled={busy} onClick={() => onAction(action)}>
                          {ACTION_LABEL[action]}
                        </MenuItem>
                      ),
                    )}
                  </MenuContent>
                </Menu>
              </span>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

const PRIMARY_ACTIONS: readonly QueueAction[] = ['try_again', 'open_job', 'prepare'];

function ActionButton({
  action,
  primary = false,
  row,
  href,
  busy,
  onAction,
  name,
}: {
  action: QueueAction;
  primary?: boolean;
  row: QueueRow;
  href: string | null;
  busy: boolean;
  onAction: (action: QueueAction) => void;
  name: string;
}) {
  const variant = primary && PRIMARY_ACTIONS.includes(action) ? 'primary' : action === 'remove' || action === 'dismiss' ? 'ghost' : 'outline';
  const label = `${ACTION_LABEL[action]}: ${name}`;
  const size = 'max-sm:h-11';
  // The row's first action is where focus goes back to when the row's actions change (useRowFocus).
  const marked = primary ? ROW_ACTION : {};
  if (action === 'open_job') {
    if (!href) return null;
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener"
        aria-label={`${ACTION_LABEL[action]} for ${name} (opens in a new tab)`}
        onClick={() => onAction(action)}
        className={buttonClasses({ variant, size: 'sm', className: size })}
        {...marked}
      >
        {ACTION_LABEL[action]}
        <ArrowSquareOutIcon size={12} aria-hidden="true" />
      </a>
    );
  }
  if (action === 'open_tracker') {
    if (!row.item.applicationId) return null;
    return (
      <Link
        href={`/tracker?app=${encodeURIComponent(row.item.applicationId)}`}
        aria-label={label}
        className={buttonClasses({ variant: 'outline', size: 'sm', className: size })}
        {...marked}
      >
        {ACTION_LABEL[action]}
      </Link>
    );
  }
  return (
    <Button
      variant={variant}
      size="sm"
      className={size}
      loading={busy && (action === 'cancel' || action === 'remove' || action === 'try_again' || action === 'prepare')}
      disabled={busy}
      focusableWhenDisabled
      aria-label={label}
      onClick={() => onAction(action)}
      {...marked}
    >
      {ACTION_LABEL[action]}
    </Button>
  );
}
