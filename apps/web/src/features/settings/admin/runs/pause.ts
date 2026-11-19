import type { JobSourceRunStatus, RunsPaused } from '@tailorit/shared/sourcing';
import { countLabel, relativeTime } from '../../../../lib/format';

// v31 RUNS: the words of Pause and Continue in Admin › Runs and Admin › Sources (docs/design/v3.1/22-runs-pause.md).
// Pure, so the web unit tests read them. A paused run stopped at its next safe point (within a few seconds): what it
// saved stays and nothing was closed; Continue reads the source again from the top.

/** What a run's row offers: Pause while it runs, "Pausing" once asked, Continue once paused; nothing otherwise. */
export type RunRowAction = 'pause' | 'pausing' | 'continue' | null;

export function runRowAction(run: { status: JobSourceRunStatus; stopRequestedAt?: string | null }): RunRowAction {
  if (run.status === 'running') return run.stopRequestedAt ? 'pausing' : 'pause';
  if (run.status === 'paused') return 'continue';
  return null;
}

/** "Paused 5 minutes ago by ops@example.com" (no admin named once their account is gone). */
export function pausedSince(paused: { at: string; by: string | null }, now: number): string {
  return `Paused ${relativeTime(paused.at, now)}${paused.by ? ` by ${paused.by}` : ''}`;
}

/** A paused source's line, or null while it is not paused. */
export function sourcePausedText(row: { pausedAt?: string | null; pausedBy?: string | null }, now: number): string | null {
  return row.pausedAt ? pausedSince({ at: row.pausedAt, by: row.pausedBy ?? null }, now) : null;
}

/** The Runs tab's bar: whether runs go on or are paused, and what that means. */
export function runsBarText(paused: RunsPaused | null, now: number): { title: string; description: string } {
  if (!paused) {
    return {
      title: 'Runs are running',
      description: 'Sources run on their schedule. Pause all stops every run safely.',
    };
  }
  return {
    title: 'Runs are paused',
    description: `${pausedSince(paused, now)}. No source runs until you continue; what was saved stays.`,
  };
}

export const PAUSE_ALL_CONFIRM = {
  title: 'Pause all runs?',
  description:
    'Every running run stops at its next safe point, within a few seconds. What it saved stays and nothing is closed. ' +
    'No source runs, on its schedule or with Run now, until you continue.',
  confirmLabel: 'Pause all',
  busyLabel: 'Pausing...',
} as const;

/** The toast after Pause all: how many running runs were asked to stop. */
export function pausedAllToast(stopping: number): { title: string; description: string } {
  return {
    title: 'Runs paused',
    description: stopping
      ? `${countLabel(stopping, 'running run stops', 'running runs stop')} at the next safe point.`
      : 'No run was going. No source runs until you continue.',
  };
}

/** The toast after Continue: how many paused sources run again now. */
export function continuedAllToast(resumed: number): { title: string; description: string } {
  return {
    title: 'Runs continued',
    description: resumed
      ? `${countLabel(resumed, 'paused source runs', 'paused sources run')} again now, from the top. The others run on their schedule.`
      : 'Sources run on their schedule again.',
  };
}

/** The toast after a run's Pause. */
export function pausingRunToast(runId: number): { title: string; description: string } {
  return { title: `Pausing run ${runId}`, description: 'It stops at its next safe point, within a few seconds. What it saved stays.' };
}

/** The toast after a run's Continue. */
export function continuedRunToast(sourceName: string): { title: string; description: string } {
  return { title: `Running ${sourceName} again`, description: 'It reads the source again from the top. Its result appears under Runs.' };
}

/** The toast after a source's Pause or Continue. */
export function sourcePauseToast(name: string, paused: boolean): { title: string; description: string } {
  return paused
    ? { title: `${name} paused`, description: 'No run of it starts until you continue it. A run that was going stops at its next safe point.' }
    : { title: `${name} continued`, description: 'It runs on its schedule again (now, if its last run was paused).' };
}
