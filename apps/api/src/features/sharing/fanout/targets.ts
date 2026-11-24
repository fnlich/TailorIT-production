import {
  FANOUT_ALL,
  PROFILE_SELF,
  type FanoutLeft,
  type FanoutRefused,
  type FanoutTargets,
  type ProfileChoice,
  type SharePermission,
  type SharingActivityVia,
} from '@tailorit/shared/sharing';
import { grantHolds, liveGrantById, lockedLiveGrant, profileEnded, reachableProfiles, type LiveGrant } from '../../../core/auth/grants';
import { constantsOf } from '../../../core/constants/service';
import type { AppDeps } from '../../../core/context';
import type { DbQueries } from '../../../core/db/types';
import { AppError } from '../../../core/http/errors';
import { refuse } from '../../../core/http/refuse';
import { areaOfPermission, countActivity } from '../activity';

// v34 FANOUT (PLAN G1): one action on several profiles. The routes under /api/profiles (acting policy `self`: they
// always serve the signed-in person, A, and ignore the tab's X-TailorIT-Profile; `'me'` is always A) name their targets;
// this module decides each one and runs the work once per target, A's own first:
// - `'me'` is A's own profile; a key is a live grant of A's that holds every box the action needs (`perms`, and the
//   channel's `extraPerms`: MCP's `mcp`); `'all'` is A's own and every such grant (reachableProfiles: the one live-grant
//   predicate, core/auth/grants.ts), with `left` naming the channel's live shares whose boxes do not allow the action.
//   Repeats are dropped. A list of more than 1 + SHARING_PROFILES_PER_GRANTEE profiles: 400 for the whole request
//   (`'all'` is never refused for its size).
// - A key A may not use (unknown, someone else's, ended, or without a box) is refused with one answer whatever the case
//   (refusedAsUnknown: profile_ended, MSG_FANOUT_PROFILE_UNUSABLE, no name). Each share is read again just before its
//   own work (runOn: liveGrantById), so a share that ends or loses the box while earlier targets run gets that answer
//   too; the settings writes also lock it in their transaction (lockGrantIn), and a work's own profile_ended /
//   profile_not_shared (startPrepare's locked read) answers the same.
// - The work's own refusal (an AppError: the AI budget, a check) is that profile's result, in
//   its code and words; anything else is logged and answered as MSG_FANOUT_PROFILE_FAILED. The other profiles go on.
// - Each grant whose work changed something (`wrote`; a read always) is counted in its activity (profile_activity, ids
//   and codes only): the area of the action's box, `write` or `read`, via `web` (MCP passes `via: 'mcp'` and keeps the
//   `write`/`read` actions, which the activity list names).

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** Who acts: the signed-in person (A). */
export interface FanoutActor {
  id: string;
  name: string;
}

/** One profile the work runs on. */
export interface FanoutTarget {
  readonly profile: ProfileChoice;
  /** Whose data: the profile's owner (A on `me`). */
  readonly ownerId: string;
  /** The owner's name. */
  readonly name: string;
  /** The live grant (null on A's own profile), as read just before the work. */
  readonly grant: LiveGrant | null;
}

/** Whether A may do what `perm` guards on `target` (always on A's own profile). */
export const targetHolds = (target: FanoutTarget, perm: SharePermission): boolean => target.grant === null || grantHolds(target.grant, perm);

/** How a fan-out counts itself in each grant's activity, and what more each grant must hold. */
export interface FanoutOptions {
  /** The activity's channel (default `web`; MCP passes `mcp`). */
  via?: SharingActivityVia;
  /** The activity's action (default `write`; a read passes `read`). Keep `write`/`read`: the activity list names them. */
  action?: string;
  /** Boxes each grant must hold besides the action's own (MCP: `mcp`); a share without them is not even `left`. */
  extraPerms?: readonly SharePermission[];
}

/** One profile's outcome: the work's fields, or the refusal. */
export type FanoutOutcome<T extends object> =
  | ({ profile: ProfileChoice; name: string; ok: true } & T)
  | FanoutRefused;

/** A fan-out's answer: every target's outcome, and the shares `'all'` left out. */
export interface FanoutAnswer<T extends object> {
  results: Array<FanoutOutcome<T>>;
  left: FanoutLeft[];
}

/** The targets decided: each usable one or its refusal, the shares `'all'` left out, and every box a grant must hold. */
export interface FanoutResolved {
  entries: Array<FanoutTarget | FanoutRefused>;
  left: FanoutLeft[];
  perms: readonly SharePermission[];
}

/** The most profiles a list reaches: A's own and SHARING_PROFILES_PER_GRANTEE (read now). */
export const fanoutTargetsMax = (deps: Deps): number => 1 + constantsOf(deps).get('SHARING_PROFILES_PER_GRANTEE');

/** The one answer a profile A may not use gets, whatever the reason: profile_ended, its words, no name. */
export function refusedAsUnknown(deps: Deps, profile: ProfileChoice): FanoutRefused {
  return {
    profile,
    name: '',
    ok: false,
    refused: 'profile_ended',
    message: constantsOf(deps).message('MSG_FANOUT_PROFILE_UNUSABLE'),
  };
}

/**
 * The targets of a request, A's own first: each usable one (a live grant holding `perms` and `options.extraPerms`), or
 * its refusal. Throws 400 (MSG_FANOUT_TOO_MANY_PROFILES) for a list of more than fanoutTargetsMax profiles.
 */
export async function resolveTargets(
  deps: Deps,
  actor: FanoutActor,
  targets: FanoutTargets,
  perms: readonly SharePermission[],
  options: FanoutOptions = {},
): Promise<FanoutResolved> {
  const channel = options.extraPerms ?? [];
  const all = [...new Set([...perms, ...channel])];
  // The channel's live shares (MCP: those with `mcp`); one read whatever the keys.
  const live = await reachableProfiles(deps, actor.id, channel);
  const usable = live.filter((grant) => grantHolds(grant, all));
  const asked: ProfileChoice[] =
    targets === FANOUT_ALL ? [PROFILE_SELF, ...usable.map((grant) => grant.id)] : [...new Set<ProfileChoice>(targets)];
  // A's own first, the rest in the order asked.
  const ordered = [...asked.filter((one) => one === PROFILE_SELF), ...asked.filter((one) => one !== PROFILE_SELF)];
  if (targets !== FANOUT_ALL) {
    const max = fanoutTargetsMax(deps);
    if (ordered.length > max) throw refuse(deps, 'validation_failed', 'MSG_FANOUT_TOO_MANY_PROFILES', { max });
  }
  const byKey = new Map(usable.map((grant) => [grant.id as string, grant]));
  const entries = ordered.map((profile): FanoutTarget | FanoutRefused => {
    if (profile === PROFILE_SELF) return { profile, ownerId: actor.id, name: actor.name, grant: null };
    const grant = byKey.get(profile);
    return grant ? { profile, ownerId: grant.owner.id, name: grant.owner.name, grant } : refusedAsUnknown(deps, profile);
  });
  const left =
    targets === FANOUT_ALL ? live.filter((grant) => !grantHolds(grant, all)).map((grant) => ({ profile: grant.id, name: grant.owner.name })) : [];
  return { entries, left, perms: all };
}

export const isTarget = (entry: FanoutTarget | FanoutRefused): entry is FanoutTarget => !('ok' in entry);

/**
 * The share `grant` read again now: still live, A's, and holding `perms`; null when not (refused as an unknown key).
 * runOn reads it just before a target's work; v36 FIX-API (D2, sec M1) a work of several steps reads it again before
 * each later step (Share All's chunks: share-all.ts).
 */
export async function grantStillHolds(deps: Deps, actor: FanoutActor, grant: LiveGrant, perms: readonly SharePermission[]): Promise<LiveGrant | null> {
  const fresh = await liveGrantById(deps, grant.id);
  return fresh && fresh.granteeId === actor.id && grantHolds(fresh, perms) ? fresh : null;
}

/** runOn's options: the fan-out's, and whether a target's result changed something (counted as a write only then). */
export interface RunOptions<T> extends FanoutOptions {
  wrote?: (value: T) => boolean;
}

/**
 * Runs `work` once per usable target (A's own first, one after another) and answers every target's outcome in that
 * order. `perms[0]` is the action's box (its activity area); every grant must hold all of `perms` and
 * `options.extraPerms`.
 */
export async function fanOut<T extends object>(
  deps: Deps,
  actor: FanoutActor,
  targets: FanoutTargets,
  perms: readonly [SharePermission, ...SharePermission[]],
  work: (target: FanoutTarget) => Promise<T>,
  options: RunOptions<T> = {},
): Promise<FanoutAnswer<T>> {
  const resolved = await resolveTargets(deps, actor, targets, perms, options);
  return runOn(deps, actor, resolved, perms[0], work, options);
}

/**
 * fanOut's second half, for a caller that resolved the targets itself (the bulk: each item's own profile). Each share
 * is read again just before its work: one that ended or lost a box meanwhile is refused as an unknown key.
 */
export async function runOn<T extends object>(
  deps: Deps,
  actor: FanoutActor,
  resolved: FanoutResolved,
  areaPerm: SharePermission,
  work: (target: FanoutTarget) => Promise<T>,
  options: RunOptions<T> = {},
): Promise<FanoutAnswer<T>> {
  const results: Array<FanoutOutcome<T>> = [];
  for (const entry of resolved.entries) {
    if (!isTarget(entry)) {
      results.push(entry);
      continue;
    }
    let target: FanoutTarget = entry;
    if (entry.grant) {
      const fresh = await grantStillHolds(deps, actor, entry.grant, resolved.perms);
      if (!fresh) {
        results.push(refusedAsUnknown(deps, entry.profile));
        continue;
      }
      target = { ...entry, grant: fresh };
    }
    try {
      const value = await work(target);
      results.push({ profile: target.profile, name: target.name, ok: true, ...value });
      if (target.grant && (options.wrote?.(value) ?? true)) countOn(deps, actor, target.grant, areaPerm, options);
    } catch (error) {
      results.push(refusalOf(deps, target, error));
    }
  }
  return { results, left: resolved.left };
}

/**
 * Inside a write's transaction (on `db`), before anything is written: `grant` is still live, A's, and holds `perms`,
 * read FOR SHARE (a Stop or a change of its boxes waits for the write to commit); else profile_ended (the target's
 * refusal as an unknown key). Nothing on A's own profile (null).
 */
export async function lockGrantIn(
  deps: Deps,
  db: Pick<DbQueries, 'one'>,
  actor: FanoutActor,
  grant: LiveGrant | null,
  perms: readonly SharePermission[],
): Promise<void> {
  if (!grant) return;
  const locked = await lockedLiveGrant(deps, db, grant.id, 'share');
  if (!locked || locked.granteeId !== actor.id || !grantHolds(locked, perms)) throw profileEnded();
}

/** Counts one call on `grant`'s profile in its activity (the area of `areaPerm`). */
export function countOn(deps: Deps, actor: FanoutActor, grant: LiveGrant, areaPerm: SharePermission, options: FanoutOptions = {}): void {
  countActivity(deps, {
    grantId: grant.id,
    ownerId: grant.owner.id,
    actorId: actor.id,
    area: areaOfPermission(areaPerm),
    action: options.action ?? 'write',
    via: options.via ?? 'web',
  });
}

/** A target's refusal from what its work threw. */
function refusalOf(deps: Deps, target: FanoutTarget, error: unknown): FanoutRefused {
  if (error instanceof AppError) {
    // The share ended, or lost the box, while the work ran: as an unknown key.
    if (error.code === 'profile_ended' || error.code === 'profile_not_shared') return refusedAsUnknown(deps, target.profile);
    return { profile: target.profile, name: target.name, ok: false, refused: error.code, message: error.message };
  }
  deps.log.error(`[sharing] a change on several profiles failed on one of them (${target.grant ? 'a shared profile' : 'their own'})`, error);
  return {
    profile: target.profile,
    name: target.name,
    ok: false,
    refused: 'internal',
    message: constantsOf(deps).message('MSG_FANOUT_PROFILE_FAILED'),
  };
}
