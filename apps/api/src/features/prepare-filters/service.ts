import {
  evaluateFilters,
  FILTER_REASONS,
  mergeExtra,
  type FilterReason,
  type CustomFilterState,
  type JobFactsView,
  type PersonFacts,
  type PrepareFilters,
  type PrepareFiltersPreview,
  type PrepareFiltersResponse,
} from '@tailorit/shared';
import { constantsOf } from '../../core/constants/index';
import { nowIso, type AppDeps } from '../../core/context';
import type { FilterCheck, PrepareFilterService } from '../../core/seams';
import { ensureJobFacts, JOB_FACTS_VERSION, readJobFacts } from '../job-facts/service';
import { customPromptOf, customStates, judgeOnServer, storeVerdicts } from './custom';
import { personFacts, personLocation } from './person';
import { readFilterResults, recordFilterResults, type StoredFilterResult } from './results';
import { readFilterSettings } from './settings';

// v2.0 P4 (06-filters-analysis.md): the prepare filters as a service (core/seams.ts PrepareFilterService), for P2's
// Prepare & Queue checks and runner, P3's Saved list and P5's MCP tools; and the settings routes' preview. Every check
// is deterministic over each job's facts (ensured first, never with AI) and the person's facts; the Custom filter's
// state comes from its stored verdicts.
// v3.0 D2-F: on the async client; deps.services.prepareFilters is this service (core/seams.ts PrepareFilterService).

/** The most Saved entries a preview reads (newest first): a technical bound, far above any person's list. */
export const PREVIEW_MAX = 5000;

/** A person's application with its job, as the filters read it. */
export interface ApplicationRow {
  id: string;
  job_id: number;
  content_hash: string;
}

/** The person's applications that have a job among some ids (a JSON array bound to `?`). */
export const APPLICATIONS_SQL = (jsonEach: string) =>
  'SELECT a.id, a.job_id, j.content_hash FROM applications a JOIN jobs j ON j.id = a.job_id ' +
  `WHERE a.user_id = ? AND a.id IN (SELECT value FROM ${jsonEach})`;

/** The ids asked about, deduplicated and bounded, in 500s (the JSON arrays APPLICATIONS_SQL binds). */
export function applicationIdChunks(applicationIds: readonly string[]): { ids: string[]; chunks: string[] } {
  const ids = [...new Set(applicationIds.filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 64))];
  const chunks: string[] = [];
  for (let index = 0; index < ids.length; index += 500) chunks.push(JSON.stringify(ids.slice(index, index + 500)));
  return { ids, chunks };
}

/** Rows in the order of `ids`. */
export function inOrderOf(ids: readonly string[], rows: ApplicationRow[]): ApplicationRow[] {
  const order = new Map(ids.map((id, position) => [id, position]));
  return rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

/** The person's applications that have a job, in the order asked (others are left out). */
async function applicationsOf(deps: Pick<AppDeps, 'db'>, userId: string, applicationIds: readonly string[]): Promise<ApplicationRow[]> {
  const { ids, chunks } = applicationIdChunks(applicationIds);
  const rows: ApplicationRow[] = [];
  for (const chunk of chunks) rows.push(...(await deps.db.all<ApplicationRow>(APPLICATIONS_SQL(deps.db.dialect.jsonEach('?')), [userId, chunk])));
  return inOrderOf(ids, rows);
}

/**
 * The verdicts of applications from their facts, the person's facts and the Custom filter's states (what `check`
 * reads).
 */
export function verdictsOf(
  deps: Pick<AppDeps, 'config' | 'log' | 'services' | 'db' | 'now'>,
  rows: readonly ApplicationRow[],
  filters: PrepareFilters,
  facts: Map<number, JobFactsView>,
  person: PersonFacts,
  states: Map<number, CustomFilterState>,
): FilterCheck[] {
  const yearsGrace = constantsOf(deps).get('QUALIFICATION_YEARS_GRACE');
  const out: FilterCheck[] = [];
  for (const row of rows) {
    const view = facts.get(row.job_id);
    if (!view) continue;
    const custom = states.get(row.job_id) ?? 'off';
    out.push({
      applicationId: row.id,
      jobId: row.job_id,
      verdict: evaluateFilters(filters, view, person, custom, { yearsGrace }),
      custom,
    });
  }
  return out;
}

/** Runs filters over applications: their facts ensured, the person's facts and the Custom filter's states read once. */
async function check(
  deps: AppDeps,
  userId: string,
  rows: readonly ApplicationRow[],
  filters: PrepareFilters,
  options: { custom: boolean },
): Promise<FilterCheck[]> {
  if (rows.length === 0) return [];
  const jobIds = rows.map((row) => row.job_id);
  await ensureJobFacts(deps, jobIds);
  const facts = await readJobFacts(deps, jobIds);
  const person = await personFacts(deps, userId);
  const prompt = options.custom ? await customPromptOf(deps, userId) : null;
  const states = await customStates(
    deps.db,
    userId,
    prompt,
    rows.map((row) => ({ jobId: row.job_id, contentHash: row.content_hash })),
  );
  return verdictsOf(deps, rows, filters, facts, person, states);
}

export interface PrepareFilterServiceInternals extends PrepareFilterService {
  /**
   * The seam's judgeOnServer, with the Prepare it is for (`prepare: {id}` in each task's input, so the cost adds up on
   * that Prepare). core/seams.ts gains the parameter at INT.
   */
  judgeOnServer(userId: string, jobIds: readonly number[], prepareId?: string): Promise<Map<number, 'pass' | 'fail'>>;
  /**
   * The Saved list's labels (P3's read model): each application's stored verdict, computed again first when it is
   * missing or stale (another filters revision, another JOB_FACTS_VERSION, facts computed after it, a Custom verdict
   * stored since). Applications that are not the person's, or have no job, are left out.
   */
  resultsOf(userId: string, applicationIds: readonly string[]): Promise<Map<string, StoredFilterResult>>;
  /** GET /api/prepare/filters' answer. */
  settingsOf(userId: string): Promise<PrepareFiltersResponse>;
  /** POST /api/prepare/filters/preview: the deterministic filters (no Custom filter, no AI) over the Saved jobs. */
  preview(userId: string, filters: PrepareFilters): Promise<PrepareFiltersPreview>;
}

export function createPrepareFilterService(deps: AppDeps): PrepareFilterServiceInternals {
  const service: PrepareFilterServiceInternals = {
    filtersOf(userId) {
      return readFilterSettings(deps, userId);
    },

    async resultsOf(userId, applicationIds) {
      const rows = await applicationsOf(deps, userId, applicationIds);
      if (rows.length === 0) return new Map();
      const ids = rows.map((row) => row.id);
      await ensureJobFacts(deps, rows.map((row) => row.job_id));
      const computed = new Map(
        (
          await deps.db.all<{ job_id: number; computed_at: string }>(
            `SELECT job_id, computed_at FROM job_facts WHERE job_id IN (SELECT CAST(value AS INTEGER) FROM ${deps.db.dialect.jsonEach('?')})`,
            [JSON.stringify(rows.map((row) => row.job_id))],
          )
        ).map((row) => [row.job_id, row.computed_at]),
      );
      const { revision } = await readFilterSettings(deps, userId);
      const stored = await readFilterResults(deps.db, userId, ids);
      const stale = rows
        .filter((row) => {
          const result = stored.get(row.id);
          return (
            !result ||
            result.filtersRevision !== revision ||
            result.factsVersion !== JOB_FACTS_VERSION ||
            result.jobId !== row.job_id ||
            result.checkedAt < (computed.get(row.job_id) ?? '')
          );
        })
        .map((row) => row.id);
      if (stale.length === 0) return stored;
      await service.evaluate(userId, stale, { record: true });
      return readFilterResults(deps.db, userId, ids);
    },

    async evaluate(userId, applicationIds, options = {}) {
      const { filters, revision } = await readFilterSettings(deps, userId);
      const effective = options.extra ? mergeExtra(filters, options.extra) : filters;
      const rows = await applicationsOf(deps, userId, applicationIds);
      const checks = await check(deps, userId, rows, effective, { custom: true });
      // A verdict with MCP's extra on top is not the saved filters' verdict: only the saved filters' is recorded.
      if (options.record && !options.extra) {
        await recordFilterResults(
          deps.db,
          userId,
          checks.map((entry) => ({ applicationId: entry.applicationId, jobId: entry.jobId, verdict: entry.verdict })),
          { filtersRevision: revision, factsVersion: JOB_FACTS_VERSION, checkedAt: nowIso(deps) },
        );
      }
      return checks;
    },

    customPrompt(userId) {
      return customPromptOf(deps, userId);
    },

    saveCustomVerdicts(userId, verdicts, decidedBy) {
      return storeVerdicts(deps, userId, verdicts, decidedBy);
    },

    judgeOnServer(userId, jobIds, prepareId) {
      return judgeOnServer(deps, userId, jobIds, prepareId);
    },

    async settingsOf(userId) {
      const { filters, revision } = await readFilterSettings(deps, userId);
      const location = await personLocation(deps, userId);
      return { filters, revision, locationKnown: location.country !== null, timeZoneKnown: location.timeZoneOffset !== null };
    },

    async preview(userId, filters) {
      const rows = await deps.db.all<ApplicationRow>(
        'SELECT a.id, a.job_id, j.content_hash FROM applications a JOIN jobs j ON j.id = a.job_id ' +
          'WHERE a.user_id = ? AND a.archived_at IS NULL AND a.current_status = 1 ORDER BY a.tracked_on DESC, a.id LIMIT ?',
        [userId, PREVIEW_MAX],
      );
      const checks = await check(deps, userId, rows, { ...filters, custom: { enabled: false, prompt: '' } }, { custom: false });
      const byReason: Partial<Record<FilterReason, number>> = {};
      let fail = 0;
      for (const entry of checks) {
        const first = entry.verdict.reasons[0];
        if (entry.verdict.verdict !== 'fail' || !first) continue;
        fail += 1;
        byReason[first.code] = (byReason[first.code] ?? 0) + 1;
      }
      const ordered = Object.fromEntries(FILTER_REASONS.filter((code) => byReason[code]).map((code) => [code, byReason[code]]));
      return { total: checks.length, pass: checks.length - fail, fail, byReason: ordered };
    },
  };
  return service;
}
