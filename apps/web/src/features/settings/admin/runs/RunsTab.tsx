'use client';

import { PauseIcon } from '@phosphor-icons/react/Pause';
import { PlayIcon } from '@phosphor-icons/react/Play';
import { JOB_SOURCE_KIND_LABEL, JOB_SOURCE_RUN_STATUSES, type JobSourceRunStatus } from '@tailorit/shared/sourcing';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useSearchParams } from 'next/navigation';
import { useRef, useState } from 'react';
import { AdminResourceTab, type AdminColumn } from '@/components/admin';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { IconButton } from '@/components/ui/IconButton';
import { HelpTip } from '@/components/ui/HelpTip';
import { ArrowsClockwiseIcon, CaretDownIcon, CaretRightIcon } from '@/components/ui/icons';
import { Notice } from '@/components/ui/Notice';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { Tooltip } from '@/components/ui/Tooltip';
import { userMessage } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { fetchSourceSettings, sourceKeys } from '../sources/api';
import { useAdminLink } from '../sources/links';
import { ChoiceMenu } from '../sources/SourceFilters';
import { formatCount } from '../sources/sources';
import { continueRun, fetchRunLog, fetchRunRow, fetchRunsPage, pauseRun, runKeys, type AdminRunRow, type RunFilters } from './api';
import { DailyReport } from './DailyReport';
import { ImportRunDetail } from './ImportRunDetail'; // v35 OPSWEB
import { runOfSearch } from '../import/address'; // v35 INT-B
import {
  IMPORT_READING_LABEL, // v35 FIX-WEB
  RUN_KIND_FILTERS,
  importRunCounts,
  importRunLabel,
  importRunReading,
  isImportRun,
  namedRunChip, // v35 FIX-WEB
  onlyNamedRun, // v35 FIX-WEB
  recordRunsLabel, // v35 FIX-WEB
  runsListSource, // v35 INT-B
  runsSourceChip, // v35 INT-B
  startedByText,
  type RunKindFilter,
} from './imports'; // v35 OPSWEB
import { RUNS_EMPTY, RunErrorLine, RunStatusBadge, runCounts, runDuration, runTriggerLabel } from './parts';
import { Badge } from '@/components/ui/Badge'; // v35 FIX-WEB (L3)
import { PAUSE_ALL_CONFIRM, continuedRunToast, pausingRunToast, runRowAction, runsBarText } from './pause';
import { useRunsPause } from './useRunsPause';

type RunsView = 'history' | 'report';
const VIEWS: ReadonlyArray<{ value: RunsView; label: string }> = [
  { value: 'history', label: 'Run history' },
  { value: 'report', label: 'Daily report' },
];
const STATUS_LABEL: Record<JobSourceRunStatus, string> = {
  running: 'Running',
  succeeded: 'Succeeded',
  partial: 'Partial',
  failed: 'Failed',
  not_modified: 'Not modified (304)',
  paused: 'Paused', // v31 RUNS
};
/** v35 OPSWEB: the Kind filter's words: the source kinds', and "Imports". */
const RUN_KIND_LABEL: Record<RunKindFilter, string> = { ...JOB_SOURCE_KIND_LABEL, import: 'Imports' };

/** While a run shown is going, its row is asked again this often (the first page only). */
const FOLLOW_MS = 3000;
/** v31 RUNS: where focus goes once the bar's Pause all closes its confirm (the bar's Continue). */
const CONTINUE_ALL_BUTTON = '[data-runs-continue-all]';

/**
 * v31 RUNS: the Runs tab's bar: "Runs are running" with Pause all (after a confirm), or "Runs are paused" since when and
 * by whom, with Continue.
 */
function RunsBar({ now, state }: { now: number; state: ReturnType<typeof useRunsPause> }) {
  const [confirming, setConfirming] = useState(false);
  const continueButton = useRef<HTMLButtonElement>(null);
  if (!state.known) return null;
  const text = runsBarText(state.paused, now);
  return (
    <div className="mb-4" data-runs-state={state.paused ? 'paused' : 'running'}>
      {/* v32 COPY (E4/E5): one status bar for both states (a dot, the state, its "?"), never an amber banner. */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface px-4 py-3 shadow-card">
        <div className="flex min-w-0 flex-1 basis-60 items-center gap-3 text-sm leading-5">
          <span aria-hidden="true" className={clsx('size-2.5 shrink-0 rounded-full', state.paused ? 'bg-warning' : 'bg-success')} />
          <p className="flex min-w-0 items-center gap-1.5 font-semibold text-foreground">
            {text.title}
            <HelpTip label={text.title}>{text.description}</HelpTip>
          </p>
        </div>
        {state.paused ? (
          <Button
            ref={continueButton}
            size="sm"
            icon={<PlayIcon size={14} weight="fill" />}
            loading={state.continueAll.isPending}
            onClick={() => state.continueAll.mutate()}
            data-runs-continue-all=""
          >
            Continue
          </Button>
        ) : (
          <Button variant="outline" size="sm" icon={<PauseIcon size={14} weight="fill" />} onClick={() => setConfirming(true)} data-runs-pause-all="">
            Pause all
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        tone="primary"
        title={PAUSE_ALL_CONFIRM.title}
        description={PAUSE_ALL_CONFIRM.description}
        confirmLabel={PAUSE_ALL_CONFIRM.confirmLabel}
        busyLabel={PAUSE_ALL_CONFIRM.busyLabel}
        focusConfirm
        onConfirm={async () => {
          await state.pauseAll();
          setConfirming(false);
        }}
        finalFocus={() => continueButton.current ?? document.querySelector<HTMLElement>(CONTINUE_ALL_BUTTON) ?? true}
      />
    </div>
  );
}

/**
 * Admin › Runs (v30 S1-WEB, 12 §9.8): the run history at scale, newest first (one source from the address, kinds and
 * statuses as filters, a page behind a cursor), a row opening to its error and log; and the daily report.
 */
export function RunsTab({ sourceId, onSourceChange }: { sourceId: number | null; onSourceChange: (sourceId: number | null) => void }) {
  const now = useNow();
  const link = useAdminLink();
  const toast = useToast();
  const pause = useRunsPause(); // v31 RUNS
  const address = useSearchParams();
  const view: RunsView = address.get('view') === 'report' ? 'report' : 'history';
  // v35 INT-B (SP v35 build/WAVE2-LINKS.md): `?run=<runId>` (Import results' "See it on Runs") opens that run among the
  // runs of its record, read from the run (GET /api/admin/runs/:id) when the address names no source.
  const namedRun = runOfSearch(address.get('run'));
  const [kinds, setKinds] = useState<RunKindFilter[]>([]);
  const [statuses, setStatuses] = useState<JobSourceRunStatus[]>([]);
  // v35 FIX-WEB (the ux review's L7): the named run as a history row; an import's is listed alone (its own chip), with
  // "Every run of …" for the runs of its record. It is read again while it runs or its rows are read.
  const named = useQuery({
    queryKey: runKeys.row(namedRun ?? 0),
    queryFn: ({ signal }) => fetchRunRow(namedRun!, signal),
    enabled: namedRun !== null && sourceId === null,
    retry: false,
    refetchInterval: (query) => (query.state.data && (query.state.data.status === 'running' || importRunReading(query.state.data)) ? FOLLOW_MS : false),
  });
  const alone = onlyNamedRun(sourceId, namedRun, named.data) && kinds.length === 0 && statuses.length === 0;
  const listSourceId = alone ? null : runsListSource(sourceId, namedRun, named.data?.sourceId);
  const waitingForNamed = namedRun !== null && sourceId === null && named.isPending;
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set(namedRun !== null ? [namedRun] : []));
  const filters: RunFilters = { sourceId: listSourceId, kinds, statuses };

  const runs = useInfiniteQuery({
    queryKey: runKeys.page(filters),
    queryFn: ({ pageParam, signal }) => fetchRunsPage(filters, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
    enabled: view === 'history' && !waitingForNamed && !alone, // v35 INT-B: the named run's record first; v35 FIX-WEB: or it alone
    // Follow a running run while only the first page is shown (a long history is refreshed by hand).
    refetchInterval: (query) => {
      const pages = query.state.data?.pages ?? [];
      // v35 OPSWEB: an import whose rows TailorIT still reads (no counts yet) is followed too.
      return pages.length === 1 && pages[0]!.items.some((run) => run.status === 'running' || importRunReading(run)) ? FOLLOW_MS : false;
    },
  });
  const source = useQuery({
    queryKey: sourceKeys.detail(listSourceId ?? 0),
    queryFn: ({ signal }) => fetchSourceSettings(listSourceId!, signal),
    enabled: listSourceId !== null,
    retry: false,
  });

  const items = alone && named.data ? [named.data] : (runs.data?.pages.flatMap((page) => page.items) ?? []);

  // v31 RUNS: a run's Pause (it stops at its next safe point) and a paused run's Continue (its source runs again now).
  const pauseOne = useMutation({
    mutationFn: (run: AdminRunRow) => pauseRun(run.id),
    onSuccess: (_answer, run) => {
      const words = pausingRunToast(run.id);
      toast.success(words.title, words.description);
      pause.refresh();
    },
    onError: (error) => toast.error('The run was not paused', userMessage(error)),
  });
  const continueOne = useMutation({
    mutationFn: (run: AdminRunRow) => continueRun(run.id),
    onSuccess: (_answer, run) => {
      const words = continuedRunToast(run.sourceName);
      toast.success(words.title, words.description);
      pause.refresh();
    },
    onError: (error) => toast.error('The run did not continue', userMessage(error)),
  });
  const sourceName = source.data?.name ?? items.find((run) => run.sourceId === listSourceId)?.sourceName ?? (listSourceId ? `Source #${listSourceId}` : null);
  // v35 INT-B: the run that names the chip (an import's record reads "Import: <name>").
  const chipRun = items.find((run) => run.id === namedRun) ?? items.find((run) => run.sourceId === listSourceId);
  const toggle = (id: number) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const columns: AdminColumn<AdminRunRow>[] = [
    {
      key: 'open',
      header: <span className="sr-only">Details</span>,
      className: 'w-12 pr-0',
      cell: (run) => (
        <IconButton
          label={
            isImportRun(run) // v35 OPSWEB: an import opens to its results and Sources found
              ? `${expanded.has(run.id) ? 'Hide' : 'Show'} the import of run ${run.id}`
              : expanded.has(run.id)
                ? `Hide the log of run ${run.id}`
                : `Show the log of run ${run.id}`
          }
          icon={expanded.has(run.id) ? <CaretDownIcon size={16} /> : <CaretRightIcon size={16} />}
          size="sm"
          tooltip={false}
          aria-expanded={expanded.has(run.id)}
          onClick={() => toggle(run.id)}
        />
      ),
    },
    {
      key: 'source',
      header: 'Source',
      className: 'min-w-52',
      cell: (run) =>
        // v35 OPSWEB (PLAN H6): an import is named "Import · <name>", with who started it.
        isImportRun(run) ? (
          <div className="min-w-0 max-w-80" data-run-import={run.importOf?.import?.id ?? ''}>
            <p className="truncate font-semibold" title={importRunLabel(run)}>
              {importRunLabel(run)}
            </p>
            <p className="truncate text-[13px] text-muted-foreground">{[startedByText(run), `Run ${run.id}`].filter(Boolean).join(' · ')}</p>
          </div>
        ) : (
          <div className="min-w-0">
            <p className="truncate font-semibold">{run.sourceName}</p>
            <p className="text-[13px] text-muted-foreground">
              {run.sourceKindLabel || JOB_SOURCE_KIND_LABEL[run.sourceKind]} · Run {run.id}
            </p>
          </div>
        ),
    },
    { key: 'trigger', header: 'Trigger', className: 'w-32', cell: (run) => (isImportRun(run) ? 'Import' : runTriggerLabel(run)) }, // v35 OPSWEB
    {
      key: 'started',
      header: 'Started',
      className: 'w-36',
      cell: (run) => (
        <Tooltip content={new Date(run.startedAt).toLocaleString('en-US')}>
          <span>{relativeTime(run.startedAt, now)}</span>
        </Tooltip>
      ),
    },
    // v35 FIX-WEB (L3): an import's Took means nothing (its rows are read by the queue afterwards): "-".
    { key: 'took', header: 'Took', className: 'w-20 text-muted-foreground', cell: (run) => (isImportRun(run) ? '-' : runDuration(run)) },
    {
      key: 'status',
      header: 'Status',
      className: 'w-40',
      cell: (run) => (
        <div className="flex flex-col items-start gap-1">
          {/* v35 FIX-WEB (L3): an import whose rows TailorIT still reads says so, not its record run's "Succeeded". */}
          {isImportRun(run) && importRunReading(run) ? (
            <Badge tone="sky" data-run-import-reading="">
              {IMPORT_READING_LABEL}
            </Badge>
          ) : (
            <RunStatusBadge status={run.status} />
          )}
          <RunErrorLine code={run.errorCode} />
        </div>
      ),
    },
    {
      key: 'requests',
      header: 'Requests',
      className: 'w-28',
      cell: (run) =>
        // v35 FIX-WEB (L3): an import makes no requests of its own (the queue reads its links): "-".
        isImportRun(run) ? (
          <span className="text-[13px] leading-5 text-muted-foreground">-</span>
        ) : (
          <div className="text-[13px] leading-5">
            <span className="num block">{formatCount(run.requests)}</span>
            {run.httpStatus !== null && <span className="block text-muted-foreground">HTTP {run.httpStatus}</span>}
          </div>
        ),
    },
    {
      key: 'counts',
      header: 'Postings',
      className: 'w-72',
      cell: (run) => {
        // v35 OPSWEB (PLAN H6): an import's rows and what came of them ("12 added · 3 reposted · 2 to review").
        if (isImportRun(run)) {
          const counts = importRunCounts(run);
          return (
            <div data-run-import-counts="">
              <p>
                <span className="num">{formatCount(counts.rowCount)}</span> <span className="text-muted-foreground">{counts.rowCount === 1 ? 'row' : 'rows'}</span>
              </p>
              <p className="text-[13px] text-muted-foreground">{counts.line}</p>
            </div>
          );
        }
        return (
          <div>
            <p>
              <span className="num">{formatCount(run.fetched)}</span> <span className="text-muted-foreground">fetched</span>
            </p>
            <p className="text-[13px] text-muted-foreground">{runCounts(run)}</p>
          </div>
        );
      },
    },
    // v31 RUNS: Pause while it runs ("Pausing" once asked), Continue once paused.
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      className: 'w-32 text-right',
      cell: (run) => {
        const action = runRowAction(run);
        if (action === 'pause' || action === 'pausing') {
          return (
            <Button
              variant="outline"
              size="sm"
              icon={<PauseIcon size={14} weight="fill" />}
              loading={action === 'pausing' || (pauseOne.isPending && pauseOne.variables?.id === run.id)}
              focusableWhenDisabled
              aria-label={action === 'pausing' ? `Pausing run ${run.id}` : `Pause run ${run.id}`}
              onClick={() => pauseOne.mutate(run)}
            >
              {action === 'pausing' ? 'Pausing...' : 'Pause'}
            </Button>
          );
        }
        if (action === 'continue') {
          return (
            <Tooltip content={pause.paused ? 'Every run is paused: continue them first.' : null}>
              <Button
                variant="outline"
                size="sm"
                icon={<PlayIcon size={14} weight="fill" />}
                disabled={Boolean(pause.paused)}
                focusableWhenDisabled
                loading={continueOne.isPending && continueOne.variables?.id === run.id}
                aria-label={`Continue run ${run.id}`}
                onClick={() => continueOne.mutate(run)}
              >
                Continue
              </Button>
            </Tooltip>
          );
        }
        return null;
      },
    },
  ];

  const viewSwitch = (
    <SegmentedControl
      aria-label="Runs view"
      size="sm"
      items={VIEWS}
      value={view}
      onValueChange={(next) => link({ tab: 'runs', source: listSourceId, view: next === 'report' ? 'report' : null })}
    />
  );
  const description =
    'Every fetch of every source: what it found, what changed, and what went wrong. Missing postings are only closed after complete, successful fetches.';

  if (view === 'report') {
    return (
      <AdminResourceTab
        title="Runs"
        description={description}
        actions={viewSwitch}
        body={
          <>
            <RunsBar now={now} state={pause} />
            <DailyReport onShowHost={(host) => link({ tab: 'hosts', host })} />
          </>
        }
      />
    );
  }

  return (
    <AdminResourceTab
      title="Runs"
      description={description}
      actions={
        <>
          {viewSwitch}
          <IconButton label="Refresh the runs" icon={<ArrowsClockwiseIcon size={16} />} variant="outline" onClick={() => void (alone ? named.refetch() : runs.refetch())} />
        </>
      }
      lead={
        <>
          <RunsBar now={now} state={pause} />
          <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
            {/* v35 FIX-WEB (L7): one import's run alone, its chip naming the import, and the way to its record's runs. */}
            {alone && named.data && (
              <>
                <Chip tone="tint" onRemove={() => onSourceChange(null)} removeLabel="Show the runs of every source">
                  {namedRunChip(named.data)}
                </Chip>
                <Button variant="ghost" size="sm" onClick={() => link({ tab: 'runs', source: named.data!.sourceId })} data-runs-record="">
                  {recordRunsLabel(named.data)}
                </Button>
              </>
            )}
            {listSourceId !== null && (
              <Chip tone="tint" onRemove={() => onSourceChange(null)} removeLabel="Show the runs of every source">
                {runsSourceChip(sourceName ?? '', chipRun)}
              </Chip>
            )}
            <ChoiceMenu label="Kind" values={RUN_KIND_FILTERS} labels={RUN_KIND_LABEL} chosen={kinds} onChange={setKinds} />
            <ChoiceMenu label="Status" values={JOB_SOURCE_RUN_STATUSES} labels={STATUS_LABEL} chosen={statuses} onChange={setStatuses} />
          </div>
        </>
      }
      items={alone ? items : runs.data ? items : undefined}
      error={alone ? null : runs.error}
      errorTitle="Runs didn't load."
      errorAction={
        <Button variant="outline" size="sm" onClick={() => void runs.refetch()}>
          Try again
        </Button>
      }
      empty={
        alone || listSourceId !== null || kinds.length > 0 || statuses.length > 0
          ? { size: 'sm', ...RUNS_EMPTY.filtered }
          : { size: 'sm', ...RUNS_EMPTY.none } // v35 OPSWEB (PLAN H6): "No runs now"
      }
      tableLabel="Ingest runs"
      columns={columns}
      getKey={(run) => run.id}
      expanded={expanded}
      renderExpanded={(run) =>
        // v35 OPSWEB (PLAN H6): an import opens to its counts, Open results and Sources found, its log below.
        // At a phone's width the table scrolls sideways in its box: the import's part keeps to the box's visible width
        // and stays in view (the box is the `@container/table` the width is read from).
        isImportRun(run) ? (
          <div className="sticky left-4 flex w-[calc(100cqw-2rem)] max-w-full flex-col gap-3">
            <ImportRunDetail run={run} />
            <RunLog runId={run.id} running={run.status === 'running'} />
          </div>
        ) : (
          <RunLog runId={run.id} running={run.status === 'running'} />
        )
      }
      tableClassName={clsx(runs.isPlaceholderData && 'opacity-70')}
      footer={
        runs.hasNextPage && (
          <div className="mt-4 flex justify-center">
            <Button variant="outline" onClick={() => void runs.fetchNextPage()} loading={runs.isFetchingNextPage}>
              Load more
            </Button>
          </div>
        )
      }
    />
  );
}

/** A run's error and log lines, read when the row is opened. */
function RunLog({ runId, running }: { runId: number; running: boolean }) {
  const detail = useQuery({
    queryKey: runKeys.log(runId),
    queryFn: ({ signal }) => fetchRunLog(runId, signal),
    refetchInterval: running ? FOLLOW_MS : false,
  });
  if (detail.isPending) return <Spinner label="Loading the log..." />;
  if (detail.isError) return <Notice tone="error">{userMessage(detail.error)}</Notice>;
  const run = detail.data;
  return (
    <div className="flex flex-col gap-3">
      {run.error && (
        <Notice tone="error" title="This run failed">
          {run.error}
        </Notice>
      )}
      <pre
        aria-label={`Log of run ${run.id}`}
        className="max-h-80 overflow-auto rounded-control border border-border bg-surface px-3 py-2.5 font-mono text-xs leading-5 whitespace-pre-wrap text-foreground"
      >
        {run.log.length ? run.log.join('\n') : 'No log lines.'}
      </pre>
    </div>
  );
}
