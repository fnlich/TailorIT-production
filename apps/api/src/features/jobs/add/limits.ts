import { HOUR_MS } from '@tailorit/shared';
import { constantsOf } from '../../../core/constants/service';
import type { AppDeps } from '../../../core/context';
import { refuse } from '../../../core/http/refuse';

// v31 LINK: one budget of adds by link per account and hour (JOB_ADDS_PER_HOUR, read at each add), shared by the web's
// Add job, the MCP tool add_job and a tracker entry's link, since each may make TailorIT read an outside page. Kept in
// this process (as the API's other rate limits are), per database handle so each test context has its own.
// v33 SHARE-3 (PLAN F9 "Who pays": "job adds ... keyed by the actor"): the hour is the person's who adds (actorOf(req),
// MCP's caller), never the profile's they add to: B adding on 3 shared profiles has one hour of adds, and B's adds on
// A's profile never spend A's. Callers pass the actor's id.

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

const windows = new WeakMap<object, Map<string, number[]>>();

function windowOf(deps: Deps, actorId: string): number[] {
  let byUser = windows.get(deps.db);
  if (!byUser) {
    byUser = new Map();
    windows.set(deps.db, byUser);
  }
  const now = deps.now().getTime();
  const kept = (byUser.get(actorId) ?? []).filter((at) => now - at < HOUR_MS);
  byUser.set(actorId, kept);
  return kept;
}

/** Takes one add from the actor's hour (v33 SHARE-3: who adds); false (nothing taken) when the hour's adds are spent. */
export function tryTakeAddSlot(deps: Deps, actorId: string): boolean {
  const kept = windowOf(deps, actorId);
  if (kept.length >= constantsOf(deps).get('JOB_ADDS_PER_HOUR')) return false;
  kept.push(deps.now().getTime());
  return true;
}

/** Takes one add from the actor's hour, or refuses (429 MSG_JOB_ADDS_RATE_LIMITED, with Retry-After). */
export function takeAddSlot(deps: Deps, actorId: string): void {
  if (tryTakeAddSlot(deps, actorId)) return;
  const kept = windowOf(deps, actorId);
  const limit = constantsOf(deps).get('JOB_ADDS_PER_HOUR');
  const oldest = kept[0] ?? deps.now().getTime();
  const retryAfterSeconds = Math.max(1, Math.ceil((oldest + HOUR_MS - deps.now().getTime()) / 1000));
  throw refuse(deps, 'rate_limited', 'MSG_JOB_ADDS_RATE_LIMITED', { limit, minutes: Math.max(1, Math.ceil(retryAfterSeconds / 60)) }, { retryAfterSeconds });
}
