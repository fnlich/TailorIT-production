import { constantsOf } from '../../core/constants/index';
import type { DailyStep } from '../../core/feature';
import { DAY_MS } from '@tailorit/shared';

// v30 INT-0: the prepare filters' step of the daily housekeeping (Feature.daily; v2.0 ran it in features/account's
// housekeeping, ST4 moved it there as a Feature.daily step, and INT-0 here, beside the table it prunes).

/** custom_filter_verdicts older than CUSTOM_FILTER_VERDICT_KEEP_DAYS. */
export const pruneCustomVerdicts: DailyStep = {
  name: 'customVerdicts',
  // A verdict is a cache: an old one is judged again when it is needed.
  run: async (deps) =>
    (
      await deps.db.run('DELETE FROM custom_filter_verdicts WHERE decided_at < ?', [
        new Date(deps.now().getTime() - constantsOf(deps).get('CUSTOM_FILTER_VERDICT_KEEP_DAYS') * DAY_MS).toISOString(),
      ])
    ).changes,
};
