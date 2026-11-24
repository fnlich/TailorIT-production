'use client';

import type { QueuePaneItem, SavedJobFilter, SavedJobItem } from '@tailorit/shared/prepare';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { UsageMeter, UsageMeterSkeleton } from '@/components/limits';
import { PAGE_GUTTER } from '@/components/shell/layout';
import { LoadError } from '@/components/ui/LoadError';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { PageHeader } from '@/components/ui/PageHeader';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/Popover';
import { TabPanel } from '@/components/ui/SegmentedControl';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { UnderlineTabs } from '@/components/ui/UnderlineTabs';
import { InfoIcon } from '@/components/ui/icons';
import { invalidateAccount } from '@/lib/account';
import { useStoredValue } from '@/lib/storage';
import { useFrameHeight } from '@/lib/useFrameHeight'; // v36 APPLYWEB
import { useMediaQuery } from '@/lib/useMediaQuery';
import { SavedPane } from '../prepare/SavedPane';
import { usePrepareAndQueue } from '../prepare/usePrepareAndQueue';
import { invalidateApplications } from '../tracker/data';
import { autoApplyKeys, fetchAgentSettings, markApplied } from './api';
import {
  HOW_TITLE,
  MARK_APPLIED_CONFIRM,
  PAGE_LEAD,
  PAGE_TITLE,
  filtersOnCount,
  groupRows,
  howItWorks,
  pollInterval,
  rowKey,
  rowStates,
  usageView,
  type QueueFilter,
} from './copy';
import { usePrepareFilters, useQueuePane, useSavedJobs } from './data';
import { KitSheet } from './KitSheet';
import { useReducedMotion } from '../../components/queue';
import { QueuePane } from './QueuePane';
import { RuleSection } from './RuleSection';
import { HeldSection } from './HeldSection'; // v33 SHARE-7
import { NotShared, useTabProfile, type TabProfile } from '../sharing/access'; // v33 INT-1

// v2.0: the Auto-apply page (/auto-apply), a two-pane workspace (docs/design/v2.0/08-ui.md, "The Auto-Apply page"):
// Saved Jobs on the left (Prepare), the Queue on the right (preparing, up next, apply manually, needs
// attention, done), the Free account's usage line in the header, the kit sheet of the manual flow. Two panes from
// 1024 px (5 : 7), tabs below. Both panes are read every 3 s while anything is preparing or applying, every 30 s
// otherwise; nothing is read while the tab is hidden.
// v31 AUTO: the page's header is the kit's PageHeader (docs/design/v3.1/20-visual-identity.md §8) with the usage tape
// meter as its action; the Saved pane's toolbar carries Filters (a dialog), Select and Prepare All.
// v32 LAYOUT (E10, the owner: "content width is a little small"): the page uses the content column's width up to
// 1600 px (as Documents does; it was 1280), and from a wide enough page the two panes share it equally, so the Saved
// pane's toolbar (All | To prepare | Filtered | Draft, Filters, Select, Prepare All) holds one line. E5: the page's
// line is its description (COPY's PageHeader shows it as the "?"), and "How auto-apply works" is a quiet button beside
// the usage meter (it opens the same popover). E4: an Auto-save rule that could not be read is a short line, not a
// banner.
// v36 APPLYWEB (PLAN A1; SP v36 REQUEST.md: "In Auto-Apply Page, There will be no scroll for full screen"): from 1024 px
// the panes' row is a frame measured to the window (lib/useFrameHeight, JOBS' helper): the Saved and Queue panes fill
// its height and their lists scroll inside them (Pane's `fill`), "Auto-save new jobs" stays a line under Saved (its
// opened form scrolls on its own), the header and the Held card keep their own height, and the window does not scroll.
// A window too short for the frame's least height scrolls a little, as it must. Phones and the stacked page (< 1024 px)
// keep the tabs and the window's scroll.

/** Two panes side by side from Tailwind's `lg`. */
const TWO_PANES_QUERY = '(min-width: 64rem)';
/**
 * v32 LAYOUT: the panes' columns. From 68 rem of page (`@container/auto-apply`: a 1140 px window) the two panes are
 * equal, which gives the Saved pane (about 33 rem) the room for its toolbar on one line. v32 FIX-UX (UXREQ-7, the
 * coordinator: "one toolbar line at every width from 1024"): a narrower page gives the Saved pane 7 parts of 12 (v2.0
 * gave the Queue 7), so its tabs, Filters, Select and Prepare All still share one line at 1024 px; the Queue's toolbar
 * (All | Active | Done, Clear finished) fits its 5.
 */
export const PANES_GRID = 'grid grid-cols-[minmax(0,7fr)_minmax(0,5fr)] @min-[68rem]/auto-apply:grid-cols-2';
/**
 * v36 APPLYWEB (PLAN A1): the panes' frame from 1024 px: the height useFrameHeight measures (down to 16 px above the
 * window's edge; a first paint's guess before it does), one row the panes stretch to fill.
 */
export const PANES_FRAME = 'h-[var(--frame-height,calc(100dvh_-_var(--spacing-topbar)_-_12rem))] grid-rows-[minmax(0,1fr)] items-stretch';
/** The Prepares dismissed on this device ("Dismiss" on a failed preparation), most recent last. */
const DISMISSED_KEY = 'tailorit.autoApply.dismissed';
const DISMISSED_MAX = 200;
/** How long "View in queue" flashes its row. */
const HIGHLIGHT_MS = 1_500;

type Tab = 'saved' | 'queue';

/**
 * v33 INT-1: what the tab may do with the Auto-save rule (Job settings): everything on the person's own profile; on a
 * shared one, read with the owner's See box (`settings:view`) and change with Change (`settings:edit`); nothing until
 * the list of profiles is read (`ready` false).
 */
export function ruleAccessOf(tab: Pick<TabProfile, 'key' | 'profile' | 'ownerName'>): { ready: boolean; see: boolean; change: boolean; owner: string | null } {
  if (tab.key === null) return { ready: true, see: true, change: true, owner: null };
  const permissions = tab.profile?.permissions ?? [];
  return {
    ready: tab.profile !== null,
    see: permissions.includes('settings:view'),
    change: permissions.includes('settings:edit'),
    owner: tab.ownerName,
  };
}

const parseDismissed = (raw: string | null) => raw ?? '[]';
function dismissedSet(raw: string): ReadonlySet<string> {
  try {
    const value: unknown = JSON.parse(raw);
    return new Set(Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : []);
  } catch {
    return new Set();
  }
}

export function AutoApplyPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const wide = useMediaQuery(TWO_PANES_QUERY);
  const reduced = useReducedMotion();
  const prepare = usePrepareAndQueue();
  const [savedFilter, setSavedFilter] = useState<SavedJobFilter>('all');
  const [queueFilter, setQueueFilter] = useState<QueueFilter>('all');
  const [tab, setTab] = useState<Tab>('saved');
  const [highlight, setHighlight] = useState<string | null>(null);
  const [kitItem, setKitItem] = useState<QueuePaneItem | null>(null);
  const [kitOpen, setKitOpen] = useState(false);
  const [marking, setMarking] = useState<QueuePaneItem | null>(null);
  const [rawDismissed, setRawDismissed] = useStoredValue<string>(DISMISSED_KEY, parseDismissed);
  const dismissed = useMemo(() => dismissedSet(rawDismissed), [rawDismissed]);
  // v36 APPLYWEB (PLAN A1): the panes' frame, measured to the window while the panes are side by side.
  const frameRef = useRef<HTMLDivElement>(null);
  useFrameHeight(frameRef, wide);

  const queue = useQueuePane();
  // The Saved pane reads at the Queue pane's pace.
  const saved = useSavedJobs(savedFilter, pollInterval(queue.data?.preparing, queue.data?.items));
  const filters = usePrepareFilters();
  // v33 INT-1 (INT-D's tour): the Auto-save rule is Job settings (GET /api/autofill/agent/settings is settings:view, PUT
  // settings:edit): on a profile shared with the person it is asked for only with its owner's See box, never for a
  // quiet 403, and changed only with Change.
  const ruleAccess = ruleAccessOf(useTabProfile());
  const rule = useQuery({
    queryKey: autoApplyKeys.settings,
    queryFn: ({ signal }) => fetchAgentSettings(signal),
    enabled: ruleAccess.see,
  });

  const supportOf = useCallback(
    (applicationId: string) => saved.items?.find((item) => item.applicationId === applicationId)?.support,
    [saved.items],
  );
  const usage = queue.data ? usageView(queue.data.usage, queue.data.items) : undefined;
  const queueRows = useMemo(
    () => (queue.data ? groupRows(queue.data.preparing, queue.data.items, 'all', dismissed).flatMap((group) => group.rows) : []),
    [queue.data, dismissed],
  );

  const queueSignature = queue.data ? [...rowStates(queueRows)].map(([key, state]) => `${key}:${state}`).join('|') : null;
  // A row that changed state in the Queue pane changes its Saved row's marker too: the Saved pane reads again at once
  // (its own pace slows to 30 s as soon as nothing prepares any more).
  const lastQueueSignature = useRef<string | null>(null);
  useEffect(() => {
    if (queueSignature === null) return;
    const before = lastQueueSignature.current;
    lastQueueSignature.current = queueSignature;
    if (before !== null && before !== queueSignature) void queryClient.invalidateQueries({ queryKey: autoApplyKeys.savedAll });
  }, [queueSignature, queryClient]);

  // On narrow screens a dot marks the hidden tab when its pane changed meanwhile.
  const unseen = useUnseenChanges(
    tab,
    wide,
    saved.items ? saved.items.map((item) => `${item.applicationId}:${item.marker}`).join('|') : null,
    queueSignature,
  );

  const viewInQueue = (item: SavedJobItem) => {
    const row =
      queue.data?.items.find((one) => (item.queueId ? one.queueId === item.queueId : one.applicationId === item.applicationId)) ?? null;
    setQueueFilter('all');
    if (!wide) setTab('queue');
    if (!row) {
      toast.info('Not in the queue right now', 'It may have been removed or cleared meanwhile.');
      return;
    }
    const key = rowKey({ kind: 'queue', item: row });
    window.setTimeout(() => {
      const node = document.querySelector<HTMLElement>(`[data-queue-row="${CSS.escape(key)}"]`);
      node?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
      if (!reduced) setHighlight(key);
      window.setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    }, 50);
  };

  const openKit = (item: QueuePaneItem) => {
    setKitItem(item);
    setKitOpen(true);
  };

  const dismiss = (key: string) => {
    const next = [...dismissed, key].slice(-DISMISSED_MAX);
    setRawDismissed(JSON.stringify(next));
  };

  const how = (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="inline-flex h-9 items-center gap-1.5 rounded-control px-2 text-sm font-medium text-primary underline-offset-2 hover:underline max-sm:min-h-11"
            data-how-it-works=""
          />
        }
      >
        <InfoIcon size={16} aria-hidden="true" />
        {HOW_TITLE}
      </PopoverTrigger>
      <PopoverContent className="w-[min(26rem,calc(100vw-2rem))]" align="end">
        <PopoverTitle>{HOW_TITLE}</PopoverTitle>
        <div className="mt-2 flex flex-col gap-2 text-[13px] leading-5 text-foreground">
          {howItWorks().map((paragraph) => (
            <p key={paragraph.slice(0, 24)}>{paragraph}</p>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );

  const header = (
    <PageHeader
      title={PAGE_TITLE}
      description={PAGE_LEAD}
      actions={
        // Stacked under the title on a narrow page (each its own line), side by side from 1024 px.
        <div className="flex flex-col items-start gap-1 lg:flex-row lg:items-center lg:gap-4">
          {how}
          {/* v2.0 fix (UX-14): no empty band for an account with no meter (Paid), nor when the queue could not be read. */}
          {queue.isPending || usage ? (
            <div className="flex min-h-10 items-center" data-usage="">
              {usage ? (
                <UsageMeter used={usage.used} limit={usage.limit} reserved={usage.reserved} resetText={usage.resetText} />
              ) : (
                <UsageMeterSkeleton />
              )}
            </div>
          ) : null}
        </div>
      }
    />
  );

  const savedPane = (
    // v36 APPLYWEB (PLAN A1): in the frame the Saved pane takes what the rule's line leaves.
    <div className={clsx('flex min-w-0 flex-col gap-4', wide && 'h-full min-h-0')} data-saved-column="">
      <SavedPane
        filter={savedFilter}
        onFilterChange={setSavedFilter}
        saved={saved}
        prepare={prepare}
        scroll={wide}
        fill={wide}
        filtersOn={filters.data ? filtersOnCount(filters.data.filters) : null}
        onViewInQueue={viewInQueue}
      />
      <div className={clsx(wide && 'flex max-h-[60%] min-h-0 shrink-0 flex-col')} data-rule-slot="">
      {!ruleAccess.see ? (
        // v33 INT-1: not asked for without the owner's Job settings See box (nothing while the list is read).
        ruleAccess.ready ? (
          <section aria-label="Auto-save new jobs" data-rule-not-shared="">
            <NotShared owner={ruleAccess.owner} />
          </section>
        ) : (
          <Skeleton className="h-16 w-full" rounded="control" />
        )
      ) : rule.isError ? (
        // v32 FIX-UX (UXREQ-8, UXREQ-13): the kit's load error, its reason in view (not in a "?").
        <div data-rule-load-failed="">
          <LoadError thing="Auto-save new jobs" error={rule.error} onRetry={() => void rule.refetch()} />
        </div>
      ) : rule.isPending ? (
        <Skeleton className="h-16 w-full" rounded="control" />
      ) : (
        <RuleSection settings={rule.data} readOnly={!ruleAccess.change} fill={wide} />
      )}
      </div>
    </div>
  );

  const queuePane = (
    <QueuePane
      queue={queue}
      filter={queueFilter}
      onFilterChange={setQueueFilter}
      prepare={prepare}
      scroll={wide}
      fill={wide}
      supportOf={supportOf}
      onOpenKit={openKit}
      onMarkApplied={setMarking}
      highlight={highlight}
      dismissed={dismissed}
      onDismiss={dismiss}
    />
  );

  const savedCount = saved.items ? `${saved.items.length}${saved.hasNextPage ? '+' : ''}` : null;
  const queueCount = queue.data ? String(queueRows.length) : null;
  const tabLabel = (label: string, count: string | null, changed: boolean) => (
    <span className="inline-flex items-center gap-1.5">
      {count === null ? label : `${label} (${count})`}
      {changed && (
        <>
          <span aria-hidden="true" className="size-2 rounded-full bg-primary" data-tab-dot="" />
          <span className="sr-only">, changed</span>
        </>
      )}
    </span>
  );

  return (
    // v36 APPLYWEB (PLAN A1): framed, no padding under the frame (its own 16 px gap is the margin), or the page would scroll.
    <div className={clsx('@container/auto-apply mx-auto w-full max-w-[1600px] pt-7', wide ? 'pb-0' : 'pb-20', PAGE_GUTTER)}>
      {header}
      {/* v33 SHARE-7: jobs someone prepared on the person's own profile, waiting for their OK (none: nothing shows). */}
      <HeldSection className="mt-6" />
      {wide ? (
        <div ref={frameRef} className={clsx(PANES_GRID, PANES_FRAME, 'mt-6 gap-6')} data-auto-apply-layout="panes" data-auto-apply-frame="">
          {savedPane}
          {queuePane}
        </div>
      ) : (
        <UnderlineTabs
          aria-label="Auto-apply"
          size="md"
          value={tab}
          onValueChange={setTab}
          className="mt-6"
          items={[
            { value: 'saved', label: tabLabel('Saved', savedCount, unseen.saved) },
            { value: 'queue', label: tabLabel('Queue', queueCount, unseen.queue) },
          ]}
        >
          <TabPanel value="saved" className="pt-4" keepMounted>
            <div data-auto-apply-layout="tabs">{savedPane}</div>
          </TabPanel>
          <TabPanel value="queue" className="pt-4" keepMounted>
            {queuePane}
          </TabPanel>
        </UnderlineTabs>
      )}

      <KitSheet item={kitItem} open={kitOpen} onOpenChange={setKitOpen} onMarkApplied={setMarking} />
      <ConfirmDialog
        open={marking !== null}
        onOpenChange={(open) => !open && setMarking(null)}
        tone="primary"
        title="Mark as applied"
        description={MARK_APPLIED_CONFIRM}
        confirmLabel="Mark as applied"
        busyLabel="Marking..."
        onConfirm={async () => {
          if (!marking) return;
          await markApplied(marking.queueId);
          toast.success('Marked as applied', `${marking.title} at ${marking.company}`);
          setKitOpen(false);
          void queryClient.invalidateQueries({ queryKey: autoApplyKeys.all });
          void invalidateApplications(queryClient);
          void invalidateAccount(queryClient);
        }}
      />
      {prepare.elements}
    </div>
  );
}

/** Which tab changed while it was hidden (narrow screens only); seeing a tab clears its mark. */
function useUnseenChanges(tab: Tab, wide: boolean, savedSignature: string | null, queueSignature: string | null) {
  const last = useRef<{ saved: string | null; queue: string | null }>({ saved: null, queue: null });
  const [unseen, setUnseen] = useState({ saved: false, queue: false });
  // Seeing a tab clears its mark.
  const [shownTab, setShownTab] = useState(tab);
  if (shownTab !== tab) {
    setShownTab(tab);
    setUnseen((current) => ({ ...current, [tab]: false }));
  }
  useEffect(() => {
    const before = last.current;
    last.current = { saved: savedSignature, queue: queueSignature };
    if (wide) return;
    const changed = {
      saved: tab !== 'saved' && before.saved !== null && savedSignature !== null && before.saved !== savedSignature,
      queue: tab !== 'queue' && before.queue !== null && queueSignature !== null && before.queue !== queueSignature,
    };
    if (!changed.saved && !changed.queue) return;
    const timer = window.setTimeout(
      () => setUnseen((current) => ({ saved: current.saved || changed.saved, queue: current.queue || changed.queue })),
      0,
    );
    return () => window.clearTimeout(timer);
  }, [savedSignature, queueSignature, tab, wide]);
  return { saved: unseen.saved && tab !== 'saved', queue: unseen.queue && tab !== 'queue' };
}
