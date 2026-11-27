'use client';

import { PauseIcon } from '@phosphor-icons/react/Pause';
import { PlayIcon } from '@phosphor-icons/react/Play';
import {
  ADMIN_SOURCE_BULK_ACTIONS,
  JOB_SOURCE_TERMS_LABEL,
  JOB_SOURCE_TIER_LABEL,
  type AdminSourceAllAction,
  type AdminSourceBulkAction,
  type AdminSourceRow,
  type AdminSourcesList,
} from '@tailorit/shared/sourcing';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AdminResourceTab, ShowMoreButton, type AdminColumn } from '@/components/admin';
import { SelectBar } from '@/components/queue';
import { Badge } from '@/components/ui/Badge';
import { HelpTip } from '@/components/ui/HelpTip';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { IconButton } from '@/components/ui/IconButton';
import { ArrowsClockwiseIcon, BriefcaseIcon, DotsThreeIcon, DownloadSimpleIcon, PlusIcon, TrashIcon, UploadSimpleIcon, WarningCircleIcon } from '@/components/ui/icons'; // v37 TRANSFER: Import, Export
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/Menu';
import { Notice } from '@/components/ui/Notice';
import { Switch } from '@/components/ui/Switch';
import { useToast } from '@/components/ui/Toast';
import { Tooltip } from '@/components/ui/Tooltip';
import { userMessage } from '@/lib/api';
import { usePublicConstants } from '@/lib/constants';
import { focusLater } from '@/lib/focusLater';
import { relativeTime } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { saveFile } from '../../../imports/results'; // v37 TRANSFER
import { hostKeys } from '../hosts/api'; // v37 TRANSFER
import { fetchSourcingReport, runKeys } from '../runs/api';
import { RunStatusBadge } from '../runs/parts';
import { runsBarText, sourcePausedText, sourcePauseToast } from '../runs/pause'; // v31 RUNS
import { alarmCount, alarmText } from '../runs/report';
import { useRunsPause } from '../runs/useRunsPause'; // v31 RUNS
import { AddSourceDialog } from './AddSourceDialog';
import {
  bulkSources,
  changeAllSources,
  continueSource,
  deleteSource,
  downloadSourcesExport, // v37 TRANSFER
  fetchSourcesAllCount,
  fetchSourcesPage,
  pauseSource,
  runSource,
  setSourceEnabled,
  sourceKeys,
} from './api';
import { BULK_ACTION_LABEL, allConfirmText, allResultLine, bulkProblems, bulkSummary, runBulk, type BulkProblem } from './bulk';
import { clearedFilters, filtersFromAddress, isFiltered, type SourceFilters } from './filters';
import { useAdminLink } from './links';
import { PurgeDialog } from './PurgeDialog';
import { PurgesSheet } from './PurgesSheet';
import { SourceFiltersBar } from './SourceFilters';
import { SourceSheet } from './SourceSheet';
import {
  TIER_TONE,
  WAITING_FOR_ADMIN_TIP,
  failureText,
  formatCount,
  isDeletable,
  isPaused,
  isUnrun,
  offRunNowHint,
  pausedRunNowHint,
  robotsTone,
  runNowHint,
  LINKS_ONLY, // v38 FIX-APP (ux L10)
  linksOnlyBoard, // v38 FIX-APP (ux L10)
  robotsLabelOf, // v38 FIX-APP (ux L10)
  scheduleText,
  sourceLine,
  termsRunNowHint, // v37 FIX-37B (E8)
  termsTone,
  waitingTip,
} from './sources';
import { TurnedOffNotice } from './TurnedOffNotice'; // v36 SOURCES
import { ImportSourcesDialog } from './ImportSourcesDialog'; // v37 TRANSFER
import { EXPORT_TIP, exportSavedText, importProblems, importSummary } from './transfer'; // v37 TRANSFER; v37 FIX-37B: EXPORT_TIP

/** How long the search box rests before the list is asked again. */
const SEARCH_DELAY_MS = 300;
/** The bulk problems listed above the table (the rest are counted). */
const PROBLEMS_SHOWN = 5;
const NO_IDS: ReadonlySet<number> = new Set();
/**
 * v31 FIX-WEB (REV-UX UX-2): the table's two layouts, by its own width (AdminTable's `@container/table`). From 70 rem
 * (1120 px: a 1440 px window with the sidebar open) the terms and robots and the open jobs have columns; narrower, they
 * sit under the source's name, so every column and the row's Run now and More actions fit without a sideways scroll
 * from a 1024 px window up.
 */
const SOURCES_WIDE = { show: 'hidden @min-[70rem]/table:table-cell', hide: '@min-[70rem]/table:hidden' } as const;
/** v30 FIX-WEB (REV-UX UX-4): where focus goes when Clear filters goes (with the filters it cleared). */
const SOURCES_SEARCH = 'input[aria-label="Search sources by name or host"]';

/** v35 OPSWEB (PLAN H7): a switched-on source that cannot run: a small "Waiting" badge, its "?" saying why and what clears it. */
export function WaitingBadge({ waiting, name }: { waiting: AdminSourceRow['waiting']; name: string }) {
  const tip = waitingTip(waiting);
  if (!waiting || !tip) return null;
  return (
    <span className="flex items-center gap-1" data-source-waiting={waiting.reason}>
      <Badge tone="warning">Waiting</Badge>
      <HelpTip label={`Waiting: ${name}`}>{tip}</HelpTip>
    </span>
  );
}

/**
 * v36 SOURCES (SP v36 PLAN S8): a source discovery or an import found that no admin turned on yet: "Waiting for an
 * admin", its "?" saying what ends it.
 */
export function WaitingForAdminBadge({ name }: { name: string }) {
  return (
    <span className="flex items-center gap-1" data-source-waiting-admin="">
      <Badge tone="sky">Waiting for an admin</Badge>
      <HelpTip label={`Waiting for an admin: ${name}`}>{WAITING_FOR_ADMIN_TIP}</HelpTip>
    </span>
  );
}

/**
 * v36 FIX-SRC (the final ux review's L6): a row's Run now. Off with a reason (the source is off or paused, every run is
 * paused, or its kind is never run), it stays focusable (aria-disabled: focusableWhenDisabled, which also keeps focus on
 * it while its own run starts) and is described by the reason, which its tooltip shows on keyboard focus and on hover (on
 * a wrapper: a button that is off takes no pointer events).
 */
export function RunNowButton({
  sourceId,
  running,
  hint,
  disabled,
  onRun,
}: {
  sourceId: number;
  running: boolean;
  /** Why it is off (or what it does), or null. */
  hint: string | null;
  disabled: boolean;
  onRun: () => void;
}) {
  const whyId = `source-run-now-why-${sourceId}`;
  const button = (
    <Button
      variant="outline"
      size="sm"
      icon={<ArrowsClockwiseIcon size={14} />}
      disabled={disabled}
      focusableWhenDisabled
      aria-describedby={hint ? whyId : undefined}
      onClick={onRun}
      data-source-run-now=""
    >
      {running ? 'Running' : 'Run now'}
    </Button>
  );
  if (!hint) return button;
  return (
    <>
      <Tooltip content={hint}>
        <span className="inline-flex" data-source-run-now-tip="">
          {button}
        </span>
      </Tooltip>
      <span id={whyId} hidden>
        {hint}
      </span>
    </>
  );
}

/**
 * Admin › Sources (v30 S1-WEB, 12 §9.8): every job source, at 80,000 rows. The server pages, searches (name or host),
 * filters (kind, tier, terms, robots, how it was found, enabled, failing, one host or company) and orders them; rows
 * are chosen for bulk Enable, Disable and Run now (one request per ADMIN_BULK_MAX). A row opens its sheet; Purges lists
 * the purges by source. Today's alarms (the daily report's) show above the filters.
 * v31 RUNS: a source is paused and continued from its row's menu and its sheet (apart from Enabled); while every run is
 * paused a notice says so, with Continue; Run now waits for a pause to end.
 * v36 SOURCES (PLAN S1, S5, S7, S8): a source runs only once an admin turned it on: Run now waits while it is off; a
 * source found and never turned on is "Waiting for an admin" (its chip filters them); v3.6's one-time notice says how
 * many sources it turned off, with a filter for them and Enable all.
 */
export function SourcesTab({ onShowRuns }: { onShowRuns: (sourceId: number) => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const now = useNow();
  const link = useAdminLink();
  const address = useSearchParams();
  const runsPause = useRunsPause(); // v31 RUNS
  const { t } = usePublicConstants();
  const [filters, setFilters] = useState<SourceFilters>(() => filtersFromAddress(address));
  const [search, setSearch] = useState('');
  // The choice belongs to the filters it was made under: another filter starts with nothing chosen.
  const filtersKey = JSON.stringify(filters);
  const [selection, setSelection] = useState<{ key: string; ids: ReadonlySet<number> }>({ key: filtersKey, ids: NO_IDS });
  const selected = selection.key === filtersKey ? selection.ids : NO_IDS;
  const anchor = useRef<number | null>(null);
  // The last bulk action's outcome, said above the table until dismissed or replaced. v37 TRANSFER: or an import's, with
  // its filter (the sources it added, waiting for an admin).
  const [outcome, setOutcome] = useState<{ summary: ReturnType<typeof bulkSummary>; problems: BulkProblem[]; show?: Partial<SourceFilters> } | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [opened, setOpened] = useState<AdminSourceRow | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<AdminSourceRow | null>(null);
  const [purging, setPurging] = useState<AdminSourceRow | null>(null);
  const [purgesOpen, setPurgesOpen] = useState(false);
  // v35 OPSWEB (PLAN H6): Enable all / Disable all for everything the filter shows (count, confirm, one request).
  const [allAction, setAllAction] = useState<AdminSourceAllAction | null>(null);
  // v37 TRANSFER (PLAN T2): the Import dialog, made anew each time it opens (its key).
  const [importing, setImporting] = useState<{ key: number; open: boolean }>({ key: 0, open: false });

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const q = search.trim();
      setFilters((previous) => (previous.q === q ? previous : { ...previous, q }));
    }, SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [search]);

  const narrow = (patch: Partial<SourceFilters>) => {
    const next = { ...filters, ...patch };
    setFilters(next);
    // The address names a host or company only while the list is narrowed to it.
    if ((filters.host && !next.host) || (filters.companyId && !next.companyId)) {
      link({ tab: 'sources', host: next.host, company: next.companyId });
    }
  };

  const sources = useInfiniteQuery({
    queryKey: sourceKeys.page(filters),
    queryFn: ({ pageParam, signal }) => fetchSourcesPage(filters, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
  });
  const items = useMemo(() => sources.data?.pages.flatMap((page) => page.items) ?? [], [sources.data]);
  const total = sources.data?.pages[0]?.total ?? 0;
  const indexOf = useMemo(() => new Map(items.map((item, index) => [item.id, index])), [items]);

  // Today's alarms; a server without the report (or a failure) shows none.
  const report = useQuery({
    queryKey: runKeys.report(null),
    queryFn: ({ signal }) => fetchSourcingReport(null, signal),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const alarms = report.data?.alarms ?? [];

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: sourceKeys.all });
    void queryClient.invalidateQueries({ queryKey: runKeys.all });
  };
  /** v37 TRANSFER (PLAN T3): a source turned on adds its host to Admin › Hosts: its list is read again. */
  const hostsChanged = () => void queryClient.invalidateQueries({ queryKey: hostKeys.all });

  // v37 TRANSFER (PLAN T1): Export saves the sources the filter shows.
  const exportFile = useMutation({
    mutationFn: () => downloadSourcesExport(filters),
    onSuccess: (file) => {
      saveFile(file.fileName, file.blob);
      toast.success('Sources exported', exportSavedText(file));
    },
    onError: (error) => toast.error('The sources were not exported', userMessage(error)),
  });

  /** Writes a change into every page shown (and the open sheet), without asking for the pages again. */
  const patchRows = (ids: ReadonlySet<number>, patch: Partial<AdminSourceRow>) => {
    queryClient.setQueriesData<InfiniteData<AdminSourcesList>>({ queryKey: sourceKeys.pages }, (current) =>
      current
        ? { ...current, pages: current.pages.map((page) => ({ ...page, items: page.items.map((item) => (ids.has(item.id) ? { ...item, ...patch } : item)) })) }
        : current,
    );
    setOpened((current) => (current && ids.has(current.id) ? { ...current, ...patch } : current));
  };

  const choose = (source: AdminSourceRow, on: boolean, shiftKey: boolean) => {
    const index = indexOf.get(source.id) ?? 0;
    const from = shiftKey && anchor.current !== null ? Math.min(anchor.current, index) : index;
    const to = shiftKey && anchor.current !== null ? Math.max(anchor.current, index) : index;
    const ids = new Set(selected);
    for (const item of items.slice(from, to + 1)) {
      if (on) ids.add(item.id);
      else ids.delete(item.id);
    }
    anchor.current = index;
    setSelection({ key: filtersKey, ids });
  };

  const chooseAll = (all: boolean) => {
    anchor.current = null;
    setSelection({ key: filtersKey, ids: all ? new Set(items.map((item) => item.id)) : NO_IDS });
  };

  const run = useMutation({
    mutationFn: (source: AdminSourceRow) => runSource(source.id),
    onSuccess: (_answer, source) => {
      toast.success(`Running ${source.name}`, 'The run continues in the background. Its result appears under Runs.');
      refresh();
    },
    onError: (error) => toast.error('The run did not start', userMessage(error)),
  });

  // v31 RUNS: Pause or Continue one source.
  const pauseToggle = useMutation({
    mutationFn: (source: AdminSourceRow) => (isPaused(source) ? continueSource(source.id) : pauseSource(source.id)),
    onSuccess: (row, source) => {
      patchRows(new Set([source.id]), { pausedAt: row.pausedAt ?? null, pausedBy: row.pausedBy ?? null, nextRunAt: row.nextRunAt });
      const words = sourcePauseToast(source.name, Boolean(row.pausedAt));
      toast.success(words.title, words.description);
      void queryClient.invalidateQueries({ queryKey: runKeys.all });
    },
    onError: (error, source) => toast.error(isPaused(source) ? 'The source did not continue' : 'The source was not paused', userMessage(error)),
  });

  // v36 SOURCES: the answer's row says who turned it on and whether it still waits for an admin.
  const toggle = useMutation({
    mutationFn: (source: AdminSourceRow) => setSourceEnabled(source.id, !source.enabled),
    onSuccess: (row, source) => {
      patchRows(new Set([source.id]), {
        enabled: row.enabled,
        enabledAt: row.enabledAt ?? null,
        enabledBy: row.enabledBy ?? null,
        waitingForAdmin: row.waitingForAdmin ?? false,
        nextRunAt: row.nextRunAt,
      });
      if (row.enabled) hostsChanged(); // v37 TRANSFER
    },
    onError: (error) => toast.error('The source was not changed', userMessage(error)),
  });

  const bulk = useMutation({
    mutationFn: ({ action, ids }: { action: AdminSourceBulkAction; ids: number[] }) =>
      runBulk(ids, (turn) => bulkSources(action, turn), (error) => userMessage(error)),
    onSuccess: (result, { action }) => {
      const names = new Map(items.map((item) => [item.id, item.name]));
      setOutcome({ summary: bulkSummary(action, result), problems: bulkProblems(result, (id) => names.get(Number(id))) });
      const done = new Set(result.results.filter((row) => row.outcome === 'done').map((row) => Number(row.id)));
      if (action !== 'run_now') patchRows(done, action === 'enable' ? { enabled: true, waitingForAdmin: false } : { enabled: false }); // v36 SOURCES
      if (action === 'enable' && done.size > 0) hostsChanged(); // v37 TRANSFER
      setSelection({ key: filtersKey, ids: new Set([...selected].filter((id) => !done.has(id))) });
      void queryClient.invalidateQueries({ queryKey: sourceKeys.pages });
    },
    onError: (error) => toast.error('The sources were not changed', userMessage(error)),
  });

  // v35 OPSWEB: the count of what the action would change, read when its confirm opens (never an old count).
  const allCount = useQuery({
    queryKey: sourceKeys.allCount(filters),
    queryFn: ({ signal }) => fetchSourcesAllCount(filters, signal),
    enabled: allAction !== null,
    staleTime: 0,
    gcTime: 0,
  });
  const allWords = allAction && allCount.data ? allConfirmText(allAction, allCount.data) : null;
  const changeAll = async (action: AdminSourceAllAction) => {
    try {
      const result = await changeAllSources(action, filters);
      const line = allResultLine(result);
      setOutcome({ summary: { title: line.text, description: null, tone: line.tone }, problems: [] });
      setAllAction(null);
      void queryClient.invalidateQueries({ queryKey: sourceKeys.pages });
      if (action === 'enable') hostsChanged(); // v37 TRANSFER
    } catch (error) {
      throw new Error(userMessage(error));
    }
  };

  const openSheet = (source: AdminSourceRow) => {
    setOpened(source);
    setOpenId(source.id);
  };

  const columns: AdminColumn<AdminSourceRow>[] = [
    {
      key: 'select',
      header: (
        <Checkbox
          checked={items.length > 0 && selected.size === items.length}
          indeterminate={selected.size > 0 && selected.size < items.length}
          onCheckedChange={(all) => chooseAll(all)}
          aria-label="Choose every source shown"
        />
      ),
      className: 'w-10 pr-0',
      cell: (source) => (
        <Checkbox checked={selected.has(source.id)} onCheckedChange={(on, details) => choose(source, on, details.shiftKey)} aria-label={`Choose ${source.name}`} />
      ),
    },
    {
      key: 'source',
      header: 'Source',
      sticky: true, // v31 FIX-WEB (REV-UX UX-2): on a narrow screen the name stays beside Run now while the row scrolls
      cell: (source) => (
        // v31 FIX-WEB (UX-2): 160-256 px (160 in a phone's table, which scrolls under it), so the name and its line
        // truncate instead of widening the table.
        <div className="max-w-64 min-w-40 @max-[40rem]/table:max-w-40">
          <button type="button" onClick={() => openSheet(source)} className="block min-w-0 max-w-full rounded-control text-left">
            {/* v30 FIX-WEB (REV-UX UX-9): the name is the visible words after a hidden verb (Label in Name). */}
            <span className="sr-only">Open </span>
            <span className="block truncate font-semibold hover:underline">{source.name}</span>
            <span className="block truncate text-[13px] text-muted-foreground">{sourceLine(source)}</span>
          </button>
          {/* v30 FIX-WEB (REV-UX UX-7): in a narrow table the open jobs, terms and robots sit here, so the row's actions stay
              in view. v31 FIX-WEB (REV-UX UX-2): by the table's own width (a container query), not the window's: with
              the sidebar a 1440 px window has a 1142 px table; and the tier is always here (no column of its own). */}
          <span className="mt-1 flex flex-wrap items-center gap-1" data-source-access-inline="">
            <span className={clsx('mr-1 text-[13px] text-muted-foreground tabular-nums', SOURCES_WIDE.hide)}>
              {`${formatCount(source.openJobs)} open ${source.openJobs === 1 ? 'job' : 'jobs'}`}
            </span>
            <Badge tone={TIER_TONE[source.tier]}>{JOB_SOURCE_TIER_LABEL[source.tier]}</Badge>
            <Badge tone={termsTone(source.termsStatus)} className={SOURCES_WIDE.hide} wrap>
              Terms: {JOB_SOURCE_TERMS_LABEL[source.termsStatus]}
            </Badge>
            <Badge tone={robotsTone(source.robotsStatus)} className={SOURCES_WIDE.hide} wrap>
              Robots: {robotsLabelOf(source)}
            </Badge>
          </span>
        </div>
      ),
    },
    {
      key: 'enabled',
      header: 'Enabled',
      className: 'w-24',
      cell: (source) => (
        // v38 FIX-APP (REVIEW38-ux L10): a links-only source has no run switch (it is never run): it says so.
        !source.enabled && linksOnlyBoard(source) ? (
          <span className="text-[13px] leading-5 text-muted-foreground" data-links-only="">
            {LINKS_ONLY.label}
          </span>
        ) : (
          <Switch
            checked={source.enabled}
            onCheckedChange={() => toggle.mutate(source)}
            disabled={toggle.isPending || (!source.enabled && isUnrun(source))}
            aria-label={`${source.enabled ? 'Disable' : 'Enable'} ${source.name}`}
          />
        )
      ),
    },
    {
      key: 'runs',
      header: 'Runs',
      className: 'w-40',
      cell: (source) => (
        // v31 FIX-WEB (REV-UX UX-2): at least 128 px, so a line wraps between phrases, never a word a line.
        <div className="min-w-32 text-[13px] leading-5">
          {linksOnlyBoard(source) && !source.running ? null : source.nextRunAt && source.enabled && !source.running ? (
            <Tooltip content={new Date(source.nextRunAt).toLocaleString('en-US')}>
              <span className="block">{scheduleText(source, now)}</span>
            </Tooltip>
          ) : (
            <span className="block">{scheduleText(source, now)}</span>
          )}
          {/* v38 FIX-APP (REVIEW38-ux L10): a links-only source says what TailorIT does with it (no "Never run"). */}
          <span className="block text-muted-foreground">
            {linksOnlyBoard(source) && !source.lastRunAt ? LINKS_ONLY.text : source.lastRunAt ? `Last ${relativeTime(source.lastRunAt, now)}` : 'Never run'}
          </span>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      className: 'w-36',
      cell: (source) => (
        <div className="flex flex-col items-start gap-1">
          {/* v31 RUNS: a paused source reads Paused, by whom and since when. */}
          {/* v38 FIX-APP (REVIEW38-ux L10): a links-only source that never ran has no run status (no "Never run"). */}
          {!(linksOnlyBoard(source) && !source.lastStatus && !source.running) && (
            <RunStatusBadge status={source.running ? 'running' : isPaused(source) ? 'paused' : source.lastStatus} />
          )}
          {isPaused(source) && <span className="text-[13px] text-muted-foreground">{sourcePausedText(source, now)}</span>}
          {/* v35 OPSWEB (PLAN H7): switched on, but it cannot run now: why, in its "?". */}
          {source.enabled && <WaitingBadge waiting={source.waiting} name={source.name} />}
          {/* v36 SOURCES (PLAN S8): found, never turned on. */}
          {source.waitingForAdmin && <WaitingForAdminBadge name={source.name} />}
          {failureText(source) && <span className="text-[13px] text-danger">{failureText(source)}</span>}
        </div>
      ),
    },
    {
      key: 'access',
      header: 'Terms and robots',
      className: clsx('w-40', SOURCES_WIDE.show), // v30 FIX-WEB (UX-7), v31 FIX-WEB (UX-2): a wide table only
      cell: (source) => (
        <div className="flex flex-col items-start gap-1">
          <Badge tone={termsTone(source.termsStatus)} wrap>
            Terms: {JOB_SOURCE_TERMS_LABEL[source.termsStatus]}
          </Badge>
          <Badge tone={robotsTone(source.robotsStatus)} wrap>
            Robots: {robotsLabelOf(source)}
          </Badge>
        </div>
      ),
    },
    {
      key: 'jobs',
      header: 'Open jobs',
      className: clsx('w-28 text-right', SOURCES_WIDE.show), // v30 FIX-WEB (UX-7): in a narrow table, in the Source cell
      cell: (source) => <span className="num">{formatCount(source.openJobs)}</span>,
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      className: 'w-40 text-right',
      cell: (source) => (
        <div className="flex items-center justify-end gap-1.5">
          <RunNowButton
            sourceId={source.id}
            running={Boolean(source.running)}
            hint={
              source.running
                ? null
                : (pausedRunNowHint(source, Boolean(runsPause.paused), t) ?? offRunNowHint(source, t) ?? termsRunNowHint(source, t) ?? runNowHint(source))
            }
            disabled={
              Boolean(source.running) ||
              isUnrun(source) ||
              isPaused(source) || // v31 RUNS
              offRunNowHint(source, t) !== null || // v36 SOURCES (PLAN S5): it is off
              termsRunNowHint(source, t) !== null || // v37 FIX-37B (E8): its terms don't allow reading
              Boolean(runsPause.paused) ||
              (run.isPending && run.variables?.id === source.id)
            }
            onRun={() => run.mutate(source)}
          />
          <Menu>
            <MenuTrigger
              render={<IconButton label={`More actions for ${source.name}`} icon={<DotsThreeIcon size={18} weight="bold" />} size="sm" tooltip={false} />}
            />
            <MenuContent align="end" width="w-56">
              <MenuItem onClick={() => openSheet(source)}>Details</MenuItem>
              <MenuItem onClick={() => onShowRuns(source.id)}>See runs</MenuItem>
              {/* v31 RUNS */}
              {!isUnrun(source) && (
                <MenuItem
                  icon={isPaused(source) ? <PlayIcon size={16} weight="fill" /> : <PauseIcon size={16} weight="fill" />}
                  disabled={pauseToggle.isPending}
                  onClick={() => pauseToggle.mutate(source)}
                >
                  {isPaused(source) ? 'Continue source' : 'Pause source'}
                </MenuItem>
              )}
              {source.host && <MenuItem onClick={() => link({ tab: 'hosts', host: source.host })}>Open its host</MenuItem>}
              <MenuSeparator />
              <MenuItem tone="danger" onClick={() => setPurging(source)}>
                Purge source
              </MenuItem>
              {isDeletable(source) && (
                <MenuItem icon={<TrashIcon />} tone="danger" disabled={source.running} onClick={() => setDeleting(source)}>
                  Delete source
                </MenuItem>
              )}
            </MenuContent>
          </Menu>
        </div>
      ),
    },
  ];

  const filtered = isFiltered(filters);
  const hidden = (outcome?.problems.length ?? 0) - PROBLEMS_SHOWN;

  return (
    <AdminResourceTab
      sectionProps={{ 'aria-labelledby': 'admin-sources-title' }}
      title="Job sources"
      description="Every board and feed TailorIT reads; due sources run on their own."
      actions={
        <>
          <Button variant="outline" icon={<TrashIcon size={16} />} onClick={() => setPurgesOpen(true)}>
            Purges
          </Button>
          <IconButton label="Refresh the sources" icon={<ArrowsClockwiseIcon size={16} />} variant="outline" onClick={() => void sources.refetch()} />
          {/* v37 TRANSFER (PLAN T1, T2): a sources file of what the filter shows, and the sources of a file, added off. */}
          {/* v37 FIX-37B (the ux review's L8): named for what they move, apart from the Admin tab "Import" (job links). */}
          <Button
            variant="outline"
            className="max-sm:h-11"
            icon={<UploadSimpleIcon size={16} />}
            aria-haspopup="dialog"
            onClick={() => setImporting((now) => ({ key: now.key + 1, open: true }))}
            data-sources-import-open=""
          >
            Import sources
          </Button>
          {/* v37 FIX-37B (E4, L10): its "?" says what a file holds (terms notes word for word); off with nothing shown. */}
          <span className="flex items-center gap-1" data-sources-export-group="">
            <Button
              variant="outline"
              className="max-sm:h-11"
              icon={<DownloadSimpleIcon size={16} />}
              loading={exportFile.isPending}
              disabled={sources.data !== undefined && total === 0}
              focusableWhenDisabled
              aria-describedby={sources.data !== undefined && total === 0 ? 'sources-export-why' : undefined}
              onClick={() => exportFile.mutate()}
              data-sources-export=""
            >
              Export sources
            </Button>
            {sources.data !== undefined && total === 0 && (
              <span id="sources-export-why" hidden>
                Nothing to export: the search and filters show no sources.
              </span>
            )}
            <HelpTip label="Export sources">{EXPORT_TIP}</HelpTip>
          </span>
          <Button icon={<PlusIcon size={16} />} onClick={() => setAdding(true)}>
            Add source
          </Button>
        </>
      }
      lead={
        <>
          <span id="admin-sources-title" className="sr-only">
            Job sources
          </span>
          {/* v36 SOURCES (PLAN S7): the sources v3.6 turned off, once. */}
          <TurnedOffNotice
            onShow={(part) => narrow({ turnedOff: part })}
            onEnableAll={() => {
              narrow({ turnedOff: 'all' });
              setAllAction('enable');
            }}
            onDismissed={() => focusLater(SOURCES_SEARCH)} // v36 FIX-SRC (ux L5): to the next control, not the page's top
          />
          {/* v31 RUNS: every run paused: no source runs until Continue. v32 COPY (E4): states are chips with a "?" and
              their button, not banners. */}
          {(runsPause.paused || alarms.length > 0) && (
            <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2">
              {runsPause.paused && (
                <span className="flex flex-wrap items-center gap-2" data-sources-runs-paused="">
                  <span className="flex items-center gap-1">
                    <Badge tone="warning" icon={<PauseIcon size={12} weight="fill" aria-hidden="true" />}>
                      {runsBarText(runsPause.paused, now).title}
                    </Badge>
                    <HelpTip label={runsBarText(runsPause.paused, now).title}>{runsBarText(runsPause.paused, now).description}</HelpTip>
                  </span>
                  <Button
                    size="sm"
                    icon={<PlayIcon size={14} weight="fill" />}
                    loading={runsPause.continueAll.isPending}
                    onClick={() => runsPause.continueAll.mutate()}
                  >
                    Continue runs
                  </Button>
                </span>
              )}
              {alarms.length > 0 && (
                <span className="flex flex-wrap items-center gap-2" data-sources-alarms={alarms.length}>
                  <span className="flex items-center gap-1">
                    <Badge tone="warning" icon={<WarningCircleIcon size={12} weight="fill" aria-hidden="true" />}>
                      {`${alarmCount(alarms.length)} today`}
                    </Badge>
                    <HelpTip label={`${alarmCount(alarms.length)} today`}>
                      {alarmText(alarms[0]!)}
                      {alarms.length > 1 ? ` And ${alarms.length - 1} more.` : ''}
                    </HelpTip>
                  </span>
                  <Button variant="outline" size="sm" onClick={() => link({ tab: 'runs', view: 'report' })}>
                    See the daily report
                  </Button>
                </span>
              )}
            </div>
          )}
          <SourceFiltersBar
            filters={filters}
            search={search}
            onSearch={setSearch}
            onChange={narrow}
            onClear={() => {
              setSearch('');
              narrow(clearedFilters(filters));
              focusLater(SOURCES_SEARCH); // v30 FIX-WEB (UX-4)
            }}
            companyName={filters.companyId ? (items.find((item) => item.companyId === filters.companyId)?.companyName ?? null) : null}
          />
        </>
      }
      items={sources.data ? items : undefined}
      error={sources.error}
      errorTitle="Sources didn't load."
      errorAction={
        <Button variant="outline" size="sm" onClick={() => void sources.refetch()}>
          Try again
        </Button>
      }
      empty={
        filtered
          ? {
              title: 'No source matches',
              description: 'Try other filters.',
              card: false,
              action: (
                <Button
                  variant="outline"
                  onClick={() => {
                    setSearch('');
                    narrow(clearedFilters(filters));
                    focusLater(SOURCES_SEARCH); // v30 FIX-WEB (UX-4): the empty state goes with the filters
                  }}
                >
                  Clear filters
                </Button>
              ),
            }
          : {
              icon: <BriefcaseIcon size={22} />,
              title: 'No job sources yet',
              description: 'Add a board, the free_tailor lake or the demo jobs.', // v35 OPSWEB: an import is not a source
              action: <Button onClick={() => setAdding(true)}>Add source</Button>,
            }
      }
      toolbar={
        <>
          {/* A live region that stays, so each bulk action's outcome is read aloud. */}
          <div aria-live="polite">
            {outcome && (
              <Notice
                tone={outcome.summary.tone}
                className="mb-3"
                title={outcome.summary.title}
                action={
                  <span className="flex flex-wrap items-center gap-2">
                    {/* v37 TRANSFER: an import's outcome shows the sources it added. */}
                    {outcome.show && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="max-sm:h-11"
                        onClick={() => {
                          setSearch('');
                          narrow(outcome.show!);
                        }}
                      >
                        Show imported sources
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => setOutcome(null)}>
                      Dismiss
                    </Button>
                  </span>
                }
              >
                {outcome.summary.description}
                {outcome.problems.length > 0 && (
                  <ul className="mt-1 list-disc pl-5" aria-label="Sources not changed">
                    {outcome.problems.slice(0, PROBLEMS_SHOWN).map((problem) => (
                      <li key={problem.id}>
                        {problem.name}: {problem.message}
                      </li>
                    ))}
                  </ul>
                )}
                {hidden > 0 && <p className="mt-1">And {formatCount(hidden)} more.</p>}
              </Notice>
            )}
          </div>
          {/* v35 OPSWEB (PLAN H6): Enable all / Disable all act on every source the filter shows, not only the loaded rows. */}
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="text-sm text-muted-foreground" aria-live="polite" data-sources-total={total}>
              {formatCount(total)} {total === 1 ? 'source' : 'sources'}
              {items.length < total ? `, ${formatCount(items.length)} shown` : ''}
            </p>
            {total > 0 && (
              <span className="flex items-center gap-1.5 sm:ml-auto" data-sources-all="">
                <Button variant="outline" size="sm" className="max-sm:h-11" aria-haspopup="dialog" onClick={() => setAllAction('enable')}>
                  Enable all
                </Button>
                <Button variant="outline" size="sm" className="max-sm:h-11" aria-haspopup="dialog" onClick={() => setAllAction('disable')}>
                  Disable all
                </Button>
                <HelpTip label="Enable all and Disable all">Every source the search and filters show, loaded or not.</HelpTip>
              </span>
            )}
          </div>
        </>
      }
      footer={
        <>
          {/* The bulk bar shows while sources are chosen, stuck to the window's foot as the table scrolls. */}
          {selected.size > 0 && (
            <SelectBar
              aria-label="Change the chosen sources"
              selected={selected.size}
              selectable={items.length}
              selectAllLabel="Choose every source shown"
              onSelectAll={chooseAll}
            >
              {ADMIN_SOURCE_BULK_ACTIONS.map((action) => (
                <Button
                  key={action}
                  size="sm"
                  variant={action === 'run_now' ? 'primary' : 'outline'}
                  disabled={selected.size === 0 || bulk.isPending}
                  loading={bulk.isPending && bulk.variables?.action === action}
                  onClick={() => bulk.mutate({ action, ids: [...selected] })}
                >
                  {BULK_ACTION_LABEL[action]}
                </Button>
              ))}
            </SelectBar>
          )}
          {/* v30 FIX-WEB (UX-4): focus stays on the button while the next page loads. */}
          <ShowMoreButton hasMore={sources.hasNextPage} loading={sources.isFetchingNextPage} onMore={() => void sources.fetchNextPage()} afterLast={['table[aria-label="Job sources"] tbody tr:last-of-type button', 'table[aria-label="Job sources"] tbody tr:last-of-type [role="checkbox"]']}>
            Show more sources
          </ShowMoreButton>
        </>
      }
      tableLabel="Job sources"
      columns={columns}
      getKey={(source) => source.id}
      tableClassName={clsx(sources.isPlaceholderData && 'opacity-70')}
    >
      <SourceSheet
        source={opened}
        open={openId !== null && opened?.id === openId}
        onOpenChange={(open) => !open && setOpenId(null)}
        now={now}
        onRun={(source) => run.mutate(source)}
        running={run.isPending && run.variables?.id === opened?.id}
        onPauseToggle={(source) => pauseToggle.mutate(source)}
        pauseBusy={pauseToggle.isPending && pauseToggle.variables?.id === opened?.id}
        pausedHint={opened ? (pausedRunNowHint(opened, Boolean(runsPause.paused), t) ?? offRunNowHint(opened, t) ?? termsRunNowHint(opened, t)) : null} // v36 SOURCES: or off; v37 FIX-37B: or its terms
        onTermsSaved={(row) => patchRows(new Set([row.id]), { termsStatus: row.termsStatus, waiting: row.waiting ?? null })} // v37 FIX-37B (E8)
        onShowRuns={onShowRuns}
        onShowHost={(host) => link({ tab: 'hosts', host })}
        onPurge={(source) => setPurging(source)}
      />
      <PurgeDialog
        source={purging}
        open={purging !== null}
        onOpenChange={(open) => !open && setPurging(null)}
        onStarted={(purge) => {
          toast.success('Purge queued', `${purge.sourceName ?? purge.companyName ?? 'The source'} is purged in batches. Follow it under Purges.`);
          setPurging(null);
          refresh();
        }}
      />
      <PurgesSheet open={purgesOpen} onOpenChange={setPurgesOpen} />
      <AddSourceDialog
        open={adding}
        onOpenChange={setAdding}
        onCreated={(source) => {
          // v36 SOURCES (PLAN S4): added on (Turn on now) or off.
          toast.success(
            'Source added',
            source.enabled === false
              ? `${source.name} is off. Turn it on when you want TailorIT to read it.`
              : `${source.name} is on. Run it now to fetch its jobs.`,
          );
          refresh();
          if (source.enabled !== false) hostsChanged(); // v37 TRANSFER
        }}
      />
      {/* v37 TRANSFER (PLAN T2): the outcome goes above the table, with a filter for the sources it added. */}
      <ImportSourcesDialog
        key={importing.key}
        open={importing.open}
        onOpenChange={(open) => setImporting((now) => ({ ...now, open }))}
        onImported={(result) => {
          setOutcome({
            summary: importSummary(result),
            problems: importProblems(result),
            ...(result.counts.new + result.counts.renamed > 0 ? { show: { ...clearedFilters(filters), via: ['file'], enabled: 'waiting' } } : {}),
          });
          refresh();
        }}
      />
      {/* v35 OPSWEB (PLAN H6): "Enable 42 sources?" with the server's count, then one request and one result line. */}
      <ConfirmDialog
        open={allAction !== null}
        onOpenChange={(open) => !open && setAllAction(null)}
        tone={allAction === 'disable' ? 'destructive' : 'primary'}
        title={allWords?.title ?? (allAction === 'disable' ? 'Disable every source shown?' : 'Enable every source shown?')}
        description={
          allCount.isError
            ? `The sources could not be counted. ${userMessage(allCount.error)}`
            : allWords
              ? allWords.changes === 0
                ? `Nothing to change: every source shown is ${allAction === 'enable' ? 'on already or cannot run' : 'off already'}.`
                : allWords.description
              : 'Counting the sources...'
        }
        confirmLabel={allWords && allWords.changes > 0 ? allWords.confirm : allAction === 'disable' ? 'Disable all' : 'Enable all'}
        busyLabel={allAction === 'disable' ? 'Disabling...' : 'Enabling...'}
        confirmDisabled={!allWords || allWords.changes === 0}
        focusCancel
        onConfirm={async () => {
          if (allAction) await changeAll(allAction);
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete source"
        description={
          deleting
            ? `Delete ${deleting.name}? Jobs only this source lists are closed, and its run history is deleted. There is no undo.`
            : undefined
        }
        confirmLabel="Delete"
        busyLabel="Deleting..."
        onConfirm={async () => {
          if (!deleting) return;
          await deleteSource(deleting.id);
          toast.success('Source deleted');
          setDeleting(null);
          refresh();
        }}
      />
    </AdminResourceTab>
  );
}
