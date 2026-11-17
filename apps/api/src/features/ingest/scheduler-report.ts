import { JOB_SOURCE_KINDS, DAY_MS, type JobSourceKind, type SourcingAlarm, type SourcingDailyReport } from '@tailorit/shared';
import type { DbQueries } from '../../core/db/types';
import { SCHEDULED_KINDS } from './types';

// v30 S1-API: the sourcing daily report (12-job-sourcing.md §9.8; CT's SourcingDailyReportSchema), read from the day's
// runs (job_source_runs, idx_job_source_runs_age), the sources' open jobs and the candidates, on demand (Admin › Sources'
// report; nothing is stored). The alarms:
//   - host_failing: a host failed more than HOST_FAILING_SHARE of its runs that day (at least HOST_FAILING_MIN_RUNS);
//   - kind_dropped: a kind's open jobs fell by more than KIND_DROP_SHARE that day (a broken adapter);
//   - kind_quiet: a kind with enabled sources made no new job for KIND_QUIET_DAYS. v30 INT-4: only a kind the worker
//     may run now (the router passes scheduler.ts runnableKinds): a feed waiting for its key, a new kind waiting for
//     BOT_USER_AGENT, career sites waiting for their switch are off on purpose, not quiet (S4's and S5's open items).
// A host's failures are counted by runs: a run is one source's read of its host, and a failed run is one whose reads
// failed (job_source_runs keeps a run's requests, not each request's outcome).

export const HOST_FAILING_SHARE = 0.2;
export const HOST_FAILING_MIN_RUNS = 5;
export const KIND_DROP_SHARE = 0.2;
export const KIND_QUIET_DAYS = 2;

interface KindRow {
  kind: JobSourceKind;
  runs: number;
  not_modified: number;
  created: number;
  updated: number;
  closed: number;
  reopened: number;
}

/** The report of one UTC day ("YYYY-MM-DD"); `runnable`: the kinds the worker may run now (default: every scheduled kind). */
export async function sourcingDailyReport(db: DbQueries, day: string, runnable: readonly string[] = SCHEDULED_KINDS): Promise<SourcingDailyReport> {
  const from = new Date(`${day}T00:00:00.000Z`).toISOString();
  const to = new Date(Date.parse(from) + DAY_MS).toISOString();
  const quietFrom = new Date(Date.parse(to) - KIND_QUIET_DAYS * DAY_MS).toISOString();
  const range = { from, to };
  const totals = await db.one<{ runs: number; not_modified: number; failed: number }>(
    `SELECT count(*) AS runs, count(*) FILTER (WHERE status = 'not_modified') AS not_modified,
       count(*) FILTER (WHERE status = 'failed') AS failed
     FROM job_source_runs WHERE started_at >= CAST(@from AS timestamptz) AND started_at < CAST(@to AS timestamptz)`,
    range,
  );
  const kinds = await db.all<KindRow>(
    `SELECT s.kind, count(*) AS runs, count(*) FILTER (WHERE r.status = 'not_modified') AS not_modified,
       coalesce(sum(r.created), 0) AS created, coalesce(sum(r.updated), 0) AS updated,
       coalesce(sum(r.deactivated), 0) AS closed, coalesce(sum(r.reopened), 0) AS reopened
     FROM job_source_runs r JOIN job_sources s ON s.id = r.source_id
     WHERE r.started_at >= CAST(@from AS timestamptz) AND r.started_at < CAST(@to AS timestamptz)
     GROUP BY s.kind`,
    range,
  );
  const open = new Map(
    (await db.all<{ kind: JobSourceKind; open: number }>('SELECT kind, coalesce(sum(open_jobs), 0) AS open FROM job_sources GROUP BY kind')).map(
      (row) => [row.kind, row.open],
    ),
  );
  const byKind: SourcingDailyReport['byKind'] = kinds
    .filter((row) => (JOB_SOURCE_KINDS as readonly string[]).includes(row.kind))
    .map((row) => ({
      kind: row.kind,
      runs: row.runs,
      notModified: row.not_modified,
      created: row.created,
      updated: row.updated,
      closed: row.closed,
      reopened: row.reopened,
      openJobs: open.get(row.kind) ?? 0,
      openJobsChange: row.created + row.reopened - row.closed,
    }))
    .sort((a, b) => a.kind.localeCompare(b.kind));
  const hosts = await db.all<{ host: string; runs: number; requests: number; failures: number }>(
    `SELECT s.host, count(*) AS runs, coalesce(sum(r.requests), 0) AS requests, count(*) FILTER (WHERE r.status = 'failed') AS failures
     FROM job_source_runs r JOIN job_sources s ON s.id = r.source_id
     WHERE s.host IS NOT NULL AND r.started_at >= CAST(@from AS timestamptz) AND r.started_at < CAST(@to AS timestamptz)
     GROUP BY s.host`,
    range,
  );
  const candidates = await db.one<{ found: number; validated: number }>(
    `SELECT count(*) FILTER (WHERE first_seen_at >= CAST(@from AS timestamptz) AND first_seen_at < CAST(@to AS timestamptz)) AS found,
       count(*) FILTER (WHERE status IN ('valid', 'empty') AND checked_at >= CAST(@from AS timestamptz) AND checked_at < CAST(@to AS timestamptz)) AS validated
     FROM job_source_candidates`,
    range,
  );
  const quiet = await db.all<{ kind: JobSourceKind }>(
    `SELECT s.kind FROM job_sources s WHERE s.enabled AND s.kind = ANY(string_to_array(@scheduled, ',')) GROUP BY s.kind
     HAVING NOT EXISTS (SELECT 1 FROM job_source_runs r JOIN job_sources x ON x.id = r.source_id
       WHERE x.kind = s.kind AND r.created > 0 AND r.started_at >= CAST(@quietFrom AS timestamptz) AND r.started_at < CAST(@to AS timestamptz))`,
    { ...range, quietFrom, scheduled: SCHEDULED_KINDS.filter((kind) => runnable.includes(kind)).join(',') },
  );
  const alarms: SourcingAlarm[] = [];
  for (const host of hosts) {
    if (host.runs >= HOST_FAILING_MIN_RUNS && host.failures / host.runs > HOST_FAILING_SHARE) {
      alarms.push({ kind: 'host_failing', host: host.host, failureShare: Math.round((host.failures / host.runs) * 1000) / 1000 });
    }
  }
  for (const row of byKind) {
    const before = row.openJobs - row.openJobsChange;
    if (before > 0 && row.openJobsChange < 0 && -row.openJobsChange / before > KIND_DROP_SHARE) {
      alarms.push({ kind: 'kind_dropped', sourceKind: row.kind, dropShare: Math.round((-row.openJobsChange / before) * 1000) / 1000 });
    }
  }
  for (const row of quiet) {
    if ((JOB_SOURCE_KINDS as readonly string[]).includes(row.kind)) alarms.push({ kind: 'kind_quiet', sourceKind: row.kind, days: KIND_QUIET_DAYS });
  }
  return {
    day,
    runs: totals?.runs ?? 0,
    notModifiedRuns: totals?.not_modified ?? 0,
    failedRuns: totals?.failed ?? 0,
    byKind,
    hosts: hosts
      .filter((host) => host.failures > 0)
      .sort((a, b) => b.failures - a.failures || a.host.localeCompare(b.host))
      .map((host) => ({ host: host.host, requests: host.requests, failures: host.failures })),
    candidates: { found: candidates?.found ?? 0, validated: candidates?.validated ?? 0 },
    alarms,
  };
}
