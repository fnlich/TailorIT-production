import type { AppDeps } from '../../../context';
import { constantsOf } from '../../../constants/service';
import {
  AI_TASK_PAYLOADS,
  covered,
  dayOf,
  dayRange,
  dropExpiredPartitions,
  dropLeftovers,
  ensurePartitions,
  finalizePendingDetaches,
  JOB_POSTINGS_RAW,
  listPartitions,
  newestJobId,
  idRange,
  JOB_TEXT_PARTITION_IDS,
  JOB_TEXTS,
  wantedRanges,
  type PartitionReport,
  type Range,
} from './partitions';
import { DAY_MS } from '@tailorit/shared';

// v30 D5L (11-database.md §8.1): the partitions' daily step and the start-up check.

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

const emptyReport = (): PartitionReport => ({ made: [], dropped: [], problems: [] });

/** A queued or running AI task was made in this payload range: the range is kept (11 §8.2). */
async function holdsLiveTask(deps: Deps, range: Range): Promise<boolean> {
  const row = await deps.db.one(
    "SELECT 1 AS found FROM ai_tasks WHERE status IN ('queued', 'running') AND created_at >= ? AND created_at < ? LIMIT 1",
    [new Date(range.from).toISOString(), new Date(range.to).toISOString()],
  );
  return row !== undefined;
}

/**
 * One pass (the daily step, and `db:partitions`): expired days dropped (JOB_RAW_KEEP_DAYS, AI_TASK_PAYLOAD_KEEP_DAYS;
 * a payload day holding a live task is kept), half-done detaches finished, then today and two periods ahead made.
 * A day is dropped once all of it is older than its keep: with a keep of 3, on the 22nd the 18th goes.
 */
export async function housekeepPartitions(deps: Deps): Promise<PartitionReport> {
  const report = emptyReport();
  const now = deps.now();
  const today = dayRange(dayOf(now)).from;
  const constants = constantsOf(deps);
  const rawCutoff = today - constants.get('JOB_RAW_KEEP_DAYS') * DAY_MS;
  const payloadCutoff = today - constants.get('AI_TASK_PAYLOAD_KEEP_DAYS') * DAY_MS;
  await dropExpiredPartitions(deps.db, JOB_POSTINGS_RAW, rawCutoff, report);
  await dropExpiredPartitions(deps.db, AI_TASK_PAYLOADS, payloadCutoff, report, (range) => holdsLiveTask(deps, range));
  await finalizePendingDetaches(deps.db, report);
  await dropLeftovers(deps.db, JOB_POSTINGS_RAW, rawCutoff, report);
  await dropLeftovers(deps.db, AI_TASK_PAYLOADS, payloadCutoff, report);
  await ensurePartitions(deps.db, await wantedRanges((sql) => deps.db.all(sql), now), report);
  return report;
}

/** The daily step's log line and count (partitions made and dropped). */
export async function partitionsDailyStep(deps: Deps): Promise<number> {
  const report = await housekeepPartitions(deps);
  logReport(deps, report);
  return report.made.length + report.dropped.length;
}

function logReport(deps: Deps, report: PartitionReport): void {
  if (report.made.length) deps.log.info(`[db] partitions made: ${report.made.join(', ')}`);
  if (report.dropped.length) deps.log.info(`[db] partitions dropped: ${report.dropped.join(', ')}`);
  for (const problem of report.problems) deps.log.warn(`[db] partitions: ${problem}`);
}

/**
 * The start-up check (before any route or worker runs): half-done detaches finished, today and two periods ahead made
 * for every partitioned table (a server that was off for days comes back with its days), then today's partitions and
 * the newest job's text partition must exist. Throws when they do not: every AI request and every new job text would
 * fail. Logs what it made.
 */
export async function checkPartitionsAtStartup(deps: Deps): Promise<PartitionReport> {
  const report = emptyReport();
  const run = (sql: string) => deps.db.all(sql);
  const now = deps.now();
  await finalizePendingDetaches(deps.db, report);
  await ensurePartitions(deps.db, await wantedRanges(run, now), report);
  logReport(deps, report);
  // Every wanted range is there unless a problem was reported: then the two that must be are read again.
  if (report.problems.length === 0) return report;
  const today = dayRange(dayOf(now));
  // The next job id's partition (the next job's text goes there).
  const newest = await newestJobId(run);
  const textRange = idRange(Math.floor(newest / JOB_TEXT_PARTITION_IDS));
  const missing: string[] = [];
  for (const spec of [JOB_POSTINGS_RAW, AI_TASK_PAYLOADS]) {
    if (!covered(await listPartitions(run, spec), today)) missing.push(`${spec.table} has no partition for ${dayOf(now)}`);
  }
  if (!covered(await listPartitions(run, JOB_TEXTS), textRange)) missing.push(`job_texts has no partition for job id ${newest + 1}`);
  if (missing.length) {
    throw new Error(
      `The database's partitions are not ready: ${missing.join('; ')}. ${report.problems.join('; ')} ` +
        'See DEPLOY.md, "Partitions".',
    );
  }
  return report;
}
