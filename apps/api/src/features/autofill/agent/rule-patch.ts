import type { AutofillAgentSettings } from '@tailorit/shared/autofill';
import type { AutoSaveRulePatch } from '@tailorit/shared/sharing';
import type { AppDeps } from '../../../core/context';
import type { DbTx } from '../../../core/db/types';
import { saveAgentSettings } from './queue';

// v34 FANOUT (PLAN G3): the Auto-save rule changed in part, for PATCH /api/autofill/agent/settings and the fan-out's
// PATCH /api/profiles/auto-apply/rule (each target): the fields given laid over the rule as saved, read with its row
// locked in the save's own transaction (queue.ts saveAgentSettings: a change at the same moment is never written back
// over), then the PUT's save (turning it on starts its "new jobs" now; a new lowest match while on weighs the jobs since
// then again). `options.lock` runs first in that transaction (the fan-out locks the share FOR SHARE).

/** `userId`'s rule with `patch` laid over it, saved; answers the rule as saved. */
export async function patchAgentSettings(
  deps: Pick<AppDeps, 'db' | 'now'>,
  userId: string,
  patch: AutoSaveRulePatch,
  options: { lock?: (t: DbTx) => Promise<void> } = {},
): Promise<AutofillAgentSettings> {
  return saveAgentSettings(
    deps,
    userId,
    (before) => ({ ruleEnabled: patch.ruleEnabled ?? before.ruleEnabled, minMatch: patch.minMatch ?? before.minMatch }),
    options,
  );
}
