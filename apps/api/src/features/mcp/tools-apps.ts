import { displayStatusOf, STATUS, type ApplicationStatus, type StatusKey } from '@tailorit/shared';
import { AUTOFILL_AGENT_STATES, type AutofillAgentState } from '@tailorit/shared/autofill';
import type { AppDeps } from '../../core/context';
import type { Dialect, SqlParam } from '../../core/db/index';
import { AppError, notFound, validationFailed } from '../../core/http/errors';
import { clearFinished, removeQueued } from '../autofill/agent/queue';
import { resumeChooser } from '../applications/resume-choice';
import { saveJobs } from '../applications/service';
import { archiveRow, LIVE_QUEUE_ROW_AT_SQL } from '../applications/store';
import { untrustedText } from '../autofill/ai/untrusted';
import { dayIn, dayRange, zoneOf, type DayRange, type Zone } from './dates';
import { loadResultSet, readSetCursor, saveResultSet, setCursor, targetsOf, type ResultSet } from './result-sets';
import { PAGE_DEFAULT, PAGE_MAX, type Table } from './tools-jobs';

// v1.5 Q2: the tracker and the auto-apply queue for the person's own AI: save_jobs / unsave_jobs, queue_remove /
// queue_clear_finished (each takes job ids, at most 500, or a result set), list_applications, queue_list and
// application_timeline (v2.0 P5: queue_add is gone, A4; a Saved entry with a live queue row shows status `draft`,
// A30's displayStatusOf). Every write goes through the tracker's and the queue's own code (saveJobs,
// archiveRow, removeQueued, clearFinished), so their rules hold (a tracked job keeps its status, a
// running row is never removed), in one transaction where the code allows it (saveJobs
// writes in chunks of 25, each its own transaction, as Save all does). Answers are counts, with at most
// EXAMPLES_MAX example ids of what was refused and why. An account's applications are at most a few thousand, so a
// list reads them in one indexed query and pages in memory.
// v3.0 D2: async. The tracker's and the queue's helpers are awaited whether they are async yet or not (features/
// applications and autofill/agent convert them: D2-D, D2-A); inside this file's transactions they must join the open
// tx (deps.db.atomic or the tx's handle), never open their own.
// v3.0 PG-G: on PostgreSQL. An entry's own posting URL is read by the baseline's tailorit_url_platform (the function
// jobs.apply_platform is generated from, equal to platform.ts's platformOfUrl: a test keeps them so); `tracked_on`
// is a date; the draft-ready flag is a boolean; the queue's tie-break is its `seq` column.

export const EXAMPLES_MAX = 10;

type Deps = Pick<AppDeps, 'db' | 'config' | 'now' | 'services' | 'log'>;

export const STATUS_KEYS = Object.keys(STATUS) as StatusKey[];
const KEY_OF = new Map<number, StatusKey>(Object.entries(STATUS).map(([key, code]) => [code, key as StatusKey]));
export const statusKey = (code: number): string => KEY_OF.get(code) ?? String(code);

export interface BulkInput {
  ids?: number[];
  setId?: string;
  exclude?: number[];
  limit?: number;
}

type Refusal = [number, string];

/** Counts of the refusals by reason, and up to EXAMPLES_MAX of them. */
function refusals(list: readonly Refusal[]) {
  if (list.length === 0) return {};
  const byReason: Record<string, number> = {};
  for (const [, reason] of list) byReason[reason] = (byReason[reason] ?? 0) + 1;
  return { refused: byReason, examples: list.slice(0, EXAMPLES_MAX) };
}

// ------------------------------------------------------------------------------------------------- save / unsave

/** save_jobs: each job Saved on `date` (default today in the zone) with the tracker's Save. */
export async function saveJobsTool(deps: Deps, userId: string, input: BulkInput & { date?: string; tz?: string }) {
  const targets = await targetsOf(deps, userId, input);
  const zone = zoneOf(input.tz);
  const date = input.date ?? dayIn(deps.now(), zone.tz);
  if (targets.ids.length === 0) return { saved: 0, restored: 0, skipped: 0 };
  const result = await saveJobs(deps, userId, targets.ids, { occurredOn: date, chooseResumes: resumeChooser(deps, userId) });
  const saved = new Set(result.items.map((item) => item.jobId));
  const left = targets.ids.filter((id) => !saved.has(id));
  // Why each job left was not saved: tracked already, or not one the account can see (gone, closed by an upgrade).
  const tracked = new Set(
    left.length === 0
      ? []
      : (
          await deps.db.all<{ job_id: number }>(
            `SELECT job_id FROM applications WHERE user_id = ? AND job_id IN (${jobIdsIn(deps.db.dialect)})`,
            [userId, JSON.stringify(left)],
          )
        ).map((row) => row.job_id),
  );
  const refused: Refusal[] = left.map((id) => [id, tracked.has(id) ? 'tracked' : 'not_found']);
  return {
    saved: result.items.filter((item) => item.created).length,
    restored: result.items.filter((item) => !item.created).length,
    ...refusals(refused),
    ...(result.pendingMatches > 0 ? { resumesPending: result.pendingMatches } : {}),
    ...(result.error !== undefined ? { incomplete: true } : {}),
    date,
  };
}

/** unsave_jobs: archives the Saved applications of the jobs, as the Jobs page's un-save does; never one past Saved. */
export async function unsaveJobsTool(deps: Deps, userId: string, input: BulkInput) {
  const targets = await targetsOf(deps, userId, input);
  const now = deps.now().toISOString();
  return deps.db.tx(async (t) => {
    const found = await t.all<{ job_id: number; id: string; current_status: number; archived_at: string | null }>(
      `SELECT job_id, id, current_status, archived_at FROM applications
       WHERE user_id = ? AND job_id IN (${jobIdsIn(t.dialect)})`,
      [userId, JSON.stringify(targets.ids)],
    );
    const rows = new Map(found.map((row) => [row.job_id, row]));
    const refused: Refusal[] = [];
    let unsaved = 0;
    for (const jobId of targets.ids) {
      const row = rows.get(jobId);
      if (!row || (row.archived_at !== null && row.current_status === STATUS.saved)) refused.push([jobId, 'not_saved']);
      else if (row.current_status !== STATUS.saved) refused.push([jobId, 'applied']);
      else {
        await archiveRow(t, userId, row.id, now);
        unsaved += 1;
      }
    }
    return { unsaved, ...refusals(refused) };
  }, { label: 'unsave_jobs' });
}

// ------------------------------------------------------------------------------------------------- the queue

/** queue_remove: takes the jobs' rows out of the queue (the rule never picks them again); a running row stays. */
export async function queueRemoveTool(deps: Deps, userId: string, input: BulkInput) {
  const targets = await targetsOf(deps, userId, input);
  return deps.db.tx(async (t) => {
    const found = await t.all<{ job_id: number; id: string }>(
      `SELECT job_id, id FROM autofill_agent_queue WHERE user_id = ? AND job_id IN (${jobIdsIn(t.dialect)})`,
      [userId, JSON.stringify(targets.ids)],
    );
    const rows = new Map(found.map((row) => [row.job_id, row.id]));
    const refused: Refusal[] = [];
    let removed = 0;
    for (const jobId of targets.ids) {
      const id = rows.get(jobId);
      if (!id) {
        refused.push([jobId, 'not_queued']);
        continue;
      }
      try {
        await removeQueued(deps, userId, id);
        removed += 1;
      } catch (error) {
        if (!(error instanceof AppError) || error.status >= 500) throw error;
        refused.push([jobId, error.code === 'conflict' ? 'running' : 'not_queued']);
      }
    }
    return { removed, ...refusals(refused) };
  }, { label: 'queue_remove' });
}

/** queue_clear_finished: the queue's Clear finished. */
export async function queueClearFinishedTool(deps: Deps, userId: string) {
  return { removed: await clearFinished(deps, userId) };
}

/** `job_id IN (...)`'s list from one bound JSON array of ids (the values are text on PostgreSQL: cast). */
const jobIdsIn = (d: Dialect) => `SELECT CAST(value AS INTEGER) FROM ${d.jsonEach('?')}`;

// ------------------------------------------------------------------------------------------------- lists

/** The platform of an application: its job's (a stored column), else its own posting URL's. */
export const APP_PLATFORM = 'COALESCE(j.apply_platform, tailorit_url_platform(a.posting_url))';
/** The day an application was applied to (its Applied event), else null. */
const APPLIED_ON = `(SELECT e.occurred_on FROM application_status_events e WHERE e.application_id = a.id AND e.status = ${STATUS.applied})`;
/** The draft is ready as the extension's lookup reads it (resume ready, letter ready or off, answers ready or not). */
const DRAFT_READY = `(d.resume_status = 'ready' AND d.letter_status IN ('ready', 'off') AND d.answers_status IN ('ready', 'not_ready'))`;

export const APP_FIELDS = ['app', 'job', 'title', 'company', 'status', 'saved', 'applied', 'updated', 'platform', 'flags', 'location', 'url'] as const;
export type AppField = (typeof APP_FIELDS)[number];
export const DEFAULT_APP_FIELDS: readonly AppField[] = ['app', 'job', 'title', 'company', 'status', 'applied', 'platform', 'flags'];
export const APP_FACETS = ['status', 'platform', 'company', 'queue'] as const;

export interface DateFilter {
  period?: string;
  from?: string;
  to?: string;
}

export interface AppFilters {
  status?: StatusKey[];
  archived?: 'exclude' | 'only' | 'include';
  saved?: DateFilter;
  applied?: DateFilter;
  event?: DateFilter & { status: StatusKey };
  platform?: string[];
  company?: string;
  title?: string;
  text?: string;
  draft?: 'ready' | 'any' | 'none';
  queue?: 'queued' | 'running' | 'finished' | 'any' | 'none';
  tz?: string;
}

export interface ListArgs extends AppFilters {
  sort?: 'updated' | 'applied' | 'saved';
  countOnly?: boolean;
  facets?: Array<(typeof APP_FACETS)[number]>;
  fields?: AppField[];
  limit?: number;
  cursor?: string;
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

const codeOf = (key: StatusKey): ApplicationStatus => STATUS[key];

/** v2.0 P5 (A30): the status a person sees: `draft` for a Saved entry with a live queue row, else the stored one's key. */
export function shownStatus(code: number, queuedAt: string | null): string {
  const shown = displayStatusOf({ status: code as ApplicationStatus, queued: queuedAt !== null });
  return typeof shown === 'number' ? statusKey(shown) : shown;
}

export interface Where {
  sql: string[];
  params: Record<string, unknown>;
  zone: Zone;
  ranges: Record<string, Partial<DayRange>>;
}

/** The filters as SQL over applications `a` (jobs `j`, drafts `d`, queue `q` joined). */
export function appWhere(
  userId: string,
  filters: AppFilters,
  now: Date,
  archivedDefault: 'exclude' | 'include',
  d: Dialect,
): Where {
  const zone = zoneOf(filters.tz);
  const params: Record<string, unknown> = { userId };
  let n = 0;
  const add = (value: unknown) => {
    const name = `p${n++}`;
    params[name] = value;
    return `@${name}`;
  };
  const sql = ['a.user_id = @userId'];
  const archived = filters.archived ?? archivedDefault;
  if (archived === 'exclude') sql.push('a.archived_at IS NULL');
  if (archived === 'only') sql.push('a.archived_at IS NOT NULL');
  if (filters.status && filters.status.length > 0) sql.push(`a.current_status IN (${filters.status.map((key) => add(codeOf(key))).join(', ')})`);
  const ranges: Record<string, Partial<DayRange>> = {};
  const between = (expression: string, range: Partial<DayRange> | null) => {
    if (!range) return;
    if (range.from) sql.push(`${expression} >= ${add(range.from)}`);
    if (range.to) sql.push(`${expression} <= ${add(range.to)}`);
  };
  if (filters.saved) {
    const range = dayRange(filters.saved, now, zone);
    if (range) ranges.saved = range;
    between('a.tracked_on', range);
  }
  if (filters.applied) {
    const range = dayRange(filters.applied, now, zone);
    if (range) ranges.applied = range;
    if (range) between(APPLIED_ON, range);
    else sql.push(`${APPLIED_ON} IS NOT NULL`);
  }
  if (filters.event) {
    const range = dayRange(filters.event, now, zone);
    if (range) ranges.event = range;
    const parts = [`ev.application_id = a.id`, `ev.status = ${add(codeOf(filters.event.status))}`];
    if (range?.from) parts.push(`ev.occurred_on >= ${add(range.from)}`);
    if (range?.to) parts.push(`ev.occurred_on <= ${add(range.to)}`);
    sql.push(`EXISTS (SELECT 1 FROM application_status_events ev WHERE ${parts.join(' AND ')})`);
  }
  if (filters.platform && filters.platform.length > 0) sql.push(`${APP_PLATFORM} IN (${filters.platform.map(add).join(', ')})`);
  const words = (text: string | undefined, columns: readonly string[]) => {
    for (const word of (text ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 10)) {
      const like = add(`%${escapeLike(word)}%`);
      sql.push(`(${columns.map((column) => d.like(column, like)).join(' OR ')})`);
    }
  };
  words(filters.company, ['a.company_name']);
  words(filters.title, ['a.title']);
  words(filters.text, ['a.title', 'a.company_name', 'a.location']);
  if (filters.draft === 'ready') sql.push(DRAFT_READY);
  if (filters.draft === 'any') sql.push('d.application_id IS NOT NULL');
  if (filters.draft === 'none') sql.push('d.application_id IS NULL');
  if (filters.queue === 'queued') sql.push(`q.state = 'queued'`);
  if (filters.queue === 'running') sql.push(`q.state = 'running'`);
  if (filters.queue === 'finished') sql.push(`q.state IN ('submitted', 'skipped', 'needs-you', 'failed')`);
  if (filters.queue === 'any') sql.push('q.id IS NOT NULL');
  if (filters.queue === 'none') sql.push('q.id IS NULL');
  return { sql, params, zone, ranges };
}

export const APP_FROM = `applications a
  LEFT JOIN jobs j ON j.id = a.job_id
  LEFT JOIN application_drafts d ON d.application_id = a.id
  LEFT JOIN autofill_agent_queue q ON q.user_id = a.user_id AND q.job_id = a.job_id`;

interface AppRow {
  id: string;
  job_id: number | null;
  title: string;
  company_name: string;
  location: string;
  posting_url: string;
  current_status: number;
  archived_at: string | null;
  favorite: boolean;
  tracked_on: string;
  updated_at: string;
  applied_on: string | null;
  platform: string;
  draft_ready: boolean;
  queue_state: AutofillAgentState | null;
  queued_at: string | null;
}

function appRows(deps: Pick<AppDeps, 'db'>, where: Where, sort: ListArgs['sort']): Promise<AppRow[]> {
  const order = sort === 'applied' ? 'applied_on DESC NULLS LAST, a.updated_at DESC' : sort === 'saved' ? 'a.tracked_on DESC, a.created_at DESC' : 'a.updated_at DESC';
  return deps.db.all<AppRow>(
    `SELECT a.id, a.job_id, a.title, a.company_name, a.location, a.posting_url, a.current_status, a.archived_at, a.favorite,
       a.tracked_on, a.updated_at, ${APPLIED_ON} AS applied_on, ${APP_PLATFORM} AS platform,
       COALESCE(${DRAFT_READY}, false) AS draft_ready, q.state AS queue_state, ${LIVE_QUEUE_ROW_AT_SQL} AS queued_at
     FROM ${APP_FROM}
     WHERE ${where.sql.join(' AND ')}
     ORDER BY ${order}, a.id`,
    where.params as Record<string, SqlParam>,
  );
}

function appFlags(row: AppRow): string {
  let flags = '';
  if (row.draft_ready) flags += 'D';
  if (row.queue_state === 'queued' || row.queue_state === 'running') flags += 'Q';
  if (row.archived_at !== null) flags += 'Z';
  if (row.favorite) flags += '*';
  return flags;
}

function appCell(row: AppRow, field: AppField): string | number | null {
  switch (field) {
    case 'app':
      return row.id;
    case 'job':
      return row.job_id;
    case 'title':
      return untrustedText(row.title, 120);
    case 'company':
      return untrustedText(row.company_name, 80);
    case 'status':
      return shownStatus(row.current_status, row.queued_at);
    case 'saved':
      return row.tracked_on.slice(0, 10);
    case 'applied':
      return row.applied_on;
    case 'updated':
      return row.updated_at.slice(0, 10);
    case 'platform':
      return row.platform;
    case 'flags':
      return appFlags(row);
    case 'location':
      return untrustedText(row.location, 60);
    case 'url':
      return row.posting_url;
  }
}

function count<T>(rows: readonly T[], keyOf: (row: T) => string, top: number): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(keyOf(row), (counts.get(keyOf(row)) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, top);
}

interface ListAnswer {
  total: number;
  setId: string;
  cols?: readonly string[];
  rows?: Table['rows'];
  next?: string;
  facets?: Record<string, Array<[string, number]>>;
  ranges?: Record<string, Partial<DayRange>>;
  tz?: string;
}

function pageRows<R>(rows: readonly R[], offset: number, limit: number) {
  return { page: rows.slice(offset, offset + limit), more: offset + limit < rows.length };
}

/** list_applications. */
export async function listApplications(deps: Pick<AppDeps, 'db' | 'now'>, userId: string, args: ListArgs): Promise<ListAnswer> {
  let set: ResultSet | null = null;
  let offset = 0;
  let query: ListArgs = args;
  if (args.cursor) {
    const cursor = readSetCursor(args.cursor);
    set = await loadResultSet(deps, userId, cursor.setId);
    if (set.source !== 'applications') throw validationFailed('cursor: that cursor is not a list_applications cursor.');
    offset = cursor.offset;
    const stored = set.query as ListArgs;
    query = { ...stored, fields: args.fields ?? stored.fields, limit: args.limit ?? stored.limit };
  }
  const where = appWhere(userId, query, deps.now(), 'exclude', deps.db.dialect);
  const rows = await appRows(deps, where, query.sort);
  if (!set) {
    const jobIds = rows.map((row) => row.job_id).filter((id): id is number => id !== null);
    const stored = { ...query, countOnly: undefined, facets: undefined, cursor: undefined };
    set = await saveResultSet(deps, userId, 'applications', stored, jobIds, jobIds.length);
  }
  const meta = {
    ...(Object.keys(where.ranges).length > 0 ? { ranges: where.ranges, tz: where.zone.tz } : {}),
  };
  const facets = query.facets && query.facets.length > 0 && !args.cursor ? appFacets(rows, query.facets) : undefined;
  if (query.countOnly && !args.cursor) return { total: rows.length, setId: set.id, ...(facets ? { facets } : {}), ...meta };
  const fields = query.fields && query.fields.length > 0 ? query.fields : DEFAULT_APP_FIELDS;
  const limit = Math.min(query.limit ?? PAGE_DEFAULT, PAGE_MAX);
  const { page, more } = pageRows(rows, offset, limit);
  return {
    total: rows.length,
    cols: fields,
    rows: page.map((row) => fields.map((field) => appCell(row, field))),
    ...(more ? { next: setCursor(set.id, offset + limit) } : {}),
    setId: set.id,
    ...(facets ? { facets } : {}),
    ...meta,
  };
}

function appFacets(rows: readonly AppRow[], facets: ReadonlyArray<(typeof APP_FACETS)[number]>) {
  const out: Record<string, Array<[string, number]>> = {};
  for (const facet of new Set(facets)) {
    if (facet === 'status') out.status = count(rows, (row) => shownStatus(row.current_status, row.queued_at), 12);
    if (facet === 'platform') out.platform = count(rows, (row) => row.platform, 12);
    if (facet === 'company') out.company = count(rows, (row) => untrustedText(row.company_name, 80), 10);
    if (facet === 'queue') out.queue = count(rows, (row) => row.queue_state ?? 'none', 8);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------- queue_list

export const QUEUE_FIELDS = ['job', 'title', 'company', 'state', 'reason', 'platform', 'run', 'source', 'updated', 'url'] as const;
export type QueueField = (typeof QUEUE_FIELDS)[number];
export const DEFAULT_QUEUE_FIELDS: readonly QueueField[] = ['job', 'title', 'company', 'state', 'reason', 'platform', 'updated'];
export const QUEUE_FACETS = ['state', 'platform', 'company', 'reason'] as const;

export interface QueueListArgs {
  state?: AutofillAgentState[];
  platform?: string[];
  company?: string;
  title?: string;
  source?: Array<'manual' | 'rule'>;
  run?: Array<'agent' | 'tab' | 'manual'>;
  countOnly?: boolean;
  facets?: Array<(typeof QUEUE_FACETS)[number]>;
  fields?: QueueField[];
  limit?: number;
  cursor?: string;
}

interface QueueListRow {
  job_id: number;
  title: string;
  company: string;
  state: AutofillAgentState;
  reason: string | null;
  platform: string;
  run: string | null;
  source: string;
  updated_at: string;
  apply_url: string;
}

/** queue_list: the account's queue rows (at most 500), running first, then queued oldest first, then finished. */
export async function queueList(deps: Pick<AppDeps, 'db' | 'now'>, userId: string, args: QueueListArgs) {
  let set: ResultSet | null = null;
  let offset = 0;
  let query = args;
  if (args.cursor) {
    const cursor = readSetCursor(args.cursor);
    set = await loadResultSet(deps, userId, cursor.setId);
    if (set.source !== 'queue') throw validationFailed('cursor: that cursor is not a queue_list cursor.');
    offset = cursor.offset;
    const stored = set.query as QueueListArgs;
    query = { ...stored, fields: args.fields ?? stored.fields, limit: args.limit ?? stored.limit };
  }
  const params: Record<string, SqlParam> = { userId };
  const sql = ['q.user_id = @userId'];
  let n = 0;
  const add = (value: SqlParam) => {
    params[`p${n}`] = value;
    return `@p${n++}`;
  };
  if (query.state?.length) sql.push(`q.state IN (${query.state.map(add).join(', ')})`);
  if (query.platform?.length) sql.push(`j.apply_platform IN (${query.platform.map(add).join(', ')})`);
  if (query.source?.length) sql.push(`q.source IN (${query.source.map(add).join(', ')})`);
  if (query.run?.length) sql.push(`q.run IN (${query.run.map(add).join(', ')})`);
  for (const [text, column] of [[query.company, 'c.name'], [query.title, 'j.title']] as const) {
    for (const word of (text ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 10)) {
      sql.push(deps.db.dialect.like(column, add(`%${escapeLike(word)}%`)));
    }
  }
  // seq: the insertion order among rows of one instant (the baseline's identity column).
  const rows = await deps.db.all<QueueListRow>(
    `SELECT q.job_id, j.title, c.name AS company, q.state, q.reason, j.apply_platform AS platform, q.run, q.source,
       q.updated_at, j.apply_url
     FROM autofill_agent_queue q JOIN jobs j ON j.id = q.job_id JOIN companies c ON c.id = j.company_id
     WHERE ${sql.join(' AND ')}
     ORDER BY CASE q.state WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
       CASE WHEN q.state IN ('running', 'queued') THEN q.created_at END ASC,
       q.finished_at DESC NULLS LAST, ${deps.db.dialect.seq('q')}`,
    params,
  );
  if (!set) {
    const stored = { ...query, countOnly: undefined, facets: undefined, cursor: undefined };
    set = await saveResultSet(deps, userId, 'queue', stored, rows.map((row) => row.job_id), rows.length);
  }
  const facets: Record<string, Array<[string, number]>> = {};
  for (const facet of new Set(query.facets ?? [])) {
    if (args.cursor) break;
    if (facet === 'state') facets.state = count(rows, (row) => row.state, AUTOFILL_AGENT_STATES.length);
    if (facet === 'platform') facets.platform = count(rows, (row) => row.platform, 12);
    if (facet === 'company') facets.company = count(rows, (row) => untrustedText(row.company, 80), 10);
    if (facet === 'reason') facets.reason = count(rows, (row) => row.reason ?? 'none', 16);
  }
  const withFacets = Object.keys(facets).length > 0 ? { facets } : {};
  if (query.countOnly && !args.cursor) return { total: rows.length, setId: set.id, ...withFacets };
  const fields = query.fields && query.fields.length > 0 ? query.fields : DEFAULT_QUEUE_FIELDS;
  const limit = Math.min(query.limit ?? PAGE_DEFAULT, PAGE_MAX);
  const { page, more } = pageRows(rows, offset, limit);
  const cellOf = (row: QueueListRow, field: QueueField): string | number | null => {
    switch (field) {
      case 'job':
        return row.job_id;
      case 'title':
        return untrustedText(row.title, 120);
      case 'company':
        return untrustedText(row.company, 80);
      case 'updated':
        return row.updated_at.slice(0, 16);
      case 'url':
        return row.apply_url;
      default:
        return row[field] as string | null;
    }
  };
  return {
    total: rows.length,
    cols: fields,
    rows: page.map((row) => fields.map((field) => cellOf(row, field))),
    ...(more ? { next: setCursor(set.id, offset + limit) } : {}),
    setId: set.id,
    ...withFacets,
  };
}

// ------------------------------------------------------------------------------------------------- one application

/** application_timeline: one of the account's applications, its events in order, its draft and its queue row. */
export async function applicationTimeline(deps: Pick<AppDeps, 'db'>, userId: string, applicationId: string) {
  const row = await deps.db.one<{
    id: string;
    job_id: number | null;
    title: string;
    company_name: string;
    location: string;
    current_status: number;
    archived_at: string | null;
    tracked_on: string;
    posting_url: string;
    platform: string;
    resume_status: string | null;
    letter_status: string | null;
    answers_status: string | null;
    queue_state: string | null;
    queue_reason: string | null;
    queue_run: string | null;
    queued_at: string | null;
  }>(
    `SELECT a.id, a.job_id, a.title, a.company_name, a.location, a.current_status, a.archived_at, a.tracked_on,
       a.posting_url, ${APP_PLATFORM} AS platform, d.resume_status, d.letter_status, d.answers_status,
       q.state AS queue_state, q.reason AS queue_reason, q.run AS queue_run, ${LIVE_QUEUE_ROW_AT_SQL} AS queued_at
     FROM ${APP_FROM} WHERE a.id = ? AND a.user_id = ?`,
    [applicationId, userId],
  );
  if (!row) throw notFound('That application');
  const events = await deps.db.all<{ status: number; occurred_on: string }>(
    'SELECT status, occurred_on FROM application_status_events WHERE application_id = ? ORDER BY occurred_on, status',
    [row.id],
  );
  return {
    app: row.id,
    job: row.job_id,
    title: untrustedText(row.title, 120),
    company: untrustedText(row.company_name, 80),
    location: untrustedText(row.location, 60),
    status: shownStatus(row.current_status, row.queued_at),
    archived: row.archived_at !== null,
    platform: row.platform,
    events: events.map((event) => [statusKey(event.status), event.occurred_on]),
    draft: row.resume_status === null ? null : { resume: row.resume_status, letter: row.letter_status, answers: row.answers_status },
    queue: row.queue_state === null ? null : { state: row.queue_state, reason: row.queue_reason, run: row.queue_run },
    url: row.posting_url,
  };
}
