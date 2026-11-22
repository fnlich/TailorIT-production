'use client';

import { toIsoDate } from '@tailorit/shared';
import {
  FANOUT_BULK_ITEMS_MAX,
  type FanoutBulkAnswer,
  type FanoutBulkBody,
  type FanoutCopySavedAnswer,
  type FanoutCopySource,
  type FanoutItem,
  type FanoutSaveJobsAnswer,
  type FanoutTargets,
  type ProfileChoice,
} from '@tailorit/shared/sharing';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, type ReactElement } from 'react';
// Relative, not '@/': the web tests draw these parts.
import { useToast } from '../../../components/ui/Toast';
import { isProfileRefusal, userMessage } from '../../../lib/api';
import { usePublicConstants } from '../../../lib/constants';
import { bulkOnProfiles, saveJobsTo } from './api';
import { FANOUT_COPY } from './copy';
import { fanoutReport, type FanoutReport } from './results';
import type { FanoutProfile, LabelOf } from './targets';
import { refreshAfterFanoutSave, useFanoutChoices, useFanoutReport, type FanoutChoices, type ReportShow } from './useFanout';

// v34 FANWEB (PLAN G2, G4): "Save to…" (the job's details, a row's arrow, the Select bar): these jobs saved on the
// profiles chosen in one request (POST /api/profiles/jobs/save; each profile picks its own best-matched resume), one
// message for the result, and Undo: the bulk archive of exactly what this save made, `onlySaved` (an entry moved past
// Saved meanwhile is left alone). Offered only where the tab may save (its profile's Job Tracker › Change).
// v34 FANWEB fix: a profile where nothing was saved is named with why; the Undo goes in batches the bulk route takes
// (FANOUT_BULK_ITEMS_MAX each) and says what it did on each profile (a profile it could not reach is the one alert).
// v34 FIX-WEB (final review share L3): the save itself goes in batches of SAVE_BATCH_MAX (Select all over a long list).
// v34 INT-2: the Job Tracker's Copy to profiles too (copyInBatches).

/** The browser's day (a Saved date is the person's own day). */
export function browserDay(): string {
  return toIsoDate(new Date()) ?? new Date().toISOString().slice(0, 10);
}

/** v34 FANWEB fix (spec M2): a profile where a save saved nothing, named with why ("Ana Lopez can't see this job."). */
export function nothingSaved(result: { notFound: number; notReached: number }, name: string): string {
  if (result.notFound > 0) return FANOUT_COPY.cantSee(name, result.notFound);
  return result.notReached > 0 ? FANOUT_COPY.notReached(name) : FANOUT_COPY.nothingNewOn(name);
}

/** What a save on several profiles says. */
export function saveReport(answer: FanoutSaveJobsAnswer, profiles: readonly FanoutProfile[], label: LabelOf): FanoutReport {
  return fanoutReport(answer, {
    profiles,
    label,
    did: (result) => result.saved + result.restored + result.alreadyTracked > 0,
    detail: (result) => FANOUT_COPY.savedCounts(result.saved + result.restored, result.alreadyTracked, result.notFound + result.notReached),
    title: FANOUT_COPY.savedOn,
    none: FANOUT_COPY.notSavedTitle,
    nothing: (result, name) => nothingSaved(result, name),
  });
}

/** The entries a save made, per profile (its Undo). */
export function savedItems(answer: {
  results: ReadonlyArray<{ ok: true; profile: FanoutItem['profile']; items: ReadonlyArray<{ applicationId: string }> } | { ok: false }>;
}): FanoutItem[] {
  return answer.results.flatMap((result) => (result.ok ? result.items.map((item) => ({ profile: result.profile, applicationId: item.applicationId })) : []));
}

/**
 * v34 FANWEB fix (spec M1): one bulk action over any number of entries, sent in batches of at most
 * FANOUT_BULK_ITEMS_MAX (the route's cap; Save all on every profile, or a big copy, makes more), the answers laid
 * together per profile (the counts added; a refusal of a profile in any batch is that profile's answer). `send` is the
 * route's call (the tests pass a fake).
 */
export async function bulkInBatches(
  body: FanoutBulkBody,
  send: (body: FanoutBulkBody) => Promise<FanoutBulkAnswer> = bulkOnProfiles,
): Promise<FanoutBulkAnswer> {
  const byProfile = new Map<ProfileChoice, FanoutBulkAnswer['results'][number]>();
  let left: FanoutBulkAnswer['left'] = [];
  for (let start = 0; start < body.items.length; start += FANOUT_BULK_ITEMS_MAX) {
    const answer = await send({ ...body, items: body.items.slice(start, start + FANOUT_BULK_ITEMS_MAX) });
    left = answer.left;
    for (const result of answer.results) {
      const before = byProfile.get(result.profile);
      if (!before || !result.ok) byProfile.set(result.profile, result);
      else if (before.ok) {
        const outcomes = before.outcomes || result.outcomes ? [...(before.outcomes ?? []), ...(result.outcomes ?? [])] : undefined;
        byProfile.set(result.profile, { ...before, affected: before.affected + result.affected, ...(outcomes ? { outcomes } : {}) });
      }
    }
  }
  return { results: [...byProfile.values()], left };
}

type SaveResult = FanoutSaveJobsAnswer['results'][number];

/** Two answers of one profile laid together: the counts added, the items and the ids joined. */
function addSaved(before: SaveResult & { ok: true }, next: SaveResult & { ok: true }): SaveResult {
  return {
    ...before,
    saved: before.saved + next.saved,
    restored: before.restored + next.restored,
    alreadyTracked: before.alreadyTracked + next.alreadyTracked,
    notFound: before.notFound + next.notFound,
    notFoundIds: [...before.notFoundIds, ...next.notFoundIds],
    notReached: before.notReached + next.notReached,
    items: [...before.items, ...next.items],
    pendingMatches: before.pendingMatches + next.pendingMatches,
    incomplete: before.incomplete || next.incomplete,
  };
}

/**
 * v34 FIX-WEB (final review share L3): a save of any number of jobs on several profiles, sent in batches of at most
 * `max` (SAVE_BATCH_MAX, the route's cap: Select all over a long list), the answers laid together per profile (a refusal
 * of a profile in any batch is that profile's answer), so one message and one Undo cover the whole save. A batch that
 * fails after an earlier one saved stops the save: its jobs and the rest count as not reached on every profile that
 * answered (the person tries again); a failure of the first batch is the whole save's. `send` is the route's call (the
 * tests pass a fake).
 */
export async function saveInBatches(
  targets: FanoutTargets,
  jobIds: readonly number[],
  max: number,
  send: (targets: FanoutTargets, jobIds: readonly number[]) => Promise<FanoutSaveJobsAnswer>,
): Promise<FanoutSaveJobsAnswer> {
  return layBatches([...new Set(jobIds)], max, (ids) => send(targets, ids));
}

/**
 * v34 INT-2 (FIX-WEB's follow-up to share L3): Copy to profiles over any number of Job Tracker entries, in batches of
 * at most `max` (SAVE_BATCH_MAX, the copy route's cap) as saveInBatches: each target's answers laid together, each
 * source's reads added (a source refused in any batch is that source's answer), so one message and one Undo cover the
 * whole copy. `send` is the route's call (the tests pass a fake).
 */
export async function copyInBatches(
  items: readonly FanoutItem[],
  targets: FanoutTargets,
  max: number,
  send: (items: readonly FanoutItem[], targets: FanoutTargets) => Promise<FanoutCopySavedAnswer>,
): Promise<FanoutCopySavedAnswer> {
  const sources = new Map<ProfileChoice, FanoutCopySource>();
  const answer = await layBatches(items, max, async (slice) => {
    const part = await send(slice, targets);
    for (const source of part.sources) {
      const before = sources.get(source.profile);
      if (!before || !source.ok) sources.set(source.profile, source);
      else if (before.ok) {
        sources.set(source.profile, {
          ...before,
          found: before.found + source.found,
          jobs: before.jobs + source.jobs,
          noJob: before.noJob + source.noJob,
          notFound: before.notFound + source.notFound,
        });
      }
    }
    return part;
  });
  return { ...answer, sources: [...sources.values()] };
}

/** The batches of a save (saveInBatches, copyInBatches): `list` sent `max` at a time, each profile's answers together. */
async function layBatches<T>(
  list: readonly T[],
  max: number,
  send: (slice: readonly T[]) => Promise<FanoutSaveJobsAnswer>,
): Promise<FanoutSaveJobsAnswer> {
  const size = Math.max(1, Math.floor(max));
  const byProfile = new Map<ProfileChoice, SaveResult>();
  let left: FanoutSaveJobsAnswer['left'] = [];
  for (let start = 0; start < list.length; start += size) {
    let answer: FanoutSaveJobsAnswer;
    try {
      answer = await send(list.slice(start, start + size));
    } catch (error) {
      if (start === 0) throw error;
      const rest = list.length - start;
      for (const [profile, result] of byProfile) {
        if (result.ok) byProfile.set(profile, { ...result, notReached: result.notReached + rest, incomplete: true });
      }
      break;
    }
    left = answer.left;
    for (const result of answer.results) {
      const before = byProfile.get(result.profile);
      if (!before || !result.ok) byProfile.set(result.profile, result);
      else if (before.ok) byProfile.set(result.profile, addSaved(before, result));
    }
  }
  return { results: [...byProfile.values()], left };
}

/** v34 FANWEB fix (sharing L4): what an Undo did: removed where it could, a profile it could not reach in the one alert. */
export function undoReport(
  answer: FanoutBulkAnswer,
  profiles: readonly FanoutProfile[],
  label: LabelOf,
  words: (count: number) => string = FANOUT_COPY.undone,
): FanoutReport {
  const affected = answer.results.reduce((sum, result) => sum + (result.ok ? result.affected : 0), 0);
  return fanoutReport(answer, {
    profiles,
    label,
    did: (result) => result.affected > 0,
    detail: (result) => words(result.affected),
    title: () => words(affected),
    none: FANOUT_COPY.undoneNone,
  });
}

/**
 * The Undo of a save or a copy on several profiles: the entries it made archived while still Saved, in batches, and
 * one message (`report`) of what it did on each profile.
 */
export function useUndoSaved(report: ReportShow, choices: Pick<FanoutChoices, 'profiles' | 'label'>) {
  const client = useQueryClient();
  const toast = useToast();
  const { show } = report;
  const { profiles, label } = choices;
  return useCallback(
    async (items: readonly FanoutItem[], words?: (count: number) => string) => {
      try {
        const answer = await bulkInBatches({ action: 'archive', onlySaved: true, items: [...items] });
        show(undoReport(answer, profiles, label, words));
      } catch (error) {
        if (!isProfileRefusal(error)) toast.error(FANOUT_COPY.undoFailed, userMessage(error));
      } finally {
        void refreshAfterFanoutSave(client);
      }
    },
    [client, toast, show, profiles, label],
  );
}

export interface SaveToProfiles extends FanoutChoices {
  /** Saves `jobIds` on `targets`, then says what happened (a whole refusal throws: the caller's toast or dialog says it). */
  save: (targets: FanoutTargets, jobIds: readonly number[]) => Promise<FanoutSaveJobsAnswer>;
  /** Undo of a save: the entries it made, archived while still Saved. */
  undo: (items: readonly FanoutItem[]) => Promise<void>;
  /** Shows another result the same way (Save all to). */
  show: (report: FanoutReport, undo?: () => void) => void;
  /** The result's alert: render once. */
  element: ReactElement;
}

export function useSaveToProfiles(): SaveToProfiles {
  const client = useQueryClient();
  const choices = useFanoutChoices(['tracker:edit']);
  const batch = usePublicConstants().get('SAVE_BATCH_MAX');
  const { profiles, label } = choices;
  const report = useFanoutReport();
  const { show } = report;
  const undoSaved = useUndoSaved(report, choices);
  const undo = useCallback((items: readonly FanoutItem[]) => undoSaved(items), [undoSaved]);

  const save = useCallback(
    async (targets: FanoutTargets, jobIds: readonly number[]) => {
      const day = browserDay();
      const answer = await saveInBatches(targets, jobIds, batch, (to, ids) => saveJobsTo(to, ids, day));
      void refreshAfterFanoutSave(client);
      const items = savedItems(answer);
      show(saveReport(answer, profiles, label), items.length > 0 ? () => void undo(items) : undefined);
      return answer;
    },
    [client, profiles, label, show, undo, batch],
  );

  // v3.3's rule: a tab on a profile shared to see only has no write control on the Jobs page, so no Save to either
  // (the person saves on their own profile from there).
  const tabMaySave = profiles.some((profile) => profile.current && profile.allowed);
  return { ...choices, available: choices.available && tabMaySave, save, undo, show, element: report.element };
}
