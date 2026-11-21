import { isProfileKey, isSharePermission, type ProfileKey, type SharePermission } from '@tailorit/shared/sharing';
import { liveGrantById } from '../../core/auth/grants';
import type { AppDeps } from '../../core/context';

// v33 SHARE-2 (PLAN F9; SP v33 PLAN-sharing.md §6 "endGrant"): stopping the work a grant allowed, once it no longer
// allows it. endGrant runs AFTER the change that ended the access committed (A stopped sharing, B left, the sweep
// expired it, an account was disabled, A took boxes away), may run any number of times, and every step touches only
// rows that name the grant (grant_id), so a share made again (a new grant, a new key) is never touched.
//
// The steps that stop the work belong to the features that own it; each plugs in from its own module, no edit here:
//
//   import { registerEndGrantStep } from '../sharing/end-grant';
//   registerEndGrantStep('prepares', async (deps, scope) => cancelGrantPrepares(deps, scope)); // answers rows changed
//
// The order is END_GRANT_STEP_ORDER (§6's 1-5): Prepares first (no new AI work starts), then the AI tasks, the
// backlogs, MCP's result sets, and the queue (held rows, and the unclaimed approved ones when remove_queued). A step
// with another name runs after those, in the order it was registered. Each step runs on its own: one that throws is
// logged and the next still runs; the access check of the queue, the runner and the AI queue (assertGrantLive) stops
// the rest anyway, and the hourly sweep runs endGrant again.
//
// A step reads its scope:
// - `permissions` null: every piece of the grant's work (the grant ended, or an account was disabled);
// - `permissions` a list: only the work allowed under those boxes (A took them away; the grant stays live):
//   ai_tasks.grant_perm, a Prepare's prepare:run (+ mcp for an MCP one), a backlog's documents:edit ...;
// - `removeQueued`: A's "Also remove the jobs they queued that haven't started" (profile_grants.remove_queued).

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** Why the work stops. */
export type EndGrantCause = 'revoked' | 'left' | 'expired' | 'permissions' | 'disabled';

/** What a step stops. */
export interface EndGrantScope {
  /** The grant (its key). */
  readonly grantId: ProfileKey;
  /** Whose profile: A. */
  readonly ownerId: string;
  /** Who worked on it: B (null for an invite nobody accepted: no work). */
  readonly granteeId: string | null;
  readonly cause: EndGrantCause;
  /** null: all of the grant's work; else only the work allowed under these boxes (A removed them). */
  readonly permissions: readonly SharePermission[] | null;
  /** A's "Also remove the jobs they queued that haven't started". */
  readonly removeQueued: boolean;
}

/** One step: stops its part of the work, answers how many rows it changed (logged). Must be safe to run twice. */
export type EndGrantStepFn = (deps: Deps, scope: EndGrantScope) => number | Promise<number>;

/** The steps of §6, in order; their owners register them (SHARE-5: prepares, queue; SHARE-3: ai_tasks, backlogs; SHARE-8: mcp_sets). */
export const END_GRANT_STEP_ORDER = ['prepares', 'ai_tasks', 'backlogs', 'mcp_sets', 'queue'] as const;
export type EndGrantStepName = (typeof END_GRANT_STEP_ORDER)[number];

const STEP_NAME = /^[a-z][a-z0-9_]{0,39}$/;

/** The registered steps, by name, in registration order (a process-wide table, as the AI task kinds are). */
const steps = new Map<string, EndGrantStepFn>();

/**
 * Registers the step `name` (a code: lower case, digits and _), replacing one of the same name. Answers a function that
 * removes it again and puts back the step it replaced, if any (a test's stand-in leaves the real step in place). A
 * feature registers its step where its module loads, or in its `services` hook.
 */
export function registerEndGrantStep(name: string, run: EndGrantStepFn): () => void {
  if (!STEP_NAME.test(name)) throw new Error(`registerEndGrantStep: "${name}" is not a step name (a-z, 0-9, _).`);
  const replaced = steps.get(name);
  steps.delete(name);
  steps.set(name, run);
  return () => {
    if (steps.get(name) !== run) return;
    steps.delete(name);
    if (replaced) steps.set(name, replaced);
  };
}

/** The registered steps' names in the order endGrant runs them. */
export function endGrantStepNames(): string[] {
  const known = (END_GRANT_STEP_ORDER as readonly string[]).filter((name) => steps.has(name));
  const others = [...steps.keys()].filter((name) => !(END_GRANT_STEP_ORDER as readonly string[]).includes(name));
  return [...known, ...others];
}

/** What one endGrant did: rows changed per step, the steps that threw, or why it did nothing. */
export interface EndGrantResult {
  grantId: string;
  changed: Record<string, number>;
  failed: string[];
  /** Set when nothing ran: `unknown` (no such grant), `live` (the whole grant's work of a grant still live). */
  skipped?: 'unknown' | 'live';
}

interface GrantForEnd {
  id: string;
  owner_user_id: string;
  grantee_user_id: string | null;
  remove_queued: boolean;
  state: string;
}

/**
 * Stops the work grant `grantId` allowed (the steps above), after commit. `permissions` (cause `permissions`) limits it
 * to the work allowed under those boxes; otherwise it is all of the grant's work, and endGrant refuses to touch a grant
 * that is still live (a guard: the grant ended, or one of its accounts is disabled, before it is called).
 */
export async function endGrant(
  deps: Deps,
  grantId: string,
  options: { cause: EndGrantCause; permissions?: readonly SharePermission[] | null },
): Promise<EndGrantResult> {
  deps.db.assertNoTx('endGrant (it runs after the change that ended the access committed)');
  const result: EndGrantResult = { grantId, changed: {}, failed: [] };
  if (!isProfileKey(grantId)) return { ...result, skipped: 'unknown' };
  const row = await deps.db.one<GrantForEnd>(
    'SELECT id, owner_user_id, grantee_user_id, remove_queued, state FROM profile_grants WHERE id = @id',
    { id: grantId },
  );
  if (!row) return { ...result, skipped: 'unknown' };
  const permissions =
    options.cause === 'permissions' ? [...new Set((options.permissions ?? []).filter(isSharePermission))] : null;
  if (permissions !== null && permissions.length === 0) return result;
  // The whole grant's work stops only once the grant no longer allows it: never on a live grant.
  if (permissions === null && (await liveGrantById(deps, grantId))) return { ...result, skipped: 'live' };

  const scope: EndGrantScope = Object.freeze({
    grantId: grantId as ProfileKey,
    ownerId: row.owner_user_id,
    granteeId: row.grantee_user_id,
    cause: options.cause,
    permissions: permissions === null ? null : Object.freeze(permissions),
    removeQueued: row.remove_queued,
  });
  for (const name of endGrantStepNames()) {
    const run = steps.get(name);
    if (!run) continue;
    try {
      result.changed[name] = await run(deps, scope);
    } catch (error) {
      result.changed[name] = 0;
      result.failed.push(name);
      deps.log.error(`[sharing] ending grant ${grantId}: the step ${name} failed; the hourly sweep runs it again`, error);
    }
  }
  const changed = Object.entries(result.changed).filter(([, count]) => count > 0);
  if (changed.length > 0) {
    deps.log.info(`[sharing] ended grant ${grantId} (${options.cause}): ${changed.map(([name, n]) => `${name} ${n}`).join(', ')}`);
  }
  return result;
}

/**
 * The admin disabled `userId` (PLAN-sharing §6): stops the work of every grant on either side of the account (its own
 * profile shared with others, and the profiles shared with it), without changing any grant's state (re-enabled, the
 * grants are live again). Never throws; answers how many grants it ran for.
 */
export async function endGrantsOfAccount(deps: Deps, userId: string): Promise<number> {
  try {
    const rows = await deps.db.all<{ id: string }>(
      `SELECT id FROM profile_grants
        WHERE (owner_user_id = @user OR grantee_user_id = @user) AND state = 'active' AND accepted_at IS NOT NULL
        ORDER BY id`,
      { user: userId },
    );
    for (const { id } of rows) await endGrant(deps, id, { cause: 'disabled' });
    return rows.length;
  } catch (error) {
    deps.log.error(`[sharing] stopping the shared work of a disabled account failed; the access checks still refuse it`, error);
    return 0;
  }
}
