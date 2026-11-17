import type { AppDeps } from '../../../core/context';
import { refreshStoredResume } from './store';

// The on-page editor saves a second after each pause in typing, so reading the resume on every save would read it, and
// re-match it to every saved job, dozens of times a minute. Its saves wait instead: the reading runs once the resume
// has had no save for ANALYSIS_DELAY_MS, from what is stored then, or at once when something asks for it. Until then
// the previous reading stands (matching reads it as it is, as it does for any stale reading).

export const ANALYSIS_DELAY_MS = 20_000;

declare module '../../../core/context' {
  interface AppServices {
    /** Readings waiting for the editor's saves to pause, by resume id. */
    deferredResumeAnalyses?: Map<string, NodeJS.Timeout>;
  }
}

function pending(deps: AppDeps): Map<string, NodeJS.Timeout> {
  deps.services.deferredResumeAnalyses ??= new Map();
  return deps.services.deferredResumeAnalyses;
}

async function run(deps: AppDeps, resumeId: string): Promise<void> {
  try {
    await refreshStoredResume(deps, resumeId);
  } catch (error) {
    deps.log.warn(`[resume-analysis] the waiting reading of resume ${resumeId} failed; it is read again later`, error);
  }
}

/** Reads the resume once it has had no save for ANALYSIS_DELAY_MS (each call starts the wait again). */
export function scheduleResumeAnalysis(deps: AppDeps, resumeId: string): void {
  const timers = pending(deps);
  clearTimeout(timers.get(resumeId));
  const timer = setTimeout(() => {
    timers.delete(resumeId);
    void run(deps, resumeId);
  }, ANALYSIS_DELAY_MS);
  timer.unref?.();
  timers.set(resumeId, timer);
}

/** Runs the resume's waiting reading now, if it has one: for a read that needs it current. */
export async function flushResumeAnalysis(deps: AppDeps, resumeId: string): Promise<void> {
  const timers = pending(deps);
  const timer = timers.get(resumeId);
  if (!timer) return;
  clearTimeout(timer);
  timers.delete(resumeId);
  await run(deps, resumeId);
}

/** Runs every waiting reading now (shutdown). */
export async function flushAllResumeAnalyses(deps: AppDeps): Promise<void> {
  for (const resumeId of [...pending(deps).keys()]) await flushResumeAnalysis(deps, resumeId);
}

/** Forgets the waiting reading of a deleted resume. */
export function cancelResumeAnalysis(deps: AppDeps, resumeId: string): void {
  const timers = pending(deps);
  clearTimeout(timers.get(resumeId));
  timers.delete(resumeId);
}
