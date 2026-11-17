import type { Router } from 'express';
import {
  AdminPurgesQuerySchema,
  JOB_SOURCE_PURGE_REASON_LABEL,
  JobSourcePurgeRequestSchema,
  type JobSourcePurge,
  type JobSourcePurgeReason,
} from '@tailorit/shared';
import { adminRouter, Where } from '../../core/admin/index';
import { constantsOf } from '../../core/constants/index';
import { nowIso, type AppDeps } from '../../core/context';
import type { DbQueries, DbTx, SqlParams } from '../../core/db/types';
import type { DailyStep } from '../../core/feature';
import { notFound, validationFailed } from '../../core/http/errors';
import { parseInput } from '../../core/http/validate';
import type { PurgeSource, PurgeSourceInput, PurgeSourceResult } from '../../core/seams';
// The seams this job calls, by their own files (core/seams re-exports purgeSource from here: importing it back would be a
// cycle). v30 INT-3: both are built (DB-INGEST, X1-API); a test may still fake one by its path.
import { jobReviews } from '../job-reviews/seam';
import { deleteJobText } from '../jobs/text';
import { closeLink } from './close';
import { projectJobs } from './project-job';

// v30 S1-API: purge by source (11-database.md §8.5, 12-job-sourcing.md §8.5). A licence ends, terms change, an employer
// opts out (13's do_not_fetch: E0-API calls purgeSource with requestedBy null), or an admin removes a source:
//   - purgeSource (the seam, in the caller's transaction) queues a job_source_purges row (state `queued`), unless an
//     open purge of the same source or company covers it, and turns the source (or every source of the company) off
//     at once with a terms note, so no run reads it again meanwhile;
//   - workPurges (the worker every minute, and the daily housekeeping) works the open purges in batches of
//     PURGE_BATCH jobs, cursor_job_id keeping its place across restarts, one transaction per batch, the row locked
//     (FOR UPDATE SKIP LOCKED: two processes never work one purge at once). Its first batch also marks the sources'
//     discovery candidates `forbidden` and deletes their raw payloads. Then for each job a purged source lists: its
//     live links of those sources close through closeLink (reason `purge`: the job closes and leaves search when no
//     live link is left); with deleteTexts, a job no other source lists loses its text, analyses and facts, except one
//     an application names, whose text stays unless deleteAppliedTexts (a contract that demands it); the closed jobs'
//     pending reviews are superseded (jobReviews.supersede, reason `purged`). The jobs rows (title, company, link),
//     their places and links stay: the owner's history and people's application records. The counts go on the row,
//     then `done`. A purge waits while a source it names is leased by a run.

/** Jobs one transaction of a purge handles (11 §8.5). */
export const PURGE_BATCH = 1000;
/** How long one call of workPurges works before it gives the process back (the worker calls it again next minute). */
export const PURGE_BUDGET_MS = 20_000;

/** The note a purged source carries (job_sources.terms_note). */
const noteOf = (reason: JobSourcePurgeReason, at: string) => `Purged (${JOB_SOURCE_PURGE_REASON_LABEL[reason].toLowerCase()}) on ${at.slice(0, 10)}.`;

/** Queues a purge of a source or of a company's sources (core/seams.ts PurgeSource; see the top). */
export const purgeSource: PurgeSource = async (deps, t, input) => queuePurge(t, input);

async function queuePurge(t: DbTx, input: PurgeSourceInput): Promise<PurgeSourceResult> {
  const request = JobSourcePurgeRequestSchema.parse(input);
  // The source's or the company's row is locked first, so two purges asked for at once queue one.
  if (request.sourceId !== undefined) {
    if (!(await t.one('SELECT id FROM job_sources WHERE id = ? FOR UPDATE', [request.sourceId]))) throw notFound('That job source');
  } else if (!(await t.one('SELECT id FROM companies WHERE id = ? FOR UPDATE', [request.companyId!]))) {
    throw notFound('That company');
  }
  const open = await t.one<{ id: number }>(
    `SELECT id FROM job_source_purges WHERE state IN ('queued', 'running')
       AND ${request.sourceId !== undefined ? 'source_id = ? AND company_id IS NULL' : 'company_id = ? AND source_id IS NULL'}
     ORDER BY id LIMIT 1`,
    [request.sourceId ?? request.companyId!],
  );
  if (open) return { purgeId: open.id, queued: false };
  const row = await t.one<{ id: number }>(
    `INSERT INTO job_source_purges(source_id, company_id, reason, delete_texts, delete_applied_texts, requested_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, CAST(? AS timestamptz)) RETURNING id`,
    [
      request.sourceId ?? null,
      request.companyId ?? null,
      request.reason,
      request.deleteTexts,
      request.deleteAppliedTexts,
      input.requestedBy,
      input.at,
    ],
  );
  await t.run(
    `UPDATE job_sources SET enabled = false, terms_note = ?, updated_at = CAST(? AS timestamptz)
     WHERE ${request.sourceId !== undefined ? 'id = ?' : 'company_id = ?'}`,
    [noteOf(request.reason, input.at), input.at, request.sourceId ?? request.companyId!],
  );
  return { purgeId: row!.id, queued: true };
}

interface PurgeRow {
  id: number;
  source_id: number | null;
  company_id: number | null;
  reason: JobSourcePurgeReason;
  delete_texts: boolean;
  delete_applied_texts: boolean;
  state: 'queued' | 'running' | 'done' | 'failed';
  cursor_job_id: number | null;
}

/** The sources a purge names: its source, or every source of its company. */
async function sourcesOf(t: DbQueries, purge: PurgeRow): Promise<number[]> {
  if (purge.source_id !== null) return [purge.source_id];
  return (await t.all<{ id: number }>('SELECT id FROM job_sources WHERE company_id = ? ORDER BY id', [purge.company_id])).map((row) => row.id);
}

/** What one batch did. */
interface BatchResult {
  done: boolean;
  /** A source it names is leased by a run: it waits. */
  waiting: boolean;
}

/** One batch of one purge, in one transaction (see the top). Null when another process holds it, or it is no longer open. */
async function purgeBatch(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>, purgeId: number): Promise<BatchResult | null> {
  const at = nowIso(deps);
  return deps.db.tx(
    async (t) => {
      const purge = await t.one<PurgeRow>(
        "SELECT * FROM job_source_purges WHERE id = ? AND state IN ('queued', 'running') FOR UPDATE SKIP LOCKED",
        [purgeId],
      );
      if (!purge) return null;
      const sources = await sourcesOf(t, purge);
      const list = sources.join(',');
      const leased = await t.one(
        "SELECT 1 AS found FROM job_sources WHERE id = ANY(CAST(string_to_array(?, ',') AS bigint[])) AND lease_until > CAST(? AS timestamptz)",
        [list, at],
      );
      if (leased) return { done: false, waiting: true };
      let rawDeleted = 0;
      if (purge.state === 'queued') {
        // Step 1 and 3: the sources off (a company's sources made since the purge was asked too), their candidates
        // forbidden, their raw payloads gone (the primary key starts with source_id: each partition's index serves it).
        await t.run(
          `UPDATE job_sources SET enabled = false, terms_note = ?, updated_at = CAST(? AS timestamptz)
           WHERE id = ANY(CAST(string_to_array(?, ',') AS bigint[])) AND (enabled OR terms_note IS NULL)`,
          [noteOf(purge.reason, at), at, list],
        );
        await t.run(
          `UPDATE job_source_candidates c SET status = 'forbidden'
           WHERE c.status <> 'forbidden' AND (c.source_id = ANY(CAST(string_to_array(@list, ',') AS bigint[]))
             OR EXISTS (SELECT 1 FROM job_sources s WHERE s.id = ANY(CAST(string_to_array(@list, ',') AS bigint[]))
                          AND s.kind = c.kind AND s.name = c.name))`,
          { list },
        );
        rawDeleted = (await t.run("DELETE FROM job_postings_raw WHERE source_id = ANY(CAST(string_to_array(?, ',') AS bigint[]))", [list])).changes;
      }
      const jobIds = (
        await t.all<{ job_id: number }>(
          `SELECT DISTINCT job_id FROM job_source_links WHERE source_id = ANY(CAST(string_to_array(?, ',') AS bigint[])) AND job_id > ?
           ORDER BY job_id LIMIT ?`,
          [list, purge.cursor_job_id ?? 0, PURGE_BATCH],
        )
      ).map((row) => row.job_id);
      const closed: number[] = [];
      let textsDeleted = 0;
      let textsKept = 0;
      for (const jobId of jobIds) {
        // Step 2: each live link of the purged sources closes; the job closes with its last live link.
        const links = await t.all<{ source_id: number; source_job_id: string }>(
          `SELECT source_id, source_job_id FROM job_source_links
           WHERE job_id = ? AND source_id = ANY(CAST(string_to_array(?, ',') AS bigint[])) AND missing_since IS NULL ORDER BY source_id, source_job_id`,
          [jobId, list],
        );
        let jobClosed = false;
        for (const link of links) {
          const result = await closeLink(deps as AppDeps, t, {
            jobId,
            link: { sourceId: link.source_id, sourceJobId: link.source_job_id },
            reason: 'purge',
            at,
          });
          jobClosed ||= result.jobClosed;
        }
        if (jobClosed) closed.push(jobId);
        // v30 FIX-A (REV-BEH BEH-5): the purged links forget their posting's hash, so a later listing of the same posting
        // (the opt-out withdrawn, the source on again, Run now) is a change: it writes the text, keys and facts again
        // instead of reopening a job with its text gone.
        await t.run(
          "UPDATE job_source_links SET source_hash = '' WHERE job_id = ? AND source_id = ANY(CAST(string_to_array(?, ',') AS bigint[])) AND source_hash <> ''",
          [jobId, list],
        );
        // Step 4: the texts of a job only the purged sources list.
        if (!purge.delete_texts) continue;
        const elsewhere = await t.one(
          "SELECT 1 AS found FROM job_source_links WHERE job_id = ? AND NOT (source_id = ANY(CAST(string_to_array(?, ',') AS bigint[]))) LIMIT 1",
          [jobId, list],
        );
        if (elsewhere) continue;
        const applied = await t.one('SELECT 1 AS found FROM applications WHERE job_id = ? LIMIT 1', [jobId]);
        if (applied && !purge.delete_applied_texts) {
          textsKept += 1;
          continue;
        }
        await deleteJobText(t, jobId);
        await t.run('DELETE FROM job_facts_certifications WHERE job_id = ?', [jobId]);
        await t.run('DELETE FROM job_facts_eligibility WHERE job_id = ?', [jobId]);
        await t.run('DELETE FROM job_facts WHERE job_id = ?', [jobId]);
        // An analysis is shared by every job of the same text: it goes only when no other job has that text.
        await t.run(
          `DELETE FROM job_analyses a USING jobs j WHERE j.id = ? AND a.content_hash = j.content_hash
             AND NOT EXISTS (SELECT 1 FROM jobs o WHERE o.content_hash = a.content_hash AND o.id <> j.id)`,
          [jobId],
        );
        textsDeleted += 1;
      }
      if (closed.length > 0) await jobReviews.supersede(deps as AppDeps, t, { jobIds: closed, reason: 'purged', at });
      // Every job a text was deleted of leaves search too (closed already, unless an own copy kept it open).
      await projectJobs(t, jobIds);
      const done = jobIds.length < PURGE_BATCH;
      await t.run(
        `UPDATE job_source_purges SET state = ?, cursor_job_id = ?, jobs_closed = jobs_closed + ?, texts_deleted = texts_deleted + ?,
           raw_deleted = raw_deleted + ?, texts_kept_for_applications = texts_kept_for_applications + ?,
           finished_at = CASE WHEN ? THEN CAST(? AS timestamptz) ELSE finished_at END
         WHERE id = ?`,
        [
          done ? 'done' : 'running',
          jobIds.length > 0 ? jobIds[jobIds.length - 1]! : purge.cursor_job_id,
          closed.length,
          textsDeleted,
          rawDeleted,
          textsKept,
          done,
          at,
          purge.id,
        ],
      );
      if (done) deps.log.info(`[ingest] purge ${purge.id} done`);
      return { done, waiting: false };
    },
    { label: 'purge by source' },
  );
}

/**
 * Works the open purges, oldest first, a batch at a time, for at most `budgetMs` (see the top). A batch that fails is
 * logged and its purge marked `failed` (an admin asks again). Answers the batches done.
 */
export async function workPurges(
  deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>,
  options: { budgetMs?: number; signal?: AbortSignal } = {},
): Promise<number> {
  const started = Date.now();
  const budget = options.budgetMs ?? PURGE_BUDGET_MS;
  const open = await deps.db.all<{ id: number }>("SELECT id FROM job_source_purges WHERE state IN ('queued', 'running') ORDER BY created_at, id");
  let batches = 0;
  for (const { id } of open) {
    for (;;) {
      if (options.signal?.aborted || Date.now() - started > budget) return batches;
      let result: BatchResult | null;
      try {
        result = await purgeBatch(deps, id);
      } catch (error) {
        deps.log.error(`[ingest] purge ${id} failed; an admin can ask for it again`, error);
        await deps.db
          .run("UPDATE job_source_purges SET state = 'failed', finished_at = CAST(? AS timestamptz) WHERE id = ? AND state IN ('queued', 'running')", [
            nowIso(deps),
            id,
          ])
          .catch(() => undefined);
        break;
      }
      if (!result || result.waiting) break;
      batches += 1;
      if (result.done) break;
    }
  }
  return batches;
}

/** The daily housekeeping's step (Feature.daily): `ingest.purges`, for a server whose worker is not running. */
export const purgesDailyStep: DailyStep = { name: 'purges', run: (deps) => workPurges(deps) };

/** Raw payloads one statement of the short keeps deletes (11 §8.1's batches). */
export const RAW_DELETE_BATCH = 10_000;

/**
 * The raw payloads of kinds that keep them for less than JOB_RAW_KEEP_DAYS (11 §8.2, 12 §12.1: the kind's
 * raw_keep_days; NAV's 7 days), deleted in batches by the primary key; the day partitions are dropped at
 * JOB_RAW_KEEP_DAYS by D5L's housekeeping. Answers the rows deleted.
 */
export async function pruneShortRawKeeps(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>): Promise<number> {
  const longest = constantsOf(deps).get('JOB_RAW_KEEP_DAYS');
  const kinds = await deps.db.all<{ kind: string; days: number }>(
    'SELECT kind, raw_keep_days AS days FROM job_source_kinds WHERE raw_keep_days < ? ORDER BY kind',
    [longest],
  );
  let deleted = 0;
  for (const { kind, days } of kinds) {
    const before = new Date(deps.now().getTime() - days * 86_400_000).toISOString();
    for (;;) {
      const batch = (
        await deps.db.run(
          `DELETE FROM job_postings_raw WHERE (source_id, source_job_id, fetched_at) IN (
             SELECT r.source_id, r.source_job_id, r.fetched_at FROM job_postings_raw r JOIN job_sources s ON s.id = r.source_id
             WHERE s.kind = ? AND r.fetched_at < CAST(? AS timestamptz) LIMIT ?)`,
          [kind, before, RAW_DELETE_BATCH],
        )
      ).changes;
      deleted += batch;
      if (batch < RAW_DELETE_BATCH) break;
    }
  }
  return deleted;
}

/** The daily housekeeping's step: `ingest.raw_keep`. */
export const rawKeepDailyStep: DailyStep = { name: 'raw_keep', run: (deps) => pruneShortRawKeeps(deps) };

// ------------------------------------------------------------------------------------------------- Admin › Purges

interface PurgeListRow extends PurgeRow {
  source_name: string | null;
  company_name: string | null;
  requested_by_email: string | null;
  jobs_closed: number;
  texts_deleted: number;
  raw_deleted: number;
  texts_kept_for_applications: number;
  created_at: string;
  finished_at: string | null;
}

const PURGE_SQL = `SELECT p.*, s.name AS source_name, c.name AS company_name, u.email AS requested_by_email
  FROM job_source_purges p LEFT JOIN job_sources s ON s.id = p.source_id LEFT JOIN companies c ON c.id = p.company_id
  LEFT JOIN users u ON u.id = p.requested_by`;

function toPurge(row: PurgeListRow): JobSourcePurge {
  return {
    id: row.id,
    sourceId: row.source_id,
    sourceName: row.source_name,
    companyId: row.company_id,
    companyName: row.company_name,
    reason: row.reason,
    deleteTexts: row.delete_texts,
    deleteAppliedTexts: row.delete_applied_texts,
    requestedBy: row.requested_by_email,
    state: row.state,
    jobsClosed: row.jobs_closed,
    textsDeleted: row.texts_deleted,
    rawDeleted: row.raw_deleted,
    textsKeptForApplications: row.texts_kept_for_applications,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

/** One purge, or null. */
export async function adminPurge(db: DbQueries, id: number): Promise<JobSourcePurge | null> {
  const row = await db.one<PurgeListRow>(`${PURGE_SQL} WHERE p.id = ?`, [id]);
  return row ? toPurge(row) : null;
}

/** Mounted at /api/admin/purges: the purges newest first, one purge, and an admin's new purge (POST /). */
export function createPurgesRouter(deps: AppDeps): Router {
  return adminRouter(deps, {
    resource: 'purge',
    list: {
      query: AdminPurgesQuerySchema,
      run: async (_deps, query) => {
        const where = new Where();
        if (query.state.length) where.add("p.state = ANY(string_to_array(@states, ','))", { states: query.state.join(',') });
        if (query.cursor) {
          const before = Number(query.cursor);
          if (!Number.isSafeInteger(before) || before <= 0) throw validationFailed('This list changed. Load it again from the top.');
          where.add('p.id < @before', { before });
        }
        const rows = await deps.db.all<PurgeListRow>(`${PURGE_SQL} ${where.sql()} ORDER BY p.id DESC LIMIT @limit`, {
          ...where.params,
          limit: query.limit + 1,
        } as SqlParams);
        const items = rows.slice(0, query.limit).map(toPurge);
        return rows.length > query.limit ? { items, nextCursor: String(items[items.length - 1]!.id) } : { items };
      },
    },
    get: (_deps, id) => adminPurge(deps.db, id),
    routes(router, { handle, audit }) {
      router.post(
        '/',
        handle(async (req, actor) => {
          const body = parseInput(JobSourcePurgeRequestSchema, req.body ?? {}, 'purge');
          const at = nowIso(deps);
          const result = await deps.db.tx((t) => queuePurge(t, { ...body, requestedBy: actor.id, at }), { label: 'queue purge' });
          if (result.queued) {
            await audit({ action: 'create', ids: [result.purgeId], actor, change: body });
            req.res!.status(202);
          }
          return adminPurge(deps.db, result.purgeId);
        }),
      );
    },
  });
}
