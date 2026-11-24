'use client';

import { STATUS } from '@tailorit/shared';
import {
  FANOUT_ALL,
  type FanoutBulkAnswer,
  type FanoutItem,
  type FanoutSavedOn,
  type FanoutSaveJobsAnswer,
  type FanoutTargets,
  type ProfileChoice,
} from '@tailorit/shared/sharing';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, type ReactElement } from 'react';
// Relative, not '@/': the web tests draw these parts.
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { useToast } from '../../components/ui/Toast';
import { invalidateAccount } from '../../lib/account';
import { isProfileRefusal, userMessage } from '../../lib/api';
import { usePublicConstants } from '../../lib/constants';
import { fetchSavedOn, saveJobsTo } from '../sharing/fanout/api';
import { FANOUT_COPY } from '../sharing/fanout/copy';
import { fanoutReport, nameOf, refusalText, type FanoutReport } from '../sharing/fanout/results';
import type { FanoutProfile, LabelOf } from '../sharing/fanout/targets';
import { refreshAfterFanoutSave, savedOnChunks, useFanoutChoices, useFanoutReport } from '../sharing/fanout/useFanout';
import { browserDay, bulkInBatches, saveInBatches } from '../sharing/fanout/useSaveTo';
import { PREPARE_ON } from './copy';

// v36 APPLYWEB (PLAN A4; SP v36 REQUEST.md: "If `select` button is clicked, there will be … `Prepare` with dropdown"):
// the Select bar's Prepare ▾ on other profiles. The jobs chosen on the tab's profile are prepared on each profile picked,
// through that profile's own filters and settings, on the signed-in person's AI: a job already at Saved there is
// prepared as it is; a job not tracked there is saved there first (as Save to does: Job Tracker › Change there), then
// prepared; a job tracked there past Saved (applied, an interview…) is left as it is. One confirm before anything
// ("Saves 2 on Ana and prepares them · Uses your AI"), then one message. A profile needs both Job Tracker › Change and
// Prepare › Change, else it is off with the reason; the tab's own needs Prepare alone (its jobs are saved there). At
// most PREPARE_BATCH_MAX jobs a profile (the rest are said). The routes: GET /api/profiles/jobs/saved-on (where each job
// is, in reads of 100), POST /api/profiles/jobs/save, POST /api/profiles/applications/bulk {action: 'prepare'}.

/** A chosen saved job, as the Select bar knows it on the tab's profile. */
export interface PrepareOnJob {
  applicationId: string;
  jobId: number;
  /** Its row offers Prepare on the tab's profile (not preparing, queued or closed). */
  preparable: boolean;
  /** The job closed: nobody can apply to it, on any profile. */
  closed: boolean;
}

/** What Prepare does on one profile. */
export interface PrepareOnPlan {
  profile: ProfileChoice;
  name: string;
  /** The tab's own profile. */
  current: boolean;
  /** Entries at Saved there, prepared as they are (their ids on that profile). */
  ready: string[];
  /** Jobs not tracked there: saved first, then prepared. */
  save: number[];
  /** Jobs left out there: tracked past Saved (applied, …), or (the tab's own) preparing, queued or closed. */
  skipped: number;
  /** Jobs past PREPARE_BATCH_MAX there, left for the next Prepare. */
  over: number;
}

/** Where each chosen job is tracked on each profile: job id → profile → its entry there. */
export type SavedOnMap = ReadonlyMap<number, ReadonlyMap<ProfileChoice, { applicationId: string; status: number }>>;

/** The saved-on reads as one map (pure). */
export function savedOnMap(reads: ReadonlyArray<FanoutSavedOn>): SavedOnMap {
  const map = new Map<number, Map<ProfileChoice, { applicationId: string; status: number }>>();
  for (const read of reads) {
    for (const job of read.jobs) {
      const entries = map.get(job.jobId) ?? new Map();
      for (const entry of job.savedOn) entries.set(entry.profile, { applicationId: entry.applicationId, status: entry.status });
      map.set(job.jobId, entries);
    }
  }
  return map;
}

/**
 * The plan of a Prepare on `targets` (pure: the tests read it). The tab's own profile prepares the chosen rows that offer
 * Prepare; another profile, every open chosen job: at Saved there as it is, not tracked there saved first, past Saved
 * left. Each profile takes at most `max`, in the order chosen.
 */
export function planPrepareOn(
  targets: readonly FanoutProfile[],
  jobs: readonly PrepareOnJob[],
  savedOn: SavedOnMap,
  max: number,
): PrepareOnPlan[] {
  const cap = Math.max(1, Math.floor(max));
  return targets.map((target) => {
    const plan: PrepareOnPlan = { profile: target.choice, name: target.label, current: target.current, ready: [], save: [], skipped: 0, over: 0 };
    let taken = 0;
    for (const job of jobs) {
      const there = target.current ? { applicationId: job.applicationId, status: STATUS.saved } : savedOn.get(job.jobId)?.get(target.choice);
      const usable = target.current ? job.preparable : !job.closed && (!there || there.status === STATUS.saved);
      if (!usable) {
        plan.skipped += 1;
        continue;
      }
      if (taken >= cap) {
        plan.over += 1;
        continue;
      }
      taken += 1;
      if (there) plan.ready.push(there.applicationId);
      else plan.save.push(job.jobId);
    }
    return plan;
  });
}

/** The jobs a plan prepares (over every profile). */
export const plannedJobs = (plans: readonly PrepareOnPlan[]) => plans.reduce((sum, plan) => sum + plan.ready.length + plan.save.length, 0);

/** The confirm's sentence: one profile "Saves 2 on Ana and prepares them · Uses your AI"; several "On 2 profiles · …". */
export function prepareOnLine(plans: readonly PrepareOnPlan[]): string {
  const live = plans.filter((plan) => plan.ready.length + plan.save.length > 0);
  if (live.length === 1) {
    const [plan] = live;
    return plan!.save.length > 0 ? PREPARE_ON.savesAndPrepares(plan!.save.length, plan!.name) : PREPARE_ON.preparesOn(plan!.name);
  }
  return PREPARE_ON.onProfiles(live.length);
}

/** One profile's line in the confirm: "saves 2, prepares 3 · 1 left as is". */
export function prepareOnPlanLine(plan: PrepareOnPlan): string {
  const jobs = plan.ready.length + plan.save.length;
  return [
    plan.save.length > 0 ? PREPARE_ON.saves(plan.save.length) : null,
    PREPARE_ON.prepares(jobs),
    plan.skipped > 0 ? PREPARE_ON.leftAsIs(plan.skipped) : null,
    plan.over > 0 ? PREPARE_ON.overLimit(plan.over) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

type BulkResult = FanoutBulkAnswer['results'][number];

/**
 * v36 FIX-WEB (APPLYWEB's open item; ux M1): the jobs a profile was to save first that were not saved there when the
 * Prepare ran (its box unticked, or its share ended, between the question and the confirm; or the save failed), and why.
 */
export interface NotSavedFirst {
  count: number;
  why: string;
}

/**
 * What the Prepare said, per profile: its outcomes, what it saved first, what it left. v36 FIX-WEB: `notSaved`, a
 * profile's saves that did not happen (its line says how many and why, and the message is the alert); (ux M1) the toast
 * lists each profile's line.
 */
export function prepareOnReport(
  answer: FanoutBulkAnswer,
  plans: readonly PrepareOnPlan[],
  saved: ReadonlyMap<ProfileChoice, number>,
  profiles: readonly FanoutProfile[],
  label: LabelOf,
  notSaved: ReadonlyMap<ProfileChoice, NotSavedFirst> = new Map(),
): FanoutReport {
  const planOf = (profile: ProfileChoice) => plans.find((plan) => plan.profile === profile);
  const affected = answer.results.reduce((sum, result) => sum + (result.ok ? result.affected : 0), 0);
  const report = prepareOnAnswerReport(answer, planOf, saved, profiles, label, affected, notSaved);
  if (notSaved.size === 0) return report;
  // A profile whose saves did not happen and that had nothing at Saved to prepare is not in the answer: its own line.
  const missing = [...notSaved].filter(([profile]) => !answer.results.some((result) => result.profile === profile));
  return {
    ...report,
    refused: true,
    lines: [
      ...missing.map(([profile, why]) => ({
        profile,
        name: nameOf(profiles, profile, planOf(profile)?.name ?? ''),
        ok: false,
        text: PREPARE_ON.notSavedFirst(why.count, why.why),
      })),
      ...report.lines,
    ],
  };
}

function prepareOnAnswerReport(
  answer: FanoutBulkAnswer,
  planOf: (profile: ProfileChoice) => PrepareOnPlan | undefined,
  saved: ReadonlyMap<ProfileChoice, number>,
  profiles: readonly FanoutProfile[],
  label: LabelOf,
  affected: number,
  notSaved: ReadonlyMap<ProfileChoice, NotSavedFirst>,
): FanoutReport {
  return fanoutReport(answer, {
    profiles,
    label,
    did: (result) => result.affected > 0,
    detail: (result) => {
      const outcomes = result.outcomes ?? [];
      const count = (wanted: readonly string[]) => outcomes.filter((outcome) => wanted.includes(outcome.outcome)).length;
      const plan = planOf((result as BulkResult & { ok: true }).profile);
      const skip = outcomes.find((outcome) => outcome.outcome === 'skipped' && outcome.reason?.label)?.reason?.label ?? null;
      const refusedSaves = plan ? notSaved.get(plan.profile) : undefined;
      return [
        FANOUT_COPY.prepareOutcome(count(['started', 'queued']), count(['filtered']), count(['skipped']), skip),
        plan && (saved.get(plan.profile) ?? 0) > 0 ? PREPARE_ON.savedFirst(saved.get(plan.profile) ?? 0) : null,
        plan && plan.skipped > 0 ? PREPARE_ON.leftAsIs(plan.skipped) : null,
        plan && plan.over > 0 ? PREPARE_ON.overLimit(plan.over) : null,
        refusedSaves ? PREPARE_ON.notSavedFirst(refusedSaves.count, refusedSaves.why) : null,
      ]
        .filter(Boolean)
        .join(', ');
    },
    title: () => FANOUT_COPY.prepareStarted(affected),
    none: FANOUT_COPY.prepareNone,
    nothing: (result, name) => FANOUT_COPY.nothingStartedOn(name, result.outcomes?.find((outcome) => outcome.outcome === 'skipped')?.reason?.label ?? null),
    toastLines: true,
  });
}

/**
 * v36 FIX-WEB: why a profile's saves did not happen, from its save's answer (a refused profile: the shell's boxes say
 * why, as every result does; fewer saved than planned: how many, and why), or null when it saved them all.
 */
export function notSavedOf(
  answer: FanoutSaveJobsAnswer,
  profile: ProfileChoice,
  planned: number,
  profiles: readonly FanoutProfile[],
  label: LabelOf,
): NotSavedFirst | null {
  const result = answer.results.find((one) => one.profile === profile) ?? answer.results[0];
  if (!result) return { count: planned, why: FANOUT_COPY.unavailable };
  if (!result.ok) return { count: planned, why: refusalText(profiles, result, label) };
  const made = result.items.length;
  if (made >= planned) return null;
  return { count: planned - made, why: result.notFound > 0 ? PREPARE_ON.cantSeeThere : PREPARE_ON.tryAgain };
}

/** The ids each save made (or brought back) per job, from a save on one profile. */
function savedIdsOf(answer: FanoutSaveJobsAnswer): { ids: string[]; count: number } {
  const ids: string[] = [];
  for (const result of answer.results) if (result.ok) for (const item of result.items) ids.push(item.applicationId);
  return { ids, count: ids.length };
}

export interface PrepareOnProfiles {
  /** Every profile, the tab's own needing Prepare alone, the others Job Tracker › Change and Prepare. */
  profiles: FanoutProfile[];
  labelOf: LabelOf;
  /** The person has a shared profile: the caret shows. */
  available: boolean;
  /** Some profile other than the tab's own is on. */
  othersOn: boolean;
  /** The targets a pick names ('all': every profile that is on). */
  listOf: (targets: FanoutTargets) => ProfileChoice[];
  /** Reads where the jobs are, then asks once (the confirm), then prepares; `onDone` once it started. */
  start: (targets: readonly ProfileChoice[], jobs: readonly PrepareOnJob[], onDone?: () => void) => void;
  /** Reading where the jobs are, or preparing. */
  pending: boolean;
  /** The confirm and the result's alert: render once. */
  elements: ReactElement;
}

interface Asking {
  plans: PrepareOnPlan[];
  onDone?: () => void;
}

export function usePrepareOnProfiles(): PrepareOnProfiles {
  const client = useQueryClient();
  const toast = useToast();
  const { get } = usePublicConstants();
  const both = useFanoutChoices(['tracker:edit', 'prepare:run']);
  const own = useFanoutChoices(['prepare:run']);
  const { label } = both;
  const tabRow = own.profiles.find((profile) => profile.current);
  const profiles = both.profiles.map((profile) => (profile.current && tabRow ? tabRow : profile));
  const report = useFanoutReport();
  const { show } = report;
  const [pending, setPending] = useState(false);
  const [asking, setAsking] = useState<Asking | null>(null);

  const listOf = useCallback(
    (targets: FanoutTargets) =>
      targets === FANOUT_ALL ? profiles.filter((profile) => profile.allowed).map((profile) => profile.choice) : [...targets],
    [profiles],
  );

  const start = useCallback(
    (targets: readonly ProfileChoice[], jobs: readonly PrepareOnJob[], onDone?: () => void) => {
      if (pending) return;
      const chosen = profiles.filter((profile) => targets.includes(profile.choice) && profile.allowed);
      if (chosen.length === 0 || jobs.length === 0) return;
      setPending(true);
      void (async () => {
        try {
          const others = chosen.some((profile) => !profile.current);
          const reads = others ? await Promise.all(savedOnChunks(jobs.map((job) => job.jobId)).map((ids) => fetchSavedOn(ids))) : [];
          const plans = planPrepareOn(chosen, jobs, savedOnMap(reads), get('PREPARE_BATCH_MAX'));
          if (plannedJobs(plans) === 0) {
            toast.info(PREPARE_ON.nothingTitle, PREPARE_ON.nothingLine);
            return;
          }
          setAsking({ plans, onDone });
        } catch (error) {
          if (!isProfileRefusal(error)) toast.error(PREPARE_ON.failed, userMessage(error, 'Please try again.'));
        } finally {
          setPending(false);
        }
      })();
    },
    [pending, profiles, get, toast],
  );

  const run = async ({ plans, onDone }: Asking) => {
    const day = browserDay();
    const saved = new Map<ProfileChoice, number>();
    // v36 FIX-WEB (APPLYWEB's open item): the saves that did not happen, per profile, are named in the result.
    const notSaved = new Map<ProfileChoice, NotSavedFirst>();
    const failures: unknown[] = [];
    const items: FanoutItem[] = [];
    const batch = get('SAVE_BATCH_MAX');
    // One profile after another, as the plans are ordered (the tab's own first): the saves first, then one Prepare.
    for (const plan of plans) {
      let ready = [...plan.ready];
      if (plan.save.length > 0) {
        try {
          const answer = await saveInBatches([plan.profile], plan.save, batch, (to, ids) => saveJobsTo(to, ids, day));
          const made = savedIdsOf(answer);
          saved.set(plan.profile, made.count);
          ready = [...ready, ...made.ids];
          const missed = notSavedOf(answer, plan.profile, plan.save.length, profiles, label);
          if (missed) notSaved.set(plan.profile, missed);
        } catch (error) {
          // The save there failed: what was at Saved there is still prepared, and the result says what was not saved.
          failures.push(error);
          notSaved.set(plan.profile, { count: plan.save.length, why: userMessage(error, PREPARE_ON.tryAgain) });
        }
      }
      for (const applicationId of ready) items.push({ profile: plan.profile, applicationId });
    }
    try {
      if (items.length === 0) {
        // Nothing to prepare anywhere: a save request that failed is the confirm's own error (as before); a save refused
        // on a profile is named in the result.
        if (failures.length > 0 && failures.length === notSaved.size) throw failures[0];
        if (notSaved.size > 0) {
          show(prepareOnReport({ results: [], left: [] }, plans, saved, profiles, label, notSaved));
          return;
        }
        toast.info(PREPARE_ON.nothingTitle, PREPARE_ON.nothingLine);
        return;
      }
      const answer = await bulkInBatches({ action: 'prepare', items });
      show(prepareOnReport(answer, plans, saved, profiles, label, notSaved));
      onDone?.();
    } finally {
      void refreshAfterFanoutSave(client);
      void client.invalidateQueries({ queryKey: ['auto-apply'] });
      void invalidateAccount(client);
    }
  };

  const plans = asking?.plans ?? [];
  const live = plans.filter((plan) => plan.ready.length + plan.save.length > 0);
  const jobs = plannedJobs(plans);
  const elements = (
    <>
      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(open) => !open && setAsking(null)}
        tone="primary"
        title={FANOUT_COPY.prepareConfirmTitle(jobs, live.length)}
        description={prepareOnLine(plans)}
        confirmLabel={FANOUT_COPY.prepareConfirmLabel}
        busyLabel={FANOUT_COPY.prepareBusy}
        // It spends the person's AI on several profiles: it opens on Cancel.
        focusCancel
        onConfirm={async () => {
          if (asking) await run(asking);
        }}
      >
        <div className="flex flex-col gap-3" data-prepare-on-confirm="">
          {plans.length > 1 || plans.some((plan) => plan.skipped + plan.over > 0) ? (
            <ul className="flex flex-col gap-1 text-[13px] leading-5" aria-label={FANOUT_COPY.profilesGroup}>
              {plans.map((plan) => (
                <li key={plan.profile} data-prepare-on={plan.profile}>
                  <span className="font-semibold text-foreground">{plan.name}</span>
                  <span className="text-muted-foreground">{`: ${prepareOnPlanLine(plan)}`}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="text-[13px] leading-5 text-muted-foreground">{FANOUT_COPY.prepareConfirmLine}</p>
        </div>
      </ConfirmDialog>
      {report.element}
    </>
  );

  return {
    profiles,
    labelOf: label,
    available: both.available,
    othersOn: profiles.some((profile) => !profile.current && profile.allowed),
    listOf,
    start,
    pending,
    elements,
  };
}
