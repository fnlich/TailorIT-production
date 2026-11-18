import { HOUR_MS } from '@tailorit/shared';
import { constantsOf } from '../../../core/constants/service';
import type { AppDeps } from '../../../core/context';
import { refuse } from '../../../core/http/refuse';

// v31 LINK: one budget of adds by link per account and hour (JOB_ADDS_PER_HOUR, read at each add), shared by the web's
// Add job, the MCP tool add_job and a tracker entry's link, since each may make TailorIT read an outside page. Kept in
// this process (as the API's other rate limits are), per database handle so each test context has its own.

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

const windows = new WeakMap<object, Map<string, number[]>>();

function windowOf(deps: Deps, userId: string): number[] {
  let byUser = windows.get(deps.db);
  if (!byUser) {
    byUser = new Map();
    windows.set(deps.db, byUser);
  }
  const now = deps.now().getTime();
  const kept = (byUser.get(userId) ?? []).filter((at) => now - at < HOUR_MS);
  byUser.set(userId, kept);
  return kept;
}

/** Takes one add from the account's hour; false (nothing taken) when the hour's adds are spent. */
export function tryTakeAddSlot(deps: Deps, userId: string): boolean {
  const kept = windowOf(deps, userId);
  if (kept.length >= constantsOf(deps).get('JOB_ADDS_PER_HOUR')) return false;
  kept.push(deps.now().getTime());
  return true;
}

/** Takes one add from the account's hour, or refuses (429 MSG_JOB_ADDS_RATE_LIMITED, with Retry-After). */
export function takeAddSlot(deps: Deps, userId: string): void {
  if (tryTakeAddSlot(deps, userId)) return;
  const kept = windowOf(deps, userId);
  const limit = constantsOf(deps).get('JOB_ADDS_PER_HOUR');
  const oldest = kept[0] ?? deps.now().getTime();
  const retryAfterSeconds = Math.max(1, Math.ceil((oldest + HOUR_MS - deps.now().getTime()) / 1000));
  throw refuse(deps, 'rate_limited', 'MSG_JOB_ADDS_RATE_LIMITED', { limit, minutes: Math.max(1, Math.ceil(retryAfterSeconds / 60)) }, { retryAfterSeconds });
}
