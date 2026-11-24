import { grantHolds, lockedLiveGrant, profileEnded } from '../../core/auth/grants';
import { nowIso, type AppDeps } from '../../core/context';
import type { DbTx } from '../../core/db/types';
import { dequeueRows, queueStandOf, type QueueRowOfJob } from '../autofill/agent/queue';
import { archiveSavedRow } from './store';

// v36 FIX-API (D1, the coordinator's decision on the final review's sec M2 = data D6; sec L3): archiving a Saved entry
// never leaves its job applying in the background. Every archive of a Saved entry (Unsave on profiles and MCP's
// unsave_jobs: sharing/fanout/unsave.ts; the Tracker's archive, its bulk archive with or without `onlySaved`, Auto-apply's
// Remove, Archive all: applications/service.ts) runs through here, in one transaction:
// - lockForArchive first: the share it acts under read again and locked (a Stop or a change of its boxes waits), then
//   the owner's person lock, the auto-apply claims' own (queue.ts claimNext, openForTab), so a claim and an archive
//   never interleave.
// - archiveSavedEntry, per entry read at Saved: its job's queue row decides (queue.ts queueStandOf). Not started
//   (queued, held for the owner's OK, to apply to by hand): taken out with the entry, as the queue's Remove does, and
//   counted `dequeued`. Running (the extension is applying to it now): the entry is left in Saved Jobs, the row as it
//   is, counted `applying`. Not started, on a shared profile without Queue changes: both left, counted `queueLocked`.
//   The archive itself keeps a "still Saved and not archived" condition (store.ts archiveSavedRow): an entry moved on
//   since it was read is left alone (`moved`).
// An Undo (the bulk's `unarchive`) restores the entry only: a row taken out is prepared again to be queued. The claims
// also refuse an archived entry's row themselves (queue.ts entryBars), whatever wrote the archive.

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** The share an archive acts under (its key, and who acts: its grantee); null for the owner's own profile. */
export interface ArchiveUnder {
  grantId: string;
  actorId: string;
}

/** What an archive did with the queue (FanoutUnsavedFields', the bulk's and the single archive's fields). */
export interface QueueCounts {
  /** Entries archived whose not-started queue row was taken out with them. */
  dequeued: number;
  /** Saved entries left as they are: the extension is applying to their jobs now. */
  applying: number;
  /** Saved entries left as they are, queued: taking them out of the queue needs that profile's Queue changes. */
  queueLocked: number;
}

export const noQueueCounts = (): QueueCounts => ({ dequeued: 0, applying: 0, queueLocked: 0 });

/** The counts that are not zero (the optional fields of the Tracker's answers: absent when nothing was queued). */
export function nonZeroQueueCounts(counts: QueueCounts): Partial<QueueCounts> {
  return Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0)) as Partial<QueueCounts>;
}

/**
 * Inside an archive's transaction, before anything is read: the share `under` names read again and locked FOR SHARE,
 * still the actor's, of `ownerId` and holding the Job Tracker's Change (else profile_ended: the answer of a key that
 * may not be used), then the owner's person lock. Answers whether the archive may take rows out of the queue: always on
 * the owner's own profile, on a shared one only with its Queue changes (`queue:edit`).
 */
export async function lockForArchive(deps: Deps, t: DbTx, ownerId: string, under: ArchiveUnder | null): Promise<boolean> {
  let mayChangeQueue = true;
  if (under) {
    const grant = await lockedLiveGrant(deps, t, under.grantId, 'share');
    if (!grant || grant.owner.id !== ownerId || grant.granteeId !== under.actorId || !grantHolds(grant, 'tracker:edit')) throw profileEnded();
    mayChangeQueue = grantHolds(grant, 'queue:edit');
  }
  await t.lockPerson(ownerId);
  return mayChangeQueue;
}

/** What became of one entry read at Saved and not archived. */
export type SavedArchiveOutcome = 'archived' | 'dequeued' | 'applying' | 'queue_locked' | 'moved';

/**
 * Archives one entry read at Saved and not archived (after lockForArchive, in its transaction), with its job's queue
 * row `row` (queue.ts queueRowsOfJobs): see the module's note.
 */
export async function archiveSavedEntry(
  deps: Deps,
  ownerId: string,
  entryId: string,
  row: QueueRowOfJob | undefined,
  mayChangeQueue: boolean,
): Promise<SavedArchiveOutcome> {
  const stand = queueStandOf(row, mayChangeQueue);
  if (stand === 'applying') return 'applying';
  if (stand === 'locked') return 'queue_locked';
  if (!(await archiveSavedRow(deps.db, ownerId, entryId, nowIso(deps)))) return 'moved';
  if (stand === 'dequeue' && row) {
    await dequeueRows(deps, ownerId, [row]);
    return 'dequeued';
  }
  return 'archived';
}

/** Adds one outcome to `counts`. */
export function countOutcome(counts: QueueCounts, outcome: SavedArchiveOutcome): void {
  if (outcome === 'dequeued') counts.dequeued += 1;
  else if (outcome === 'applying') counts.applying += 1;
  else if (outcome === 'queue_locked') counts.queueLocked += 1;
}
