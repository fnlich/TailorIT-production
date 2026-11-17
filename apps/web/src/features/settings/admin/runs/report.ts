import { JOB_SOURCE_KIND_LABEL, type SourcingAlarm, type SourcingDailyReport } from '@tailorit/shared/sourcing';
import { DAY_MS } from '@tailorit/shared';

// v30 S1-WEB: the daily report's words (12 §9.8: runs, the 304 share, new, changed and closed jobs by kind, failures by
// host, candidates found and validated, open jobs by kind; and its alarms). The thresholds are S1-API's: the report
// names what crossed them. Pure.

/** "23%" (a share from 0 to 1; whole percents, "<1%" for a share above 0 that rounds to 0). */
export function percentText(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return '0%';
  const whole = Math.round(share * 100);
  return whole === 0 ? '<1%' : `${Math.min(100, whole)}%`;
}

/** The share of `part` in `whole` (0 when there is no whole). */
export function shareOf(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

/** The day's jobs over every kind: new, changed, closed, reopened, and open at the day's end with the change. */
export function reportTotals(report: SourcingDailyReport) {
  const sum = (pick: (row: SourcingDailyReport['byKind'][number]) => number) => report.byKind.reduce((total, row) => total + pick(row), 0);
  return {
    created: sum((row) => row.created),
    updated: sum((row) => row.updated),
    closed: sum((row) => row.closed),
    reopened: sum((row) => row.reopened),
    openJobs: sum((row) => row.openJobs),
    openJobsChange: sum((row) => row.openJobsChange),
    notModifiedShare: shareOf(report.notModifiedRuns, report.runs),
  };
}

/** "+1,204", "−320", "0": a change in open jobs. */
export function changeText(change: number): string {
  if (change === 0) return '0';
  const magnitude = Math.abs(change).toLocaleString('en-US');
  return change > 0 ? `+${magnitude}` : `−${magnitude}`;
}

/** An alarm in a sentence. */
export function alarmText(alarm: SourcingAlarm): string {
  switch (alarm.kind) {
    case 'host_failing':
      return `${alarm.host} failed ${percentText(alarm.failureShare)} of its requests.`;
    case 'kind_dropped':
      return `${JOB_SOURCE_KIND_LABEL[alarm.sourceKind]}: open jobs fell by ${percentText(alarm.dropShare)} in a day. Its adapter may be broken.`;
    case 'kind_quiet':
      return `${JOB_SOURCE_KIND_LABEL[alarm.sourceKind]}: no new jobs for ${alarm.days} ${alarm.days === 1 ? 'day' : 'days'}.`;
  }
}

/** "1 alarm", "3 alarms". */
export function alarmCount(count: number): string {
  return `${count} ${count === 1 ? 'alarm' : 'alarms'}`;
}

/** The hosts with failures, most failures first, with each one's share of failed requests. */
export function failingHosts(report: SourcingDailyReport) {
  return [...report.hosts]
    .sort((a, b) => b.failures - a.failures || a.host.localeCompare(b.host))
    .map((row) => ({ ...row, share: shareOf(row.failures, row.requests) }));
}

/** The kinds that ran or hold open jobs, busiest first (a kind with nothing that day is left out). */
export function activeKinds(report: SourcingDailyReport) {
  return report.byKind
    .filter((row) => row.runs > 0 || row.openJobs > 0 || row.created > 0 || row.closed > 0)
    .sort((a, b) => b.runs - a.runs || b.openJobs - a.openJobs);
}

/** The day before `day` (YYYY-MM-DD, calendar arithmetic only: no time zone involved). */
export function dayBefore(day: string, count = 1): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date) - count * DAY_MS).toISOString().slice(0, 10);
}

/** The days the report's picker offers: the server's today and the six before it. */
export function reportDays(today: string, count = 7): string[] {
  return Array.from({ length: count }, (_, index) => dayBefore(today, index));
}

/** "Today", "Yesterday", "Thu, Nov 12". */
export function dayLabel(day: string, today: string): string {
  if (day === today) return 'Today';
  if (day === dayBefore(today)) return 'Yesterday';
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
