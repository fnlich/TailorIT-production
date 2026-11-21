import type { PrepareAllPlan } from '@tailorit/shared/prepare';
import { PROFILE_SELF, type ProfileChoice, type SharingOverviewProfile } from '@tailorit/shared/sharing';
// Relative, not '@/': the web tests draw these views.
import { ApiError, userMessage } from '../../lib/api';
import { PROFILES_COPY } from './copy';

// v33 SHARE-7 (PLAN F9 "Seeing every profile at once"; SP v33 PLAN-sharing.md §8): "Prepare all profiles" on the
// Profiles page. It reads Prepare All's plan on every profile the person may prepare (their own, and each shared one
// with `prepare:run`), shows one confirm (how many jobs on how many profiles, and the person's own AI use: theirs pays
// for all of it), then starts one Prepare All per profile with the jobs its plan named, and gathers every refusal into
// one alert. The pure parts are here.

/** A profile the person may prepare: their own always; a shared one with `prepare:run`. */
export function canPrepare(profile: Pick<SharingOverviewProfile, 'permissions'>): boolean {
  return profile.permissions === null || profile.permissions.includes('prepare:run');
}

/** One profile's plan, as read (or the reason it could not be). */
export interface PlanRead {
  profile: ProfileChoice;
  name: string;
  plan?: PrepareAllPlan;
  error?: unknown;
}

/** A profile Prepare All did not start on, and why (the answer's own sentence). */
export interface Refusal {
  profile: ProfileChoice;
  name: string;
  message: string;
}

export interface PrepareAllSummary {
  /** Jobs to start, over every profile. */
  total: number;
  /** The profiles with jobs to start, own first, each with its plan's jobs. */
  runs: { profile: ProfileChoice; name: string; applicationIds: string[]; taking: number }[];
  /** The profiles whose plan did not read. */
  refused: Refusal[];
  /**
   * The person's AI use for the confirm's note: their own profile's plan only (their AI pays everywhere); null when it
   * did not read (another profile's plan may count its owner's day).
   */
  ai: PrepareAllPlan['ai'] | null;
}

/**
 * Why one profile did not prepare, in the page's words. A share that ended or no longer lets the person prepare says so
 * here (the API's own sentence for an ended profile is about the tab going back, which this page does not do); anything
 * else is the answer's own sentence.
 */
export function refusalReason(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.code === 'profile_ended') return PROFILES_COPY.endedReason;
  if (error instanceof ApiError && error.code === 'profile_not_shared') return PROFILES_COPY.notSharedReason;
  return userMessage(error, fallback);
}

/** What one confirm shows and starts, from every profile's plan. */
export function summarize(reads: readonly PlanRead[], fallback: string): PrepareAllSummary {
  const ordered = [...reads].sort((a, b) => Number(b.profile === PROFILE_SELF) - Number(a.profile === PROFILE_SELF));
  const runs: PrepareAllSummary['runs'] = [];
  const refused: Refusal[] = [];
  for (const read of ordered) {
    if (read.plan) {
      if (read.plan.taking > 0 && read.plan.applicationIds.length > 0) {
        runs.push({ profile: read.profile, name: read.name, applicationIds: [...read.plan.applicationIds], taking: read.plan.taking });
      }
    } else {
      refused.push({ profile: read.profile, name: read.name, message: refusalReason(read.error, fallback) });
    }
  }
  const own = ordered.find((read) => read.profile === PROFILE_SELF && read.plan)?.plan;
  return {
    total: runs.reduce((sum, run) => sum + run.taking, 0),
    runs,
    refused,
    ai: own?.ai ?? null,
  };
}
