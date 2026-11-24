import type { FanoutSaveJobsAnswer, FanoutTargets, FanoutUnsaveJobsAnswer, ProfileChoice } from '@tailorit/shared/sharing';
import { queueSentences } from '../../sharing/fanout/copy';
import type { FanoutReport } from '../../sharing/fanout/results';
import { rowName, type FanoutProfile, type LabelOf } from '../../sharing/fanout/targets';
import { saveReport, unsaveReport } from '../../sharing/fanout/useSaveTo';

// v36 JOBS (PLAN J2, J3; SP v36 REQUEST.md: "if user click `select`, `Save` and `Unsave` will be shown. so even if the
// job is saved, it will be able to be selected"): the Jobs list's selection. Every row can be chosen (saved and applied
// jobs too); the bar saves or unsaves the chosen jobs on the tab's profile, or (Save ▾, Unsave ▾, with a shared profile)
// on the profiles picked. Each says what it did in one message with Undo: a save counts the jobs already saved; an
// unsave removes Saved entries only, and counts the jobs applied to ("applied: left as is").

export { SELECTION_COPY, type SelectionAction } from './selectionCopy';

const jobs = (count: number) => `${count.toLocaleString('en-US')} ${count === 1 ? 'job' : 'jobs'}`;

/** A save or unsave that ran on the tab's profile alone (one target, the tab's own). */
export function onTabAlone(targets: FanoutTargets, tab: ProfileChoice): boolean {
  return targets !== 'all' && targets.length === 1 && targets[0] === tab;
}

/** The sentences after a count, as one line ("2 already saved. 1 not visible on this profile."). */
const sentences = (parts: ReadonlyArray<string | null>): string | null => {
  const kept = parts.filter((part): part is string => Boolean(part));
  return kept.length > 0 ? kept.join(' ') : null;
};

/**
 * What a save on the tab's profile alone says: "3 jobs saved" (new or back), then the jobs already saved, those the
 * profile does not see and those not reached; a refused profile is the per-profile report's alert.
 */
export function tabSaveReport(answer: FanoutSaveJobsAnswer, profiles: readonly FanoutProfile[], label: LabelOf): FanoutReport {
  const result = answer.results[0];
  if (!result || !result.ok || answer.results.length !== 1) return saveReport(answer, profiles, label);
  const saved = result.saved + result.restored;
  const description = sentences([
    result.alreadyTracked > 0 ? `${result.alreadyTracked.toLocaleString('en-US')} already saved.` : null,
    result.notFound > 0 ? `${jobs(result.notFound)} not visible on this profile.` : null,
    result.notReached > 0 ? `${jobs(result.notReached)} not saved: try again.` : null,
  ]);
  return {
    title: saved > 0 ? `${jobs(saved)} saved` : 'Nothing new saved',
    description,
    notes: description ? [description] : [],
    lines: [],
    refused: false,
    done: saved > 0,
  };
}

/**
 * What an unsave on the tab's profile alone says: "2 jobs removed from saved jobs", then the jobs applied to (left as
 * they are) and those not saved; a refused profile is the per-profile report's alert. v36 FIX-WEB (D1): first what it
 * did to the auto-apply queue (taken out too; being applied now or needing Queue changes: left in saved jobs).
 */
export function tabUnsaveReport(answer: FanoutUnsaveJobsAnswer, profiles: readonly FanoutProfile[], label: LabelOf): FanoutReport {
  const result = answer.results[0];
  if (!result || !result.ok || answer.results.length !== 1) return unsaveReport(answer, profiles, label);
  const here = profiles.find((profile) => profile.choice === result.profile)?.label ?? result.name;
  const description = sentences([
    ...queueSentences(result, rowName('queue:edit', label), here),
    result.applied > 0 ? `${jobs(result.applied)} applied: left as is.` : null,
    result.notSaved > 0 ? `${jobs(result.notSaved)} not saved.` : null,
    result.notFound > 0 ? `${jobs(result.notFound)} not visible on this profile.` : null,
  ]);
  return {
    title: result.removed > 0 ? `${jobs(result.removed)} removed from saved jobs` : 'Nothing was removed',
    description,
    notes: description ? [description] : [],
    lines: [],
    refused: false,
    done: result.removed > 0,
  };
}
