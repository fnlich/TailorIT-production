'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Button } from '@/components/ui/Button';
import { ArrowsClockwiseIcon, SparkleIcon } from '@/components/ui/icons';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { TapeMeter } from '@/components/ui/TapeMeter';
import { userMessage } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { adminKeys, fetchAiBackground, fetchAiCapacity, fetchAiHealth, runAiTest } from './api';
import { BACKGROUND_REFRESH_MS, gateLine, gateTone, jobsRow, matchesRow, resumesRow } from './background';
import {
  CAPACITY_REFRESH_MS,
  CAPACITY_SOURCE_TEXT,
  capacityState,
  percentText,
  resetsText,
  todayText,
  windowText,
} from './capacity';
import { AdminResourceTab } from '@/components/admin';
import type { AiHealth } from './types';

/** "Models by feature": each AI task kind as people read it (v2.0 fix UX-16: every kind has words, no raw id). */
export const MODEL_KIND_LABEL: Record<string, string> = {
  resume_import: 'Resume import',
  entry_bullets: 'Resume bullets',
  job_analysis: 'Job analysis',
  cover_letter: 'Cover letters',
  template_fill: 'Template fill',
  resume_analysis: 'Resume analysis',
  autofill_pick: 'Autofill: option tiebreaks',
  autofill_classify: 'Autofill: field categories',
  autofill_draft: 'Autofill: drafts',
  autofill_answer: 'Autofill: answers',
  tailor: 'Resume tailoring', // v31 FIX-WEB (REV-REQ REQ-3)
  job_search: 'AI job search',
  custom_filter: 'Custom filter',
  company_summary: 'Company summaries', // v30 E3
};

/**
 * Admin > AI: the local Claude CLI's health (version, sign-in, models), a one-prompt connectivity test, and the
 * background work Claude still has to do.
 */
export function AiTab() {
  const queryClient = useQueryClient();
  const now = useNow();
  const health = useQuery({ queryKey: adminKeys.aiHealth, queryFn: ({ signal }) => fetchAiHealth(false, signal) });
  const recheck = useMutation({
    mutationFn: () => fetchAiHealth(true),
    onSuccess: (answer) => queryClient.setQueryData(adminKeys.aiHealth, answer),
  });
  // A test call changes the AI holds (one that works clears them, one that fails may set one), so Background work is
  // read again; not awaited, so the answer shows at once.
  const test = useMutation({
    mutationFn: runAiTest,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.aiBackground });
    },
  });

  const data: AiHealth | undefined = recheck.data ?? health.data;

  // v30 ST5: on the admin tab base; its body is no list but the AI's cards, each with its own states.
  return (
    <AdminResourceTab
      title="AI"
      description="AI features run through the Claude CLI signed in on this server, on its subscription. By default, Claude reads each added job once, in the background, newest first. Opening or saving a job never starts a reading."
      actions={
        <>
          <Button variant="outline" icon={<ArrowsClockwiseIcon size={16} />} onClick={() => recheck.mutate()} loading={recheck.isPending}>
            Check again
          </Button>
          <Button icon={<SparkleIcon size={16} />} onClick={() => test.mutate()} loading={test.isPending} disabled={!data?.enabled}>
            Run test
          </Button>
        </>
      }
      body={
        <>
          <ServerAiStatusCard />
          {health.isError ? (
            <Notice tone="error" className="mt-5" title="AI health could not be read">
              {userMessage(health.error)}
            </Notice>
          ) : !data ? (
            <div className="mt-5 rounded-card border border-border bg-surface p-6 shadow-card">
              <Skeleton className="h-6 w-1/2" />
              <Skeleton className="mt-4 h-4 w-3/4" />
            </div>
          ) : (
            <div className="mt-5 rounded-card border border-border bg-surface p-6 shadow-card" data-ai-health={data.available ? 'available' : 'unavailable'}>
              <div className="flex items-center gap-3">
                <span
                  aria-hidden="true"
                  className={clsx('size-2.5 shrink-0 rounded-full', data.available ? 'bg-success' : data.enabled ? 'bg-warning' : 'bg-control-strong')}
                />
                <h3 className="text-[15px] leading-5 font-semibold text-foreground">
                  {data.available ? 'Claude CLI is ready' : data.enabled ? 'Claude CLI is not available' : 'AI is turned off'}
                </h3>
              </div>
              <p className="mt-2 text-sm leading-5 text-muted-foreground">{data.message}</p>
              <dl className="mt-5 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                <Fact label="CLI version" value={data.cliVersion ?? 'Not found'} />
                <Fact label="Signed in" value={data.loggedIn ? [data.authMethod, data.subscriptionType].filter(Boolean).join(', ') || 'Yes' : 'No'} />
                <Fact label="Default model" value={data.defaultModel} />
                <Fact label="Checked" value={relativeTime(data.checkedAt, now)} />
              </dl>
              <h4 className="mt-6 text-[11px] leading-4 font-semibold tracking-[0.06em] text-subtle-foreground uppercase">Models by feature</h4>
              <ul className="mt-2 grid gap-x-8 gap-y-1.5 text-sm sm:grid-cols-2">
                {Object.entries(data.models).map(([kind, model]) => (
                  <li key={kind} className="flex justify-between gap-4 border-b border-divider-soft py-1.5">
                    <span className="text-muted-foreground">{MODEL_KIND_LABEL[kind] ?? kind}</span>
                    <span className="font-mono text-xs leading-5 text-foreground">{model}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {test.isError && (
            <Notice tone="error" className="mt-5">
              {userMessage(test.error)}
            </Notice>
          )}
          {test.data && (
            <Notice tone={test.data.ok ? 'success' : 'error'} className="mt-5" title={test.data.ok ? 'The test prompt worked' : 'The test prompt failed'}>
              {test.data.ok
                ? `${test.data.model} answered "${test.data.answer ?? ''}" in ${(test.data.ms / 1000).toFixed(1)} s.`
                : `${test.data.error?.message ?? 'No answer.'}${test.data.error?.detail ? ` (${test.data.error.detail})` : ''}`}
            </Notice>
          )}
          <BackgroundWorkCard />
        </>
      }
    />
  );
}

const STATE_DOT = { open: 'bg-success', blocked: 'bg-danger', none: 'bg-control-strong' } as const;

/**
 * v2.0: "Server AI status" (docs/design/v2.0/08-ui.md; 03-ai-usage.md): the Claude seat's usage as a large percentage
 * and a bar against the block threshold, its window, source and reset, whether server AI is open or blocked for
 * everyone, and today's charged total and write-offs. Read every 30 s while the AI tab is open. Admins only.
 */
function ServerAiStatusCard() {
  const now = useNow();
  const capacity = useQuery({
    queryKey: adminKeys.aiCapacity,
    queryFn: ({ signal }) => fetchAiCapacity(signal),
    refetchInterval: CAPACITY_REFRESH_MS,
  });
  if (!capacity.data) {
    return capacity.isError ? (
      <Notice tone="error" title="Server AI status could not be read">
        {userMessage(capacity.error)}
      </Notice>
    ) : (
      <div className="rounded-card border border-border bg-surface p-6 shadow-card" aria-busy="true">
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="mt-4 h-3 w-full" rounded="full" />
      </div>
    );
  }
  const data = capacity.data;
  const state = capacityState(data);
  const fill = Math.min(100, Math.max(0, (data.utilization ?? 0) * 100));
  const mark = Math.min(100, data.threshold * 100);
  const resets = resetsText(data.resetsAt, now);
  return (
    <div className="rounded-card border border-border bg-surface p-6 shadow-card" data-ai-capacity={state.tone}>
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className={clsx('size-2.5 shrink-0 rounded-full', STATE_DOT[state.tone])} />
        <h3 className="text-[15px] leading-5 font-semibold text-foreground">Server AI status</h3>
      </div>
      <div className="mt-4 flex flex-wrap items-end gap-x-6 gap-y-2">
        <p className="num text-[40px] leading-none tracking-tight text-foreground" data-ai-utilization="">
          {percentText(data.utilization)}
        </p>
        <p className="pb-1 text-[13px] leading-5 text-muted-foreground">
          {[windowText(data.window), data.source ? CAPACITY_SOURCE_TEXT[data.source] : null, resets].filter(Boolean).join(' · ')}
        </p>
      </div>
      {/* v31 ADMINWEB: the tape meter (20-visual-identity.md §7), its tone by meaning, and the block threshold marked on it. */}
      <div className="relative mt-4">
        <TapeMeter
          label="Server AI usage"
          value={fill}
          valueText={`${percentText(data.utilization)} used; it blocks at ${percentText(data.threshold)}`}
          showValue={false}
          size="lg"
          tone={data.blocked ? 'danger' : fill >= mark - 10 ? 'warning' : 'primary'}
        />
        <span aria-hidden="true" className="absolute -top-1 -bottom-1 w-0.5 -translate-x-1/2 rounded-full bg-danger" style={{ left: `${mark}%` }} />
      </div>
      <p className="mt-1.5 text-right text-xs leading-4 text-muted-foreground">
        Blocks at <span className="num">{percentText(data.threshold)}</span>
      </p>
      {state.tone === 'blocked' ? (
        <Notice tone="error" className="mt-3">
          {state.text}
        </Notice>
      ) : (
        <p className="mt-3 text-sm leading-5 text-foreground">{state.text}</p>
      )}
      <p className="mt-2 text-sm leading-5 text-muted-foreground tabular-nums" data-ai-today="">
        {todayText(data)}
      </p>
    </div>
  );
}

const GATE_DOT = { running: 'bg-success', paused: 'bg-warning', off: 'bg-control-strong' } as const;

/**
 * What Claude still has to read in the background (added jobs, uploaded resumes), the resume matches to update, and
 * whether background work runs now. Read again every 30 s while the AI tab is open (the panel unmounts when closed).
 */
function BackgroundWorkCard() {
  const now = useNow();
  const work = useQuery({
    queryKey: adminKeys.aiBackground,
    queryFn: ({ signal }) => fetchAiBackground(signal),
    refetchInterval: BACKGROUND_REFRESH_MS,
  });

  if (!work.data) {
    return work.isError ? (
      <Notice tone="error" className="mt-5" title="Background work could not be read">
        {userMessage(work.error)}
      </Notice>
    ) : (
      <div className="mt-5 rounded-card border border-border bg-surface p-6 shadow-card">
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="mt-4 h-4 w-2/3" />
      </div>
    );
  }

  const { gate } = work.data;
  const tone = gateTone(gate);
  const rows = [jobsRow(work.data.jobs), resumesRow(work.data.resumes), matchesRow(work.data.matches)];
  return (
    <div className="mt-5 rounded-card border border-border bg-surface p-6 shadow-card" data-ai-background={tone}>
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className={clsx('size-2.5 shrink-0 rounded-full', GATE_DOT[tone])} />
        <h3 className="text-[15px] leading-5 font-semibold text-foreground">Background work</h3>
      </div>
      <p className="mt-2 text-sm leading-5 text-muted-foreground">{gateLine(gate, now)}</p>
      <ul className="mt-5 divide-y divide-divider-soft">
        {rows.map((row) => (
          <li key={row.key} data-ai-background-row={row.key} className="py-3 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
              <p className="text-sm font-medium text-foreground tabular-nums">{row.title}</p>
              {row.detail && <p className="text-[13px] leading-5 text-muted-foreground tabular-nums">{row.detail}</p>}
            </div>
            <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">{row.note}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate font-medium text-foreground">{value}</dd>
    </div>
  );
}
