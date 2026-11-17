import { STATUS, type StatusKey } from '@tailorit/shared';
import type { AppDeps } from '../../core/context';
import type { SqlParam } from '../../core/db/index';
import { validationFailed } from '../../core/http/errors';
import { untrustedText } from '../autofill/ai/untrusted';
import { dayRange } from './dates';
import { APP_FROM, APP_PLATFORM, appWhere, statusKey, type AppFilters } from './tools-apps';

// v1.5 Q2: application_stats, counted in SQL over the account's applications and their status events
// (application_status_events: one row per status reached, with the day it happened). Two readings:
// - with `event` (a status: applied, screen, interviewing, ...): the applications that reached it on a day in the
//   range ("how many did I apply to this week": event applied, period thisWeek). Day, week and month group by that
//   day. Archived applications count (it happened).
// - without: the applications as they stand (current status), the Tracker board's: archived ones are left out unless
//   asked; a range filters by the day each was saved, and day, week and month group by it.
// The groups: status (the current one), platform (the job board of the job's apply URL, else the entry's own posting
// URL: features/mcp/platform.ts), company, source (where TailorIT got the job: greenhouse, lever, ft_lake, page, ...;
// `manual` for an entry with no job), day, week (its Monday) and month. At most two at once. Answers a small table.
// v3.0 PG-G: on PostgreSQL, where the two days (applications.tracked_on, application_status_events.occurred_on) are
// `date` columns: a day is read as YYYY-MM-DD text, a week as its Monday by date arithmetic, a month with to_char.

export const STAT_GROUPS = ['status', 'platform', 'company', 'source', 'day', 'week', 'month'] as const;
export type StatGroup = (typeof STAT_GROUPS)[number];
/** The most rows one answer holds (a group by company may have many). */
export const STAT_ROWS_MAX = 100;

export interface StatsArgs {
  metric?: 'count';
  groupBy?: StatGroup[];
  event?: StatusKey;
  period?: string;
  from?: string;
  to?: string;
  tz?: string;
  filters?: Omit<AppFilters, 'tz'>;
}

const SOURCE = `COALESCE((SELECT so.kind FROM job_source_links sl JOIN job_sources so ON so.id = sl.source_id
  WHERE sl.job_id = a.job_id ORDER BY so.kind = 'page', sl.first_seen_at LIMIT 1), CASE WHEN a.job_id IS NULL THEN 'manual' ELSE 'unknown' END)`;

function groupSql(group: StatGroup, day: string): string {
  switch (group) {
    case 'status':
      return 'a.current_status';
    case 'platform':
      return APP_PLATFORM;
    case 'company':
      return 'a.company_name';
    case 'source':
      return SOURCE;
    case 'day':
      return day;
    case 'week':
      // The week's Monday: a date less the days since Monday (isodow is 1 on Monday, 7 on Sunday).
      return `(${day} - (extract(isodow FROM ${day})::integer - 1))`;
    case 'month':
      return `to_char(${day}, 'YYYY-MM')`;
  }
}

/** application_stats. */
export async function applicationStats(deps: Pick<AppDeps, 'db' | 'now'>, userId: string, args: StatsArgs) {
  if (args.metric !== undefined && args.metric !== 'count') throw validationFailed('metric: only "count" is there.');
  const groups = [...new Set(args.groupBy ?? [])];
  if (groups.length > 2) throw validationFailed('groupBy: at most two groups at once.');
  const now = deps.now();
  const where = appWhere(userId, { ...args.filters, tz: args.tz }, now, args.event ? 'include' : 'exclude', deps.db.dialect);
  const range = dayRange({ period: args.period, from: args.from, to: args.to }, now, where.zone);
  const params = { ...where.params };
  let n = 0;
  const add = (value: unknown) => {
    params[`s${n}`] = value;
    return `@s${n++}`;
  };
  let from = APP_FROM;
  let day = 'a.tracked_on';
  const conditions = [...where.sql];
  if (args.event) {
    from += ` JOIN application_status_events se ON se.application_id = a.id AND se.status = ${add(STATUS[args.event])}`;
    day = 'se.occurred_on';
  }
  if (range?.from) conditions.push(`${day} >= ${add(range.from)}`);
  if (range?.to) conditions.push(`${day} <= ${add(range.to)}`);
  const selects = groups.map((group, index) => `${groupSql(group, day)} AS g${index}`);
  const groupBy = groups.map((_, index) => `g${index}`);
  const dated = groups.some((group) => group === 'day' || group === 'week' || group === 'month');
  const order = groups.length === 0 ? '' : `ORDER BY ${dated ? groupBy.join(', ') : `n DESC, ${groupBy.join(', ')}`}`;
  const sql = `SELECT ${[...selects, 'COUNT(DISTINCT a.id) AS n'].join(', ')} FROM ${from}
    WHERE ${conditions.join(' AND ')} ${groups.length > 0 ? `GROUP BY ${groupBy.join(', ')}` : ''} ${order}`;
  const bound = params as Record<string, SqlParam>;
  const rows = await deps.db.all<Record<string, string | number>>(sql, bound);
  const total = groups.length === 0
    ? ((rows[0]?.n as number | undefined) ?? 0)
    : ((await deps.db.one<{ n: number }>(`SELECT COUNT(DISTINCT a.id) AS n FROM ${from} WHERE ${conditions.join(' AND ')}`, bound))?.n ?? 0);
  const cell = (group: StatGroup, value: string | number) =>
    group === 'status' ? statusKey(Number(value)) : group === 'company' ? untrustedText(String(value), 80) : value;
  return {
    cols: [...groups, 'n'],
    rows: groups.length === 0 ? [[total]] : rows.slice(0, STAT_ROWS_MAX).map((row) => [...groups.map((group, index) => cell(group, row[`g${index}`]!)), row.n]),
    total,
    ...(rows.length > STAT_ROWS_MAX ? { cut: STAT_ROWS_MAX } : {}),
    ...(args.event ? { event: args.event } : {}),
    ...(range ? { range: [range.from ?? null, range.to ?? null] } : {}),
    archived: args.filters?.archived ?? (args.event ? 'include' : 'exclude'),
    tz: where.zone.tz,
  };
}
