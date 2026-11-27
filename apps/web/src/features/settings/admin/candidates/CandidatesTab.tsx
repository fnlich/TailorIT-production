'use client';

import {
  ADMIN_CANDIDATE_BULK_ACTIONS,
  BOARD_SOURCE_KINDS, // v38 FRAME
  JOB_SOURCE_CANDIDATE_STATUSES,
  JOB_SOURCE_CANDIDATE_STATUS_LABEL,
  JOB_SOURCE_DISCOVERED_VIA,
  JOB_SOURCE_DISCOVERED_VIA_LABEL,
  JOB_SOURCE_KIND_LABEL,
  type CandidateFunnel,
  type DiscoveryKindMeasure,
  type JobSourceCandidate,
  type JobSourceCandidateStatus,
  type JobSourceKind,
} from '@tailorit/shared/sourcing';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import { AdminResourceTab, ScrollRegion, ShowMoreButton, type AdminColumn } from '@/components/admin';
import { SelectBar } from '@/components/queue';
import { Badge } from '@/components/ui/Badge';
import { HelpTip } from '@/components/ui/HelpTip';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { IconButton } from '@/components/ui/IconButton';
import { ArrowsClockwiseIcon, CheckCircleIcon, MagnifyingGlassIcon, PlusIcon, WarningCircleIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { useToast } from '@/components/ui/Toast';
import { Tooltip } from '@/components/ui/Tooltip';
import { userMessage } from '@/lib/api';
import { focusLater } from '@/lib/focusLater';
import { relativeTime } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { runBulk } from '../sources/bulk';
import { useAdminLink } from '../sources/links';
import { ChoiceMenu } from '../sources/SourceFilters';
import { formatCount } from '../sources/sources';
import { AddCandidatesDialog } from './AddCandidatesDialog';
import { bulkCandidates, candidateKeys, fetchCandidatesPage, fetchMeasures, NO_CANDIDATE_FILTERS, type CandidateBulkAction, type CandidateFilters } from './api';
import {
  CANDIDATE_BULK_LABEL,
  STATUS_TONE,
  addSummary,
  candidateBulkSummary,
  crawlText,
  foundText,
  funnelRows,
  kindText,
  openLifeText,
  probesText,
  sourceText,
  statusLine,
  validationStateOf,
  validationText,
  viaRows,
} from './candidates';

// v30 S2: Admin › Candidates (docs/design/part2/12-job-sourcing.md §4, §9.8 "the candidate funnel"): the boards
// discovery found (Add job, links in applications and page jobs, cross-links, Common Crawl, an admin's list), their
// validation's outcome and next try, the funnel from found to source, why validation is off (BOT_USER_AGENT, the
// worker), Common Crawl's progress, name probes (off) with the companies that have no board, each validated board's
// open jobs and open life, and the measures by kind. Retry and Drop act on up to ADMIN_BULK_MAX rows a turn. SCH's
// stub, built.

/** Whether Admin › Candidates is built: the registry draws it once true. */
export const CANDIDATES_TAB_READY = true;

const SEARCH_DELAY_MS = 300;
/**
 * The board kinds a candidate may have, for the kind filter (v37 BOARDS: an employer's iCIMS site too). v38 FRAME (SP v38
 * PLAN A10): every board kind, in the board registry's order (career sites last).
 */
const CANDIDATE_KINDS: readonly JobSourceKind[] = BOARD_SOURCE_KINDS;
const KIND_LABELS = Object.fromEntries(CANDIDATE_KINDS.map((kind) => [kind, JOB_SOURCE_KIND_LABEL[kind]])) as Record<JobSourceKind, string>;

/** The funnel: found, then each state with its count (a click filters the list), and the signals that found them. */
export function FunnelSummary({
  funnel,
  chosen,
  onChoose,
}: {
  funnel: CandidateFunnel;
  chosen: readonly JobSourceCandidateStatus[];
  onChoose?: (status: JobSourceCandidateStatus | 'all') => void;
}) {
  const validation = validationText(funnel);
  const notes = [crawlText(funnel), probesText(funnel)].filter((line): line is string => line !== null);
  const vias = viaRows(funnel);
  return (
    <section aria-label="The candidate funnel" className="mb-4 flex flex-col gap-3" data-candidate-funnel>
      {/* v32 COPY (E4/E5): validation's state is a chip. v32 FIX-UX (UXREQ-8): its numbers (today's reads, the crawl,
          the probes) are values, so they show under it; the "?" says what validation is, in one sentence. */}
      <span className="flex items-center gap-1.5" data-candidate-validation={validation.on ? 'on' : 'off'}>
        <Badge
          tone={validation.on ? 'success' : 'warning'}
          icon={
            validation.on ? (
              <CheckCircleIcon size={13} weight="fill" aria-hidden="true" />
            ) : (
              <WarningCircleIcon size={13} weight="fill" aria-hidden="true" />
            )
          }
        >
          {validation.on ? 'Validation is on' : 'Validation is off'}
        </Badge>
        <HelpTip label={validation.on ? 'Validation is on' : 'Validation is off'}>{VALIDATION_TIP}</HelpTip>
      </span>
      <ul className="flex flex-col gap-0.5 text-[13px] leading-5 text-muted-foreground" data-candidate-validation-lines="">
        {[validation.text, ...notes].map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <ul className="flex flex-wrap gap-2" aria-label="Candidates by state">
        {funnelRows(funnel).map((row) => {
          const active = row.status === 'all' ? chosen.length === 0 : chosen.length === 1 && chosen[0] === row.status;
          return (
            <li key={row.status}>
              <button
                type="button"
                aria-pressed={active}
                onClick={() => onChoose?.(row.status)}
                className={clsx(
                  'flex flex-col items-start rounded-control border px-3 py-2 text-left',
                  active ? 'border-primary bg-primary-soft' : 'border-border bg-surface hover:bg-surface-muted',
                )}
              >
                <span className="num text-lg leading-6">{formatCount(row.count)}</span>
                <span className="text-[13px] text-muted-foreground">{row.label}</span>
                {/* v36 FIX-SRC (ux L7): a source step's split (waiting for you, turned on, off). */}
                {row.detail && (
                  <span className="text-xs leading-4 text-muted-foreground" data-candidate-funnel-detail="">
                    {row.detail}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {vias.length > 0 && (
        <p className="text-[13px] text-muted-foreground" data-candidate-vias>
          Found by: {vias.map((row) => `${row.label} ${formatCount(row.count)}`).join(' · ')}
        </p>
      )}
    </section>
  );
}

/** The measures by kind: boards, open jobs per board, new postings a month and open life (12 §5.2). */
export function MeasuresTable({ byKind }: { byKind: readonly DiscoveryKindMeasure[] }) {
  if (byKind.length === 0) return <p className="text-[13px] text-muted-foreground">No board is measured yet.</p>;
  const number = (value: number | null) => (value === null ? '-' : value.toLocaleString('en-US'));
  return (
    // v30 FIX-WEB (REV-UX UX-7): a focusable, named region, so a keyboard scrolls it.
    <ScrollRegion label="Boards by kind">
      <table className="w-full min-w-[40rem] text-left text-[13px]" aria-label="Boards by kind">
        <thead className="text-[11px] leading-4 font-semibold tracking-[0.06em] text-subtle-foreground uppercase">
          <tr>
            <th className="py-1.5 pr-3 font-semibold">Kind</th>
            <th className="py-1.5 pr-3 text-right font-semibold">Boards</th>
            <th className="py-1.5 pr-3 text-right font-semibold">With open jobs</th>
            <th className="py-1.5 pr-3 text-right font-semibold">Open jobs per board</th>
            <th className="py-1.5 pr-3 text-right font-semibold">New postings a month per board</th>
            <th className="py-1.5 pr-3 text-right font-semibold">Open life (median)</th>
          </tr>
        </thead>
        <tbody>
          {byKind.map((row) => (
            <tr key={row.kind} className="border-t border-divider-soft">
              <td className="py-1.5 pr-3">{JOB_SOURCE_KIND_LABEL[row.kind]}</td>
              <td className="num py-1.5 pr-3 text-right">{formatCount(row.sources)}</td>
              <td className="num py-1.5 pr-3 text-right">{formatCount(row.boardsWithOpenJobs)}</td>
              <td className="num py-1.5 pr-3 text-right">{number(row.openJobsPerBoard)}</td>
              <td className="num py-1.5 pr-3 text-right">{number(row.newPostingsPerBoardPerMonth)}</td>
              <td className="num py-1.5 pr-3 text-right">{openLifeText(row.openLifeDaysMedian) ?? '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}

/** What validation is (the chip's "?"). v36 SOURCES: the source it makes stays off until an admin turns it on. */
const VALIDATION_TIP = 'Validation reads each board discovery found, once; a board that answers becomes a source that waits, off, for you.';

export function CandidatesTab() {
  const now = useNow();
  const toast = useToast();
  // The result of a bulk action, above the table (a toast would sit on the bulk bar's buttons): the admin's action.
  const [outcome, setOutcome] = useState<ReturnType<typeof candidateBulkSummary> | null>(null);
  const link = useAdminLink();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<CandidateFilters>(NO_CANDIDATE_FILTERS);
  // The chosen rows, kept with the filters they were chosen under (new filters start a new choice).
  const [selection, setSelection] = useState<{ filters: CandidateFilters; ids: Set<number> }>(() => ({ filters: NO_CANDIDATE_FILTERS, ids: new Set() }));
  const [adding, setAdding] = useState(false);
  const selected = selection.filters === filters ? selection.ids : new Set<number>();

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const q = search.trim();
      setFilters((previous) => (previous.q === q ? previous : { ...previous, q }));
    }, SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [search]);

  const candidates = useInfiniteQuery({
    queryKey: candidateKeys.page(filters),
    queryFn: ({ pageParam, signal }) => fetchCandidatesPage(filters, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
  });
  const measures = useQuery({ queryKey: candidateKeys.measures, queryFn: ({ signal }) => fetchMeasures(signal) });
  const items = useMemo(() => candidates.data?.pages.flatMap((page) => page.items) ?? [], [candidates.data]);
  const total = candidates.data?.pages[0]?.total ?? 0;
  const funnel = candidates.data?.pages[0]?.funnel ?? null;
  const validation = validationStateOf(funnel); // v30 FIX-WEB (UX-12)

  const refresh = () => void queryClient.invalidateQueries({ queryKey: candidateKeys.all });
  const setSelected = (ids: Set<number>) => setSelection({ filters, ids });
  const bulk = useMutation({
    mutationFn: ({ action, ids }: { action: CandidateBulkAction; ids: number[] }) =>
      runBulk(ids, (turn) => bulkCandidates(action, turn), (error) => userMessage(error)),
    onSuccess: (result, { action }) => {
      setOutcome(candidateBulkSummary(action, result));
      setSelected(new Set());
      refresh();
    },
  });

  const choose = (candidate: JobSourceCandidate, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(candidate.id);
    else next.delete(candidate.id);
    setSelected(next);
  };
  const chooseAll = (on: boolean) => setSelected(on ? new Set(items.map((item) => item.id)) : new Set());
  const narrow = (next: Partial<CandidateFilters>) => setFilters((previous) => ({ ...previous, ...next }));

  const columns: AdminColumn<JobSourceCandidate>[] = [
    {
      key: 'choose',
      header: (
        <Checkbox
          checked={items.length > 0 && selected.size === items.length}
          indeterminate={selected.size > 0 && selected.size < items.length}
          onCheckedChange={(on) => chooseAll(on)}
          aria-label="Choose every candidate shown"
        />
      ),
      className: 'w-10',
      cell: (candidate) => <Checkbox checked={selected.has(candidate.id)} onCheckedChange={(on) => choose(candidate, on)} aria-label={`Choose ${candidate.name}`} />,
    },
    {
      key: 'board',
      header: 'Board',
      cell: (candidate) => (
        <div className="min-w-0">
          <span className="block truncate font-semibold" title={candidate.name}>
            {candidate.name}
          </span>
          <span className="block truncate text-[13px] text-muted-foreground">{kindText(candidate)}</span>
        </div>
      ),
    },
    { key: 'found', header: 'Found by', className: 'w-56', cell: (candidate) => <span className="text-[13px]">{foundText(candidate)}</span> },
    {
      key: 'status',
      header: 'State',
      className: 'w-72',
      cell: (candidate) => (
        <div className="flex min-w-0 flex-col items-start gap-1">
          {candidate.lastError ? (
            <Tooltip content={candidate.lastError}>
              <Badge tone={STATUS_TONE[candidate.status]}>{JOB_SOURCE_CANDIDATE_STATUS_LABEL[candidate.status]}</Badge>
            </Tooltip>
          ) : (
            <Badge tone={STATUS_TONE[candidate.status]}>{JOB_SOURCE_CANDIDATE_STATUS_LABEL[candidate.status]}</Badge>
          )}
          <span className="text-[13px] text-muted-foreground">{statusLine(candidate, now, validation)}</span>
        </div>
      ),
    },
    { key: 'seen', header: 'Last seen', className: 'w-32', cell: (candidate) => <span className="text-[13px]">{relativeTime(candidate.lastSeenAt, now)}</span> },
    {
      key: 'source',
      header: 'Source',
      className: 'w-60',
      cell: (candidate) =>
        candidate.sourceId === null ? (
          <span className="text-muted-foreground">Not yet</span>
        ) : (
          <button
            type="button"
            className="block max-w-full truncate rounded-control text-left text-[13px] hover:underline"
            onClick={() => link({ tab: 'sources', source: candidate.sourceId })}
          >
            {/* v30 FIX-WEB (UX-9): the visible words in the name, after the hidden part that says whose source it is. */}
            <span className="sr-only">{`The source of ${candidate.name}: `}</span>
            {sourceText(candidate)}
          </button>
        ),
    },
  ];

  const narrowed = filters.q !== '' || filters.kind.length > 0 || filters.status.length > 0 || filters.discoveredVia.length > 0;

  return (
    <AdminResourceTab
      title="Candidates"
      description="Boards discovery found; each is read once, then becomes a source that waits for you to turn it on."
      actions={
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" icon={<PlusIcon size={16} />} onClick={() => setAdding(true)}>
            Add boards
          </Button>
          <IconButton label="Refresh the candidates" icon={<ArrowsClockwiseIcon size={16} />} variant="outline" onClick={refresh} />
        </div>
      }
      lead={
        <>
          {funnel && (
            <FunnelSummary funnel={funnel} chosen={filters.status} onChoose={(status) => narrow({ status: status === 'all' ? [] : [status] })} />
          )}
          {measures.data && (
            <details className="mb-4 rounded-card border border-border bg-surface px-4 py-3" data-candidate-measures>
              <summary className="cursor-pointer text-sm font-medium">Open life and postings by kind</summary>
              <div className="mt-3">
                <MeasuresTable byKind={measures.data.byKind} />
              </div>
            </details>
          )}
          <div className="mb-4 flex flex-wrap items-center gap-3" role="search" aria-label="Find candidates">
            <Input
              type="search"
              aria-label="Search candidates"
              placeholder="Search boards"
              leading={<MagnifyingGlassIcon size={16} />}
              className="pl-9"
              wrapperClassName="w-full max-w-sm"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <ChoiceMenu label="State" values={JOB_SOURCE_CANDIDATE_STATUSES} labels={JOB_SOURCE_CANDIDATE_STATUS_LABEL} chosen={filters.status} onChange={(status) => narrow({ status })} />
            <ChoiceMenu label="Kind" values={CANDIDATE_KINDS} labels={KIND_LABELS} chosen={filters.kind} onChange={(kind) => narrow({ kind })} />
            <ChoiceMenu
              label="Found by"
              values={JOB_SOURCE_DISCOVERED_VIA}
              labels={JOB_SOURCE_DISCOVERED_VIA_LABEL}
              chosen={filters.discoveredVia}
              onChange={(discoveredVia) => narrow({ discoveredVia })}
            />
            {narrowed && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSearch('');
                  setFilters(NO_CANDIDATE_FILTERS);
                  // v30 FIX-WEB (REV-UX UX-4): the button goes with the filters: focus goes to the search box.
                  focusLater('input[aria-label="Search candidates"]');
                }}
              >
                Clear filters
              </Button>
            )}
          </div>
        </>
      }
      items={candidates.data ? items : undefined}
      error={candidates.error}
      errorTitle="Candidates didn't load."
      errorAction={
        <Button variant="outline" size="sm" onClick={() => void candidates.refetch()}>
          Try again
        </Button>
      }
      empty={
        narrowed
          ? { title: 'No candidate matches', description: 'Try other filters.', card: false }
          : {
              size: 'sm',
              title: 'No candidates yet',
              description: 'A board appears once discovery or Add boards finds it.',
              action: <Button onClick={() => setAdding(true)}>Add boards</Button>,
            }
      }
      toolbar={
        <>
          <div aria-live="polite">
            {outcome && (
              <Notice
                tone={outcome.tone}
                className="mb-3"
                title={outcome.title}
                action={
                  <Button variant="ghost" size="sm" onClick={() => setOutcome(null)}>
                    Dismiss
                  </Button>
                }
              >
                {outcome.description}
              </Notice>
            )}
          </div>
          <p className="mb-3 text-sm text-muted-foreground" aria-live="polite" data-candidates-total={total}>
            {formatCount(total)} {total === 1 ? 'candidate' : 'candidates'}
            {items.length < total ? `, ${formatCount(items.length)} shown` : ''}
          </p>
        </>
      }
      footer={
        <>
          {selected.size > 0 && (
            <SelectBar
              aria-label="Change the chosen candidates"
              selected={selected.size}
              selectable={items.length}
              selectAllLabel="Choose every candidate shown"
              onSelectAll={chooseAll}
            >
              {ADMIN_CANDIDATE_BULK_ACTIONS.map((action) => (
                <Button
                  key={action}
                  size="sm"
                  variant={action === 'retry' ? 'primary' : 'outline'}
                  disabled={bulk.isPending}
                  loading={bulk.isPending && bulk.variables?.action === action}
                  onClick={() => bulk.mutate({ action, ids: [...selected] })}
                >
                  {CANDIDATE_BULK_LABEL[action]}
                </Button>
              ))}
            </SelectBar>
          )}
          {/* v30 FIX-WEB (UX-4): focus stays on the button while the next page loads. */}
          <ShowMoreButton
            hasMore={candidates.hasNextPage}
            loading={candidates.isFetchingNextPage}
            onMore={() => void candidates.fetchNextPage()}
            afterLast={['table[aria-label="Candidates"] tbody tr:last-of-type button', 'table[aria-label="Candidates"] tbody tr:last-of-type [role="checkbox"]']}
          >
            Show more candidates
          </ShowMoreButton>
        </>
      }
      tableLabel="Candidates"
      columns={columns}
      getKey={(candidate) => candidate.id}
      tableClassName={clsx(candidates.isPlaceholderData && 'opacity-70')}
    >
      <AddCandidatesDialog
        open={adding}
        onOpenChange={setAdding}
        onAdded={(result) => {
          toast.success('Boards added', addSummary(result));
          refresh();
        }}
      />
    </AdminResourceTab>
  );
}
