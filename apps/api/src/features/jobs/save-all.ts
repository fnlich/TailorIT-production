import type { JobsQuery, SaveAllPreview, SaveAllResponse } from '@tailorit/shared';
import { constantsOf } from '../../core/constants/service';
import { todayIso, type AppDeps } from '../../core/context';
import { refuse } from '../../core/http/refuse';
import { resumeChooser } from '../applications/resume-choice';
import { assertValidDate, saveJobs } from '../applications/service';
import { countJobs, matchingJobIds, searchScopeOf, type SearchScope } from './search';

// Save all (work package WP7): the list header's "Save all" saves the jobs that match the list's filters as Saved
// applications, at most SAVE_BATCH_MAX per click (v2.0: a central constant, 100 by default, read at the moment of use, so
// an admin's change applies to the next click), in the order the list shows them. The matches are the list's own
// (`countJobs` / `matchingJobIds` over the same filters, joins and order). A match is saveable when the viewer does not
// track it: no application yet, or one un-saved earlier (archived while only Saved), which comes back. Jobs already
// tracked keep their status (an active application, or Applied and later even when archived). The writes are the
// tracker's (`saveJobs`): the single Save's prefill, the best-matched resume chosen within one budget per click (the
// rest are linked by the match worker within seconds), never an AI call. Undo is the tracker's bulk archive with
// `onlySaved`, over the application ids of the answer.

export interface SaveAll {
  /** GET /api/jobs/save-all/preview: the numbers of the "Save N jobs?" confirm. */
  preview(userId: string, query: JobsQuery): Promise<SaveAllPreview>;
  /**
   * POST /api/jobs/save-all: saves the first SAVE_BATCH_MAX saveable matches on `occurredOn` (default today, UTC).
   * 400 for a day that is not real or is in the future; 409 while another run of the account is going.
   */
  run(userId: string, query: JobsQuery, occurredOn?: string): Promise<SaveAllResponse>;
}

type SaveAllDeps = Pick<AppDeps, 'db' | 'config' | 'now' | 'services' | 'log'>;

/**
 * The matches of the query, and those Save all can save (two COUNTs; a write between them may move either, so the
 * saveable count is held to the matched one).
 */
async function counted(deps: SaveAllDeps, scope: SearchScope, query: JobsQuery): Promise<{ matched: number; saveable: number }> {
  const matched = await countJobs(deps.db, query, scope);
  const saveable = await countJobs(deps.db, query, scope, { untrackedOnly: true });
  return { matched, saveable: Math.min(saveable, matched) };
}

/** The service behind the routes. It remembers which accounts have a run going, so make one per app. */
export function createSaveAll(deps: SaveAllDeps): SaveAll {
  /** Accounts with a run going: their next click answers 409 until it ends. */
  const running = new Set<string>();
  // v3.0 PG-SEARCH: with the admin's search caps (JOB_SEARCH_COUNT_CAP, SEARCH_RELEVANCE_WINDOW), read per click.
  const scopeOf = (userId: string): SearchScope => searchScopeOf(deps, userId);
  /** The jobs one click saves (SAVE_BATCH_MAX). */
  const batchMax = () => constantsOf(deps).get('SAVE_BATCH_MAX');

  return {
    async preview(userId, query) {
      const { matched, saveable } = await counted(deps, scopeOf(userId), query);
      return { matched, saveable, willSave: Math.min(saveable, batchMax()) };
    },

    async run(userId, query, occurredOn) {
      const date = occurredOn ?? todayIso(deps);
      assertValidDate(deps, date);
      // Taken before the try, so a refused second click never releases the first click's run.
      // A second click while the first one still runs (one run per account at a time): MSG_SAVE_ALL_BUSY (v30 ST3).
      if (running.has(userId)) throw refuse(deps, 'conflict', 'MSG_SAVE_ALL_BUSY');
      running.add(userId);
      try {
        const scope = scopeOf(userId);
        const { matched, saveable } = await counted(deps, scope, query);
        const jobIds = await matchingJobIds(deps.db, query, scope, { untrackedOnly: true, limit: batchMax() });
        // A first chunk that fails throws (nothing was saved: 500). A later one ends the run with what was saved.
        const result = await saveJobs(deps, userId, jobIds, {
          occurredOn: date,
          chooseResumes: resumeChooser(deps, userId),
        });
        const incomplete = result.error !== undefined;
        if (incomplete) {
          deps.log.error(
            `[jobs] Save all stopped part-way for account ${userId}: ${result.items.length} of ${jobIds.length} job(s) saved`,
            result.error,
          );
        }
        return {
          items: result.items,
          alreadyTracked: matched - saveable,
          // Jobs found tracked (or gone) when written are no longer saveable either.
          remaining: Math.max(0, saveable - result.items.length - result.skipped),
          pendingMatches: result.pendingMatches,
          incomplete,
        };
      } finally {
        running.delete(userId);
      }
    },
  };
}
