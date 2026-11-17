'use client';

import {
  JOB_SOURCE_DISCOVERED_VIA_LABEL,
  JOB_SOURCE_ROBOTS_LABEL,
  JOB_SOURCE_TERMS_LABEL,
  JOB_SOURCE_TIER_LABEL,
  type AdminSourceRow,
} from '@tailorit/shared/sourcing';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { RowDetailSheet } from '@/components/queue';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ArrowSquareOutIcon, ArrowsClockwiseIcon } from '@/components/ui/icons';
import { relativeTime } from '@/lib/format';
import { RunStatusBadge } from '../runs/parts';
import { fetchSourceSettings, sourceKeys, type SourceSettings } from './api';
import {
  TIER_TONE,
  failureText,
  formatCount,
  isUnrun,
  robotsTone,
  runNowHint,
  scheduleText,
  sheetOf,
  sourceDetail,
  sourceLine,
  termsTone,
} from './sources';

// v30 S1-WEB: one source's sheet (12 §9.8): its schedule (tier, next run, the last complete listing that verified its
// links, failures), whether its terms and robots.txt let it run, whether its postings may go to AI, how it was found,
// its host and company, and what it reads. The row is CT's AdminSourceRow; its settings come from its own route.

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-3 py-2 text-sm max-sm:grid-cols-1 max-sm:gap-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
    </div>
  );
}

function When({ value, now }: { value: string | null; now: number }) {
  if (!value) return <span className="text-muted-foreground">Never</span>;
  return (
    <span>
      {relativeTime(value, now)} <span className="text-muted-foreground">({new Date(value).toLocaleString('en-US')})</span>
    </span>
  );
}

/** The facts of a source (drawn without a server in the web tests). */
export function SourceDetails({
  source,
  settings,
  now,
  onShowHost,
}: {
  source: AdminSourceRow;
  settings: SourceSettings | null;
  now: number;
  onShowHost?: (host: string) => void;
}) {
  const detail = settings ? sourceDetail({ kind: source.kind, config: settings.config }) : null;
  const sheet = settings ? sheetOf({ kind: source.kind, config: settings.config }) : null;
  return (
    <div className="flex flex-col gap-6" data-source-details={source.id}>
      <section aria-labelledby={`source-${source.id}-schedule`}>
        <h3 id={`source-${source.id}-schedule`} className="text-sm font-semibold text-foreground">
          Schedule
        </h3>
        <dl className="mt-1 divide-y divide-border">
          <Fact label="State">{source.enabled ? 'Enabled' : 'Paused'}</Fact>
          <Fact label="Tier">
            <Badge tone={TIER_TONE[source.tier]}>{JOB_SOURCE_TIER_LABEL[source.tier]}</Badge>
          </Fact>
          <Fact label="Next run">{scheduleText(source, now)}</Fact>
          <Fact label="Last run">
            <span className="flex flex-wrap items-center gap-2">
              <RunStatusBadge status={source.running ? 'running' : source.lastStatus} />
              {source.lastRunAt && <When value={source.lastRunAt} now={now} />}
            </span>
          </Fact>
          <Fact label="Last success">
            <When value={source.lastSuccessAt} now={now} />
          </Fact>
          <Fact label="Last complete listing">
            <When value={source.lastCompleteAt} now={now} />
          </Fact>
          <Fact label="Failures">{failureText(source) ?? 'None in a row'}</Fact>
          <Fact label="Open jobs">{formatCount(source.openJobs)}</Fact>
        </dl>
      </section>
      <section aria-labelledby={`source-${source.id}-access`}>
        <h3 id={`source-${source.id}-access`} className="text-sm font-semibold text-foreground">
          Access
        </h3>
        <dl className="mt-1 divide-y divide-border">
          <Fact label="Terms">
            <Badge tone={termsTone(source.termsStatus)}>{JOB_SOURCE_TERMS_LABEL[source.termsStatus]}</Badge>
          </Fact>
          <Fact label="robots.txt">
            <Badge tone={robotsTone(source.robotsStatus)}>{JOB_SOURCE_ROBOTS_LABEL[source.robotsStatus]}</Badge>
          </Fact>
          <Fact label="AI">{source.aiInput ? 'Its postings may be read by AI' : 'Its postings are never sent to AI'}</Fact>
          <Fact label="Found by">{source.discoveredVia ? JOB_SOURCE_DISCOVERED_VIA_LABEL[source.discoveredVia] : 'Added before discovery'}</Fact>
        </dl>
      </section>
      <section aria-labelledby={`source-${source.id}-where`}>
        <h3 id={`source-${source.id}-where`} className="text-sm font-semibold text-foreground">
          Where it reads
        </h3>
        <dl className="mt-1 divide-y divide-border">
          <Fact label="Kind">{source.kindLabel}</Fact>
          {detail && <Fact label="Reads">{detail}</Fact>}
          <Fact label="Host">
            {source.host ? (
              onShowHost ? (
                <Button variant="link" onClick={() => onShowHost(source.host!)}>
                  {source.host}
                </Button>
              ) : (
                source.host
              )
            ) : (
              <span className="text-muted-foreground">None (no outside reads)</span>
            )}
          </Fact>
          {source.companyName && <Fact label="Company">{source.companyName}</Fact>}
          {sheet && (
            <Fact label="Google Sheet">
              <a href={sheet.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary-ink underline-offset-2 hover:underline">
                Open in Google Sheets <ArrowSquareOutIcon size={14} />
              </a>
            </Fact>
          )}
        </dl>
      </section>
    </div>
  );
}

export function SourceSheet({
  source,
  open,
  onOpenChange,
  now,
  onRun,
  running,
  onShowRuns,
  onShowHost,
  onPurge,
}: {
  source: AdminSourceRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  now: number;
  onRun: (source: AdminSourceRow) => void;
  /** Its Run now is on its way. */
  running: boolean;
  onShowRuns: (id: number) => void;
  onShowHost: (host: string) => void;
  onPurge: (source: AdminSourceRow) => void;
}) {
  const settings = useQuery({
    queryKey: sourceKeys.detail(source?.id ?? 0),
    queryFn: ({ signal }) => fetchSourceSettings(source!.id, signal),
    enabled: open && source !== null,
  });
  return (
    <RowDetailSheet
      item={source}
      open={open}
      onOpenChange={onOpenChange}
      title={(item) => item.name}
      description={source ? sourceLine(source) : undefined}
      footer={(item) => {
        const hint = runNowHint({ kind: item.kind, config: settings.data?.config });
        return (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {hint && <p className="mr-auto max-w-sm text-[13px] text-muted-foreground">{hint}</p>}
            <Button variant="outline" onClick={() => onShowRuns(item.id)}>
              See runs
            </Button>
            <Button variant="destructive-outline" onClick={() => onPurge(item)}>
              Purge source
            </Button>
            {!isUnrun(item) && (
              <Button icon={<ArrowsClockwiseIcon size={16} />} loading={running} disabled={item.running} onClick={() => onRun(item)}>
                {item.running ? 'Running' : 'Run now'}
              </Button>
            )}
          </div>
        );
      }}
    >
      {(item) => <SourceDetails source={item} settings={settings.data ?? null} now={now} onShowHost={onShowHost} />}
    </RowDetailSheet>
  );
}
