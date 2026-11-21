import { STATUS } from '@tailorit/shared';
import {
  PROFILE_SELF,
  type ProfileChoice,
  type SharingOverview,
  type SharingOverviewItem,
  type SharingOverviewProfile,
} from '@tailorit/shared/sharing';
import { grantHolds, reachableProfiles, sharingEnabled } from '../../core/auth/grants';
import type { AppDeps, SessionUser } from '../../core/context';
import { sqlTextArray } from './rows';

// v33 SHARE-2 (PLAN F9; SP v33 PLAN-sharing.md §8): every profile at once, for the Profiles page: the person's own
// profile, then each live profile shared with them that holds `prepare:view` (core/auth/grants.ts reachableProfiles,
// the only way it finds them), each with its counts, and one merged "Needs you" list (at most OVERVIEW_ITEMS_MAX) from
// the profiles that also hold `tracker:view`. Four grouped statements for all the profiles (at most
// SHARING_PROFILES_PER_GRANTEE + 1). `self`: it is always the signed-in person's own view.

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** The most items of the merged "Needs you" list. */
export const OVERVIEW_ITEMS_MAX = 20;

/** The Prepare states that are waiting or running. */
const ACTIVE_PREPARE = `('waiting', 'filtering', 'analyzing', 'building')`;

interface ProfileOf {
  choice: ProfileChoice;
  ownerId: string;
  name: string;
  email: string;
  permissions: SharingOverviewProfile['permissions'];
  accessEndsAt: string | null;
  tracker: boolean;
}

/** GET /api/sharing/overview for `actor`. */
export async function overviewOf(deps: Deps, actor: SessionUser): Promise<SharingOverview> {
  const enabled = sharingEnabled(deps);
  const own: ProfileOf = {
    choice: PROFILE_SELF,
    ownerId: actor.id,
    name: actor.name,
    email: actor.email,
    permissions: null,
    accessEndsAt: null,
    tracker: true,
  };
  const shared: ProfileOf[] = enabled
    ? (await reachableProfiles(deps, actor.id, ['prepare:view'])).map((grant) => ({
        choice: grant.id,
        ownerId: grant.owner.id,
        name: grant.owner.name,
        email: grant.owner.email,
        permissions: [...grant.permissions],
        accessEndsAt: grant.accessEndsAt === null ? null : new Date(grant.accessEndsAt).toISOString(),
        tracker: grantHolds(grant, 'tracker:view'),
      }))
    : [];
  const profiles = [own, ...shared];
  const ids = sqlTextArray(profiles.map((profile) => profile.ownerId));
  const trackerIds = sqlTextArray(profiles.filter((profile) => profile.tracker).map((profile) => profile.ownerId));

  const tracker = await deps.db.all<{ user_id: string; saved: number; applied: number }>(
    `SELECT user_id, count(*) FILTER (WHERE current_status = ${STATUS.saved}) AS saved,
            count(*) FILTER (WHERE current_status <> ${STATUS.saved}) AS applied
       FROM applications WHERE user_id = ANY(CAST(@ids AS text[])) AND archived_at IS NULL
      GROUP BY user_id`,
    { ids: trackerIds },
  );
  const preparing = await deps.db.all<{ user_id: string; n: number }>(
    `SELECT user_id, count(*) AS n FROM prepare_jobs
      WHERE user_id = ANY(CAST(@ids AS text[])) AND state IN ${ACTIVE_PREPARE}
      GROUP BY user_id`,
    { ids },
  );
  const queue = await deps.db.all<{ user_id: string; queued: number; running: number; waiting: number; needs_you: number }>(
    `SELECT user_id,
            count(*) FILTER (WHERE state IN ('queued', 'running') AND NOT awaiting_owner) AS queued,
            count(*) FILTER (WHERE state = 'running') AS running,
            count(*) FILTER (WHERE state = 'queued' AND awaiting_owner AND (user_id = @me OR prepared_by = @me)) AS waiting,
            count(*) FILTER (WHERE state = 'needs-you') AS needs_you
       FROM autofill_agent_queue WHERE user_id = ANY(CAST(@ids AS text[]))
      GROUP BY user_id`,
    { ids, me: actor.id },
  );
  const items = await deps.db.all<{
    id: string;
    user_id: string;
    application_id: string | null;
    job_id: number;
    title: string;
    company: string;
    updated_at: string;
    awaiting: boolean;
  }>(
    `SELECT q.id, q.user_id, q.application_id, q.job_id, coalesce(a.title, j.title) AS title,
            coalesce(a.company_name, c.name, '') AS company, q.updated_at, (q.state = 'queued') AS awaiting
       FROM autofill_agent_queue q
       JOIN jobs j ON j.id = q.job_id
       LEFT JOIN companies c ON c.id = j.company_id
       LEFT JOIN applications a ON a.id = q.application_id
      WHERE q.user_id = ANY(CAST(@ids AS text[]))
        AND (q.state = 'needs-you' OR (q.user_id = @me AND q.state = 'queued' AND q.awaiting_owner))
      ORDER BY q.updated_at DESC, q.seq DESC
      LIMIT @max`,
    { ids: trackerIds, me: actor.id, max: OVERVIEW_ITEMS_MAX },
  );

  const byOwner = <T extends { user_id: string }>(rows: T[]) => new Map(rows.map((row) => [row.user_id, row]));
  const trackerOf = byOwner(tracker);
  const preparingOf = byOwner(preparing);
  const queueOf = byOwner(queue);
  const choiceOf = new Map(profiles.map((profile) => [profile.ownerId, profile.choice]));

  const cards: SharingOverviewProfile[] = profiles.map((profile) => {
    const counts = trackerOf.get(profile.ownerId);
    const lane = queueOf.get(profile.ownerId);
    const running = Number(lane?.running ?? 0);
    const preparingCount = Number(preparingOf.get(profile.ownerId)?.n ?? 0);
    return {
      profile: profile.choice,
      name: profile.name,
      email: profile.email,
      permissions: profile.permissions,
      accessEndsAt: profile.accessEndsAt,
      counts: {
        saved: profile.tracker ? Number(counts?.saved ?? 0) : null,
        applied: profile.tracker ? Number(counts?.applied ?? 0) : null,
        preparing: preparingCount,
        queued: Number(lane?.queued ?? 0),
        waitingForOk: Number(lane?.waiting ?? 0),
        needsYou: Number(lane?.needs_you ?? 0),
      },
      busy: preparingCount > 0 || running > 0,
    };
  });
  const needsYou: SharingOverviewItem[] = items.flatMap((row) => {
    const profile = choiceOf.get(row.user_id);
    if (profile === undefined) return [];
    return [
      {
        profile,
        kind: row.awaiting ? 'awaiting_ok' : 'needs_you',
        queueId: row.id,
        applicationId: row.application_id,
        jobId: Number(row.job_id),
        title: row.title,
        company: row.company,
        at: new Date(row.updated_at).toISOString(),
      },
    ];
  });
  return { enabled, profiles: cards, needsYou, busy: cards.some((card) => card.busy) };
}
