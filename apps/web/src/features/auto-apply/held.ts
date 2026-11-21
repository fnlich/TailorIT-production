import {
  HeldApprovedSchema,
  HeldListSchema,
  HeldRemovedSchema,
  type HeldApproved,
  type HeldDecisionBodySchema,
  type HeldList,
  type HeldRemoved,
} from '@tailorit/shared/auto-apply';
import type { QueuePaneItem } from '@tailorit/shared/prepare';
import type { z } from 'zod';
// Relative, not '@/': the web tests draw these views.
import { api } from '../../lib/api';
import type { QueueRow, StateLine } from './copy';

// v33 SHARE-7 (PLAN F9 "Prepare and the queue"; SP v33 PLAN-sharing.md §6 "Jobs wait for A's OK"): the jobs someone the
// person shares their profile with (B) prepared on it wait for the person's (A's) OK before A's extension applies to
// them, unless A ticked "Apply without my OK". A sees them on Auto-apply per share: "From Bob · 12 wait for your OK",
// Approve all, Remove. B, working on A's profile, sees "Waiting for Ana's OK" on those rows. The routes are SHARE-5's,
// `never` while the tab works on a shared profile (approving is A's alone), and only ever answer A's own profile.
//   GET  /api/auto-apply/held     → { groups: HeldGroup[] }
//   POST /api/auto-apply/approve  { grantKey, ids?, through? } → { approved }
//   POST /api/auto-apply/reject   { grantKey, ids?, through? } → { removed }
// With no ids, `through` (a group's `newestAt` as the person saw it) is required and only the rows held at or before it
// change: a row B prepared after the confirm's read is never approved or removed unseen (the SHARE-7 review's finding 1,
// agreed with SHARE-5's fixer).
// v33 INT-C: the contract is SHARE-5's (@tailorit/shared/auto-apply held.ts: HeldGroup {grantKey, name, email, count,
// oldestAt, newestAt}, HeldList, HeldDecisionBody, HeldApproved, HeldRemoved); the queue row's `awaitingOwner` is
// QueuePaneItemSchema's.
export { HeldGroupSchema, HeldListSchema, type HeldGroup, type HeldList } from '@tailorit/shared/auto-apply';

/** Whether a queue row waits for the profile owner's OK (only B, working on A's profile, gets such rows). */
export function awaitsOwner(item: QueuePaneItem): boolean {
  return item.awaitingOwner === true;
}

/**
 * A row that waits for the profile owner's OK, in place of its state line (null: any other row). B, on A's profile:
 * "Waiting for Ana's OK"; A, should their own pane list one: "Waiting for your OK" (the card above approves it).
 */
export function heldLine(row: QueueRow, tab: { acting: boolean; ownerName: string | null }): StateLine | null {
  if (row.kind !== 'queue' || !awaitsOwner(row.item)) return null;
  if (!tab.acting) return { icon: 'clock', text: HELD_COPY.title, detail: HELD_COPY.yoursDetail, tone: 'muted' };
  return {
    icon: 'clock',
    text: tab.ownerName ? HELD_COPY.waiting(tab.ownerName) : HELD_COPY.waitingOwnerless,
    detail: HELD_COPY.waitingDetail,
    tone: 'muted',
  };
}

export const heldKeys = {
  held: ['auto-apply', 'held'] as const,
};

/** GET /api/auto-apply/held (the person's own profile only). */
export function fetchHeld(signal?: AbortSignal): Promise<HeldList> {
  return api.get<HeldList>('/api/auto-apply/held', { signal, schema: HeldListSchema });
}

/**
 * Which held jobs of a share a decision covers: the ones named, or every one held at or before `through` (the group's
 * `newestAt` as the confirm read it). Never "every one": a job held after the person looked is not theirs to decide yet.
 */
export type HeldScope = { ids: readonly string[] } | { through: string };

/** The body of an approve or reject (SHARE-5's HeldDecisionBody as sent). */
export function heldDecisionBody(grantKey: string, scope: HeldScope): z.input<typeof HeldDecisionBodySchema> {
  return 'ids' in scope ? { grantKey, ids: [...scope.ids] } : { grantKey, through: scope.through };
}

/** POST /api/auto-apply/approve: the held jobs of that share in `scope` go into the queue. */
export function approveHeld(grantKey: string, scope: HeldScope): Promise<HeldApproved> {
  return api.post('/api/auto-apply/approve', heldDecisionBody(grantKey, scope), { schema: HeldApprovedSchema });
}

/** POST /api/auto-apply/reject: the held jobs of that share in `scope` leave the queue. */
export function rejectHeld(grantKey: string, scope: HeldScope): Promise<HeldRemoved> {
  return api.post('/api/auto-apply/reject', heldDecisionBody(grantKey, scope), { schema: HeldRemovedSchema });
}

export const HELD_COPY = {
  title: 'Waiting for your OK',
  tip: 'Jobs someone you share your profile with prepared; your extension applies to them only after you approve.',
  group: (name: string, count: number) => `From ${name} · ${count} ${count === 1 ? 'waits' : 'wait'} for your OK`,
  approveAll: 'Approve all',
  remove: 'Remove',
  approveTitle: (count: number, name: string) => `Approve ${count} ${count === 1 ? 'job' : 'jobs'} from ${name}?`,
  approveDescription: 'They join your queue, and your extension applies to them in turn.',
  approveConfirm: 'Approve all',
  approving: 'Approving...',
  approved: (count: number) => `${count} ${count === 1 ? 'job' : 'jobs'} added to your queue`,
  removeTitle: (count: number, name: string) => `Remove ${count} ${count === 1 ? 'job' : 'jobs'} from ${name}?`,
  removeDescription: 'They leave your queue. The jobs stay saved in your Job Tracker.',
  removeConfirm: 'Remove',
  removing: 'Removing...',
  removed: (count: number) => `${count} ${count === 1 ? 'job' : 'jobs'} removed`,
  /** The confirm while it reads how many wait now. */
  checkingTitle: (name: string) => `Checking the jobs from ${name}...`,
  checkingDescription: 'Counting the jobs that wait now.',
  /** Nothing of that share waits any more (approved or removed elsewhere). */
  noneLeft: (name: string) => `Nothing from ${name} waits for your OK now`,
  readFailed: "The jobs waiting for your OK didn't load",
  /** B's row, on A's profile. */
  waiting: (owner: string) => `Waiting for ${owner}'s OK`,
  waitingOwnerless: "Waiting for the owner's OK",
  waitingDetail: 'They approve it first',
  /** A's own row, should their pane list one. */
  yoursDetail: 'Approve it above',
} as const;
