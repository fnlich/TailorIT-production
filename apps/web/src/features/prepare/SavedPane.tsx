'use client';

import { SAVED_JOB_FILTERS, type SavedJobFilter, type SavedJobItem } from '@tailorit/shared/prepare';
import { ListChecksIcon } from '@phosphor-icons/react/ListChecks';
import { useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import Link from 'next/link';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconButton } from '@/components/ui/IconButton';
import { Menu, MenuContent, MenuItem, MenuLinkItem, MenuSeparator, MenuTrigger } from '@/components/ui/Menu';
import { Popover, PopoverClose, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/Popover';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Skeleton } from '@/components/ui/Skeleton';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import {
  ArchiveIcon,
  ArrowSquareOutIcon,
  BookmarkSimpleIcon,
  CheckIcon,
  DotsThreeIcon,
  FunnelIcon,
  KanbanIcon,
  SparkleIcon,
  WarningCircleIcon,
  XCircleIcon,
} from '@/components/ui/icons';
import { userMessage } from '@/lib/api';
import { usePublicConstants } from '@/lib/constants';
import { focusSoon } from '@/lib/focusLater';
import { VerificationBadge } from '@/features/jobs/verification/VerificationBadge'; // v31 INT-2 (v30 INT-3's HeldBadge inside)
import { ClosedBadge, isClosed } from '@/features/jobs/closed/ClosedBadge'; // v30 FIX-WEB (UX-10)
import { RowCredit } from '@/features/jobs/credits/JobCredit'; // v30 FIX-WEB (REQ-1)
import { creditOf } from '@/features/jobs/credits/credit';
import { autoApplyKeys } from '../auto-apply/api';
import {
  LIVE_THROTTLE_MS,
  SAVED_FILTER_EMPTY,
  orderSaved,
  savedAction,
  savedFilterLabel,
  savedMarker,
  savedSummary,
  selectableSaved,
  type MarkerIcon,
  type MarkerView,
} from '../auto-apply/copy';
import type { useSavedJobs } from '../auto-apply/data';
import { Pane, ROW_ACTION, SelectBar, useReducedMotion, useRowFocus, useThrottled } from '../../components/queue';
import { CountIconButton } from '../../components/ui/CountIconButton';
import { PaneLoadFailed, PaneOutOfDate } from '../../components/queue/PaneStates';
import { SupportIcon } from '../auto-apply/Pane';
import { CompanyLogo } from '../tracker/CompanyLogo';
import { invalidateApplications, trackerApi } from '../tracker/data';
import { cancelPrepare } from './api';
import { CHANGE_FILTERS, FILTERS_LABEL, filtersButtonName, PREPARE_ALL_LABEL, PREPARE_LABEL } from './copy';
import { PrepareButton } from './PrepareButton';
import { tabCan, useTabProfile } from '../sharing/access'; // v33 FIX-1
import type { PrepareAndQueue } from './usePrepareAndQueue';

// v2.0: the Saved Jobs pane, the left of the Auto-apply page (docs/design/v2.0/08-ui.md, "The Saved pane"), which
// replaces v1.5's Prepare card (PrepareSection). The person's Tracker entries at Saved with a job, newest first, each
// with its support icon, its marker (Draft, Preparing, Filtered: <reason>, Preparation failed, Not applied, Prepared)
// and its one action (Prepare & Queue, Cancel, View in queue); All | To prepare | Filtered | Draft; Filters (the count
// of filters on, to Settings › Prepare & Queue); Select, for Prepare & Queue on several at once.
// v31 AUTO: the toolbar is [Filters · n on] [Select] [Prepare All]: Filters opens the filters dialog on this page (as
// "Change filters" in a filtered row's popover does), Prepare All prepares every saved job in To prepare that passes
// the filters (the server chooses them; usePrepareAndQueue's confirm says how many). In select mode the select bar
// holds the pane's action, so Select and Prepare All step aside. A row's Prepare & Queue is an outline button: the
// pane's one primary action is Prepare All (or the select bar's).
// v32 LAYOUT (E10): Filters and Select are their icons alone (named "Filters, 2 on" and "Select", with tooltips; the
// count of filters on is a small badge), so the toolbar sits on the line of All | To prepare | Filtered | Draft where the
// pane has the room; Prepare All keeps its words. E4: a list that could not be read is the pane's own state, and one
// that could not be refreshed a small "Out of date" mark beside the pane's title, not a banner.

const MARKER_ICON: Record<MarkerIcon, ReactNode> = {
  check: <CheckIcon size={12} weight="bold" aria-hidden="true" />,
  spinner: <Spinner size={12} />,
  funnel: <FunnelIcon size={12} aria-hidden="true" />,
  x: <XCircleIcon size={12} aria-hidden="true" />,
  warning: <WarningCircleIcon size={12} aria-hidden="true" />,
  sparkle: <SparkleIcon size={12} aria-hidden="true" />,
};

/** How long a row that left the list (applied, unsaved) takes to fade out. */
const LEAVE_MS = 200;

const nameOf = (item: SavedJobItem) => `${item.title} at ${item.company}`;

/** The select mode's bar (its name) and the Select button, for focus to move between them. */
const SELECT_BAR_NAME = 'Prepare & Queue the selected jobs';
const SELECT_BAR = `[role="toolbar"][aria-label="${SELECT_BAR_NAME}"]`;
const SELECT_BUTTON = '[data-saved-select]';

export interface SavedPaneProps {
  filter: SavedJobFilter;
  onFilterChange: (filter: SavedJobFilter) => void;
  saved: ReturnType<typeof useSavedJobs>;
  prepare: PrepareAndQueue;
  /** Wide screens: the list scrolls inside the pane. */
  scroll: boolean;
  /** How many prepare filters are on (null: unknown). */
  filtersOn: number | null;
  /** View in queue: the Queue pane scrolls to the row and flashes it. */
  onViewInQueue: (item: SavedJobItem) => void;
}

export function SavedPane({ filter, onFilterChange, saved, prepare, scroll, filtersOn, onViewInQueue }: SavedPaneProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { t } = usePublicConstants();
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // v33 FIX-1 (PLAN-sharing §9): on a profile shared without Prepare & queue's Change, no Select, Prepare All, a row's
  // Prepare & Queue or Cancel (each was refused); without the Job Tracker's Change, no Remove from Saved Jobs.
  const tab = useTabProfile();
  const canPrepare = tabCan(tab, 'prepare:run');
  const canRemove = tabCan(tab, 'tracker:edit');
  const [removing, setRemoving] = useState<SavedJobItem | null>(null);
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(new Set());
  const items = saved.items ? orderSaved(saved.items, filter) : null;
  const shown = useLeaving(items, filter, Boolean(saved.isPlaceholderData));
  const choosable = (items ?? []).filter(selectableSaved);
  const chosen = choosable.filter((item) => selected.has(item.applicationId));
  // One polite summary, at most every 10 s, never a row at a time.
  const live = useThrottled(items ? savedSummary(items) : '', LIVE_THROTTLE_MS);

  const namesOf = (list: readonly SavedJobItem[]) =>
    new Map(list.map((item) => [item.applicationId, { title: item.title, company: item.company }] as const));

  // v31 FIX-WEB (REV-UX UX-3): Select and the select bar take each other's place, so focus moves with them: into the bar
  // (its select-all box) when select mode starts, back to Select when it ends from inside the bar (Cancel, or the bar's
  // Prepare & Queue once it is done), never to the page's start.
  const startSelection = () => {
    setSelectMode(true);
    focusSoon([`${SELECT_BAR} [role="checkbox"]`, `${SELECT_BAR} button`]);
  };

  const endSelection = () => {
    const active = document.activeElement;
    const fromBar = !active || active === document.body || Boolean(active.closest(SELECT_BAR));
    setSelectMode(false);
    setSelected(new Set());
    if (fromBar) focusSoon([SELECT_BUTTON, '[data-saved-toolbar] [data-filters-button]']);
  };

  const prepareOne = (item: SavedJobItem) =>
    prepare.prepare({ applicationIds: [item.applicationId], names: namesOf([item]) });

  const prepareChosen = () =>
    prepare.prepare({
      applicationIds: chosen.map((item) => item.applicationId),
      names: namesOf(chosen),
      onDone: endSelection,
    });

  const cancel = async (item: SavedJobItem) => {
    if (!item.prepareId || cancelling.has(item.applicationId)) return;
    setCancelling((current) => new Set(current).add(item.applicationId));
    try {
      await cancelPrepare(item.prepareId);
      toast.success('Preparation cancelled', nameOf(item));
    } catch (error) {
      toast.error('It could not be cancelled', userMessage(error, 'Please try again.'));
    } finally {
      setCancelling((current) => {
        const next = new Set(current);
        next.delete(item.applicationId);
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: autoApplyKeys.all });
    }
  };

  // Nothing in the list shown could be prepared (and no more to load): Prepare All has nothing to take either. Another
  // tab (Draft) may hide what To prepare holds, so it asks the server there.
  const nothingToPrepare =
    (filter === 'all' || filter === 'ready') && items !== null && choosable.length === 0 && !saved.hasNextPage;

  const controls = (
    <div className="flex flex-wrap items-center gap-2" data-saved-toolbar="">
      <SegmentedControl
        aria-label="Show saved jobs"
        listClassName="max-sm:h-11 max-sm:*:min-w-11"
        value={filter}
        onValueChange={(next) => {
          onFilterChange(next);
          setSelected(new Set());
        }}
        items={SAVED_JOB_FILTERS.map((value) => ({ value, label: savedFilterLabel(value, t) }))}
      />
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {/* v31 FIX-WEB (REV-UX UX-12): it opens a dialog, not a list (its funnel, no caret). */}
        <CountIconButton
          label={filtersButtonName(filtersOn)}
          tooltip={FILTERS_LABEL}
          icon={<FunnelIcon size={18} aria-hidden="true" />}
          count={filtersOn}
          aria-haspopup="dialog"
          onClick={prepare.openFilters}
          data-filters-button=""
        />
        {!selectMode && canPrepare && (
          <>
            <IconButton
              label="Select"
              tooltip="Select jobs"
              variant="outline"
              className="max-sm:size-11"
              icon={<ListChecksIcon size={18} aria-hidden="true" />}
              disabled={choosable.length === 0}
              onClick={startSelection}
              data-saved-select=""
            />
            <Button
              className="max-sm:h-11"
              loading={prepare.allPending}
              disabled={nothingToPrepare}
              focusableWhenDisabled
              onClick={() => prepare.prepareAll({ names: namesOf(items ?? []) })}
              data-prepare-all=""
            >
              {PREPARE_ALL_LABEL}
            </Button>
          </>
        )}
      </div>
    </div>
  );

  // v30 ST5: the select mode's bar is components/queue's SelectBar (same toolbar, select-all box and polite count).
  const footer = selectMode ? (
    <SelectBar
      aria-label={SELECT_BAR_NAME}
      selected={chosen.length}
      selectable={choosable.length}
      selectAllLabel="Select every saved job shown that can be prepared"
      onSelectAll={(on) => setSelected(on ? new Set(choosable.map((item) => item.applicationId)) : new Set())}
    >
      <PrepareButton
        count={chosen.length}
        disabled={chosen.length === 0}
        loading={chosen.some((item) => prepare.pending.has(item.applicationId))}
        onClick={prepareChosen}
        className="max-sm:h-11 max-sm:flex-1"
      />
      <Button variant="outline" size="sm" className="max-sm:h-11" onClick={endSelection}>
        Cancel
      </Button>
    </SelectBar>
  ) : undefined;

  let body: ReactNode;
  if (saved.isError && !saved.data) {
    body = <PaneLoadFailed title="Your saved jobs didn't load." message={userMessage(saved.error)} onRetry={() => void saved.refetch()} />;
  } else if (shown === null) {
    body = (
      <ul aria-busy="true" aria-label="Loading your saved jobs" className="divide-y divide-divider-soft">
        {Array.from({ length: 6 }, (_unused, index) => (
          <SkeletonRow key={index} />
        ))}
      </ul>
    );
  } else if (shown.length === 0) {
    body =
      filter === 'all' ? (
        <EmptyState
          icon={<BookmarkSimpleIcon size={22} />}
          title="No saved jobs yet"
          description="Save jobs from Jobs, or with the extension's Add job."
          action={
            <Link href="/jobs" className={buttonClasses({ variant: 'primary' })}>
              Find jobs
            </Link>
          }
        />
      ) : (
        <EmptyState
          size="sm"
          title={SAVED_FILTER_EMPTY[filter]}
          action={
            <Button variant="outline" size="sm" onClick={() => onFilterChange('all')}>
              Show all saved jobs
            </Button>
          }
        />
      );
  } else {
    body = (
      <>
        <ul aria-label="Saved jobs" aria-busy={saved.isFetching && saved.isPlaceholderData ? true : undefined} className="divide-y divide-divider-soft">
          {shown.map(({ item, leaving }) => (
            <SavedRow
              key={item.applicationId}
              onChangeFilters={prepare.openFilters}
              item={item}
              leaving={leaving}
              marker={savedMarker(item, t)}
              selectMode={selectMode}
              canPrepare={canPrepare}
              canRemove={canRemove}
              checked={selected.has(item.applicationId)}
              onChecked={(on) =>
                setSelected((current) => {
                  const next = new Set(current);
                  if (on) next.add(item.applicationId);
                  else next.delete(item.applicationId);
                  return next;
                })
              }
              pending={prepare.pending.has(item.applicationId)}
              cancelling={cancelling.has(item.applicationId)}
              onPrepare={() => prepareOne(item)}
              onCancel={() => void cancel(item)}
              onViewInQueue={() => onViewInQueue(item)}
              onRemove={() => setRemoving(item)}
            />
          ))}
        </ul>
        {saved.hasNextPage && (
          <div className="flex justify-center p-3">
            <Button variant="ghost" size="sm" loading={saved.isFetchingNextPage} onClick={() => void saved.fetchNextPage()}>
              Load more saved jobs
            </Button>
          </div>
        )}
      </>
    );
  }

  const count = items === null ? null : items.length;
  return (
    <>
      <Pane
        id="saved-pane-title"
        title="Saved jobs"
        count={count === null ? null : count}
        controls={controls}
        status={saved.isError && saved.data ? <PaneOutOfDate onRetry={() => void saved.refetch()} /> : undefined}
        scroll={scroll}
        footer={footer}
      >
        {body}
        <p className="sr-only" role="status" aria-live="polite" data-saved-live="">
          {live}
        </p>
      </Pane>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        tone="primary"
        title="Remove from Saved Jobs?"
        description={removing ? `${nameOf(removing)} is archived in your Job Tracker, notes and all. You can restore it there.` : undefined}
        confirmLabel="Remove"
        busyLabel="Removing..."
        onConfirm={async () => {
          if (!removing) return;
          await trackerApi.archive(removing.applicationId);
          toast.success('Removed from Saved Jobs', nameOf(removing));
          void queryClient.invalidateQueries({ queryKey: autoApplyKeys.all });
          void invalidateApplications(queryClient);
        }}
      />
    </>
  );
}

/** The list with the rows that just left it kept a moment, fading out (none with reduced motion). */
function useLeaving(
  items: readonly SavedJobItem[] | null,
  filter: SavedJobFilter,
  /** The rows shown are another tab's while this one loads. */
  placeholder: boolean,
): Array<{ item: SavedJobItem; leaving: boolean }> | null {
  const reduced = useReducedMotion();
  const previous = useRef<readonly SavedJobItem[] | null>(null);
  // Another tab's rows are not leaving: they were never in this one.
  const previousFilter = useRef(filter);
  const [leaving, setLeaving] = useState<SavedJobItem[]>([]);
  useEffect(() => {
    const before = previous.current;
    const sameTab = previousFilter.current === filter;
    previous.current = placeholder ? null : items;
    previousFilter.current = filter;
    if (!before || !items || reduced || !sameTab || placeholder) return;
    const now = new Set(items.map((item) => item.applicationId));
    const gone = before.filter((item) => !now.has(item.applicationId));
    if (gone.length === 0) return;
    // A row the server no longer lists (applied, unsaved, another tab) fades, then goes.
    const show = window.setTimeout(() => setLeaving((current) => [...current, ...gone]), 0);
    // v2.0 INT: only the fade's start is called off when the list changes again; its end always runs. A read that came
    // back within LEAVE_MS (a poll, an invalidation) used to clear both, and the row that left stayed, hidden, for good.
    window.setTimeout(
      () => setLeaving((current) => current.filter((item) => !gone.some((left) => left.applicationId === item.applicationId))),
      LEAVE_MS,
    );
    return () => window.clearTimeout(show);
  }, [items, reduced, filter, placeholder]);
  if (items === null) return null;
  const present = new Set(items.map((item) => item.applicationId));
  return [
    ...items.map((item) => ({ item, leaving: false })),
    ...leaving.filter((item) => !present.has(item.applicationId)).map((item) => ({ item, leaving: true })),
  ];
}

function SkeletonRow() {
  return (
    <li aria-hidden="true" className="flex min-h-16 items-center gap-3 px-4 py-3 sm:px-5">
      <Skeleton className="size-8" rounded="control" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Skeleton className="h-3.5 w-3/5" />
        <Skeleton className="h-3 w-2/5" />
      </div>
      <Skeleton className="h-5.5 w-16" />
    </li>
  );
}

function MarkerBadge({ item, marker, onChangeFilters }: { item: SavedJobItem; marker: MarkerView; onChangeFilters: () => void }) {
  const filtered = item.marker === 'filtered';
  const badge = (
    // A filter's reason is read in full (v2.0 fix UX-1): it wraps rather than being cut.
    <Badge tone={marker.tone} icon={MARKER_ICON[marker.icon]} wrap={filtered} data-marker={item.marker}>
      {marker.label}
    </Badge>
  );
  if (!filtered) return badge;
  // Every failing filter, and the way to change them: a popover (a tooltip cannot hold a link).
  const reasons = item.reasons && item.reasons.length > 0 ? item.reasons : null;
  return (
    <Popover>
      <PopoverTrigger
        render={
          // v2.0 fix UX-6: a hit area of at least 24 px (44 px on a phone) around the 22 px badge.
          <button
            type="button"
            className="inline-flex min-h-6 max-w-full items-center rounded-tag outline-offset-2 max-sm:min-h-11"
            aria-label={`${marker.label}: why it was filtered`}
          />
        }
      >
        {badge}
      </PopoverTrigger>
      <PopoverContent className="w-72" aria-label={`Why ${item.title} was filtered`}>
        <PopoverTitle>Filtered out by your prepare filters</PopoverTitle>
        {reasons ? (
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-[13px] leading-5 text-foreground">
            {reasons.map((reason) => (
              <li key={reason.code}>{reason.label}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-[13px] leading-5 text-foreground">{marker.label}</p>
        )}
        <p className="mt-2 text-[13px] leading-5 text-muted-foreground">
          Prepare &amp; Queue checks the filters again, so a changed filter can let it through.
        </p>
        {/* v31 AUTO: the filters dialog, on this page (the popover closes first). */}
        <PopoverClose render={<Button variant="link" className="mt-3 h-auto px-0" onClick={onChangeFilters} />}>{CHANGE_FILTERS}</PopoverClose>
      </PopoverContent>
    </Popover>
  );
}

function SavedRow({
  item,
  onChangeFilters,
  leaving,
  marker,
  selectMode,
  canPrepare,
  canRemove,
  checked,
  onChecked,
  pending,
  cancelling,
  onPrepare,
  onCancel,
  onViewInQueue,
  onRemove,
}: {
  item: SavedJobItem;
  /** "Change filters" in a filtered row's popover: the filters dialog. */
  onChangeFilters: () => void;
  leaving: boolean;
  marker: MarkerView | null;
  selectMode: boolean;
  /** v33 FIX-1: Prepare & Queue and Cancel are offered (Prepare & queue's Change on a shared profile). */
  canPrepare: boolean;
  /** v33 FIX-1: Remove from Saved Jobs is offered (the Job Tracker's Change on a shared profile). */
  canRemove: boolean;
  checked: boolean;
  onChecked: (on: boolean) => void;
  pending: boolean;
  cancelling: boolean;
  onPrepare: () => void;
  onCancel: () => void;
  onViewInQueue: () => void;
  onRemove: () => void;
}) {
  const action = savedAction(item);
  const name = nameOf(item);
  const supportId = useId();
  const closedId = useId();
  // v30 FIX-WEB (REV-UX UX-10): a job that closed says so, and Prepare & Queue is off for it (named why).
  const closed = isClosed(item);
  const [rowRef, rowFocus] = useRowFocus<HTMLLIElement>(`${action}:${selectMode}`);
  return (
    // v2.0 fix (UX-1): the row lays out by the pane's width. Below 42rem of pane (two panes side by side, and phones)
    // it stacks: the title on its own line at the row's full width, the company, then the support icon and the marker
    // with the actions beside them (wrapping under when the marker is long). From 42rem, one line: the title (at least
    // 10rem), the markers, the actions.
    <li
      ref={rowRef}
      {...rowFocus}
      data-saved-row={item.applicationId}
      aria-hidden={leaving || undefined}
      className={clsx(
        'flex min-h-16 items-start gap-3 px-4 py-3 transition-[opacity,background-color] duration-200 @lg/pane:px-5 @2xl/pane:items-center',
        selectMode && checked ? 'bg-primary-soft' : 'hover:bg-surface-low',
        leaving && 'pointer-events-none opacity-0',
      )}
    >
      {selectMode && (
        <span className="flex pt-1.5 @2xl/pane:pt-0">
          {selectableSaved(item) ? (
            <Checkbox checked={checked} onCheckedChange={onChecked} aria-label={`Select ${name}`} />
          ) : (
            <Checkbox checked={false} disabled onCheckedChange={() => undefined} aria-label={`${name}: ${closed ? 'closed' : (marker?.label ?? 'not now')}`} />
          )}
        </span>
      )}
      <CompanyLogo name={item.company} logoUrl={item.logoUrl} size={32} className="mt-0.5 @2xl/pane:mt-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 @2xl/pane:flex-row @2xl/pane:items-center @2xl/pane:gap-3">
        <div className="min-w-0 @2xl/pane:min-w-40 @2xl/pane:flex-1" data-saved-text="">
          <p className="truncate text-[15px] leading-5 font-semibold text-foreground" title={item.title}>
            {item.title}
          </p>
          <p className="truncate text-[13px] leading-5 text-muted-foreground">
            {item.company}
            {item.location && <span className="lg:max-xl:hidden"> · {item.location}</span>}
          </p>
          {/* v30 FIX-WEB (REQ-1): the credit its source asks for. */}
          <RowCredit credit={creditOf(item)} />
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2" data-saved-markers="">
            <SupportIcon support={item.support} id={supportId} />
            {marker && <MarkerBadge item={item} marker={marker} onChangeFilters={onChangeFilters} />}
            <VerificationBadge held={item.held} verification={item.verification} />
            <ClosedBadge closed={closed} sentenceId={closedId} />
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {action === 'prepare' && !selectMode && canPrepare && (
              <PrepareButton
                variant="outline"
                loading={pending}
                disabled={closed}
                onClick={onPrepare}
                aria-label={`${PREPARE_LABEL} ${name}`}
                aria-describedby={closed ? `${supportId} ${closedId}` : supportId}
                className="max-sm:h-11"
                {...ROW_ACTION}
              />
            )}
            {action === 'cancel' && canPrepare && (
              <Button
                variant="ghost"
                size="sm"
                className="max-sm:h-11"
                loading={cancelling}
                onClick={onCancel}
                aria-label={`Cancel preparing ${name}`}
                aria-describedby={supportId}
                {...ROW_ACTION}
              >
                Cancel
              </Button>
            )}
            {action === 'view_in_queue' && (
              <Button
                variant="link"
                size="sm"
                className="max-sm:h-11"
                onClick={onViewInQueue}
                aria-label={`View ${name} in the queue`}
                aria-describedby={supportId}
                {...ROW_ACTION}
              >
                View in queue
              </Button>
            )}
            <Menu>
              <MenuTrigger
                render={
                  <IconButton
                    label={`More actions for ${name}`}
                    tooltip="More actions"
                    size="sm"
                    className="max-sm:size-11"
                    icon={<DotsThreeIcon size={16} weight="bold" />}
                  />
                }
              />
              <MenuContent width="w-60" align="end">
                <MenuLinkItem
                  href={`/jobs?jobId=${item.jobId}`}
                  icon={<ArrowSquareOutIcon size={16} />}
                  render={<Link href={`/jobs?jobId=${item.jobId}`} />}
                >
                  Open job posting
                </MenuLinkItem>
                <MenuLinkItem
                  href={`/tracker?app=${encodeURIComponent(item.applicationId)}`}
                  icon={<KanbanIcon size={16} />}
                  render={<Link href={`/tracker?app=${encodeURIComponent(item.applicationId)}`} />}
                >
                  Open in Job Tracker
                </MenuLinkItem>
                {canRemove && (
                  <>
                    <MenuSeparator />
                    <MenuItem icon={<ArchiveIcon size={16} />} onClick={onRemove}>
                      Remove from Saved Jobs
                    </MenuItem>
                  </>
                )}
              </MenuContent>
            </Menu>
          </div>
        </div>
      </div>
    </li>
  );
}
