'use client';

import type { ApplicationStatus } from '@tailorit/shared';
import type { FanoutBulkAnswer, FanoutBulkBody, FanoutCopySavedAnswer, FanoutItem, FanoutTargets } from '@tailorit/shared/sharing';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, type ReactElement } from 'react';
import { invalidateAccount } from '@/lib/account';
import { usePublicConstants } from '@/lib/constants';
import { bulkOnProfiles, copySavedTo } from '../../sharing/fanout/api';
import { FANOUT_COPY, namesList, queueNotes } from '../../sharing/fanout/copy';
import { fanoutReport, nameOf, refusalText, type FanoutReport } from '../../sharing/fanout/results';
import { rowName, type FanoutProfile, type LabelOf } from '../../sharing/fanout/targets';
import { refreshAfterFanoutSave, useFanoutChoices, useFanoutReport, type FanoutChoices } from '../../sharing/fanout/useFanout';
import { browserDay, bulkInBatches, copyInBatches, nothingSaved, savedItems, useUndoSaved } from '../../sharing/fanout/useSaveTo';
import { invalidateApplications } from '../data';
import type { BulkKind } from '../toolbar/Toolbar';

// v34 FANWEB (PLAN G2, G4): the Job Tracker's actions on several profiles. Copy to profiles… (the single view's Select
// and the All profiles view's): the selected entries' jobs saved on the profiles chosen, as Saved (POST
// /api/profiles/applications/copy: never their notes, history or documents). The All profiles view's bulk actions (Move
// to a stage, Archive, Restore, Prepare): one request, each card on its own profile (POST
// /api/profiles/applications/bulk), a card whose profile is shared to see only left out and named. One message each,
// Undo for a copy and for archiving or restoring.
// v34 FANWEB fix: a profile where nothing happened is named with why; Move, Archive and Restore go in batches the route
// takes; Copy's Undo says what it removed (and a failure).
// v34 INT-2 (FIX-WEB's follow-up to share L3): Copy to profiles goes in batches of SAVE_BATCH_MAX (the copy route's
// cap), as Save to does: one message and one Undo for the whole copy.

/** What a copy says: where the jobs went, a source or a target refused, cards with no job. */
export function copyReport(answer: FanoutCopySavedAnswer, profiles: readonly FanoutProfile[], label: LabelOf): FanoutReport {
  const report = fanoutReport(answer, {
    profiles,
    label,
    did: (result) => result.saved + result.restored + result.alreadyTracked > 0,
    detail: (result) => FANOUT_COPY.savedCounts(result.saved + result.restored, result.alreadyTracked, result.notFound + result.notReached),
    title: FANOUT_COPY.copiedTo,
    none: FANOUT_COPY.nothingCopied,
    nothing: (result, name) => nothingSaved(result, name),
  });
  const noJob = answer.sources.reduce((sum, source) => sum + (source.ok ? source.noJob : 0), 0);
  const refusedSources = answer.sources.filter((source) => !source.ok);
  const lines = [
    ...refusedSources.map((source) => ({
      profile: source.profile,
      name: profiles.find((profile) => profile.choice === source.profile)?.label ?? source.name,
      ok: false,
      text: source.ok ? '' : refusalText(profiles, source, label),
    })),
    ...report.lines,
  ];
  const extra = noJob > 0 ? FANOUT_COPY.noJob(noJob) : null;
  return {
    ...report,
    lines,
    refused: report.refused || refusedSources.length > 0,
    description: [report.description, extra].filter(Boolean).join(' ') || null,
    notes: [...(report.notes ?? []), ...(extra ? [extra] : [])],
  };
}

/** The word of a bulk action's result ("archived", "moved"). */
const BULK_WORD = { archive: 'archived', unarchive: 'restored', status: 'moved', prepare: 'prepared' } as const;

/** What a bulk action says: how many cards on which profiles, the cards left alone (shared to see only). */
export function bulkReport(
  answer: FanoutBulkAnswer,
  action: keyof typeof BULK_WORD,
  profiles: readonly FanoutProfile[],
  label: LabelOf,
  skipped: readonly string[],
): FanoutReport {
  const affected = answer.results.reduce((sum, result) => sum + (result.ok ? result.affected : 0), 0);
  const isPrepare = action === 'prepare';
  // v36 FIX-WEB (D1): an archive says on each profile's line what it did to that profile's auto-apply queue, and then
  // the toast lists those lines (ux M1).
  const box = rowName('queue:edit', label);
  const queueOf = (result: FanoutBulkAnswer['results'][number]) =>
    action === 'archive' && result.ok ? queueNotes(result, box, nameOf(profiles, result.profile, result.name)) : [];
  const report = fanoutReport(answer, {
    profiles,
    label,
    did: (result) => result.affected > 0,
    toastLines: answer.results.some((result) => queueOf(result).length > 0),
    detail: (result) => {
      const queue = queueOf(result as FanoutBulkAnswer['results'][number]);
      if (!isPrepare) return [FANOUT_COPY.bulkDone(result.affected, BULK_WORD[action]), ...queue].join(', ');
      const outcomes = result.outcomes ?? [];
      const count = (wanted: readonly string[]) => outcomes.filter((outcome) => wanted.includes(outcome.outcome)).length;
      return FANOUT_COPY.prepareOutcome(count(['started', 'queued']), count(['filtered']), count(['skipped']), firstSkip(outcomes));
    },
    title: () => (isPrepare ? FANOUT_COPY.prepareStarted(affected) : FANOUT_COPY.bulkDone(affected, BULK_WORD[action])),
    none: isPrepare ? FANOUT_COPY.prepareNone : FANOUT_COPY.bulkNothing,
    extra: () => (skipped.length > 0 ? FANOUT_COPY.readOnlySkipped(namesList([...skipped])) : null),
    // v34 FANWEB fix (spec M2, L8): a profile where nothing happened, and why (Prepare: its first skip's reason).
    nothing: (result, name) =>
      isPrepare ? FANOUT_COPY.nothingStartedOn(name, firstSkip(result.outcomes ?? [])) : FANOUT_COPY.nothingToChangeOn(name),
  });
  return report;
}

/** The first skipped job's reason on a profile (its words, as the server renders them), or null. */
function firstSkip(outcomes: NonNullable<FanoutBulkAnswer['results'][number] & { ok: true }>['outcomes'] = []): string | null {
  const skip = outcomes.find((outcome) => outcome.outcome === 'skipped' && outcome.reason?.label);
  return skip?.reason?.label ?? null;
}

export interface TrackerFanout extends FanoutChoices {
  /** Copies the entries' jobs to `targets` (in batches of SAVE_BATCH_MAX; one message, one Undo). */
  copy: (items: readonly FanoutItem[], targets: FanoutTargets) => Promise<void>;
  /** A bulk action on cards of several profiles; `skipped`: the profiles whose cards were left out (see only). */
  bulk: (kind: BulkKind, items: readonly FanoutItem[], skipped: readonly string[]) => Promise<void>;
  /** Prepare on cards of several profiles (the confirm is the caller's). */
  prepare: (items: readonly FanoutItem[]) => Promise<void>;
  /** The result's alert: render once. */
  element: ReactElement;
}

export function useTrackerFanout(): TrackerFanout {
  const client = useQueryClient();
  const choices = useFanoutChoices(['tracker:edit']);
  const batch = usePublicConstants().get('SAVE_BATCH_MAX');
  const { profiles, label } = choices;
  const report = useFanoutReport();
  const { show } = report;
  const undoSaved = useUndoSaved(report, choices);

  const refresh = useCallback(() => {
    void invalidateApplications(client);
    void refreshAfterFanoutSave(client);
  }, [client]);

  const run = useCallback(
    async (kind: BulkKind | 'prepare', items: readonly FanoutItem[], skipped: readonly string[], undoable: boolean): Promise<void> => {
      const action = typeof kind === 'object' ? 'status' : kind;
      if (action === 'delete') return; // never on several profiles: a person who was shared a profile archives
      const status: ApplicationStatus | undefined = typeof kind === 'object' ? kind.status : undefined;
      try {
        const body: FanoutBulkBody = { action, items: [...items], ...(status !== undefined ? { status, occurredOn: browserDay() } : {}) };
        // Prepare in one request (each profile's own cap, PREPARE_BATCH_MAX, is that profile's to say); the rest in batches.
        const answer = action === 'prepare' ? await bulkOnProfiles(body) : await bulkInBatches(body);
        const done = answer.results.filter((result) => result.ok && result.affected > 0).map((result) => result.profile);
        const back = items.filter((item) => done.includes(item.profile));
        const reverse = action === 'archive' ? 'unarchive' : action === 'unarchive' ? 'archive' : null;
        show(
          bulkReport(answer, action, profiles, label, skipped),
          undoable && reverse && back.length > 0 ? () => void run(reverse, back, [], false) : undefined,
        );
      } finally {
        refresh();
        if (action === 'prepare') {
          void client.invalidateQueries({ queryKey: ['auto-apply'] });
          void invalidateAccount(client);
        }
      }
    },
    [profiles, label, show, refresh, client],
  );

  const copy = useCallback(
    async (items: readonly FanoutItem[], targets: FanoutTargets) => {
      const day = browserDay();
      const answer = await copyInBatches(items, targets, batch, (slice, to) => copySavedTo(slice, to, day));
      refresh();
      const made = savedItems(answer);
      show(
        copyReport(answer, profiles, label),
        made.length > 0
          ? () =>
              void undoSaved(made, FANOUT_COPY.copyUndone).finally(() => {
                refresh();
              })
          : undefined,
      );
    },
    [profiles, label, show, refresh, undoSaved, batch],
  );

  return {
    ...choices,
    copy,
    bulk: (kind, items, skipped) => run(kind, items, skipped, true),
    prepare: (items) => run('prepare', items, [], false),
    element: report.element,
  };
}
