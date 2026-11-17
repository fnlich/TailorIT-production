import { randomUUID } from 'node:crypto';
import { queueCanOpen, type AutofillAgentRunKind, type AutofillAgentState } from '@tailorit/shared/autofill';
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
}

export type PreparedRowResult = { queueId: string; run: 'manual' | null } | 'full';

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** The statements of the insert. */
export const PREPARED_SQL = {
  existing: 'SELECT id, job_id, resume_id, state, run FROM autofill_agent_queue WHERE user_id = ? AND job_id = ?',
  job: 'SELECT apply_url FROM jobs WHERE id = ?',
  held: 'SELECT count(*) AS n FROM autofill_agent_queue WHERE user_id = ?',
  kit: `SELECT coalesce(
           (SELECT p.resume_id FROM prepare_jobs p WHERE p.id = @prepareId AND p.user_id = @userId),
           (SELECT d.resume_id FROM application_drafts d WHERE d.application_id = @applicationId AND d.user_id = @userId),
           (SELECT a.resume_id FROM applications a WHERE a.id = @applicationId AND a.user_id = @userId)) AS resume_id`,
  remove: 'DELETE FROM autofill_agent_queue WHERE id = ? AND user_id = ?',
  insert: `INSERT INTO autofill_agent_queue(id, user_id, job_id, application_id, prepare_id, state, source, attempts,
           resume_id, run, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', 'prepare', 0, ?, ?, ?, ?)`,
  undismiss: 'DELETE FROM autofill_agent_dismissed WHERE user_id = ? AND job_id = ?',
} as const;

export type ExistingRow = Removed & { state: AutofillAgentState; run: AutofillAgentRunKind | null };

/** The live row answered as it is. */
export const liveAnswer = (existing: ExistingRow): PreparedRowResult => ({
  queueId: existing.id,
  run: existing.run === 'manual' ? 'manual' : null,
});

/** Whether the account's rows, with the finished one replaced, would pass QUEUE_SIZE_MAX. */
export const queueFull = (deps: Deps, held: number, existing: ExistingRow | undefined): boolean =>
  held - (existing ? 1 : 0) + 1 > constantsOf(deps).get('QUEUE_SIZE_MAX');

/** The queue insert (see above). */
export async function insertPreparedRow(deps: Deps, input: PreparedRowInput): Promise<PreparedRowResult> {
  return deps.db.atomic(
    async (t): Promise<PreparedRowResult> => {
      const { userId, jobId, applicationId, prepareId } = input;
      await t.lockPerson(userId);
      const existing = await t.one<ExistingRow>(PREPARED_SQL.existing, [userId, jobId]);
      if (existing && (existing.state === 'queued' || existing.state === 'running')) return liveAnswer(existing);
      const job = await t.one<{ apply_url: string }>(PREPARED_SQL.job, [jobId]);
      if (!job) throw notFound('That job');
      const held = (await t.one<{ n: number }>(PREPARED_SQL.held, [userId]))!.n;
      if (queueFull(deps, held, existing)) return 'full';
      const kit = (await t.one<{ resume_id: string | null }>(PREPARED_SQL.kit, { prepareId, applicationId, userId }))!;
      if (existing) {
        await t.run(PREPARED_SQL.remove, [existing.id, userId]);
        await tombstone(deps, userId, [existing]);
      }
      const run: 'manual' | null = queueCanOpen(job.apply_url) ? null : 'manual';
      const id = randomUUID();
      const now = nowIso(deps);
      await t.run(PREPARED_SQL.insert, [id, userId, jobId, applicationId, prepareId, kit.resume_id, run, now, now]);
      await t.run(PREPARED_SQL.undismiss, [userId, jobId]);
      return { queueId: id, run };
    },
    { label: 'insertPreparedRow' },
  );
}
