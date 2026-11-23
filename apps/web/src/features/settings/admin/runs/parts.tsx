'use client';

import { PauseIcon } from '@phosphor-icons/react/Pause';
import { SHEET_SOURCE_LABEL } from '@tailorit/shared/ingest';
import { runErrorLabel, type JobSourceRunStatus, type JobSourceRunTrigger } from '@tailorit/shared/sourcing';
import { Badge } from '@/components/ui/Badge';
import { Spinner } from '@/components/ui/Spinner';

// v30 ST0: the table, its loading rows and the heading row moved to components/admin (the admin tabs' base). v30 ST5:
// every tab is built on AdminResourceTab and reads them from there; this file keeps the runs' own pieces. v30 S1-WEB:
// moved into runs/, on CT's run statuses and triggers (a 304 is "Not modified"; a posting check is a run too).

const STATUS_LABEL: Record<JobSourceRunStatus, string> = {
  running: 'Running',
  succeeded: 'Succeeded',
  partial: 'Partial',
  failed: 'Failed',
  not_modified: 'Not modified',
  paused: 'Paused', // v31 RUNS
};

/**
 * A run's status as a badge: green, amber, red, grey for a 304, or blue with a spinner while it runs. v31 RUNS: an
 * outline badge with a pause mark once an admin paused it.
 */
export function RunStatusBadge({ status }: { status: JobSourceRunStatus | string | null }) {
  if (!status) return <span className="text-muted-foreground">Never run</span>;
  const known = status as JobSourceRunStatus;
  const tone =
    known === 'succeeded'
      ? 'success'
      : known === 'partial'
        ? 'warning'
        : known === 'failed'
          ? 'destructive'
          : known === 'not_modified'
            ? 'neutral'
            : known === 'paused'
              ? 'outline'
              : 'sky';
  return (
    <Badge tone={tone} icon={known === 'running' ? <Spinner size={12} /> : known === 'paused' ? <PauseIcon size={12} weight="fill" /> : undefined}>
      {STATUS_LABEL[known] ?? status}
    </Badge>
  );
}

/** The counts a run reports (v2.0's runs and CT's: `reopened` is CT's). */
interface RunCounts {
  created: number;
  updated: number;
  unchanged: number;
  deactivated: number;
  failed: number;
  reopened?: number;
}

/** "+12 new · 3 updated · 2 closed · 1 reopened · 1 failed": what a run changed, the zero parts left out. */
export function runCounts(run: RunCounts): string {
  const parts = [
    run.created ? `${run.created} new` : '',
    run.updated ? `${run.updated} updated` : '',
    run.unchanged ? `${run.unchanged} unchanged` : '',
    run.deactivated ? `${run.deactivated} closed` : '',
    run.reopened ? `${run.reopened} reopened` : '',
    run.failed ? `${run.failed} failed` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'No changes';
}

/** How long a run took: "42s", "3m 05s"; "Running" while it has no end. */
export function runDuration(run: { startedAt: string; finishedAt: string | null }): string {
  if (!run.finishedAt) return 'Running';
  const seconds = Math.max(0, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

const TRIGGER_LABEL: Record<JobSourceRunTrigger, string> = {
  schedule: 'Schedule',
  manual: 'Run now',
  upload: 'Upload',
  startup: 'Startup',
  liveness: 'Posting check',
};

/** What started a run: a file is an "Upload", a Google Sheet tab (when the server names the kind so) an "Import". */
export function runTriggerLabel(run: { trigger: JobSourceRunTrigger; sourceKindLabel?: string }): string {
  if (run.trigger === 'upload' && run.sourceKindLabel === SHEET_SOURCE_LABEL) return 'Import';
  return TRIGGER_LABEL[run.trigger] ?? run.trigger;
}

/**
 * v30 FIX-WEB (REV-UX UX-11): a failed run's error code in words ("Board not found", "HTTP 429"), the code itself in its
 * hover text (the word an admin filters on).
 */
export function RunErrorLine({ code }: { code: string | null }) {
  if (!code) return null;
  return (
    <span className="text-[13px] text-muted-foreground" title={code} data-run-error={code}>
      {runErrorLabel(code)}
    </span>
  );
}

/** v35 OPSWEB (PLAN H6, the owner's "No runs now"): Runs with no run at all, and with filters that match none. */
export const RUNS_EMPTY = {
  none: { title: 'No runs now', description: 'Runs appear when a source is read or links are imported.' },
  filtered: { title: 'No run matches', description: 'Try other filters.' },
} as const;
