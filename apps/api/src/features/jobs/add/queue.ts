import { randomUUID } from 'node:crypto';
import {
  DAY_MS,
  linkKey,
  MINUTE_MS,
  type JobAddState,
  type JobVerifyReason,
  type LinkBatchProgress,
  type QueuedLinks,
} from '@tailorit/shared';
import { constantsOf } from '../../../core/constants/service';
import type { AppDeps } from '../../../core/context';
import type { DailyStep } from '../../../core/feature';
import { ROW_SOURCE_KINDS } from '../../ingest/types';
import { sharedAddress } from './address';
import { settleLegacyJob, TRANSIENT_REASONS } from './legacy';
import { outsideWorkPaused } from './pause';
import { settleRecheck } from './recheck';
import { addJobByLink, isAddableLink } from './pipeline';

// v31 LINK (docs/design/v3.1/21-jobs-from-links.md §5): the links an import (a CSV or JSON file, a Google Sheet's tab,
// the free_tailor lake) or an admin's add (POST /api/admin/jobs/add) queues for TailorIT's own read. Only the link is
// taken from a row: its title, company and text are never stored; each posting is read from its link by addJobByLink
// (an ATS's API, or the page's schema.org JobPosting), in the ingest worker, a host's links one after the other, each
// host at its own pace (the ingest client's and the shared reader's turns), never inside the request. A link queued twice
// while it waits is read once (one open row per link key). A read that failed for now (`unavailable`, or an error) is
// tried again later, at most LINK_QUEUE_ATTEMPTS times; a done row keeps its result for the progress view, pruned after
// JOB_LINK_QUEUE_KEEP_DAYS. No pass reads while every run is paused (v3.1 RUNS, pause.ts).
//
// v31 FIX-LINK (REV-BEH BEH-3, BEH-5, BEH-6, BEH-9; REV-SEC SEC-2; the one-source rule):
//   - the queue's limits are constants (LINK_QUEUE_TICK_MS, LINK_QUEUE_PER_PASS hosts, LINK_QUEUE_PER_HOST links of
//     each, LINK_QUEUE_ATTEMPTS, LINK_QUEUE_RETRY_MS);
//   - a pass takes its hosts in turn (BEH-6): the hosts whose first due link is oldest, each with its own oldest links,
//     whatever another host's backlog; an admin's link or an import's before a legacy or a weekly read;
//   - a read that failed for now (`unavailable`, `blocked`, an error) waits LINK_QUEUE_RETRY_MS, twice as long at each
//     new try (at most a day), and is tried LINK_QUEUE_ATTEMPTS times (a legacy job's, three times as often: BEH-3);
//   - a pass checks the pause before each link (BEH-9): a link not reached is put back as it was;
//   - an import's run (a file, a Sheet, the lake) queues only a link with no read lately (BEH-5): one with no job, or
//     whose job no server read saw within JOB_PAGE_RECHECK_DAYS, and that no queued read of the source settled since;
//   - every link is kept in its shared form (address.ts, SEC-2).

/**
 * Where a queued link came from (job_link_queue.origin). v31 LINK2: `legacy` (a job stored before v3.1 from what a row
 * or a browser said, read now: legacy.ts) and `recheck` (a job read from its page, read again: recheck.ts), each for
 * one job (for_job_id).
 */
export type LinkQueueOrigin = 'admin' | 'import' | 'sheets' | 'ft_lake' | 'legacy' | 'recheck';

/** How long a claimed link is the pass's before another pass may take it again. */
export const LINK_QUEUE_LEASE_MS = 10 * MINUTE_MS;
/** v31 LINK2: how long a legacy job's read waits while page reads are not set up here. */
export const LEGACY_WAIT_MS = DAY_MS;
/** v31 FIX-LINK (BEH-3): a legacy job's read is tried this many times LINK_QUEUE_ATTEMPTS (days, with the growing wait). */
export const LEGACY_ATTEMPTS_FACTOR = 3;
/** v31 FIX-LINK (BEH-3): the longest wait before a failed read is tried again. */
export const LINK_QUEUE_RETRY_MAX_MS = DAY_MS;
/** The origins whose rows wait behind an admin's and an import's (BEH-6: the legacy pass's and the weekly reads). */
const BACKGROUND_ORIGINS = ['legacy', 'recheck'] as const;
/** v31 FIX-LINK (BEH-5): the origins of an import's run, which queue only a link with no read lately. */
const RUN_ORIGINS: ReadonlySet<LinkQueueOrigin> = new Set(['import', 'sheets', 'ft_lake']);
/** Rows one insert writes. */
const INSERT_CHUNK = 500;
/** The refused links an answer names (the rest are counted only). */
const REFUSED_SHOWN = 100;

export interface QueueLinksInput {
  urls: readonly string[];
  origin: LinkQueueOrigin;
  addedBy: string | null;
  sourceId?: number | null;
  /** The batch the links join (an import's run); a new one when absent. */
  batchId?: string;
}

/** The SQL list of the kinds whose jobs no server read made (ingest/types.ts ROW_SOURCE_KINDS). */
const ROW_KINDS_SQL = ROW_SOURCE_KINDS.map((kind) => `'${kind}'`).join(', ');

/**
 * v31 FIX-LINK (BEH-5): the link keys of an import's run read lately (see the top): a queued read of the source settled
 * since `since`, or a job of the link that a server read (a source no row made) saw since then.
 */
async function readLately(
  deps: Pick<AppDeps, 'db'>,
  sourceId: number | null,
  keys: readonly string[],
  since: string,
): Promise<Set<string>> {
  const lately = new Set<string>();
  if (sourceId !== null) {
    const done = await deps.db.all<{ url_key: string }>(
      "SELECT DISTINCT url_key FROM job_link_queue WHERE state = 'done' AND done_at > ? AND source_id = ?",
      [since, sourceId],
    );
    for (const row of done) lately.add(row.url_key);
  }
  for (let start = 0; start < keys.length; start += INSERT_CHUNK) {
    const chunk = keys.slice(start, start + INSERT_CHUNK);
    const seen = await deps.db.all<{ key: string }>(
      `SELECT DISTINCT k.key FROM job_keys k
       JOIN job_source_links l ON l.job_id = k.job_id JOIN job_sources s ON s.id = l.source_id
       WHERE k.key_kind = 'link' AND k.key IN (SELECT value FROM ${deps.db.dialect.jsonEach('?')})
         AND s.kind NOT IN (${ROW_KINDS_SQL}) AND GREATEST(l.last_seen_at, COALESCE(l.liveness_checked_at, l.last_seen_at)) > ?`,
      [JSON.stringify(chunk), since],
    );
    for (const row of seen) lately.add(row.key);
  }
  return lately;
}

/** Queues links for TailorIT's own read (see the top); answers what was queued, what waited already and what was refused. */
export async function queueLinks(
  deps: Pick<AppDeps, 'db' | 'now' | 'config' | 'log' | 'services'>,
  input: QueueLinksInput,
): Promise<QueuedLinks> {
  const batchId = input.batchId ?? randomUUID();
  const refused: QueuedLinks['refused'] = [];
  const unique = new Map<string, { url: string; host: string }>();
  let repeated = 0;
  for (const given of input.urls) {
    const url = sharedAddress(given);
    const key = url ? linkKey(url) : null;
    if (!url || !key || url.length > 2100 || !isAddableLink(url)) {
      if (refused.length < REFUSED_SHOWN) refused.push({ url: (sharedAddress(given) ?? given.split(/[?#]/)[0] ?? '').slice(0, 300), reason: 'invalid_link' });
      continue;
    }
    if (unique.has(key)) {
      repeated += 1;
      continue;
    }
    unique.set(key, { url, host: new URL(url).hostname });
  }
  const now = deps.now();
  const at = now.toISOString();
  let readRecently = 0;
  if (RUN_ORIGINS.has(input.origin) && unique.size > 0) {
    const since = new Date(now.getTime() - constantsOf(deps).get('JOB_PAGE_RECHECK_DAYS') * DAY_MS).toISOString();
    const lately = await readLately(deps, input.sourceId ?? null, [...unique.keys()], since);
    for (const key of lately) if (unique.delete(key)) readRecently += 1;
  }
  const rows = [...unique.entries()];
  let queued = 0;
  for (let start = 0; start < rows.length; start += INSERT_CHUNK) {
    const chunk = rows.slice(start, start + INSERT_CHUNK);
    const inserted = await deps.db.all<{ id: number }>(
      `INSERT INTO job_link_queue(url, url_key, host, origin, batch_id, source_id, added_by, next_at, created_at)
       VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
       ON CONFLICT (url_key, (COALESCE(for_job_id, 0))) WHERE state <> 'done' DO NOTHING RETURNING id`,
      chunk.flatMap(([key, link]) => [link.url, key, link.host, input.origin, batchId, input.sourceId ?? null, input.addedBy, at, at]),
    );
    queued += inserted.length;
  }
  return { batchId, queued, alreadyQueued: rows.length - queued, repeated, refused, ...(readRecently > 0 ? { readRecently } : {}) };
}

/**
 * v31 LINK2: queues each job's link for a read made for that job (`legacy`, `recheck`), one open row per link and job;
 * a link that is no https address of a public host is left out. Answers how many were queued.
 */
export async function queueJobLinks(
  deps: Pick<AppDeps, 'db' | 'now'>,
  jobs: ReadonlyArray<{ jobId: number; url: string }>,
  origin: 'legacy' | 'recheck',
): Promise<number> {
  const at = deps.now().toISOString();
  const rows = jobs
    .map((job) => ({ jobId: job.jobId, url: sharedAddress(job.url) }))
    .filter((job): job is { jobId: number; url: string } => job.url !== null && job.url.length <= 2100 && isAddableLink(job.url))
    .map((job) => ({ ...job, key: linkKey(job.url)!, host: new URL(job.url).hostname }));
  let queued = 0;
  for (let start = 0; start < rows.length; start += INSERT_CHUNK) {
    const chunk = rows.slice(start, start + INSERT_CHUNK);
    const inserted = await deps.db.all<{ id: number }>(
      `INSERT INTO job_link_queue(url, url_key, host, origin, for_job_id, next_at, created_at)
       VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}
       ON CONFLICT (url_key, (COALESCE(for_job_id, 0))) WHERE state <> 'done' DO NOTHING RETURNING id`,
      chunk.flatMap((row) => [row.url, row.key, row.host, origin, row.jobId, at, at]),
    );
    queued += inserted.length;
  }
  return queued;
}

interface DueRow {
  id: number;
  url: string;
  host: string;
  origin: LinkQueueOrigin;
  attempts: number;
  /** v31 LINK2: the job a `legacy` or `recheck` read is for. */
  for_job_id: number | null;
}

/**
 * v31 FIX-LINK (BEH-6): the due links of one pass, the hosts taken in turn: the `hosts` hosts whose first due link comes
 * first (an admin's or an import's before a legacy or a weekly read, then the oldest), up to `perHost` links of each in
 * the same order. One statement, whatever one host's backlog (v31 LINK took the hosts from the 160 oldest rows alone).
 */
export const DUE_BY_HOST_SQL = `WITH due AS (
    SELECT id, host, next_at, CASE WHEN origin IN (${BACKGROUND_ORIGINS.map((origin) => `'${origin}'`).join(', ')}) THEN 1 ELSE 0 END AS later,
           row_number() OVER (PARTITION BY host ORDER BY CASE WHEN origin IN (${BACKGROUND_ORIGINS.map((origin) => `'${origin}'`).join(', ')}) THEN 1 ELSE 0 END, next_at, id) AS n
    FROM job_link_queue
    WHERE state <> 'done' AND next_at <= ? AND (state = 'queued' OR lease_until < ?)
  ), hosts AS (
    SELECT host FROM due WHERE n = 1 ORDER BY later, next_at, id LIMIT ?
  )
  SELECT d.id FROM due d JOIN hosts h ON h.host = d.host WHERE d.n <= ? ORDER BY d.later, d.next_at, d.id`;

/**
 * One pass of the queue: the due links (a lease that ran out counts as due), the hosts in turn (DUE_BY_HOST_SQL), at
 * most LINK_QUEUE_PER_PASS hosts, up to LINK_QUEUE_PER_HOST links of each; each claimed, read (addJobByLink, or LINK2's
 * legacy and recheck reads) and settled. Answers how many were read.
 */
export async function workLinkQueue(deps: AppDeps, max?: number): Promise<number> {
  // v31 RUNS' Pause all holds the worker's outside work (pause.ts).
  if (await outsideWorkPaused(deps)) return 0;
  const constants = constantsOf(deps);
  const hosts = max ?? constants.get('LINK_QUEUE_PER_PASS');
  const now = deps.now();
  const at = now.toISOString();
  const due = await deps.db.all<{ id: number }>(DUE_BY_HOST_SQL, [at, at, hosts, constants.get('LINK_QUEUE_PER_HOST')]);
  const ids = due.map((row) => Number(row.id));
  if (ids.length === 0) return 0;
  const lease = new Date(now.getTime() + LINK_QUEUE_LEASE_MS).toISOString();
  const claimed = await deps.db.all<DueRow>(
    `UPDATE job_link_queue SET state = 'working', lease_until = ?, attempts = attempts + 1
     WHERE id IN (SELECT CAST(value AS bigint) FROM ${deps.db.dialect.jsonEach('?')})
       AND state <> 'done' AND (state = 'queued' OR lease_until < ?)
     RETURNING id, url, host, origin, attempts, for_job_id`,
    [lease, JSON.stringify(ids), at],
  );
  // The hosts at once; one host's links one after the other, in the order taken.
  const order = new Map(ids.map((id, at) => [id, at]));
  const byHost = new Map<string, DueRow[]>();
  for (const row of [...claimed].sort((a, b) => (order.get(Number(a.id)) ?? 0) - (order.get(Number(b.id)) ?? 0))) {
    byHost.set(row.host, [...(byHost.get(row.host) ?? []), row]);
  }
  let read = 0;
  await Promise.all(
    [...byHost.values()].map(async (rows) => {
      for (const [index, row] of rows.entries()) {
        // BEH-9: Pause all stops the pass between two links; the links not reached go back as they were.
        if (await outsideWorkPaused(deps)) {
          await putBack(deps, rows.slice(index));
          return;
        }
        await settle(deps, row);
        read += 1;
      }
    }),
  );
  return read;
}

/** Claimed links a pass did not read (Pause all): queued again as they were, due now, the claim's attempt undone. */
async function putBack(deps: AppDeps, rows: readonly DueRow[]): Promise<void> {
  if (rows.length === 0) return;
  await deps.db.run(
    `UPDATE job_link_queue SET state = 'queued', lease_until = NULL, attempts = GREATEST(attempts - 1, 0)
     WHERE id IN (SELECT CAST(value AS bigint) FROM ${deps.db.dialect.jsonEach('?')}) AND state = 'working'`,
    [JSON.stringify(rows.map((row) => Number(row.id)))],
  );
}

/** The wait before a failed read is tried again (BEH-3): LINK_QUEUE_RETRY_MS, doubled at each try, at most a day. */
export function retryWaitMs(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>, attempts: number): number {
  const base = constantsOf(deps).get('LINK_QUEUE_RETRY_MS');
  return Math.min(LINK_QUEUE_RETRY_MAX_MS, base * 2 ** Math.max(0, Math.min(attempts - 1, 20)));
}

/** The tries a queued link gets (BEH-3): LINK_QUEUE_ATTEMPTS, a legacy job's LEGACY_ATTEMPTS_FACTOR times as many. */
export function attemptsOf(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>, origin: LinkQueueOrigin): number {
  const attempts = constantsOf(deps).get('LINK_QUEUE_ATTEMPTS');
  return origin === 'legacy' ? attempts * LEGACY_ATTEMPTS_FACTOR : attempts;
}

/** Reads one claimed link and writes its result (or puts it back for a later try). */
async function settle(deps: AppDeps, row: DueRow): Promise<void> {
  let state: JobAddState;
  let reason: JobVerifyReason | null;
  let jobId: number | null;
  const lastTry = row.attempts >= attemptsOf(deps, row.origin);
  try {
    if (row.origin === 'legacy' && row.for_job_id !== null) {
      // v31 LINK2: a job stored before v3.1 from what a row or a browser said (legacy.ts). v31 FIX-LINK (BEH-3): a
      // failure for now settles nothing until the last try.
      const outcome = await settleLegacyJob(deps, Number(row.for_job_id), row.url, { final: lastTry });
      state = outcome.state;
      reason = outcome.reason;
      jobId = outcome.jobId;
    } else if (row.origin === 'recheck' && row.for_job_id !== null) {
      // v31 LINK2: a job read from its page, read again (recheck.ts).
      const checked = await settleRecheck(deps, Number(row.for_job_id), row.url);
      state = checked === 'live' ? 'published' : checked === 'closed' ? 'refused' : 'private_unverified';
      reason = checked === 'closed' ? 'closed' : checked === 'unreadable' ? 'unavailable' : null;
      jobId = Number(row.for_job_id);
      // An unreadable page is read again at the next interval, not retried now (the check time moved).
      if (checked === 'unreadable') reason = null;
    } else {
      const outcome = await addJobByLink(deps, { url: row.url, userId: null, origin: row.origin as 'admin' | 'import' | 'sheets' | 'ft_lake' });
      state = outcome.state;
      reason = outcome.reason;
      jobId = outcome.jobId;
    }
  } catch (error) {
    // Never the error's own text (it can hold the link).
    deps.log.warn('[job-links] a queued link could not be read; tried again later', error instanceof Error ? error.name : 'unknown');
    state = 'refused';
    reason = 'unavailable';
    jobId = null;
  }
  const now = deps.now();
  // v31 LINK2: a legacy job's read waits while page reads are not set up here (legacy.ts): asked again a day later.
  if (row.origin === 'legacy' && reason === 'not_set_up') {
    await deps.db.run("UPDATE job_link_queue SET state = 'queued', lease_until = NULL, next_at = ?, reason = ?, attempts = 0 WHERE id = ?", [
      new Date(now.getTime() + LEGACY_WAIT_MS).toISOString(),
      reason,
      row.id,
    ]);
    return;
  }
  // BEH-3: a read that failed for now is tried again, a little later each time.
  if (reason !== null && TRANSIENT_REASONS.has(reason) && !lastTry) {
    await deps.db.run("UPDATE job_link_queue SET state = 'queued', lease_until = NULL, next_at = ?, reason = ? WHERE id = ?", [
      new Date(now.getTime() + retryWaitMs(deps, row.attempts)).toISOString(),
      reason,
      row.id,
    ]);
    return;
  }
  await deps.db.run(
    "UPDATE job_link_queue SET state = 'done', result = ?, reason = ?, job_id = ?, lease_until = NULL, done_at = ? WHERE id = ?",
    [state, reason, jobId, now.toISOString(), row.id],
  );
}

/** The worker hook: a pass every LINK_QUEUE_TICK_MS (read at start), never two at once. */
export function startLinkQueueWorker(deps: AppDeps): () => void {
  let running = false;
  const pass = async () => {
    if (running) return;
    running = true;
    try {
      const read = await workLinkQueue(deps);
      if (read > 0) deps.log.debug(`[job-links] ${read} queued link(s) read`);
    } catch (error) {
      deps.log.warn('[job-links] a pass of the link queue failed; the next one runs on time', error instanceof Error ? error.name : 'unknown');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void pass(), constantsOf(deps).get('LINK_QUEUE_TICK_MS'));
  timer.unref?.();
  return () => clearInterval(timer);
}

/** GET /api/admin/jobs/add/:batchId: a batch's progress (its first `limit` links, in the order queued); null when unknown. */
export async function batchProgress(deps: Pick<AppDeps, 'db'>, batchId: string, limit = 500): Promise<LinkBatchProgress | null> {
  const counts = await deps.db.all<{ state: string; result: string | null; n: number }>(
    'SELECT state, result, count(*)::int AS n FROM job_link_queue WHERE batch_id = ? GROUP BY state, result',
    [batchId],
  );
  if (counts.length === 0) return null;
  const items = await deps.db.all<{ url: string; state: 'queued' | 'working' | 'done'; result: JobAddState | null; reason: JobVerifyReason | null; job_id: number | null }>(
    'SELECT url, state, result, reason, job_id FROM job_link_queue WHERE batch_id = ? ORDER BY id LIMIT ?',
    [batchId, limit],
  );
  const tally: Record<string, number> = {};
  let total = 0;
  let done = 0;
  for (const row of counts) {
    const n = Number(row.n);
    total += n;
    if (row.state === 'done') done += n;
    const key = row.state === 'done' ? (row.result ?? 'refused') : row.state;
    tally[key] = (tally[key] ?? 0) + n;
  }
  return {
    batchId,
    total,
    done,
    counts: tally,
    items: items.map((row) => ({
      url: row.url,
      state: row.state,
      result: row.result,
      reason: row.state === 'done' ? row.reason : null,
      jobId: row.job_id === null ? null : Number(row.job_id),
    })),
  };
}

/** The daily step: done rows older than JOB_LINK_QUEUE_KEEP_DAYS leave the queue. */
export const linkQueuePruneStep: DailyStep = {
  name: 'link-queue-prune',
  async run(deps) {
    const before = new Date(deps.now().getTime() - constantsOf(deps).get('JOB_LINK_QUEUE_KEEP_DAYS') * DAY_MS).toISOString();
    const { changes } = await deps.db.run("DELETE FROM job_link_queue WHERE state = 'done' AND done_at < ?", [before]);
    return changes;
  },
};
