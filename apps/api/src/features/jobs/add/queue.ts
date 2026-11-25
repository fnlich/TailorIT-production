import { randomUUID } from 'node:crypto';
import {
  DAY_MS,
  HOUR_MS,
  JOB_VERIFY_REASONS,
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
import { settleLegacyJob } from './legacy';
import { TRY_LATER_REASONS } from './verdict'; // v37 CLOSED (C1): the verdict's try-later reasons (legacy.ts's set)
import { outsideWorkPaused } from './pause';
import { settleRecheckRead } from './recheck'; // v37 CLOSED (C1): the re-check's verdict
import { addJobByLink, isAddableLink } from './pipeline';
import { settleImportLink } from './import-pipeline'; // v35 IMPORT
import { recordQueueOutcome, repairImportRows, type QueueOutcome } from './import-store'; // v35 IMPORT; v35 FIX-STORE: repairImportRows
import type { DbQueries } from '../../../core/db/types'; // v35 FIX-STORE
import { laneKeyOf, laneSql, registeredLanes } from '../../ingest/hosts'; // v37 LANE (W8): Workday links on the one Workday lane; v37 INT-A laneSql; v37 FIX-LANE the lanes

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
// v37 CLOSED (SP v37 PLAN.md C3, "try later never becomes Review"):
//   - a read made while its site (or every Workday site: the LANE package's lane) paused TailorIT is read again when the
//     pause ends, its try given back (no attempt used while the site is paused);
//   - an import's link (an admin's add, a file, a sheet, a paste, a person's import) that failed for now is read again
//     with the growing wait for LINK_QUEUE_RETRY_HOURS from its queueing, the last read at that hour (LINK_QUEUE_ATTEMPTS
//     no longer bounds it); only then does its row go to Review (or Needs a title and company). The other origins (the
//     lake, the legacy pass, the re-checks) keep LINK_QUEUE_ATTEMPTS;
//   - a queued read waits up to LINK_QUEUE_READ_TIMEOUT_MS for its turn (import-pipeline.ts), a person's Add job 15 s.

/**
 * Where a queued link came from (job_link_queue.origin). v31 LINK2: `legacy` (a job stored before v3.1 from what a row
 * or a browser said, read now: legacy.ts) and `recheck` (a job read from its page, read again: recheck.ts), each for
 * one job (for_job_id).
 */
export type LinkQueueOrigin = 'admin' | 'import' | 'sheets' | 'ft_lake' | 'legacy' | 'recheck';

/** How long a claimed link is the pass's before another pass may take it again (at least; see linkQueueLeaseMs). */
export const LINK_QUEUE_LEASE_MS = 10 * MINUTE_MS;
/** v37 FIX-LANE (the ux review's M6): the room a claim keeps past its links' own read budgets. */
export const LINK_QUEUE_LEASE_MARGIN_MS = MINUTE_MS;

/**
 * v37 FIX-LANE (M6): how long a pass's claim lasts: its lane's links are read one after the other, each allowed
 * LINK_QUEUE_READ_TIMEOUT_MS (its wait for the site's turn included), so the claim outlasts LINK_QUEUE_PER_HOST of them
 * plus a margin, and never less than LINK_QUEUE_LEASE_MS: no later pass takes a link still being read, whatever an
 * admin sets either constant to.
 */
export function linkQueueLeaseMs(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>): number {
  const constants = constantsOf(deps);
  return Math.max(
    LINK_QUEUE_LEASE_MS,
    constants.get('LINK_QUEUE_PER_HOST') * constants.get('LINK_QUEUE_READ_TIMEOUT_MS') + LINK_QUEUE_LEASE_MARGIN_MS,
  );
}

/**
 * v37 FIX-LANE (SP v37 FIXES-361 F3): which lanes a pass reads. The worker runs a pass per registered lane
 * (ingest/hosts.ts registeredLanes: the Workday lane's, one request at a time to all of Workday, its pace adapting to
 * Workday's 429s: it can be slow) and one of every other host, side by side, so a slow lane never holds up the links of
 * the other boards. A lane's pass is named by its key (`workday.lane`); `all` (one pass of every lane) is a single
 * call's (tests, a one-off).
 */
export type LinkQueueLanes = 'all' | 'others' | (string & {});
/** v31 LINK2: how long a legacy job's read waits while page reads are not set up here. */
export const LEGACY_WAIT_MS = DAY_MS;
/** v31 FIX-LINK (BEH-3): a legacy job's read is tried this many times LINK_QUEUE_ATTEMPTS (days, with the growing wait). */
export const LEGACY_ATTEMPTS_FACTOR = 3;
/** v31 FIX-LINK (BEH-3): the longest wait before a failed read is tried again. */
export const LINK_QUEUE_RETRY_MAX_MS = DAY_MS;
/** The origins whose rows wait behind an admin's and an import's (BEH-6: the legacy pass's and the weekly reads). */
const BACKGROUND_ORIGINS = ['legacy', 'recheck'] as const;
/**
 * v31 FIX-LINK (BEH-5): the origins of an import's run, which queue only a link with no read lately. v35 IMPORT (H5): the
 * free_tailor lake's only: an admin's file or sheet import queues every row (import-store.ts), so a known job is reposted.
 */
const RUN_ORIGINS: ReadonlySet<LinkQueueOrigin> = new Set(['ft_lake']);
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
       ON CONFLICT (url_key, (COALESCE(for_job_id, 0)), (COALESCE(user_id, ''))) WHERE state <> 'done' DO NOTHING RETURNING id`,
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
       ON CONFLICT (url_key, (COALESCE(for_job_id, 0)), (COALESCE(user_id, ''))) WHERE state <> 'done' DO NOTHING RETURNING id`,
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
  /** v37 CLOSED (C3): when the link was queued (an import's tries run for LINK_QUEUE_RETRY_HOURS from it). */
  created_at: string | Date;
  /** v31 LINK2: the job a `legacy` or `recheck` read is for. */
  for_job_id: number | null;
  // v35 IMPORT (migration 0057): an import's row: its fields, the person's profile and grant, who queued it, its import.
  details: unknown;
  user_id: string | null;
  grant_id: string | null;
  added_by: string | null;
  source_id: number | null;
  import_id: number | null;
}

/**
 * v31 FIX-LINK (BEH-6): the due links of one pass, the hosts taken in turn: the `hosts` hosts whose first due link comes
 * first (an admin's or an import's before a legacy or a weekly read, then the oldest), up to `perHost` links of each in
 * the same order. One statement, whatever one host's backlog (v31 LINK took the hosts from the 160 oldest rows alone).
 * v37 INT-A (LANE's W8 with CLOSED's lease note): a host is its lane (ingest/hosts.ts laneSql: every Workday host is the
 * one Workday lane), so a pass takes at most `perHost` Workday links whatever the tenants, read one after the other:
 * LINK_QUEUE_PER_HOST x LINK_QUEUE_READ_TIMEOUT_MS stays within the claim's lease (v37 FIX-LANE: linkQueueLeaseMs).
 */
export const dueByHostSql = () => `WITH due AS (
    SELECT id, ${laneSql('host')} AS lane, next_at, CASE WHEN origin IN (${BACKGROUND_ORIGINS.map((origin) => `'${origin}'`).join(', ')}) THEN 1 ELSE 0 END AS later,
           row_number() OVER (PARTITION BY ${laneSql('host')} ORDER BY CASE WHEN origin IN (${BACKGROUND_ORIGINS.map((origin) => `'${origin}'`).join(', ')}) THEN 1 ELSE 0 END, next_at, id) AS n
    FROM job_link_queue
    WHERE state <> 'done' AND next_at <= ? AND (state = 'queued' OR lease_until < ?)
      AND (CAST(? AS text) = 'all' OR (CAST(? AS text) = 'others' AND ${laneSql('host')} = host)
        OR (${laneSql('host')} <> host AND ${laneSql('host')} = CAST(? AS text))) -- v37 FIX-LANE (F3): a lane's pass, or the others'
  ), lanes AS (
    SELECT lane FROM due WHERE n = 1 ORDER BY later, next_at, id LIMIT ?
  )
  SELECT d.id FROM due d JOIN lanes l ON l.lane = d.lane WHERE d.n <= ? ORDER BY d.later, d.next_at, d.id`;

/**
 * One pass of the queue: the due links (a lease that ran out counts as due), the hosts in turn (dueByHostSql), at
 * most LINK_QUEUE_PER_PASS hosts, up to LINK_QUEUE_PER_HOST links of each; each claimed, read (addJobByLink, or LINK2's
 * legacy and recheck reads) and settled. Answers how many were read.
 */
export async function workLinkQueue(deps: AppDeps, max?: number, options: { lanes?: LinkQueueLanes } = {}): Promise<number> {
  // v31 RUNS' Pause all holds the worker's outside work (pause.ts).
  if (await outsideWorkPaused(deps)) return 0;
  await repairNow(deps); // v35 FIX-STORE (D2, D3)
  const constants = constantsOf(deps);
  const hosts = max ?? constants.get('LINK_QUEUE_PER_PASS');
  const now = deps.now();
  const at = now.toISOString();
  const lanes = options.lanes ?? 'all'; // v37 FIX-LANE (F3)
  const due = await deps.db.all<{ id: number }>(dueByHostSql(), [at, at, lanes, lanes, lanes, hosts, constants.get('LINK_QUEUE_PER_HOST')]);
  const ids = due.map((row) => Number(row.id));
  if (ids.length === 0) return 0;
  const lease = new Date(now.getTime() + linkQueueLeaseMs(deps)).toISOString(); // v37 FIX-LANE (M6)
  const claimed = await deps.db.all<DueRow>(
    `UPDATE job_link_queue SET state = 'working', lease_until = ?, attempts = attempts + 1
     WHERE id IN (SELECT CAST(value AS bigint) FROM ${deps.db.dialect.jsonEach('?')})
       AND state <> 'done' AND (state = 'queued' OR lease_until < ?)
     RETURNING id, url, host, origin, attempts, created_at, for_job_id, details, user_id, grant_id, added_by, source_id, import_id`,
    [lease, JSON.stringify(ids), at],
  );
  // The hosts at once; one host's links one after the other, in the order taken. v37 LANE (SP v37 PLAN W8): every
  // Workday host's links on the one Workday lane (ingest/hosts.ts laneKeyOf), one after the other.
  const order = new Map(ids.map((id, at) => [id, at]));
  const byHost = new Map<string, DueRow[]>();
  for (const row of [...claimed].sort((a, b) => (order.get(Number(a.id)) ?? 0) - (order.get(Number(b.id)) ?? 0))) {
    const lane = laneKeyOf(row.host); // v37 LANE
    byHost.set(lane, [...(byHost.get(lane) ?? []), row]);
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

/**
 * v37 CLOSED (C3): the end of an import's link's tries: LINK_QUEUE_RETRY_HOURS after it was queued (ms since the epoch),
 * or null for the other origins (their tries are counted: attemptsOf).
 */
export function retryWindowEnd(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>, row: Pick<DueRow, 'origin' | 'created_at'>): number | null {
  if (!isImportOrigin(row.origin)) return null;
  const queued = new Date(row.created_at).getTime();
  return Number.isFinite(queued) ? queued + constantsOf(deps).get('LINK_QUEUE_RETRY_HOURS') * HOUR_MS : null;
}

/** The tries a queued link gets (BEH-3): LINK_QUEUE_ATTEMPTS, a legacy job's LEGACY_ATTEMPTS_FACTOR times as many. */
export function attemptsOf(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>, origin: LinkQueueOrigin): number {
  const attempts = constantsOf(deps).get('LINK_QUEUE_ATTEMPTS');
  return origin === 'legacy' ? attempts * LEGACY_ATTEMPTS_FACTOR : attempts;
}

/**
 * v35 FIX-STORE (the final review's D2): a lake's link as it is now: an admin's import may have taken it over since the
 * pass claimed it (import-store.ts queueRows: the import's origin, source, fields and who queued it), so it is read as
 * the import's. Any other row as claimed.
 */
async function currentOf(deps: AppDeps, row: DueRow): Promise<DueRow> {
  if (row.origin !== 'ft_lake') return row;
  const now = await deps.db.one<Pick<DueRow, 'origin' | 'details' | 'source_id' | 'added_by' | 'import_id'>>(
    'SELECT origin, details, source_id, added_by, import_id FROM job_link_queue WHERE id = ?',
    [row.id],
  );
  return now && now.origin !== row.origin ? { ...row, ...now } : row;
}

/** Reads one claimed link and writes its result (or puts it back for a later try). */
async function settle(deps: AppDeps, claimed: DueRow): Promise<void> {
  const row = await currentOf(deps, claimed); // v35 FIX-STORE (D2)
  let state: JobAddState;
  let reason: JobVerifyReason | null;
  let jobId: number | null;
  let imported: QueueOutcome | null = null; // v35 IMPORT
  // v37 CLOSED (C3): an import's link is read again until its window ends; the end of a site's pause (`until`).
  const windowEnd = retryWindowEnd(deps, row);
  const lastTry = windowEnd !== null ? deps.now().getTime() >= windowEnd : row.attempts >= attemptsOf(deps, row.origin);
  let until: string | null = null;
  try {
    if (row.origin === 'legacy' && row.for_job_id !== null) {
      // v31 LINK2: a job stored before v3.1 from what a row or a browser said (legacy.ts). v31 FIX-LINK (BEH-3): a
      // failure for now settles nothing until the last try.
      const outcome = await settleLegacyJob(deps, Number(row.for_job_id), row.url, { final: lastTry });
      state = outcome.state;
      reason = outcome.reason;
      jobId = outcome.jobId;
      until = outcome.until ?? null; // v37 INT-A: a paused read's try given back (as the other origins')
    } else if (row.origin === 'recheck' && row.for_job_id !== null) {
      // v31 LINK2: a job read from its page, read again (recheck.ts).
      const checked = await settleRecheckRead(deps, Number(row.for_job_id), row.url);
      state = checked.state === 'live' ? 'published' : checked.state === 'closed' ? 'refused' : 'private_unverified';
      reason = checked.state === 'closed' ? 'closed' : null;
      jobId = Number(row.for_job_id);
      // An unreadable page is read again at the next interval, not retried now (the check time moved). v37 CLOSED (C1):
      // a read that failed for now (try later) is read again soon, after the site's pause when it paused TailorIT.
      if (checked.state === 'later') {
        reason = 'unavailable';
        until = checked.until ?? null;
      }
    } else if (row.origin === 'ft_lake') {
      const outcome = await addJobByLink(deps, { url: row.url, userId: null, origin: 'ft_lake', timeoutMs: constantsOf(deps).get('LINK_QUEUE_READ_TIMEOUT_MS') });
      state = outcome.state;
      reason = outcome.reason;
      jobId = outcome.jobId;
      until = outcome.pause?.until ?? null; // v37 CLOSED (C3)
    } else {
      // v35 IMPORT (SP v35 PLAN.md H2, H5): an admin's links and every import's rows (import-pipeline.ts): the row's
      // fields and profile decide what an unreadable link and a job TailorIT has come to; each import row waiting on this
      // link gets its result (import-store.ts recordQueueOutcome). The queue row keeps v3.1's state for the old view.
      const settled = await settleImportLink(deps, row, lastTry);
      if (settled.retry) {
        state = 'private_unverified';
        reason = settled.reason;
        jobId = null;
        until = settled.until ?? null; // v37 CLOSED (C3)
      } else {
        imported = settled;
        state = legacyStateOf(settled);
        // A result reached is final: never tried again for a reason it carries (an unreadable link vouched for).
        reason =
          settled.reason !== null && isVerifyReason(settled.reason) && !TRY_LATER_REASONS.has(settled.reason as JobVerifyReason)
            ? (settled.reason as JobVerifyReason)
            : null;
        jobId = settled.jobId;
      }
    }
  } catch (error) {
    // Never the error's own text (it can hold the link).
    deps.log.warn('[job-links] a queued link could not be read; tried again later', error instanceof Error ? error.name : 'unknown');
    state = 'refused';
    reason = 'unavailable';
    jobId = null;
    if (lastTry && isImportOrigin(row.origin)) imported = { result: 'failed', reason: 'unavailable', jobId: null };
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
  // BEH-3: a read that failed for now is tried again, a little later each time. v37 CLOSED (C3): after a site's pause
  // with its try given back; an import's link at most at the end of its window (its last read).
  if (reason !== null && TRY_LATER_REASONS.has(reason) && !lastTry) {
    const paused = until !== null && Date.parse(until) > now.getTime();
    let next = paused ? Date.parse(until!) : now.getTime() + retryWaitMs(deps, row.attempts);
    if (!paused && windowEnd !== null) next = Math.min(next, Math.max(windowEnd, now.getTime()));
    await deps.db.run(
      `UPDATE job_link_queue SET state = 'queued', lease_until = NULL, next_at = ?, reason = ?,
         attempts = CASE WHEN ? THEN GREATEST(attempts - 1, 0) ELSE attempts END WHERE id = ?`,
      [new Date(next).toISOString(), reason, paused, row.id],
    );
    return;
  }
  const markDone = (t: DbQueries) =>
    t.run("UPDATE job_link_queue SET state = 'done', result = ?, reason = ?, job_id = ?, lease_until = NULL, done_at = ? WHERE id = ?", [
      state,
      reason,
      jobId,
      now.toISOString(),
      row.id,
    ]);
  // v35 IMPORT: each import row waiting on this link gets its result. v35 FIX-STORE (the final review's D3): in the
  // queue row's own transaction (import-store.ts recordQueueOutcome).
  if (imported) await recordQueueOutcome(deps, Number(row.id), imported, markDone);
  else await markDone(deps.db);
}

/** v35 FIX-STORE (D3): the repair of import rows left waiting runs at most this often (each process). */
export const IMPORT_REPAIR_EVERY_MS = MINUTE_MS;
/** The last repair of each app (deps), by its clock. */
const REPAIRED_AT = new WeakMap<object, number>();

/**
 * v35 FIX-STORE (the final review's D2, D3): the queue pass's repair (import-store.ts repairImportRows), at most once
 * every IMPORT_REPAIR_EVERY_MS; a failure is logged, never the pass's.
 */
async function repairNow(deps: AppDeps): Promise<void> {
  const now = deps.now().getTime();
  const last = REPAIRED_AT.get(deps);
  if (last !== undefined && now >= last && now - last < IMPORT_REPAIR_EVERY_MS) return;
  REPAIRED_AT.set(deps, now);
  try {
    await repairImportRows(deps);
  } catch (error) {
    deps.log.warn('[job-links] the repair of import rows failed; the next pass tries again', error instanceof Error ? error.name : 'unknown');
  }
}

/** v35 IMPORT: the origins whose rows an import (or an admin's add) queued. */
function isImportOrigin(origin: LinkQueueOrigin): boolean {
  return origin === 'admin' || origin === 'import' || origin === 'sheets';
}

/** v35 IMPORT: whether a row's reason is one of the read's (JOB_VERIFY_REASONS), kept on the queue row. */
function isVerifyReason(reason: string): boolean {
  return (JOB_VERIFY_REASONS as readonly string[]).includes(reason);
}

/** v35 IMPORT: an import row's result as v3.1's queue states (the old progress view's words). */
function legacyStateOf(outcome: QueueOutcome): JobAddState {
  switch (outcome.result) {
    case 'added':
    case 'reposted':
    case 'known':
      return outcome.held || outcome.reason === 'waiting_review' ? 'waiting_admin' : 'published';
    case 'review':
      return 'waiting_admin';
    case 'added_private':
      return 'private_unverified';
    default:
      // needs_details, closed, failed: nothing was added (v3.1's refused, with its reason).
      return 'refused';
  }
}

/**
 * The worker hook: a pass every LINK_QUEUE_TICK_MS (read at start), never two at once. v37 FIX-LANE (F3): a pass per
 * lane and one of every other host (LinkQueueLanes), each never two at once, so none waits for another.
 */
export function startLinkQueueWorker(deps: AppDeps): () => void {
  const passOf = (lanes: LinkQueueLanes) => {
    let running = false;
    return async () => {
      if (running) return;
      running = true;
      try {
        const read = await workLinkQueue(deps, undefined, { lanes });
        if (read > 0) deps.log.debug(`[job-links] ${read} queued link(s) read`);
      } catch (error) {
        deps.log.warn('[job-links] a pass of the link queue failed; the next one runs on time', error instanceof Error ? error.name : 'unknown');
      } finally {
        running = false;
      }
    };
  };
  const passes = [...registeredLanes().map((lane) => passOf(lane.key)), passOf('others')];
  const timer = setInterval(() => {
    for (const pass of passes) void pass();
  }, constantsOf(deps).get('LINK_QUEUE_TICK_MS'));
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
