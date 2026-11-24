import { STATUS } from '@tailorit/shared';
import type { FanoutUnsaveJobsBody, FanoutUnsavedJob } from '@tailorit/shared/sharing';
import { constantsOf } from '../../../core/constants/service';
import type { AppDeps } from '../../../core/context';
import type { Dialect } from '../../../core/db/index';
import type { DbQueries } from '../../../core/db/types';
import { refuse } from '../../../core/http/refuse';
import { archiveSavedEntry, lockForArchive, noQueueCounts, type ArchiveUnder, type QueueCounts } from '../../applications/archive-saved'; // v36 FIX-API (D1)
import { queueRowsOfJobs } from '../../autofill/agent/queue'; // v36 FIX-API (D1)
import { currentJobId } from '../../jobs/store';
import { fanOut, type FanoutActor, type FanoutAnswer, type FanoutOptions, type FanoutTarget } from './targets';

// v36 JOBS (PLAN J5, J6): Unsave on several profiles, the other half of Save to. The Jobs page's Select bar removes the
// chosen jobs from Saved on the tab's profile, or on the profiles chosen next (POST /api/profiles/jobs/unsave), with the
// Job Tracker's Change on each: the box that already covers saving and restoring there (no new permission). Only Saved
// entries go (archived, never deleted, as the Tracker's own un-save); a job at Applied or later is left as it is. The
// archive is MCP's unsave_jobs' own (archiveSavedEntries: mcp/tools-apps.ts archiveSavedJobs answers its counts, so
// MCP's answer is unchanged); the web's answer also carries the archived entries' ids, which its Undo restores (the
// bulk's `unarchive`).
// v36 FIX-API (D1, the coordinator's decision on the final review's sec M2 = data D6; sec L3): a Saved entry whose job
// is in the auto-apply queue is archived with its not-started row taken out (`dequeued`), or left in Saved Jobs while
// the extension applies to it (`applying`) or, on a shared profile without Queue changes, while it is queued
// (`queueLocked`); the archive keeps a "still Saved and not archived" condition (applications/archive-saved.ts).

type Deps = Pick<AppDeps, 'db' | 'config' | 'now' | 'services' | 'log'>;

/** One job's entry on a profile, as an unsave reads it. */
export interface UnsaveRow {
  job_id: number;
  id: string;
  current_status: number;
  archived_at: string | null;
}

/** `job_id IN (...)`'s list from one bound JSON array of ids (the values are text on PostgreSQL: cast). */
const jobIdsIn = (d: Dialect) => `SELECT CAST(value AS INTEGER) FROM ${d.jsonEach('?')}`;

/** The entries of `jobIds` on `userId`'s profile, by job id (an unsave reads them in its transaction). */
export async function entriesOf(t: Pick<DbQueries, 'all' | 'dialect'>, userId: string, jobIds: readonly number[]): Promise<Map<number, UnsaveRow>> {
  const found = await t.all<UnsaveRow>(
    `SELECT job_id, id, current_status, archived_at FROM applications
     WHERE user_id = ? AND job_id IN (${jobIdsIn(t.dialect)})`,
    [userId, JSON.stringify(jobIds)],
  );
  return new Map(found.map((row) => [row.job_id, row]));
}

/** The entries an unsave archives: Saved and not archived yet. */
export const archivable = (row: UnsaveRow | undefined): boolean => row !== undefined && row.current_status === STATUS.saved && row.archived_at === null;

/**
 * Why an unsave left a job: no Saved entry there (never saved, or removed already), one past Saved, or (v36 FIX-API, D1)
 * a Saved one the extension is applying to now (`applying`) or that is queued on a shared profile without Queue changes
 * (`queue_locked`).
 */
export type UnsaveSkip = 'not_saved' | 'applied' | 'applying' | 'queue_locked';

/** What one profile's unsave did, job by job in the order asked. */
export interface ArchivedSaved {
  /** The entries archived: each one's job and application (an Undo restores exactly these). */
  archived: FanoutUnsavedJob[];
  /** v36 FIX-API (D1): of `archived`, the jobs whose not-started queue row was taken out with them. */
  dequeued: number[];
  /** The jobs left, with why. */
  skipped: Array<[jobId: number, reason: UnsaveSkip]>;
}

/** v36 FIX-API (D1.4): the share an unsave acts under on a target (null on the person's own profile). */
export const underOf = (actor: FanoutActor, target: Pick<FanoutTarget, 'grant'>): ArchiveUnder | null =>
  target.grant ? { grantId: target.grant.id, actorId: actor.id } : null;

/**
 * Archives the Saved entries of `jobIds` on `userId`'s profile in one transaction (labelled `label`); `check` sees how
 * many Saved entries it names before anything changes (MCP's removal by set). A job with no entry, or with one removed
 * from Saved already, is `not_saved`; one at Applied or later (archived or not) is `applied`, never touched. v36 FIX-API
 * (D1): `under` is the share it acts under (none: the owner's own profile); a Saved entry's queue row decides
 * (applications/archive-saved.ts): taken out with it (`dequeued`), or the entry left (`applying`, `queue_locked`).
 */
export async function archiveSavedEntries(
  deps: Deps,
  userId: string,
  jobIds: readonly number[],
  options: { check?: (archives: number) => void; label?: string; under?: ArchiveUnder | null } = {},
): Promise<ArchivedSaved> {
  return deps.db.tx(
    async (t) => {
      const mayChangeQueue = await lockForArchive(deps, t, userId, options.under ?? null);
      const rows = await entriesOf(t, userId, jobIds);
      const savedJobs = jobIds.filter((jobId) => archivable(rows.get(jobId)));
      options.check?.(savedJobs.length);
      const queued = await queueRowsOfJobs(deps, userId, savedJobs);
      const archived: FanoutUnsavedJob[] = [];
      const dequeued: number[] = [];
      const skipped: ArchivedSaved['skipped'] = [];
      for (const jobId of jobIds) {
        const row = rows.get(jobId);
        if (!row || (row.archived_at !== null && row.current_status === STATUS.saved)) skipped.push([jobId, 'not_saved']);
        else if (row.current_status !== STATUS.saved) skipped.push([jobId, 'applied']);
        else {
          const outcome = await archiveSavedEntry(deps, userId, row.id, queued.get(jobId), mayChangeQueue);
          if (outcome === 'archived' || outcome === 'dequeued') archived.push({ jobId, applicationId: row.id });
          if (outcome === 'dequeued') dequeued.push(jobId);
          else if (outcome === 'applying' || outcome === 'queue_locked') skipped.push([jobId, outcome]);
          else if (outcome === 'moved') skipped.push([jobId, await movedSkip(t, row.id)]);
        }
      }
      return { archived, dequeued, skipped };
    },
    { label: options.label ?? 'unsave_jobs' },
  );
}

/** Why an entry read at Saved was not archived after all: it moved past Saved meanwhile, or it was archived already. */
async function movedSkip(t: Pick<DbQueries, 'one'>, applicationId: string): Promise<UnsaveSkip> {
  const now = await t.one<{ current_status: number }>('SELECT current_status FROM applications WHERE id = ?', [applicationId]);
  return now && now.current_status !== STATUS.saved ? 'applied' : 'not_saved';
}

/** What an unsave did on one profile (FanoutUnsavedFields): each distinct job asked counts once. */
export interface UnsavedOnTarget extends QueueCounts {
  removed: number;
  items: FanoutUnsavedJob[];
  notSaved: number;
  applied: number;
  notFound: number;
}

/**
 * The unsave of `jobIds` on `ownerId`'s profile (`under`: the share it acts under; null on the person's own). A page job
 * an upgrade closed is the shared job it gave way to there (as a save there reads it: currentJobId); a job the owner
 * does not see is not found.
 */
export async function unsaveJobsOn(deps: Deps, ownerId: string, jobIds: readonly number[], under: ArchiveUnder | null = null): Promise<UnsavedOnTarget> {
  const asked = [...new Set(jobIds)];
  const current: number[] = [];
  let notFound = 0;
  for (const id of asked) {
    const now = await currentJobId(deps, ownerId, id);
    if (now === null) notFound += 1;
    else if (!current.includes(now)) current.push(now);
  }
  const done: ArchivedSaved =
    current.length === 0 ? { archived: [], dequeued: [], skipped: [] } : await archiveSavedEntries(deps, ownerId, current, { label: 'unsave_jobs_web', under });
  const skips = (reason: UnsaveSkip) => done.skipped.filter(([, why]) => why === reason).length;
  const queue = noQueueCounts();
  queue.dequeued = done.dequeued.length;
  queue.applying = skips('applying');
  queue.queueLocked = skips('queue_locked');
  return { removed: done.archived.length, items: done.archived, notSaved: skips('not_saved'), applied: skips('applied'), notFound, ...queue };
}

/** At most SAVE_BATCH_MAX jobs a request, as a save (400 MSG_FANOUT_TOO_MANY_JOBS on jobIds). */
function assertUnsaveCount(deps: Deps, count: number): void {
  const max = constantsOf(deps).get('SAVE_BATCH_MAX');
  if (count > max) {
    const words = constantsOf(deps).message('MSG_FANOUT_TOO_MANY_JOBS', { max });
    throw refuse(deps, 'validation_failed', 'MSG_FANOUT_TOO_MANY_JOBS', { max }, { fields: { jobIds: words } });
  }
}

/**
 * POST /api/profiles/jobs/unsave: the jobs' Saved entries removed on every target (the Job Tracker's Change each; a
 * target A may not use answers as an unknown key, as a save's). Only a profile where something was removed counts as a
 * write in its activity.
 */
export async function unsaveJobsOnProfiles(
  deps: Deps,
  actor: FanoutActor,
  body: FanoutUnsaveJobsBody,
  options: FanoutOptions = {},
): Promise<FanoutAnswer<UnsavedOnTarget>> {
  assertUnsaveCount(deps, new Set(body.jobIds).size);
  return fanOut(deps, actor, body.targets, ['tracker:edit'], (target) => unsaveJobsOn(deps, target.ownerId, body.jobIds, underOf(actor, target)), {
    ...options,
    wrote: (value) => value.removed > 0,
  });
}
