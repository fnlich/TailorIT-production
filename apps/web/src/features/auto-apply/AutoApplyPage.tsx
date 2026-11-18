'use client';

import type { QueuePaneItem, SavedJobFilter, SavedJobItem } from '@tailorit/shared/prepare';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { UsageMeter, UsageMeterSkeleton } from '@/components/limits';
import { PAGE_GUTTER } from '@/components/shell/layout';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/Popover';
import { TabPanel } from '@/components/ui/SegmentedControl';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { UnderlineTabs } from '@/components/ui/UnderlineTabs';
import { InfoIcon } from '@/components/ui/icons';
import { invalidateAccount } from '@/lib/account';
import { userMessage } from '@/lib/api';
import { useStoredValue } from '@/lib/storage';
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

// v2.0: the Auto-apply page (/auto-apply), a two-pane workspace (docs/design/v2.0/08-ui.md, "The Auto-Apply page"):
// Saved Jobs on the left (Prepare & Queue), the Queue on the right (preparing, up next, apply manually, needs
// attention, done), the Free account's usage line in the header, the kit sheet of the manual flow. Two panes from
// 1024 px (5 : 7), tabs below. Both panes are read every 3 s while anything is preparing or applying, every 30 s
// otherwise; nothing is read while the tab is hidden.
// v31 AUTO: the page's header is the kit's PageHeader (docs/design/v3.1/20-visual-identity.md §8) with the usage tape
// meter as its action; the Saved pane's toolbar carries Filters (a dialog), Select and Prepare All.

/** Two panes side by side from Tailwind's `lg`. */
const TWO_PANES_QUERY = '(min-width: 64rem)';
/** The Prepares dismissed on this device ("Dismiss" on a failed preparation), most recent last. */
const DISMISSED_KEY = 'tailorit.autoApply.dismissed';
const DISMISSED_MAX = 200;
/** How long "View in queue" flashes its row. */
const HIGHLIGHT_MS = 1_500;

type Tab = 'saved' | 'queue';

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

  const queue = useQueuePane();
  // The Saved pane reads at the Queue pane's pace.
  const saved = useSavedJobs(savedFilter, pollInterval(queue.data?.preparing, queue.data?.items));
  const filters = usePrepareFilters();
  const rule = useQuery({ queryKey: autoApplyKeys.settings, queryFn: ({ signal }) => fetchAgentSettings(signal) });

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

  const header = (
    <PageHeader
      title={PAGE_TITLE}
      description={
        <span className="flex flex-wrap items-center gap-x-2">
          <span>{PAGE_LEAD}</span>
          <Popover>
            <PopoverTrigger
              render={
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-control px-1 text-sm font-medium text-primary underline-offset-2 hover:underline max-sm:min-h-11"
                />
              }
            >
              <InfoIcon size={16} aria-hidden="true" />
              {HOW_TITLE}
            </PopoverTrigger>
            <PopoverContent className="w-[min(26rem,calc(100vw-2rem))]" align="start">
              <PopoverTitle>{HOW_TITLE}</PopoverTitle>
              <div className="mt-2 flex flex-col gap-2 text-[13px] leading-5 text-foreground">
                {howItWorks().map((paragraph) => (
                  <p key={paragraph.slice(0, 24)}>{paragraph}</p>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        </span>
      }
      actions={
        // v2.0 fix (UX-14): no empty band for an account with no meter (Paid), nor when the queue could not be read.
        queue.isPending || usage ? (
          <div className="flex min-h-10 items-center max-lg:basis-full" data-usage="">
            {usage ? (
              <UsageMeter used={usage.used} limit={usage.limit} reserved={usage.reserved} resetText={usage.resetText} />
            ) : (
              <UsageMeterSkeleton />
            )}
          </div>
        ) : undefined
      }
    />
  );

  const savedPane = (
    <div className="flex min-w-0 flex-col gap-4">
      <SavedPane
        filter={savedFilter}
        onFilterChange={setSavedFilter}
        saved={saved}
        prepare={prepare}
        scroll={wide}
        filtersOn={filters.data ? filtersOnCount(filters.data.filters) : null}
        onViewInQueue={viewInQueue}
      />
      {rule.isError ? (
        <Notice
          tone="error"
          title="Auto-save new jobs could not be loaded"
          action={
            <Button variant="outline" size="sm" onClick={() => void rule.refetch()}>
              Try again
            </Button>
          }
        >
          {userMessage(rule.error)}
        </Notice>
      ) : rule.isPending ? (
        <Skeleton className="h-16 w-full" rounded="control" />
      ) : (
        <RuleSection settings={rule.data} />
      )}
    </div>
  );

  const queuePane = (
    <QueuePane
      queue={queue}
      filter={queueFilter}
      onFilterChange={setQueueFilter}
      prepare={prepare}
      scroll={wide}
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
    <div className={clsx('mx-auto w-full max-w-[1280px] pt-7 pb-20', PAGE_GUTTER)}>
      {header}
      {wide ? (
        <div className="mt-6 grid grid-cols-[minmax(0,5fr)_minmax(0,7fr)] items-start gap-6" data-auto-apply-layout="panes">
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
