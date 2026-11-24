import { STATUS } from '@tailorit/shared';
import type {
  FanoutRefused,
  FanoutShareAllAnswer,
  FanoutShareAllBody,
  FanoutShareAllPreviewAnswer,
  FanoutShareAllPreviewQuery,
  FanoutShareAllRead,
  FanoutShareAllSource,
  ProfileChoice,
} from '@tailorit/shared/sharing';
import { constantsOf } from '../../../core/constants/service';
import { todayIso, type AppDeps } from '../../../core/context';
import { refuse } from '../../../core/http/refuse';
import { assertValidDate } from '../../applications/service';
import { currentJobId } from '../../jobs/store';
import { jobVisibleTo } from '../../jobs/visibility';
import { sqlTextArray } from '../rows';
import { saveJobsOn, type SavedOnTarget } from './jobs';
import { fanOut, grantStillHolds, resolveTargets, runOn, type FanoutActor, type FanoutOptions, type FanoutTarget } from './targets';

// v36 APPLYAPI (SP v36 PLAN A3): Share All, every job in Saved on one profile (the source) saved on the profiles the
// person may save to, as a preview and a start (the shapes and the rules: @tailorit/shared/sharing share-all.ts).
// - The source is read with the Job Tracker's See (`tracker:view`), resolved and re-read as every fan-out target is
//   (targets.ts: a key that may not be used answers MSG_FANOUT_PROFILE_UNUSABLE, whatever the reason; the grant is read
//   again just before the read), and the read is counted in its activity. A refused source runs nothing.
// - Its entries: Tracker entries at Saved, not archived, with a job (every Saved tab of the Auto-apply page), newest
//   saved first (the Saved pane's order: the tracked day, the moment added, the id), at most SHARE_ALL_MAX.
// - The preview classifies each job on each target without writing (classifyOn: saveJobsOn's own rules); the start
//   saves the jobs of the entries named that are still in the source's Saved on each target with saveJobsOn (Copy to's
//   save: the job alone at Saved, an entry removed from Saved restored, any other entry left alone), in chunks of
//   SAVE_BATCH_MAX, each target's Job Tracker's Change checked as for Copy to, and counted as a write where it changed
//   something.
// - v36 FIX-API (D2, the final review's sec M1): a target's share is read again before each chunk after the first
//   (grantStillHolds: live, the person's, with the Job Tracker's Change); one that ended or lost the box meanwhile
//   stops there: what it saved so far is answered (items, for Undo), the rest `notReached`, `incomplete`.
// The routes are router.ts's (`self`, acting.ts), with the fan-out's per-person limits.

type Deps = AppDeps;

/** A source entry Share All takes: the Tracker entry and its job. */
interface SavedEntry {
  id: string;
  jobId: number;
}

/** The source's Saved entries with a job: `FROM` and `WHERE` (parameter 1: the owner). */
const SAVED_ENTRIES = `FROM applications a JOIN jobs j ON j.id = a.job_id
  WHERE a.user_id = ? AND a.current_status = ${STATUS.saved} AND a.archived_at IS NULL`;
/** The Saved pane's order (auto-apply/saved.ts): the tracked day, then the moment the entry was added, then the id. */
const SAVED_ORDER = 'ORDER BY a.tracked_on DESC, a.created_at DESC, a.id DESC';

const entryOf = (row: { id: string; job_id: number }): SavedEntry => ({ id: row.id, jobId: Number(row.job_id) });

/** The newest `limit` Saved entries of `ownerId`, and how many there are in all. */
async function savedEntries(deps: Deps, ownerId: string, limit: number): Promise<{ total: number; entries: SavedEntry[] }> {
  const total = await deps.db.one<{ n: number | string }>(`SELECT count(*) AS n ${SAVED_ENTRIES}`, [ownerId]);
  const rows = await deps.db.all<{ id: string; job_id: number }>(`SELECT a.id, a.job_id ${SAVED_ENTRIES} ${SAVED_ORDER} LIMIT ?`, [ownerId, limit]);
  return { total: Number(total?.n ?? 0), entries: rows.map(entryOf) };
}

/** Of `ids`, the entries still in `ownerId`'s Saved (with a job), in the Saved pane's order. */
async function stillSaved(deps: Deps, ownerId: string, ids: readonly string[]): Promise<SavedEntry[]> {
  const rows = await deps.db.all<{ id: string; job_id: number }>(
    `SELECT a.id, a.job_id ${SAVED_ENTRIES} AND a.id = ANY(CAST(? AS text[])) ${SAVED_ORDER}`,
    [ownerId, sqlTextArray(ids)],
  );
  return rows.map(entryOf);
}

/** The distinct jobs of `entries`, in their order. */
const jobsOf = (entries: readonly SavedEntry[]): number[] => [...new Set(entries.map((entry) => entry.jobId))];

/** One profile's preview numbers (FanoutShareAllPreviewResult's fields). */
interface ShareAllPreviewCounts {
  added: number;
  backInSaved: number;
  alreadyThere: number;
  notFound: number;
}

/**
 * What saveJobsOn would do with `jobIds` on `ownerId`'s profile, read only. Its rules: a job the owner does not see (or
 * a page job an upgrade closed whose shared job they do not see: currentJobId) is not found; a job with no entry there
 * is added; an entry removed from Saved (archived while at Saved) comes back; any other entry (active, or archived at
 * Applied or later) is already there.
 */
async function classifyOn(deps: Deps, ownerId: string, jobIds: readonly number[]): Promise<ShareAllPreviewCounts> {
  const counts: ShareAllPreviewCounts = { added: 0, backInSaved: 0, alreadyThere: 0, notFound: 0 };
  if (jobIds.length === 0) return counts;
  // The jobs the owner sees, in one read; one an upgrade closed follows its chain as saveJobsOn does (rare).
  const visible = await deps.db.all<{ id: number; superseded_by: number | null }>(
    `SELECT j.id, j.superseded_by FROM jobs j WHERE j.id = ANY(CAST(string_to_array(?, ',') AS bigint[])) AND ${jobVisibleTo('j')}`,
    [jobIds.join(','), ownerId],
  );
  const seen = new Map(visible.map((row) => [Number(row.id), row.superseded_by === null ? null : Number(row.superseded_by)]));
  const current = new Map<number, number | null>();
  for (const id of jobIds) {
    if (!seen.has(id)) current.set(id, null);
    else current.set(id, seen.get(id) === null ? id : await currentJobId(deps, ownerId, id));
  }
  const nowIds = [...new Set([...current.values()].filter((id): id is number => id !== null))];
  const entries =
    nowIds.length === 0
      ? []
      : await deps.db.all<{ job_id: number; archived: boolean; current_status: number }>(
          `SELECT job_id, archived_at IS NOT NULL AS archived, current_status FROM applications
            WHERE user_id = ? AND job_id = ANY(CAST(string_to_array(?, ',') AS bigint[]))`,
          [ownerId, nowIds.join(',')],
        );
  const byJob = new Map(entries.map((row) => [Number(row.job_id), row]));
  for (const id of jobIds) {
    const now = current.get(id) ?? null;
    if (now === null) {
      counts.notFound += 1;
      continue;
    }
    const entry = byJob.get(now);
    if (!entry) counts.added += 1;
    else if (entry.archived && Number(entry.current_status) === STATUS.saved) counts.backInSaved += 1;
    else counts.alreadyThere += 1;
  }
  return counts;
}

const noneSaved = (): SavedOnTarget => ({
  saved: 0,
  restored: 0,
  alreadyTracked: 0,
  notFound: 0,
  notFoundIds: [],
  notReached: 0,
  items: [],
  pendingMatches: 0,
  incomplete: false,
});

/**
 * Saves `jobIds` on `ownerId`'s profile in chunks of SAVE_BATCH_MAX (saveJobsOn each), the counts summed. A chunk that
 * stops part-way (or fails after an earlier chunk saved something) ends it: the jobs after it are not reached and the
 * answer is `incomplete`; a first chunk that fails throws (that profile's refusal: nothing was saved there). v36 FIX-API
 * (D2): `stillAllowed` is asked before each chunk after the first (the target's share read again); false ends it the
 * same way.
 */
async function saveInChunks(
  deps: Deps,
  ownerId: string,
  jobIds: readonly number[],
  date: string,
  stillAllowed: () => Promise<boolean> = async () => true,
): Promise<SavedOnTarget> {
  const size = constantsOf(deps).get('SAVE_BATCH_MAX');
  const total = noneSaved();
  for (let start = 0; start < jobIds.length; start += size) {
    const chunk = jobIds.slice(start, start + size);
    if (start > 0 && !(await stillAllowed())) {
      deps.log.warn('[sharing] Share All stopped part-way on one profile: its share ended or lost the box meanwhile');
      total.notReached += jobIds.length - start;
      total.incomplete = true;
      break;
    }
    let part: SavedOnTarget;
    try {
      part = await saveJobsOn(deps, ownerId, chunk, date);
    } catch (error) {
      if (start === 0) throw error;
      deps.log.warn('[sharing] Share All stopped part-way on one profile; the jobs after it were not saved there', error);
      total.notReached += jobIds.length - start;
      total.incomplete = true;
      break;
    }
    total.saved += part.saved;
    total.restored += part.restored;
    total.alreadyTracked += part.alreadyTracked;
    total.notFound += part.notFound;
    total.notFoundIds.push(...part.notFoundIds);
    total.notReached += part.notReached;
    total.items.push(...part.items);
    total.pendingMatches += part.pendingMatches;
    if (part.incomplete) {
      total.notReached += jobIds.length - start - chunk.length;
      total.incomplete = true;
      break;
    }
  }
  return total;
}

/** A save wrote something there (new or restored entries): only then is it a write in the share's activity. */
const savedSome = (value: SavedOnTarget): boolean => value.items.length > 0;

/** v36 FIX-API (D2): whether `target`'s share still lets the person save there (always on their own profile). */
const shareHolds = (deps: Deps, actor: FanoutActor, target: FanoutTarget) => async (): Promise<boolean> =>
  target.grant === null || (await grantStillHolds(deps, actor, target.grant, ['tracker:edit'])) !== null;

/**
 * Reads the source with the Job Tracker's See (`read` counted in a share's activity): `read`'s answer, or the refusal
 * every fan-out gives a profile that may not be used.
 */
async function readSource<T extends object>(
  deps: Deps,
  actor: FanoutActor,
  source: ProfileChoice,
  options: FanoutOptions,
  read: (ownerId: string) => Promise<T>,
): Promise<({ profile: ProfileChoice; name: string; ok: true } & T) | FanoutRefused> {
  const resolved = await resolveTargets(deps, actor, [source], ['tracker:view'], options);
  const answer = await runOn(deps, actor, resolved, 'tracker:view', (target) => read(target.ownerId), { ...options, action: 'read' });
  return answer.results[0]!;
}

/**
 * GET /api/profiles/saved/share-all/preview: the source's Saved jobs (the newest SHARE_ALL_MAX) and, on every target
 * (the Job Tracker's Change each, the start's own box, so `'all'` names the same profiles and leaves the same out),
 * what sharing them would do. A read: each share's call is counted as one.
 */
export async function shareAllPreviewOnProfiles(
  deps: Deps,
  actor: FanoutActor,
  query: FanoutShareAllPreviewQuery,
  options: FanoutOptions = {},
): Promise<FanoutShareAllPreviewAnswer> {
  const max = constantsOf(deps).get('SHARE_ALL_MAX');
  let entries: SavedEntry[] = [];
  const source: FanoutShareAllSource = await readSource(deps, actor, query.source, options, async (ownerId) => {
    const read = await savedEntries(deps, ownerId, max);
    entries = read.entries;
    return { saved: read.total, taking: read.entries.length, over: read.total - read.entries.length, max };
  });
  if (!source.ok) return { source, applicationIds: [], results: [], left: [] };
  const jobIds = jobsOf(entries);
  const answer = await fanOut(deps, actor, query.targets, ['tracker:edit'], (target) => classifyOn(deps, target.ownerId, jobIds), {
    ...options,
    action: 'read',
  });
  return { source, applicationIds: entries.map((entry) => entry.id), ...answer };
}

/**
 * POST /api/profiles/saved/share-all: the jobs of the entries named (the preview's applicationIds) that are still in
 * the source's Saved, saved on every target (the Job Tracker's Change each). At most SHARE_ALL_MAX entries (400
 * MSG_SHARE_ALL_TOO_MANY); an entry named that is not in the source's Saved now is left out (`gone`), and nothing the
 * preview did not name is ever shared.
 */
export async function shareAllOnProfiles(
  deps: Deps,
  actor: FanoutActor,
  body: FanoutShareAllBody,
  options: FanoutOptions = {},
): Promise<FanoutShareAllAnswer> {
  const asked = [...new Set(body.applicationIds)];
  const max = constantsOf(deps).get('SHARE_ALL_MAX');
  if (asked.length > max) {
    const words = constantsOf(deps).message('MSG_SHARE_ALL_TOO_MANY', { max });
    throw refuse(deps, 'validation_failed', 'MSG_SHARE_ALL_TOO_MANY', { max }, { fields: { applicationIds: words } });
  }
  const date = body.occurredOn ?? todayIso(deps);
  assertValidDate(deps, date);
  let entries: SavedEntry[] = [];
  const source: FanoutShareAllRead = await readSource(deps, actor, body.source, options, async (ownerId) => {
    entries = await stillSaved(deps, ownerId, asked);
    return { asked: asked.length, shared: entries.length, jobs: jobsOf(entries).length, gone: asked.length - entries.length };
  });
  if (!source.ok) return { source, results: [], left: [] };
  const jobIds = jobsOf(entries);
  const answer = await fanOut(
    deps,
    actor,
    body.targets,
    ['tracker:edit'],
    (target) => (jobIds.length === 0 ? Promise.resolve(noneSaved()) : saveInChunks(deps, target.ownerId, jobIds, date, shareHolds(deps, actor, target))),
    { ...options, wrote: savedSome },
  );
  return { source, ...answer };
}
