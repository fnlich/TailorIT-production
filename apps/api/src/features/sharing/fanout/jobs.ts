import { type AddJobResult, type ApplicationStatus, type JobAddOrigin, type SavedJobRef } from '@tailorit/shared';
import {
  PROFILE_SELF,
  type FanoutAddJobBody,
  type FanoutCopySavedAnswer,
  type FanoutCopySavedBody,
  type FanoutSaveJobsBody,
  type FanoutSavedOn,
  type ProfileChoice,
} from '@tailorit/shared/sharing';
import { reachableProfiles } from '../../../core/auth/grants';
import { constantsOf } from '../../../core/constants/service';
import { todayIso, type AppDeps } from '../../../core/context';
import { refuse } from '../../../core/http/refuse';
import { resumeChooser } from '../../applications/resume-choice';
import { assertValidDate, saveJobs } from '../../applications/service';
import { addJobByLink, type LinkRead } from '../../jobs/add/pipeline';
import { takeAddSlot } from '../../jobs/add/limits';
import { addInFlightOf, addJobResultOf } from '../../jobs/add/router';
import { currentJobId } from '../../jobs/store';
import { sqlTextArray } from '../rows';
import { countOn, fanOut, isTarget, resolveTargets, runOn, type FanoutActor, type FanoutAnswer, type FanoutOptions } from './targets';

// v34 FANOUT (PLAN G1, G2): saved jobs on several profiles. Each runs the single-profile service once per target, with
// the target's owner as whose data and A (the signed-in person) as who acts:
// - saveJobsOnProfiles: the tracker's Save (applications/service.ts saveJobs): each job at Saved, the owner's best resume
//   chosen there, no AI; a job the owner does not see (jobVisibleTo: another person's own job, a job held for review only
//   others track, gone) is not_found there;
// (v36 JOBS: Save all to profiles is gone; unsave.ts is the Select bar's Unsave.)
// - addByLinkOnProfiles: Add job's pipeline (jobs/add/pipeline.ts) on each target, one of A's adds an hour when a target
//   is usable; a link TailorIT cannot read is read once per request (the pipeline's knownRead);
// - copySavedJobs: the jobs of Tracker entries of one or several profiles saved on the targets (the job only);
// - savedOnProfiles: which profiles track each job.
// The routes are router.ts's; MCP (MCPFAN) calls these with its own options (via `mcp`, the `mcp` box).

type Deps = AppDeps;

/** What a save did on one profile (FanoutSavedFields). */
export interface SavedOnTarget {
  saved: number;
  restored: number;
  alreadyTracked: number;
  notFound: number;
  notFoundIds: number[];
  notReached: number;
  items: SavedJobRef[];
  pendingMatches: number;
  incomplete: boolean;
}

/** The jobs `ownerId` tracks among `jobIds` (any entry, archived or not). */
async function trackedJobs(deps: Deps, ownerId: string, jobIds: readonly number[]): Promise<Set<number>> {
  if (jobIds.length === 0) return new Set();
  const rows = await deps.db.all<{ job_id: number }>(
    "SELECT job_id FROM applications WHERE user_id = ? AND job_id = ANY(CAST(string_to_array(?, ',') AS bigint[]))",
    [ownerId, jobIds.join(',')],
  );
  return new Set(rows.map((row) => Number(row.job_id)));
}

/**
 * Saves `jobIds` at Saved on `ownerId`'s profile, as the tracker's Save does (saveJobs). Each job asked counts
 * once: saved (new), restored (un-saved earlier), already tracked, not found (one the owner does not see), or not
 * reached (the save stopped part-way before it).
 */
export async function saveJobsOn(deps: Deps, ownerId: string, jobIds: readonly number[], occurredOn: string): Promise<SavedOnTarget> {
  const asked = [...new Set(jobIds)];
  // A page job an upgrade closed is the shared job it gave way to; one the owner does not see answers null (not_found).
  const current = new Map<number, number | null>();
  for (const id of asked) current.set(id, await currentJobId(deps, ownerId, id));
  const visible = [...new Set([...current.values()].filter((id): id is number => id !== null))];
  const result =
    visible.length === 0
      ? { items: [] as SavedJobRef[], skipped: 0, pendingMatches: 0, error: undefined as unknown }
      : await saveJobs(deps, ownerId, visible, { occurredOn, chooseResumes: resumeChooser(deps, ownerId) });
  const savedNow = new Map(result.items.map((item) => [item.jobId, item]));
  const tracked = await trackedJobs(deps, ownerId, visible.filter((id) => !savedNow.has(id)));
  const incomplete = result.error !== undefined;
  const out = { saved: 0, restored: 0, alreadyTracked: 0, notReached: 0 };
  const notFoundIds: number[] = [];
  for (const id of asked) {
    const now = current.get(id) ?? null;
    const item = now === null ? undefined : savedNow.get(now);
    if (item) out[item.created ? 'saved' : 'restored'] += 1;
    else if (now !== null && tracked.has(now)) out.alreadyTracked += 1;
    else if (now !== null && incomplete) out.notReached += 1;
    else notFoundIds.push(id);
  }
  return { ...out, notFound: notFoundIds.length, notFoundIds, items: result.items, pendingMatches: result.pendingMatches, incomplete };
}

/** The day a save is dated: the one given (checked), else today. */
function dayOf(deps: Deps, occurredOn: string | undefined): string {
  const date = occurredOn ?? todayIso(deps);
  assertValidDate(deps, date);
  return date;
}

/** At most SAVE_BATCH_MAX jobs (or entries) a request (400 MSG_FANOUT_TOO_MANY_JOBS on `field`). */
function assertJobCount(deps: Deps, count: number, field: string): void {
  const max = constantsOf(deps).get('SAVE_BATCH_MAX');
  if (count > max) {
    const words = constantsOf(deps).message('MSG_FANOUT_TOO_MANY_JOBS', { max });
    throw refuse(deps, 'validation_failed', 'MSG_FANOUT_TOO_MANY_JOBS', { max }, { fields: { [field]: words } });
  }
}

/** A save wrote something there (new or restored entries): only then is it a write in the share's activity. */
const savedSome = (value: SavedOnTarget): boolean => value.items.length > 0;

/** POST /api/profiles/jobs/save: the jobs saved on every target (Job Tracker's Change each). */
export async function saveJobsOnProfiles(
  deps: Deps,
  actor: FanoutActor,
  body: FanoutSaveJobsBody,
  options: FanoutOptions = {},
): Promise<FanoutAnswer<SavedOnTarget>> {
  assertJobCount(deps, new Set(body.jobIds).size, 'jobIds');
  const date = dayOf(deps, body.occurredOn);
  return fanOut(deps, actor, body.targets, ['tracker:edit'], (target) => saveJobsOn(deps, target.ownerId, body.jobIds, date), {
    ...options,
    wrote: savedSome,
  });
}

/**
 * POST /api/profiles/jobs/add: Add job's link on every target, one after another (A's own first). One of A's
 * JOB_ADDS_PER_HOUR for the link (429 for the whole request when the hour's adds are spent) once a target is usable
 * (none usable: nothing taken, nothing read). A read that failed (a page TailorIT cannot read, a closed posting) is
 * reused for the other targets, never read again. On a shared profile the link's later notices go to A (the add's
 * `actor`), as an add made there does. `options.origin`: the add's channel (default `web`; MCP's add_job passes `mcp`).
 */
export async function addByLinkOnProfiles(
  deps: Deps,
  actor: FanoutActor,
  body: FanoutAddJobBody,
  options: FanoutOptions & { origin?: Extract<JobAddOrigin, 'web' | 'mcp'> } = {},
): Promise<FanoutAnswer<AddJobResult>> {
  const resolved = await resolveTargets(deps, actor, body.targets, ['tracker:edit'], options);
  if (resolved.entries.some(isTarget)) takeAddSlot(deps, actor.id);
  const inFlight = addInFlightOf(deps);
  let failedRead: Extract<LinkRead, { kind: 'closed' | 'unreadable' }> | undefined;
  return runOn(
    deps,
    actor,
    resolved,
    'tracker:edit',
    async (target) => {
      const outcome = await addJobByLink(deps, {
        url: body.url,
        userId: target.ownerId,
        origin: options.origin ?? 'web',
        details: body.details ?? null,
        save: true,
        inFlight,
        ...(failedRead ? { knownRead: failedRead } : {}),
        onRead: (read) => {
          if (read.kind !== 'shared') failedRead = read;
        },
        ...(target.grant ? { actor: { id: actor.id, grantId: target.grant.id } } : {}),
      });
      return addJobResultOf(deps, outcome);
    },
    { ...options, wrote: (value) => value.jobId !== null },
  );
}

/** One source profile's read of its entries (FanoutCopySource's fields). */
interface CopySource {
  found: number;
  jobs: number;
  noJob: number;
  notFound: number;
}

/**
 * POST /api/profiles/applications/copy: the jobs of Tracker entries of one or several profiles saved at Saved on every
 * target (the job only: no notes, status history, documents or resume). At most SAVE_BATCH_MAX entries (400). Each
 * source needs the Job Tracker's See: one A may not read is refused there, as a target is (never the whole request, so
 * nothing reads as the tab's own profile ending); each source's read is counted in its activity.
 */
export async function copySavedJobs(
  deps: Deps,
  actor: FanoutActor,
  body: FanoutCopySavedBody,
  options: FanoutOptions = {},
): Promise<FanoutCopySavedAnswer> {
  const bySource = new Map<ProfileChoice, string[]>();
  for (const item of body.items) {
    const ids = bySource.get(item.profile) ?? [];
    if (!ids.includes(item.applicationId)) ids.push(item.applicationId);
    bySource.set(item.profile, ids);
  }
  assertJobCount(deps, [...bySource.values()].reduce((sum, ids) => sum + ids.length, 0), 'items');
  const date = dayOf(deps, body.occurredOn);
  const jobs = new Set<number>();
  const sources = await runOn<CopySource>(
    deps,
    actor,
    await resolveTargets(deps, actor, [...bySource.keys()], ['tracker:view'], options),
    'tracker:view',
    async (source) => {
      const ids = bySource.get(source.profile) ?? [];
      const rows = await deps.db.all<{ id: string; job_id: number | null }>(
        'SELECT id, job_id FROM applications WHERE user_id = ? AND id = ANY(CAST(? AS text[]))',
        [source.ownerId, sqlTextArray(ids)],
      );
      const named = new Set(rows.flatMap((row) => (row.job_id === null ? [] : [Number(row.job_id)])));
      for (const job of named) jobs.add(job);
      return { found: rows.length, jobs: named.size, noJob: rows.filter((row) => row.job_id === null).length, notFound: ids.length - rows.length };
    },
    { ...options, action: 'read' },
  );
  const jobIds = [...jobs];
  const answer = await fanOut(
    deps,
    actor,
    body.targets,
    ['tracker:edit'],
    (target) => (jobIds.length === 0 ? Promise.resolve(emptySave()) : saveJobsOn(deps, target.ownerId, jobIds, date)),
    { ...options, wrote: savedSome },
  );
  return { sources: sources.results, ...answer };
}

const emptySave = (): SavedOnTarget => ({
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
 * GET /api/profiles/jobs/saved-on: which of A's own profile and A's live shares with the Job Tracker's See track each
 * of `jobIds` (an active entry, at any status). A read of each share's Job Tracker, counted in its activity.
 */
export async function savedOnProfiles(
  deps: Deps,
  actor: FanoutActor,
  jobIds: readonly number[],
  options: FanoutOptions = {},
): Promise<FanoutSavedOn> {
  const grants = await reachableProfiles(deps, actor.id, ['tracker:view', ...(options.extraPerms ?? [])]);
  const profiles: Array<{ profile: ProfileChoice; name: string; ownerId: string }> = [
    { profile: PROFILE_SELF, name: actor.name, ownerId: actor.id },
    ...grants.map((grant) => ({ profile: grant.id, name: grant.owner.name, ownerId: grant.owner.id })),
  ];
  const asked = [...new Set(jobIds)];
  const rows = await deps.db.all<{ user_id: string; job_id: number; id: string; current_status: number }>(
    `SELECT user_id, job_id, id, current_status FROM applications
      WHERE user_id = ANY(CAST(? AS text[])) AND job_id = ANY(CAST(string_to_array(?, ',') AS bigint[])) AND archived_at IS NULL`,
    [sqlTextArray(profiles.map((one) => one.ownerId)), asked.join(',')],
  );
  for (const grant of grants) countOn(deps, actor, grant, 'tracker:view', { ...options, action: 'read' });
  const order = new Map(profiles.map((one, at) => [one.ownerId, at]));
  return {
    profiles: profiles.map(({ profile, name }) => ({ profile, name })),
    jobs: asked.map((jobId) => ({
      jobId,
      savedOn: rows
        .filter((row) => Number(row.job_id) === jobId)
        .sort((a, b) => (order.get(a.user_id) ?? 0) - (order.get(b.user_id) ?? 0))
        .map((row) => ({
          profile: profiles[order.get(row.user_id) ?? 0]!.profile,
          applicationId: row.id,
          status: Number(row.current_status) as ApplicationStatus,
        })),
    })),
  };
}
