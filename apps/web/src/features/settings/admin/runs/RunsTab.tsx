'use client';

import { PauseIcon } from '@phosphor-icons/react/Pause';
import { PlayIcon } from '@phosphor-icons/react/Play';
import {
  JOB_SOURCE_KIND_LABEL,
  JOB_SOURCE_RUN_STATUSES,
  type JobSourceKind,
  type JobSourceRunStatus,
} from '@tailorit/shared/sourcing';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useSearchParams } from 'next/navigation';
import { useRef, useState } from 'react';
import { AdminResourceTab, type AdminColumn } from '@/components/admin';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { IconButton } from '@/components/ui/IconButton';
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
import { FILTER_KINDS } from '../sources/filters';
import { useAdminLink } from '../sources/links';
import { ChoiceMenu } from '../sources/SourceFilters';
import { formatCount } from '../sources/sources';
import { continueRun, fetchRunLog, fetchRunsPage, pauseRun, runKeys, type AdminRunRow, type RunFilters } from './api';
import { DailyReport } from './DailyReport';
import { RunErrorLine, RunStatusBadge, runCounts, runDuration, runTriggerLabel } from './parts';
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
      {state.paused ? (
        <Notice
          tone="warning"
          title={text.title}
          action={
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
          }
        >
          {text.description}
        </Notice>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface px-4 py-3 shadow-card">
          <div className="flex min-w-0 flex-1 basis-60 items-start gap-3 text-sm leading-5">
            <span aria-hidden="true" className="mt-1.5 size-2.5 shrink-0 rounded-full bg-success" />
            <div className="min-w-0">
              <p className="font-semibold text-foreground">{text.title}</p>
              <p className="text-[13px] text-muted-foreground">{text.description}</p>
            </div>
          </div>
          <Button variant="outline" size="sm" icon={<PauseIcon size={14} weight="fill" />} onClick={() => setConfirming(true)} data-runs-pause-all="">
            Pause all
          </Button>
        </div>
      )}
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
  const view: RunsView = useSearchParams().get('view') === 'report' ? 'report' : 'history';
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [kinds, setKinds] = useState<JobSourceKind[]>([]);
  const [statuses, setStatuses] = useState<JobSourceRunStatus[]>([]);
  const filters: RunFilters = { sourceId, kinds, statuses };

  const runs = useInfiniteQuery({
    queryKey: runKeys.page(filters),
    queryFn: ({ pageParam, signal }) => fetchRunsPage(filters, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
    enabled: view === 'history',
    // Follow a running run while only the first page is shown (a long history is refreshed by hand).
    refetchInterval: (query) => {
      const pages = query.state.data?.pages ?? [];
      return pages.length === 1 && pages[0]!.items.some((run) => run.status === 'running') ? FOLLOW_MS : false;
    },
  });
  const source = useQuery({
    queryKey: sourceKeys.detail(sourceId ?? 0),
    queryFn: ({ signal }) => fetchSourceSettings(sourceId!, signal),
    enabled: sourceId !== null,
    retry: false,
  });

  const items = runs.data?.pages.flatMap((page) => page.items) ?? [];

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
  const sourceName = source.data?.name ?? items.find((run) => run.sourceId === sourceId)?.sourceName ?? (sourceId ? `Source #${sourceId}` : null);
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
          label={expanded.has(run.id) ? `Hide the log of run ${run.id}` : `Show the log of run ${run.id}`}
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
      cell: (run) => (
        <div className="min-w-0">
          <p className="truncate font-semibold">{run.sourceName}</p>
          <p className="text-[13px] text-muted-foreground">
            {run.sourceKindLabel || JOB_SOURCE_KIND_LABEL[run.sourceKind]} · Run {run.id}
          </p>
        </div>
      ),
    },
    { key: 'trigger', header: 'Trigger', className: 'w-32', cell: (run) => runTriggerLabel(run) },
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
    { key: 'took', header: 'Took', className: 'w-20 text-muted-foreground', cell: (run) => runDuration(run) },
    {
      key: 'status',
      header: 'Status',
      className: 'w-40',
      cell: (run) => (
        <div className="flex flex-col items-start gap-1">
          <RunStatusBadge status={run.status} />
          <RunErrorLine code={run.errorCode} />
        </div>
      ),
    },
    {
      key: 'requests',
      header: 'Requests',
      className: 'w-28',
      cell: (run) => (
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
      cell: (run) => (
        <div>
          <p>
            <span className="num">{formatCount(run.fetched)}</span> <span className="text-muted-foreground">fetched</span>
          </p>
          <p className="text-[13px] text-muted-foreground">{runCounts(run)}</p>
        </div>
      ),
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
      onValueChange={(next) => link({ tab: 'runs', source: sourceId, view: next === 'report' ? 'report' : null })}
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
          <IconButton label="Refresh the runs" icon={<ArrowsClockwiseIcon size={16} />} variant="outline" onClick={() => void runs.refetch()} />
        </>
      }
      lead={
        <>
          <RunsBar now={now} state={pause} />
          <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
            {sourceId !== null && (
              <Chip tone="tint" onRemove={() => onSourceChange(null)} removeLabel="Show the runs of every source">
                Source: {sourceName}
              </Chip>
            )}
            <ChoiceMenu label="Kind" values={FILTER_KINDS} labels={JOB_SOURCE_KIND_LABEL} chosen={kinds} onChange={setKinds} />
            <ChoiceMenu label="Status" values={JOB_SOURCE_RUN_STATUSES} labels={STATUS_LABEL} chosen={statuses} onChange={setStatuses} />
          </div>
        </>
      }
      items={runs.data ? items : undefined}
      error={runs.error}
      errorTitle="The runs could not be loaded"
      errorAction={
        <Button variant="outline" size="sm" onClick={() => void runs.refetch()}>
          Try again
        </Button>
      }
      empty={
        sourceId !== null || kinds.length > 0 || statuses.length > 0
          ? { size: 'sm', title: 'No run matches', description: 'Try another source, kind or status.' }
          : { size: 'sm', title: 'No runs yet', description: 'Run a source from the Sources tab, or import a file.' }
      }
      tableLabel="Ingest runs"
      columns={columns}
      getKey={(run) => run.id}
      expanded={expanded}
      renderExpanded={(run) => <RunLog runId={run.id} running={run.status === 'running'} />}
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
