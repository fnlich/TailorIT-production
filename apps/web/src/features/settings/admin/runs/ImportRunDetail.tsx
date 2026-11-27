'use client';

import type { AdminRunSource, AdminSourceAllAction } from '@tailorit/shared/sourcing';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button, buttonClasses } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { HelpTip } from '@/components/ui/HelpTip';
import { ArrowRightIcon } from '@/components/ui/icons';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { Switch } from '@/components/ui/Switch';
import { useToast } from '@/components/ui/Toast';
import { userMessage } from '@/lib/api';
import { hostKeys } from '../hosts/api'; // v37 INT-B (TRANSFER E3)
import { setSourceEnabled, sourceKeys } from '../sources/api';
import { allResultLine } from '../sources/bulk';
import { importResultsHref } from '../sources/links';
import { waitingTip } from '../sources/sources';
import { WaitingForAdminBadge } from '../sources/SourcesTab'; // v36 INT-A
import { changeRunSources, fetchRunSources, runKeys, type AdminRunRow } from './api';
import { foundSourceState, importCountParts, importRunName, runSourcesConfirm, sourcesFoundLine, startedByText } from './imports';
import { foundViaText } from '../sources/embedded'; // v381 EMBED

// v35 OPSWEB (PLAN H6): an import run, opened on Admin › Runs: its counts, "Open results" (Admin › Import's results of
// the run), and Sources found: each board source its links named (name, kind, company, state), the ones it made with a
// switch each and Enable all / Disable all, the ones that were there already listed as "Already a source".

const STATE_TONE: Record<ReturnType<typeof foundSourceState>, BadgeTone> = {
  On: 'success',
  Off: 'neutral',
  Waiting: 'warning',
  Paused: 'outline',
};

/** The import's counts as tags ("12 added"), or a line while TailorIT still reads its rows. */
function ImportCounts({ run }: { run: AdminRunRow }) {
  const summary = run.importOf?.import;
  if (!summary) return <p className="text-[13px] text-muted-foreground">This import has no results to show.</p>;
  if (!summary.counts) {
    return (
      <p className="text-[13px] text-muted-foreground" data-import-run-reading="">
        TailorIT is reading its {summary.rows.toLocaleString('en-US')} {summary.rows === 1 ? 'row' : 'rows'}; the counts follow.
      </p>
    );
  }
  const parts = importCountParts(summary.counts);
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="What came of its rows" data-import-run-counts="">
      <li>
        <Badge tone="outline">
          {summary.counts.rows.toLocaleString('en-US')} {summary.counts.rows === 1 ? 'row' : 'rows'}
        </Badge>
      </li>
      {parts.map((part) => (
        <li key={part.key}>
          <Badge tone={part.key === 'failed' || part.key === 'needs_details' ? 'warning' : part.key === 'added' || part.key === 'reposted' ? 'success' : 'neutral'}>
            {part.text}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

/**
 * One found source: its name, kind and company, its state, and (made by this import) its switch. v36 INT-A: a source no
 * admin turned on yet also says "Waiting for an admin" (SOURCES' badge, as on Admin › Sources).
 */
export function FoundSource({ source, busy, onToggle }: { source: AdminRunSource; busy: boolean; onToggle: (source: AdminRunSource) => void }) {
  const state = foundSourceState(source);
  const line = [
    source.kindLabel,
    source.companyName && source.companyName !== source.name ? source.companyName : null,
    foundViaText(source.embeddedSites), // v381 EMBED (SP v381 PLAN E5)
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2" data-found-source={source.id} data-found-created={source.created ? 'true' : 'false'}>
      <div className="min-w-0 flex-1 basis-48">
        <p className="truncate text-sm font-semibold text-foreground">{source.name}</p>
        {/* v381 FIX (REVIEW381-ux L3): the line wraps (its "Found via <site>" is never cut off at 390 px). */}
        <p className="text-[13px] break-words text-muted-foreground">{line}</p>
      </div>
      <span className="flex items-center gap-1.5">
        <Badge tone={STATE_TONE[state]} data-found-state={state} {...(source.waiting ? { 'data-source-waiting': source.waiting.reason } : {})}>
          {state}
        </Badge>
        {state === 'Waiting' && <HelpTip label={`Waiting: ${source.name}`}>{waitingTip(source.waiting)}</HelpTip>}
        {source.waitingForAdmin && <WaitingForAdminBadge name={source.name} />}
      </span>
      {source.created ? (
        <Switch
          checked={source.enabled}
          disabled={busy}
          onCheckedChange={() => onToggle(source)}
          aria-label={`${source.enabled ? 'Disable' : 'Enable'} ${source.name}`}
        />
      ) : (
        <span className="text-[13px] text-muted-foreground" data-found-existing="">
          Already a source
        </span>
      )}
    </li>
  );
}

/** Sources found: the list, its switches, and Enable all / Disable all of the ones this import made. */
function SourcesFound({ run }: { run: AdminRunRow }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [asking, setAsking] = useState<AdminSourceAllAction | null>(null);
  const [result, setResult] = useState<ReturnType<typeof allResultLine> | null>(null);
  const found = useQuery({ queryKey: runKeys.sources(run.id), queryFn: ({ signal }) => fetchRunSources(run.id, signal) });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: runKeys.sources(run.id) });
    void queryClient.invalidateQueries({ queryKey: sourceKeys.all });
    // v37 INT-B (TRANSFER T3): a source turned on here adds its host: an Admin › Hosts list open in this session reads again.
    void queryClient.invalidateQueries({ queryKey: hostKeys.all });
  };
  const toggle = useMutation({
    mutationFn: (source: AdminRunSource) => setSourceEnabled(source.id, !source.enabled),
    onSuccess: () => refresh(),
    onError: (error) => toast.error('The source was not changed', userMessage(error)),
  });
  const words = asking && found.data ? runSourcesConfirm(asking, found.data) : null;
  const titleId = `run-${run.id}-sources-found`;

  let body;
  if (found.isError) {
    body = (
      <Notice
        tone="error"
        title="Sources found didn't load."
        action={
          <Button variant="outline" size="sm" onClick={() => void found.refetch()}>
            Try again
          </Button>
        }
      >
        {userMessage(found.error)}
      </Notice>
    );
  } else if (!found.data) {
    body = (
      // v381 FIX (REVIEW381-ux L4): a status, so its label is read while the sources load.
      <div role="status" aria-busy="true" aria-label="Loading the sources found" className="flex flex-col gap-2 py-2">
        <Skeleton className="h-3.5 w-1/3" />
        <Skeleton className="h-3 w-1/4" />
      </div>
    );
  } else if (found.data.items.length === 0) {
    body = <p className="text-[13px] text-muted-foreground">None of its links named a board TailorIT reads in full.</p>;
  } else {
    body = (
      <ul className="divide-y divide-divider-soft" aria-labelledby={titleId}>
        {found.data.items.map((source) => (
          <FoundSource key={source.id} source={source} busy={toggle.isPending && toggle.variables?.id === source.id} onToggle={(item) => toggle.mutate(item)} />
        ))}
      </ul>
    );
  }

  const created = found.data?.created ?? 0;
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2" data-run-sources-found={run.id}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h4 id={titleId} className="flex items-center gap-1 text-sm font-semibold text-foreground">
          Sources found
          <HelpTip label="Sources found">Boards this import&apos;s links named; the ones it made stay off until you switch them on.</HelpTip>
        </h4>
        {found.data && <span className="text-[13px] text-muted-foreground">{sourcesFoundLine(found.data)}</span>}
        {created > 0 && (
          <span className="flex items-center gap-1.5 sm:ml-auto">
            <Button variant="outline" size="sm" className="max-sm:h-11" aria-haspopup="dialog" onClick={() => setAsking('enable')}>
              Enable all
            </Button>
            <Button variant="outline" size="sm" className="max-sm:h-11" aria-haspopup="dialog" onClick={() => setAsking('disable')}>
              Disable all
            </Button>
          </span>
        )}
      </div>
      <div aria-live="polite">
        {result && (
          <Notice
            tone={result.tone}
            title={result.text}
            action={
              <Button variant="ghost" size="sm" onClick={() => setResult(null)}>
                Dismiss
              </Button>
            }
          />
        )}
      </div>
      {body}
      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(open) => !open && setAsking(null)}
        tone={asking === 'disable' ? 'destructive' : 'primary'}
        title={words?.title ?? ''}
        description={words ? (words.changes === 0 ? `Nothing to change: they are all ${asking === 'enable' ? 'on' : 'off'} already.` : words.description) : undefined}
        confirmLabel={words && words.changes > 0 ? words.confirm : asking === 'disable' ? 'Disable all' : 'Enable all'}
        busyLabel={asking === 'disable' ? 'Disabling...' : 'Enabling...'}
        confirmDisabled={!words || words.changes === 0}
        focusCancel
        onConfirm={async () => {
          if (!asking) return;
          try {
            const answer = await changeRunSources(run.id, asking);
            setResult(allResultLine(answer));
            setAsking(null);
            refresh();
          } catch (error) {
            throw new Error(userMessage(error));
          }
        }}
      />
    </section>
  );
}

/** An import run opened: who started it, its counts, Open results, and Sources found. */
export function ImportRunDetail({ run }: { run: AdminRunRow }) {
  const by = startedByText(run);
  return (
    <div className="flex flex-col gap-4 rounded-control border border-divider-soft bg-surface p-3 sm:p-4" data-import-run={run.id}>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-60">
          <p className="text-sm font-semibold break-words text-foreground">{importRunName(run)}</p>
          {by && <p className="text-[13px] text-muted-foreground">{by}</p>}
        </div>
        <Link href={importResultsHref(run.id)} className={buttonClasses({ variant: 'outline', size: 'sm' })} data-import-run-results="">
          Open results
          <ArrowRightIcon size={14} aria-hidden="true" />
        </Link>
      </div>
      <ImportCounts run={run} />
      <SourcesFound run={run} />
    </div>
  );
}
