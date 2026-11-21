import { randomUUID } from 'node:crypto';
import { queueCanOpen, type AutofillAgentRunKind, type AutofillAgentState } from '@tailorit/shared/autofill';
import { grantHolds, lockedLiveGrant, profileEnded } from '../../../core/auth/grants'; // v33 SHARE-5
import { constantsOf } from '../../../core/constants/service';
import { nowIso, type AppDeps } from '../../../core/context';
import { notFound } from '../../../core/http/errors';
import { tombstone, type Removed } from './queue';

// v2.0: the queue insert at the end of a Prepare (docs/design/v2.0/05-prepare-flow.md, "The queue insert:
// insertPreparedRow"; DECISIONS A5, A14, A30). The one way a job enters the auto-apply queue: P2's runner and P5's MCP
// saves call it inside the transaction that finishes the Prepare (it joins that transaction).
// - An existing finished row for (user, job) is replaced: deleted, with a tombstone (as the removed enqueue did), so a
//   late result of its run finds the tombstone, never the new row.
// - One `queued` or `running` is answered as it is (its id; `manual` when it is a manual row).
// - The account's rows are checked against QUEUE_SIZE_MAX: 'full', nothing written.
// - run = queueCanOpen(job.apply_url) ? NULL : 'manual' (A14): the extension never takes a manual row.
// - source = 'prepare'; application_id and prepare_id name the entry and the Prepare.
// - resume_id is the kit's, frozen now (A30): the Prepare's chosen resume, else the draft's, else the entry's.
// - autofill_agent_dismissed forgets the job (the person asked for it again).
//
// v3.0 D2 (11-database.md §9.3): on the async client, in a savepoint of the caller's transaction (deps.db.atomic), or a
// transaction of its own. It counts the account's rows, then inserts one: the person's lock first. Prepare's runner
// and MCP call it inside their own transactions (it joins them as a savepoint).

export interface PreparedRowInput {
  userId: string;
  jobId: number;
  applicationId: string;
  prepareId: string;
  // v33 SHARE-5 (PLAN F9 "Prepare and the queue"; SP v33 PLAN-sharing.md §5, §6): a job someone the profile is shared
  // with (B) prepared names them (prepared_by: who prepared it; the owner's own when absent) and the grant (required
  // then). The insert decides the rest from the grant itself, read live and locked in its transaction (the SHARE-5
  // review's decision 4: it fails closed): no live grant with Prepare & queue's Change, nothing is written
  // (profile_ended); the row waits for the owner's OK (awaiting_owner) unless the grant holds `apply`; it never takes the
  // owner's last SHARING_QUEUE_RESERVE queue places ('full' sooner); and without Queue changes (`queue:edit`) it never
  // replaces a finished row it did not prepare under that grant ('kept': the decision 8; a replace is a Remove).
  preparedBy?: string;
  grantId?: string | null;
}

/** v33 SHARE-5: 'kept': a job someone else prepared did not replace the owner's finished row of it (see above). */
export type PreparedRowResult = { queueId: string; run: 'manual' | null } | 'full' | 'kept';

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** The statements of the insert. */
export const PREPARED_SQL = {
  existing: 'SELECT id, job_id, resume_id, state, run, prepared_by, grant_id FROM autofill_agent_queue WHERE user_id = ? AND job_id = ?',
  job: 'SELECT apply_url FROM jobs WHERE id = ?',
  held: 'SELECT count(*) AS n FROM autofill_agent_queue WHERE user_id = ?',
  kit: `SELECT coalesce(
           (SELECT p.resume_id FROM prepare_jobs p WHERE p.id = @prepareId AND p.user_id = @userId),
           (SELECT d.resume_id FROM application_drafts d WHERE d.application_id = @applicationId AND d.user_id = @userId),
           (SELECT a.resume_id FROM applications a WHERE a.id = @applicationId AND a.user_id = @userId)) AS resume_id`,
  remove: 'DELETE FROM autofill_agent_queue WHERE id = ? AND user_id = ?',
  // v33 SHARE-5: the payer columns (prepared_by, grant_id) and the hold (awaiting_owner) written out.
  insert: `INSERT INTO autofill_agent_queue(id, user_id, job_id, application_id, prepare_id, state, source, attempts,
           resume_id, run, created_at, updated_at, prepared_by, grant_id, awaiting_owner)
         VALUES (?, ?, ?, ?, ?, 'queued', 'prepare', 0, ?, ?, ?, ?, ?, ?, ?)`,
  undismiss: 'DELETE FROM autofill_agent_dismissed WHERE user_id = ? AND job_id = ?',
} as const;

export type ExistingRow = Removed & {
  state: AutofillAgentState;
  run: AutofillAgentRunKind | null;
  /** v33 SHARE-5: who prepared it, under which grant. */
  prepared_by?: string;
  grant_id?: string | null;
};

/** The live row answered as it is. */
export const liveAnswer = (existing: ExistingRow): PreparedRowResult => ({
  queueId: existing.id,
  run: existing.run === 'manual' ? 'manual' : null,
});

/**
 * Whether the account's rows, with the finished one replaced, would pass QUEUE_SIZE_MAX. v33 SHARE-5: `reserve` (a job
 * someone the profile is shared with prepared) keeps the owner's last places: the limit is that many lower.
 */
export const queueFull = (deps: Deps, held: number, existing: ExistingRow | undefined, reserve = 0): boolean =>
  held - (existing ? 1 : 0) + 1 > constantsOf(deps).get('QUEUE_SIZE_MAX') - reserve;

/** v33 SHARE-5: the owner's queue places a job someone else prepared on their profile never takes (SHARING_QUEUE_RESERVE). */
export const queueReserveOf = (deps: Deps, preparedBy: string | undefined, userId: string): number =>
  preparedBy !== undefined && preparedBy !== userId ? constantsOf(deps).get('SHARING_QUEUE_RESERVE') : 0;

/** The queue insert (see above). */
export async function insertPreparedRow(deps: Deps, input: PreparedRowInput): Promise<PreparedRowResult> {
  return deps.db.atomic(
    async (t): Promise<PreparedRowResult> => {
      const { userId, jobId, applicationId, prepareId } = input;
      // v33 SHARE-5 (the SHARE-5 review's decision 4): a job someone else prepared needs its grant, live, letting them
      // prepare; the grant is locked (before the owner's person lock, as everywhere) until this commits, so a change of
      // it waits and its endGrant sees this row.
      const grantee = input.preparedBy !== undefined && input.preparedBy !== userId;
      const grant = grantee ? await lockedLiveGrant(deps, t, input.grantId, 'share') : null;
      if (grantee && (!grant || grant.owner.id !== userId || grant.granteeId !== input.preparedBy || !grantHolds(grant, 'prepare:run'))) {
        throw profileEnded();
      }
      await t.lockPerson(userId);
      const existing = await t.one<ExistingRow>(PREPARED_SQL.existing, [userId, jobId]);
      if (existing && (existing.state === 'queued' || existing.state === 'running')) return liveAnswer(existing);
      // v33 SHARE-5 (decision 8): without Queue changes, someone else never replaces (removes) a finished row they did
      // not prepare under this grant: the owner's needs-you, failed or skipped row stays theirs to look at.
      if (existing && grant && !grantHolds(grant, 'queue:edit') && !(existing.prepared_by === input.preparedBy && existing.grant_id === grant.id)) {
        return 'kept';
      }
      const job = await t.one<{ apply_url: string }>(PREPARED_SQL.job, [jobId]);
      if (!job) throw notFound('That job');
      const held = (await t.one<{ n: number }>(PREPARED_SQL.held, [userId]))!.n;
      // v33 SHARE-5: a job someone else prepared never takes the owner's last queue places.
      if (queueFull(deps, held, existing, queueReserveOf(deps, input.preparedBy, userId))) return 'full';
      const kit = (await t.one<{ resume_id: string | null }>(PREPARED_SQL.kit, { prepareId, applicationId, userId }))!;
      if (existing) {
        await t.run(PREPARED_SQL.remove, [existing.id, userId]);
        await tombstone(deps, userId, [existing]);
      }
      const run: 'manual' | null = queueCanOpen(job.apply_url) ? null : 'manual';
      const id = randomUUID();
      const now = nowIso(deps);
      await t.run(PREPARED_SQL.insert, [
        id,
        userId,
        jobId,
        applicationId,
        prepareId,
        kit.resume_id,
        run,
        now,
        now,
        grantee ? input.preparedBy! : userId,
        grant ? grant.id : null,
        // v33 SHARE-5: waits for the owner's OK unless the grant holds "Apply without my OK" (`apply`).
        grant ? !grantHolds(grant, 'apply') : false,
      ]);
      await t.run(PREPARED_SQL.undismiss, [userId, jobId]);
      return { queueId: id, run };
    },
    { label: 'insertPreparedRow' },
  );
}
