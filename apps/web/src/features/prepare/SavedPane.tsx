'use client';

import { SAVED_JOB_FILTERS, type SavedJobFilter, type SavedJobItem } from '@tailorit/shared/prepare';
import { ShareNetworkIcon } from '@phosphor-icons/react/ShareNetwork';
import type { FanoutTargets, ProfileChoice } from '@tailorit/shared/sharing';
import { useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import Link from 'next/link';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconButton } from '@/components/ui/IconButton';
import { Menu, MenuContent, MenuItem, MenuLinkItem, MenuSeparator, MenuSub, MenuSubContent, MenuTrigger } from '@/components/ui/Menu';
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
import { Pane, ROW_ACTION, SelectBar, SelectToggle, useReducedMotion, useRowFocus, useThrottled } from '../../components/queue';
import { CountIconButton } from '../../components/ui/CountIconButton';
import { PaneLoadFailed, PaneOutOfDate } from '../../components/queue/PaneStates';
import { SupportIcon } from '../auto-apply/Pane';
import { CompanyLogo } from '../tracker/CompanyLogo';
import { invalidateApplications, trackerApi } from '../tracker/data';
import { cancelPrepare } from './api';
import {
  CHANGE_FILTERS,
  FILTERS_LABEL,
  filtersButtonName,
  PREPARE_ALL_LABEL,
  PREPARE_ALL_MENU,
  PREPARE_LABEL,
  prepareLabel,
  removedReport,
  SAVED_SELECT,
  SAVED_SELECT_MAX,
} from './copy';
import { PrepareButton } from './PrepareButton';
import { tabCan, useTabProfile } from '../sharing/access'; // v33 FIX-1
import type { PrepareAndQueue } from './usePrepareAndQueue';
// v36 APPLYWEB (PLAN A2-A5): Prepare All ▾, Share All ▾, the Select bar's Remove, Share ▾ and Prepare ▾, a row's Share to ›.
import { FANOUT_COPY, QUEUE_COPY, archiveOneOutcome, inQueueNote } from '../sharing/fanout/copy';
import { ProfilesDialog } from '../sharing/fanout/parts';
import { menuProfiles, ProfileMenuItems, profileRowOf, ProfileSplitButton } from '../sharing/fanout/ProfileSplitButton';
import { useShareSaved, type ShareSaved } from '../sharing/fanout/share';
import { boxName, type FanoutProfile } from '../sharing/fanout/targets';
import { useFanoutChoices, useSavedOn, type SavedOnJob } from '../sharing/fanout/useFanout';
import { usePrepareAllProfiles } from '../sharing/usePrepareAllProfiles';
import { usePrepareOnProfiles, type PrepareOnJob } from './prepareOn';
// v36 FIX-WEB (D1): a Remove's question and result say what it does to the auto-apply queue.
import { useQueueWords, type QueueWords } from '../sharing/fanout/useQueueWords';

// v2.0: the Saved Jobs pane, the left of the Auto-apply page (docs/design/v2.0/08-ui.md, "The Saved pane"), which
// replaces v1.5's Prepare card (PrepareSection). The person's Tracker entries at Saved with a job, newest first, each
// with its support icon, its marker (Draft, Preparing, Filtered: <reason>, Preparation failed, Not applied, Prepared)
// and its one action (Prepare, Cancel, View in queue); All | To prepare | Filtered | Draft; Filters (the count
// of filters on, to Settings › Prepare); Select, for Prepare on several at once.
// v31 AUTO: the toolbar is [Filters · n on] [Select] [Prepare All]: Filters opens the filters dialog on this page (as
// "Change filters" in a filtered row's popover does), Prepare All prepares every saved job in To prepare that passes
// the filters (the server chooses them; usePrepareAndQueue's confirm says how many). In select mode the select bar
// holds the pane's action, so Select and Prepare All step aside. A row's Prepare is an outline button: the
// pane's one primary action is Prepare All (or the select bar's).
// v32 LAYOUT (E10): Filters and Select are their icons alone (named "Filters, 2 on" and "Select", with tooltips; the
// count of filters on is a small badge), so the toolbar sits on the line of All | To prepare | Filtered | Draft where the
// pane has the room; Prepare All keeps its words. E4: a list that could not be read is the pane's own state, and one
// that could not be refreshed a small "Out of date" mark beside the pane's title, not a banner.
// v36 APPLYWEB (PLAN A1-A8; SP v36 REQUEST.md, the Auto-Apply page): the pane fills the page's frame from 1024 px
// (`fill`). The toolbar is [tabs] [Filters] [Select] then [Share All ▾] [Prepare All ▾], wrapping to a second line where
// the pane is too narrow for one (A7). Prepare All ▾ (A2): the main part prepares the tab's profile as before; its caret
// (with a shared profile) prepares the profiles picked, each its own saved jobs ("Prepare all profiles"' engine).
// Share All ▾ (A3): every job in Saved on the tab's profile shared to the profiles picked (its preview, one confirm,
// Undo). Select (A4, JOBS' icon SelectToggle) lets any saved row be chosen; its bar: Select All / Deselect All (every
// saved job in the tab, the remaining pages read first, up to 500), "N selected", Remove (Undo), Share ▾, Prepare ▾ (the
// preparable rows here; on another profile the jobs missing there are saved first), Cancel. A row's ⋯ menu gains "Share
// to ›" (A5). The action is named "Prepare" (A6). Clear finished, Approve all, the robot mark and a row's Prepare are
// as they were (A8).

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
const SELECT_BAR_NAME = SAVED_SELECT.bar;
const SELECT_BAR = `[role="toolbar"][aria-label="${SELECT_BAR_NAME}"]`;
const SELECT_BUTTON = '[data-saved-select]';

export interface SavedPaneProps {
  filter: SavedJobFilter;
  onFilterChange: (filter: SavedJobFilter) => void;
  saved: ReturnType<typeof useSavedJobs>;
  prepare: PrepareAndQueue;
  /** Wide screens: the list scrolls inside the pane. */
  scroll: boolean;
  /** v36 APPLYWEB (PLAN A1): the pane fills the page's measured frame (Pane's `fill`). */
  fill?: boolean;
  /** How many prepare filters are on (null: unknown). */
  filtersOn: number | null;
  /** View in queue: the Queue pane scrolls to the row and flashes it. */
  onViewInQueue: (item: SavedJobItem) => void;
}

export function SavedPane({ filter, onFilterChange, saved, prepare, scroll, fill = false, filtersOn, onViewInQueue }: SavedPaneProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { t, get } = usePublicConstants();
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // v36 APPLYWEB (PLAN A4): Select All reads the tab's remaining pages first.
  const [loadingAll, setLoadingAll] = useState(false);
  // v33 FIX-1 (PLAN-sharing §9): on a profile shared without Prepare's Change, no Prepare All, a row's Prepare or Cancel
  // (each was refused); without the Job Tracker's Change, no Remove from Saved Jobs.
  const tab = useTabProfile();
  const canPrepare = tabCan(tab, 'prepare:run');
  const canRemove = tabCan(tab, 'tracker:edit');
  const [removing, setRemoving] = useState<SavedJobItem | null>(null);
  const [removingChosen, setRemovingChosen] = useState(false);
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(new Set());
  const items = saved.items ? orderSaved(saved.items, filter) : null;
  const shown = useLeaving(items, filter, Boolean(saved.isPlaceholderData));
  // v36 APPLYWEB (PLAN A4): every saved row can be chosen; Prepare takes the preparable ones among them.
  const chosen = (items ?? []).filter((item) => selected.has(item.applicationId));
  const preparable = chosen.filter(selectableSaved);
  const allChosen =
    items !== null &&
    chosen.length > 0 &&
    chosen.length >= Math.min(items.length, SAVED_SELECT_MAX) &&
    (!saved.hasNextPage || chosen.length >= SAVED_SELECT_MAX);
  // One polite summary, at most every 10 s, never a row at a time.
  const live = useThrottled(items ? savedSummary(items) : '', LIVE_THROTTLE_MS);

  // v36 APPLYWEB (PLAN A2-A5): sharing from this profile, Prepare on other profiles, Prepare All on the profiles picked.
  const share = useShareSaved();
  const prepareOn = usePrepareOnProfiles();
  const prepareChoices = useFanoutChoices(['prepare:run']);
  const prepareAllRef = useMemo<RefObject<HTMLButtonElement | null>>(() => lazyRef('[data-saved-toolbar] [data-prepare-all]'), []);
  const allProfiles = usePrepareAllProfiles(prepareAllRef, { overview: false });
  const [choosingPrepareAll, setChoosingPrepareAll] = useState(false);
  const [choosingPrepare, setChoosingPrepare] = useState(false);
  const canShare = share.available && share.blocked === null;
  const canPrepareAny = canPrepare || prepareOn.othersOn;
  // A4: Select shows when Remove, Share or Prepare is possible here.
  const canSelect = canRemove || canShare || canPrepareAny;
  const jobIds = useMemo(() => (share.available ? (items ?? []).map((item) => item.jobId) : []), [share.available, items]);
  const savedOn = useSavedOn(jobIds);

  const namesOf = (list: readonly SavedJobItem[]) =>
    new Map(list.map((item) => [item.applicationId, { title: item.title, company: item.company }] as const));

  // v31 FIX-WEB (REV-UX UX-3): Select and the select bar take each other's place, so focus moves with them: into the bar
  // (its Select All) when select mode starts, back to Select when it ends from inside the bar (Cancel, or the bar's
  // action once it is done), never to the page's start.
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

  /** After a dialog the bar opened: Select (the bar is gone), else the bar's first button. */
  const barFocus = () =>
    document.querySelector<HTMLElement>(SELECT_BUTTON) ?? document.querySelector<HTMLElement>(`${SELECT_BAR} button`) ?? true;

  /** v36 APPLYWEB (PLAN A4): Select All: the tab's remaining pages read first, then every saved job in it (up to 500). */
  const selectEvery = async () => {
    if (!items) return;
    let list: readonly SavedJobItem[] = items;
    let more = Boolean(saved.hasNextPage);
    if (more && list.length < SAVED_SELECT_MAX) {
      setLoadingAll(true);
      try {
        while (more && list.length < SAVED_SELECT_MAX) {
          const next = await saved.fetchNextPage();
          if (next.isError || !next.data) break;
          list = orderSaved(
            next.data.pages.flatMap((page) => page.items),
            filter,
          );
          more = Boolean(next.hasNextPage);
        }
      } catch {
        // What was read is selected.
      } finally {
        setLoadingAll(false);
      }
    }
    setSelected(new Set(list.slice(0, SAVED_SELECT_MAX).map((item) => item.applicationId)));
  };

  const prepareOne = (item: SavedJobItem) =>
    prepare.prepare({ applicationIds: [item.applicationId], names: namesOf([item]) });

  /** v36 APPLYWEB (PLAN A4): the bar's Prepare on this profile: the preparable rows (at most PREPARE_BATCH_MAX). */
  const prepareChosen = () => {
    if (preparable.length === 0) {
      toast.info(SAVED_SELECT.nothingTitle, SAVED_SELECT.nothingLine);
      return;
    }
    const max = get('PREPARE_BATCH_MAX');
    const taking = preparable.slice(0, max);
    const skipped = chosen.length - preparable.length;
    const over = preparable.length - taking.length;
    const note = [skipped > 0 ? SAVED_SELECT.skipped(skipped) : null, over > 0 ? SAVED_SELECT.overBatch(over, max) : null].filter(Boolean).join(' ');
    prepare.prepare({
      applicationIds: taking.map((item) => item.applicationId),
      names: namesOf(taking),
      onDone: endSelection,
      ...(note ? { note } : {}),
    });
  };

  /** The bar's Prepare ▾: this profile alone is the main part's; other profiles save what they lack, then prepare. */
  const prepareOnPicked = (targets: FanoutTargets) => {
    const list = prepareOn.listOf(targets);
    if (list.length === 1 && list[0] === share.source) {
      prepareChosen();
      return;
    }
    const jobs: PrepareOnJob[] = chosen.map((item) => ({
      applicationId: item.applicationId,
      jobId: item.jobId,
      preparable: selectableSaved(item),
      closed: isClosed(item),
    }));
    prepareOn.start(list, jobs, endSelection);
  };

  /** The bar's Share: the only target at once, else Choose profiles…. */
  const shareChosen = (targets?: FanoutTargets) => {
    const ids = chosen.map((item) => item.applicationId);
    const only = onlyTarget(share);
    if (targets) void share.share(ids, targets, endSelection);
    else if (only) void share.share(ids, [only], endSelection);
    else share.chooseFor(ids, { onDone: endSelection, finalFocus: barFocus });
  };

  /** Prepare All ▾: the tab's profile alone is today's Prepare All; other profiles, "Prepare all profiles" over them. */
  const prepareAllOn = (targets: FanoutTargets) => {
    const list =
      targets === 'all' ? prepareChoices.profiles.filter((profile) => profile.allowed).map((profile) => profile.choice) : [...targets];
    if (list.length === 1 && list[0] === prepareChoices.tab) {
      prepare.prepareAll({ names: namesOf(items ?? []) });
      return;
    }
    allProfiles.startOn(
      prepareChoices.profiles.filter((profile) => list.includes(profile.choice)).map((profile) => ({ profile: profile.choice, name: profile.label })),
    );
  };

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

  const refreshSaved = () => {
    void queryClient.invalidateQueries({ queryKey: autoApplyKeys.all });
    void invalidateApplications(queryClient);
  };

  /**
   * v36 APPLYWEB (PLAN A4): Remove's Undo: the entries it archived, back at Saved. v36 FIX-WEB (D1): never their place in
   * the queue (`dequeued`: the jobs the Remove took out of it, to prepare again).
   */
  const restore = async (ids: readonly string[], dequeued = 0) => {
    try {
      const { affected } = await trackerApi.bulk({ ids: [...ids], action: 'unarchive' });
      toast.success(SAVED_SELECT.restored(affected), dequeued > 0 && affected > 0 ? QUEUE_COPY.requeue(dequeued) : undefined);
    } catch (error) {
      toast.error(SAVED_SELECT.restoreFailed, userMessage(error, 'Please try again.'));
    } finally {
      refreshSaved();
    }
  };

  // Nothing in the list shown could be prepared (and no more to load): Prepare All has nothing to take either. Another
  // tab (Draft) may hide what To prepare holds, so it asks the server there.
  const nothingToPrepare =
    (filter === 'all' || filter === 'ready') && items !== null && !items.some(selectableSaved) && !saved.hasNextPage;
  // v36 FIX-WEB (ux L1): Saved is empty on this profile (the All tab read to its end with no row): Share All has nothing
  // to share, so it is off with why (the other tabs show part of Saved, so they say nothing of it).
  const savedEmpty = filter === 'all' && items !== null && items.length === 0 && !saved.hasNextPage;
  const shareAllOff = share.blocked ?? (savedEmpty ? FANOUT_COPY.shareAllNone : null);
  // v36 FIX-WEB (D1): the chosen jobs in the auto-apply queue, and whether this tab may take them out of it.
  const queueWords = useQueueWords();
  const queuedChosen = chosen.filter((item) => item.marker === 'queued').length;
  const shareOnly = onlyTarget(share);
  /** Where focus goes after Share All's dialogs: its button. */
  const shareAllFocus = () => document.querySelector<HTMLElement>('[data-saved-toolbar] [data-share-all]') ?? true;

  const controls = (
    // v36 APPLYWEB (PLAN A7): one line where it fits; else Share All ▾ and Prepare All ▾ wrap under it, at its right.
    <div className="flex flex-wrap items-center justify-end gap-2" data-saved-toolbar="">
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
      <span aria-hidden="true" className="min-w-0 flex-1" />
      <div className="flex items-center gap-2" data-saved-tools="">
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
        {!selectMode && canSelect && (
          <SelectToggle variant="outline" size="md" disabled={!items || items.length === 0} onClick={startSelection} data-saved-select="" />
        )}
      </div>
      {!selectMode && (share.available || canPrepare) && (
        <div className="flex flex-wrap items-center justify-end gap-2" data-saved-actions="">
          {share.available && (
            <ProfileSplitButton
              name="share-all"
              variant="outline"
              size="md"
              mainIcon={<ShareNetworkIcon size={16} aria-hidden="true" />}
              onMain={() => (shareOnly ? share.shareAll([shareOnly], shareAllFocus) : share.chooseAll(shareAllFocus))}
              loading={share.allPending}
              disabled={shareAllOff !== null}
              mainTip={shareAllOff ?? undefined}
              menuLabel={FANOUT_COPY.shareAllMenu}
              profiles={share.profiles}
              exclude={share.exclude}
              labelOf={share.labelOf}
              onPick={(targets) => share.shareAll(targets, shareAllFocus)}
              onChoose={() => share.chooseAll(shareAllFocus)}
              icon={<ShareNetworkIcon size={16} />}
              itemData="data-share-all-to"
              mainData={{ 'data-share-all': '' }}
            >
              {FANOUT_COPY.shareAll}
            </ProfileSplitButton>
          )}
          {canPrepare && (
            <ProfileSplitButton
              name="prepare-all"
              variant="primary"
              size="md"
              split={prepareChoices.available}
              onMain={() => prepare.prepareAll({ names: namesOf(items ?? []) })}
              loading={prepare.allPending || allProfiles.reading}
              mainDisabled={nothingToPrepare}
              menuLabel={PREPARE_ALL_MENU}
              profiles={prepareChoices.profiles}
              labelOf={prepareChoices.label}
              onPick={prepareAllOn}
              onChoose={() => setChoosingPrepareAll(true)}
              itemData="data-prepare-all-on"
              mainData={{ 'data-prepare-all': '' }}
            >
              {PREPARE_ALL_LABEL}
            </ProfileSplitButton>
          )}
        </div>
      )}
    </div>
  );

  // v30 ST5: the select mode's bar is components/queue's SelectBar (same toolbar and polite count); v36 APPLYWEB (PLAN
  // A4): its Select All / Deselect All button, then Remove, Share ▾, Prepare ▾ and Cancel.
  const busy = prepareOn.pending || chosen.some((item) => prepare.pending.has(item.applicationId));
  const footer = selectMode ? (
    <SelectBar
      aria-label={SELECT_BAR_NAME}
      selected={chosen.length}
      selectable={items?.length ?? 0}
      selectAllLabel={SAVED_SELECT.selectAllTip(SAVED_SELECT_MAX)}
      onSelectAll={(on) => (on ? void selectEvery() : setSelected(new Set()))}
      selectAllAs="button"
      allSelected={allChosen}
      selectAllBusy={loadingAll}
    >
      {canRemove && (
        <IconButton
          label={SAVED_SELECT.remove}
          variant="outline"
          className="max-sm:size-11"
          icon={<ArchiveIcon size={18} aria-hidden="true" />}
          disabled={chosen.length === 0}
          focusableWhenDisabled
          onClick={() => setRemovingChosen(true)}
          data-saved-remove=""
        />
      )}
      {share.available && (
        <ProfileSplitButton
          name="share"
          variant="outline"
          size="md"
          mainIcon={<ShareNetworkIcon size={16} aria-hidden="true" />}
          onMain={() => shareChosen()}
          disabled={chosen.length === 0 || share.blocked !== null}
          focusableWhenDisabled
          mainTip={share.blocked ?? undefined}
          menuLabel={FANOUT_COPY.shareMenu}
          profiles={share.profiles}
          exclude={share.exclude}
          labelOf={share.labelOf}
          onPick={(targets) => shareChosen(targets)}
          onChoose={() => share.chooseFor(chosen.map((item) => item.applicationId), { onDone: endSelection, finalFocus: barFocus })}
          icon={<ShareNetworkIcon size={16} />}
          itemData="data-share-chosen-to"
        >
          {FANOUT_COPY.share}
        </ProfileSplitButton>
      )}
      {canPrepareAny && (
        <ProfileSplitButton
          name="prepare"
          variant="primary"
          size="md"
          split={prepareOn.available}
          onMain={prepareChosen}
          loading={busy}
          disabled={chosen.length === 0}
          mainDisabled={!canPrepare}
          mainTip={canPrepare ? undefined : SAVED_SELECT.prepareNeeds(boxName('prepare:run', prepareOn.labelOf))}
          menuLabel={SAVED_SELECT.prepareMenu}
          profiles={prepareOn.profiles}
          labelOf={prepareOn.labelOf}
          onPick={prepareOnPicked}
          onChoose={() => setChoosingPrepare(true)}
          itemData="data-prepare-chosen-on"
          mainData={{ 'data-prepare-button': '' }}
        >
          {canPrepare ? prepareLabel(preparable.length) : PREPARE_LABEL}
        </ProfileSplitButton>
      )}
      <Button variant="outline" size="sm" className="max-sm:h-11" onClick={endSelection} data-saved-select-cancel="">
        {SAVED_SELECT.cancel}
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
              share={share}
              savedOn={savedOn.get(item.jobId)}
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
        fill={fill}
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
        title={SAVED_SELECT.removeOneTitle}
        description={removing ? removeOneLine(removing, queueWords) : undefined}
        confirmLabel="Remove"
        busyLabel="Removing..."
        onConfirm={async () => {
          if (!removing) return;
          // v36 FIX-WEB (D1): a job in the queue leaves it too; one being applied now (or on a shared profile without
          // Queue changes) is left in saved jobs, and the message says why.
          const outcome = archiveOneOutcome(await trackerApi.archive(removing.applicationId), queueWords.box, queueWords.name);
          if (outcome.left) toast.info(QUEUE_COPY.notRemoved, [nameOf(removing), ...outcome.notes].join(' · '));
          else toast.success(SAVED_SELECT.removedOne, [nameOf(removing), ...outcome.notes].join(' · '));
          refreshSaved();
        }}
      />
      {/* v36 APPLYWEB (PLAN A4): Remove on the chosen rows: the bulk archive of what is still Saved, with Undo. */}
      <ConfirmDialog
        open={removingChosen}
        onOpenChange={setRemovingChosen}
        tone="primary"
        title={SAVED_SELECT.removeTitle(chosen.length)}
        description={removeManyLine(queuedChosen, queueWords)}
        confirmLabel={SAVED_SELECT.removeConfirm}
        busyLabel={SAVED_SELECT.removeBusy}
        finalFocus={barFocus}
        onConfirm={async () => {
          const ids = chosen.map((item) => item.applicationId);
          if (ids.length === 0) return;
          const answer = await trackerApi.bulk({ ids, action: 'archive', onlySaved: true });
          endSelection();
          refreshSaved();
          // v36 FIX-WEB (D1): what the Remove did to the auto-apply queue, and the jobs it left in saved jobs.
          const result = removedReport(answer, queueWords.box, queueWords.name);
          if (!result.done) {
            toast.info(result.title, result.description ?? undefined);
            return;
          }
          let id = '';
          id = toast.toast({
            type: 'success',
            title: result.title,
            description: result.description ?? undefined,
            timeout: 10_000,
            action: {
              label: FANOUT_COPY.undo,
              onClick: () => {
                toast.dismiss(id);
                void restore(ids, answer.dequeued ?? 0);
              },
            },
          });
        }}
      />
      {/* v36 APPLYWEB (PLAN A2): Prepare All ▾'s Choose profiles…. */}
      <ProfilesDialog
        open={choosingPrepareAll}
        onOpenChange={setChoosingPrepareAll}
        title={PREPARE_ALL_MENU}
        help={PREPARE_ON_HELP}
        profiles={prepareChoices.profiles}
        label={prepareChoices.label}
        initial={[prepareChoices.tab]}
        confirmLabel={(n) => (n === 1 ? 'Prepare on 1 profile' : `Prepare on ${n} profiles`)}
        finalFocus={() => prepareAllRef.current ?? true}
        onConfirm={(targets) => prepareAllOn(targets)}
      />
      {/* v36 APPLYWEB (PLAN A4): the bar's Prepare ▾ Choose profiles…. */}
      <ProfilesDialog
        open={choosingPrepare}
        onOpenChange={setChoosingPrepare}
        title={SAVED_SELECT.prepareMenu}
        help={PREPARE_ON_HELP}
        profiles={prepareOn.profiles}
        label={prepareOn.labelOf}
        initial={[share.source]}
        confirmLabel={(n) => (n === 1 ? 'Prepare on 1 profile' : `Prepare on ${n} profiles`)}
        finalFocus={barFocus}
        onConfirm={(targets) => prepareOnPicked(targets)}
      />
      {share.elements}
      {prepareOn.elements}
      {allProfiles.elements}
    </>
  );
}

/** Prepare's Choose profiles…: what each profile does. */
const PREPARE_ON_HELP = "Each profile prepares the jobs with its owner's filters and settings, on your AI use.";

/**
 * v36 FIX-WEB (ux L2): when no profile of a row's Share to › can take the job (each has it already, or lacks the box),
 * each one's reason ("Ana Lopez: In its Job Tracker"), for the row drawn off; null when some profile can.
 */
export function shareToReasons(share: Pick<ShareSaved, 'profiles' | 'labelOf' | 'exclude'>, savedOn: SavedOnJob | undefined): string[] | null {
  const rows = menuProfiles(share.profiles, 'list', share.exclude).map((profile) => ({
    profile,
    off: profileRowOf(profile, share.labelOf, undefined, (one) => savedOn?.choices.has(one.choice) ?? false).off,
  }));
  if (rows.length === 0 || rows.some((row) => row.off === null)) return null;
  return rows.map((row) => `${row.profile.label}: ${row.off!.replace(/\.$/, '')}`);
}

/** v36 FIX-WEB (D1): a row's Remove question, with what it does to the job's place in the auto-apply queue. */
export function removeOneLine(item: SavedJobItem, queue: QueueWords): string {
  const line = SAVED_SELECT.removeOneLine(nameOf(item));
  if (item.marker !== 'queued') return line;
  return `${line} ${queue.canChange ? QUEUE_COPY.oneInQueue : QUEUE_COPY.oneInQueueLocked(queue.box, queue.name)}`;
}

/** v36 FIX-WEB (D1): the bar's Remove question, with the chosen jobs in the auto-apply queue. */
export function removeManyLine(queued: number, queue: QueueWords): string {
  const note = inQueueNote(queued, queue);
  return note ? `${SAVED_SELECT.removeLine} ${note}` : SAVED_SELECT.removeLine;
}

/** The only profile a share can go to, when there is one (Share's main part then shares at once). */
function onlyTarget(share: Pick<ShareSaved, 'targets'>): ProfileChoice | null {
  const on = share.targets.filter((profile: FanoutProfile) => profile.allowed);
  return on.length === 1 ? on[0]!.choice : null;
}

/** A ref read when it is needed: the element `selector` finds then (a part that owns no ref of its own). */
function lazyRef(selector: string): RefObject<HTMLButtonElement | null> {
  return {
    get current() {
      return typeof document === 'undefined' ? null : document.querySelector<HTMLButtonElement>(selector);
    },
  } as RefObject<HTMLButtonElement | null>;
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
          Prepare checks the filters again, so a changed filter can let it through.
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
  share,
  savedOn,
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
  /** v33 FIX-1: Prepare and Cancel are offered (Prepare's Change on a shared profile). */
  canPrepare: boolean;
  /** v33 FIX-1: Remove from Saved Jobs is offered (the Job Tracker's Change on a shared profile). */
  canRemove: boolean;
  /** v36 APPLYWEB (PLAN A5): "Share to ›" in the ⋯ menu (the targets, All profiles, Choose profiles…). */
  share: ShareSaved;
  /** Where the job is in other profiles' Job Trackers (those are checked and off in Share to ›). */
  savedOn: SavedOnJob | undefined;
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
  // v30 FIX-WEB (REV-UX UX-10): a job that closed says so, and Prepare is off for it (named why).
  const closed = isClosed(item);
  const [rowRef, rowFocus] = useRowFocus<HTMLLIElement>(`${action}:${selectMode}`);
  const shareReasons = shareToReasons(share, savedOn);
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
        // v36 APPLYWEB (PLAN A4): every saved row can be chosen (Remove and Share take any; Prepare the preparable ones).
        <span className="flex pt-1.5 @2xl/pane:pt-0">
          <Checkbox checked={checked} onCheckedChange={onChecked} aria-label={`Select ${name}`} />
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
                {share.available &&
                  (share.blocked ? (
                    <MenuItem icon={<ShareNetworkIcon size={16} />} disabled hint={share.blocked} data-share-to-blocked="">
                      {FANOUT_COPY.shareTo}
                    </MenuItem>
                  ) : shareReasons ? (
                    // v36 FIX-WEB (ux L2): no profile can take this job (each has it, or lacks the box): a submenu of
                    // rows that are all off cannot be entered by keyboard, so the row itself is off and lists why.
                    <MenuItem
                      icon={<ShareNetworkIcon size={16} />}
                      disabled
                      hint={
                        <>
                          {shareReasons.map((reason) => (
                            <span key={reason} className="block">
                              {reason}
                            </span>
                          ))}
                        </>
                      }
                      data-share-to-none=""
                    >
                      {FANOUT_COPY.shareTo}
                    </MenuItem>
                  ) : (
                    // v36 APPLYWEB (PLAN A5): each profile it can be shared to (one that has it checked and off), All
                    // profiles, Choose profiles….
                    <MenuSub label={FANOUT_COPY.shareTo} icon={<ShareNetworkIcon size={16} />}>
                      <MenuSubContent width="w-64">
                        <ProfileMenuItems
                          profiles={share.profiles}
                          labelOf={share.labelOf}
                          exclude={share.exclude}
                          checked={(profile) => savedOn?.choices.has(profile.choice) ?? false}
                          onPick={(targets) => void share.share([item.applicationId], targets)}
                          onChoose={() => share.chooseFor([item.applicationId], { savedOn: savedOn?.choices })}
                          icon={<ShareNetworkIcon size={16} />}
                          order="list"
                          itemData="data-share-to"
                        />
                      </MenuSubContent>
                    </MenuSub>
                  ))}
                {canRemove && (
                  <>
                    <MenuSeparator />
                    <MenuItem icon={<ArchiveIcon size={16} />} onClick={onRemove}>
                      {SAVED_SELECT.remove}
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
