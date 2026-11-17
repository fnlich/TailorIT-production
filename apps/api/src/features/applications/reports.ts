import {
  JobKeywordsSchema,
  KeywordGroupSchema,
  STATUS,
  buildExportCsv,
  eventDate,
  extractKeywords,
  htmlToText,
  insights,
  matchResult,
  noResumeMatch,
  normalizeCompanyName,
  sankeyData,
  type InsightsResponse,
  type JobKeywords,
  type KeywordGroup,
  type MatchResult,
  type SankeyResponse,
} from '@tailorit/shared';
import type { AppDeps } from '../../core/context';
import { getSkillLibrary } from '../../core/skills-vocabulary';
import { ownCompanyKey } from '../ingest/store';
import { companyVisibleTo } from '../jobs/visibility';
import { getResumeEvidence } from '../resumes/evidence';
import { descriptionHtmlOf } from './description';
import { allApplicationRows, filterClause, type ApplicationFilter, type SortSpec } from './query';
import { loadEventsFor, loadOwnedRow, type ApplicationRow } from './store';

// Read-only reports over the account's applications: the CSV export, the chart and its insights, the company names
// the Add Application combobox offers, and an application's resume score.
// v3.0 D2: async on deps.db; LIKE and the case-insensitive order are portable (the dialect's LIKE, lower()).

type Deps = Pick<AppDeps, 'db' | 'now'>;

/** A UTF-8 byte-order mark: Excel reads the file as UTF-8 only with it. */
const BOM = String.fromCharCode(0xfeff);

/** The export's file name: TailorIT_Tracked_Jobs_2026-10-22.csv. */
export function exportFileName(date: string): string {
  return `TailorIT_Tracked_Jobs_${date}.csv`;
}

/** Every application the filters select (no paging), as CSV with a byte-order mark so Excel reads it as UTF-8. */
export async function exportCsv(deps: Deps, userId: string, filter: ApplicationFilter, spec: SortSpec): Promise<string> {
  const rows = await allApplicationRows(deps.db, filterClause(deps.db.dialect, userId, filter), spec);
  const events = await loadEventsFor(
    deps.db,
    rows.map((row) => row.id),
  );
  const csv = buildExportCsv(
    rows.map((row) => ({
      companyName: row.company_name,
      title: row.title,
      location: row.location,
      employmentType: row.employment_type,
      currentStatus: row.current_status,
      appliedOn: eventDate(events.get(row.id) ?? [], STATUS.applied),
      trackedOn: row.tracked_on,
      postingUrl: row.posting_url,
      salaryMin: row.salary_min,
      salaryMax: row.salary_max,
      salaryCurrency: row.salary_currency,
      salaryPeriod: row.salary_period,
      favorite: Boolean(row.favorite),
      archivedAt: row.archived_at,
      notesHtml: row.notes_html,
    })),
  );
  return `${BOM}${csv}\r\n`;
}

/** The active applications as the chart reads them. */
async function chartApplications(deps: Deps, userId: string) {
  const rows = await allApplicationRows(deps.db, filterClause(deps.db.dialect, userId, { tab: 'active' }), {
    sort: 'tracked',
    order: 'asc',
  });
  const events = await loadEventsFor(
    deps.db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({ title: row.title, companyName: row.company_name, events: events.get(row.id) ?? [] }));
}

export async function sankeyReport(deps: Deps, userId: string): Promise<SankeyResponse> {
  return sankeyData(await chartApplications(deps, userId));
}

export async function insightsReport(deps: Deps, userId: string): Promise<InsightsResponse> {
  return insights(await chartApplications(deps, userId), deps.now());
}

const MAX_COMPANY_SUGGESTIONS = 300;
const MAX_COMPANY_MATCHES = 50;

/**
 * The company rows an account may see by name: every shared row (a board's or an import's) and its own (made for one of
 * its page jobs, companies.owner_user_id); never a name only another account's page gave. One parameter: the account.
 * v30 ST3: the rule is jobs/visibility.ts's companyVisibleTo.
 */
const VISIBLE_COMPANY = companyVisibleTo('');

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (char) => `\\${char}`);

/**
 * Company names for the Add Application field: the companies the account has tracked and the ones the job board
 * knows, without repeats (case-insensitive). With `q`, the names containing it (those starting with it first);
 * without, every tracked company and the first job-board ones, alphabetically.
 */
export async function companyNames(deps: Pick<AppDeps, 'db'>, userId: string, q?: string): Promise<string[]> {
  const d = deps.db.dialect;
  const query = (q ?? '').trim().slice(0, 100);
  let own: Array<{ name: string }>;
  let known: Array<{ name: string }>;
  if (query) {
    const like = `%${escapeLike(query)}%`;
    own = await deps.db.all<{ name: string }>(
      `SELECT DISTINCT company_name AS name FROM applications
       WHERE user_id = ? AND ${d.like('company_name', '?')} LIMIT ?`,
      [userId, like, MAX_COMPANY_MATCHES],
    );
    known = await deps.db.all<{ name: string }>(
      `SELECT name FROM companies WHERE ${VISIBLE_COMPANY} AND ${d.like('name', '?')}
       ORDER BY (${d.like('name', '?')}) DESC, lower(name) LIMIT ?`,
      [userId, like, `${escapeLike(query)}%`, MAX_COMPANY_MATCHES],
    );
  } else {
    own = await deps.db.all<{ name: string }>(
      "SELECT DISTINCT company_name AS name FROM applications WHERE user_id = ? AND company_name <> ''",
      [userId],
    );
    known = await deps.db.all<{ name: string }>(
      `SELECT name FROM companies WHERE ${VISIBLE_COMPANY} AND name <> '' ORDER BY lower(name) LIMIT ?`,
      [userId, MAX_COMPANY_SUGGESTIONS],
    );
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { name } of [...own, ...known]) {
    const key = name.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(name.trim());
  }
  const lower = query.toLowerCase();
  const rank = (name: string) => (lower && name.toLowerCase().startsWith(lower) ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'en', { sensitivity: 'base' }));
}

/**
 * POST /api/applications/import/companies: which of an import file's company names TailorIT already knows, each with
 * the name it knows it by: a company the account tracks (first) or the job board lists, compared the way an
 * application finds its company's logo (case, punctuation and legal suffixes aside). Unknown names are left out.
 */
export async function knownCompanies(
  deps: Pick<AppDeps, 'db'>,
  userId: string,
  names: readonly string[],
): Promise<Record<string, string>> {
  const byKey = new Map<string, string>();
  const own = await deps.db.all<{ name: string }>(
    "SELECT DISTINCT company_name AS name FROM applications WHERE user_id = ? AND company_name <> ''",
    [userId],
  );
  for (const { name } of own) {
    const key = normalizeCompanyName(name);
    if (key && !byKey.has(key)) byKey.set(key, name.trim());
  }
  // The shared row of the name (a board's), else the account's own (one of its page jobs'); never another account's.
  const known: Record<string, string> = {};
  for (const name of names) {
    const key = normalizeCompanyName(name);
    if (!key) continue;
    if (!byKey.has(key)) {
      const row = await deps.db.one<{ name: string }>(
        // v30 INT-3 (E0-API's note): never a row merged away; the oldest of homonyms.
        'SELECT name FROM companies WHERE name_key IN (?, ?) AND merged_into_id IS NULL ORDER BY owner_user_id IS NOT NULL, id LIMIT 1',
        [key, ownCompanyKey(userId, key)],
      );
      if (row?.name.trim()) byKey.set(key, row.name.trim());
    }
    const match = byKey.get(key);
    if (match) known[name] = match;
  }
  return known;
}

/** Cover letters written for one application (the cover letter editor stores the application it was opened from). */
export async function lettersForApplication(deps: Pick<AppDeps, 'db'>, userId: string, id: string) {
  await loadOwnedRow(deps.db, userId, id);
  const rows = await deps.db.all<{ id: string; title: string; updated_at: string }>(
    'SELECT id, title, updated_at FROM cover_letters WHERE user_id = ? AND application_id = ? ORDER BY updated_at DESC, id',
    [userId, id],
  );
  return rows.map((row) => ({ id: row.id, title: row.title, updatedAt: row.updated_at }));
}

type ScoreDeps = Pick<AppDeps, 'db' | 'services' | 'log'>;

/** Keyword groups in the shared contract; a group that breaks it is dropped rather than the whole list. */
function readKeywords(value: unknown): JobKeywords | null {
  const strict = JobKeywordsSchema.safeParse(value);
  if (strict.success) return strict.data;
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const groups = (list: unknown): KeywordGroup[] =>
    Array.isArray(list)
      ? list.flatMap((item) => {
          const group = KeywordGroupSchema.safeParse(item);
          return group.success ? [group.data] : [];
        })
      : [];
  return { high: groups(record.high), low: groups(record.low) };
}

/**
 * The keywords of the job an application was tracked from, as the Jobs page's match reads them: the job analysis
 * service's current analysis, else the analysis stored on the job. Null when there is neither.
 */
async function jobKeywords(deps: ScoreDeps, jobId: number): Promise<JobKeywords | null> {
  const service = deps.services.jobAnalysis;
  if (service && typeof service.get === 'function') {
    try {
      const keywords = readKeywords((await service.get(jobId))?.analysis.keywords);
      if (keywords) return keywords;
    } catch (error) {
      deps.log.warn(`[applications] the job analysis service failed for job ${jobId}; using the stored analysis`, error);
    }
  }
  const stored = await deps.db.one<{ keywords: string }>(
    'SELECT a.keywords FROM jobs j JOIN job_analyses a ON a.id = j.analysis_id WHERE j.id = ?',
    [jobId],
  );
  if (!stored) return null;
  try {
    return readKeywords(JSON.parse(stored.keywords));
  } catch {
    return null;
  }
}

/**
 * The keywords of an application's description (the skill vocabulary, the title making one high priority): its own,
 * else its job's text (v30 DB-JOBS, D1c).
 */
async function descriptionKeywords(db: ScoreDeps['db'], row: ApplicationRow): Promise<JobKeywords> {
  const text = htmlToText(await descriptionHtmlOf(db, row));
  return text.trim() ? extractKeywords(text, getSkillLibrary().vocabulary, { title: row.title }) : { high: [], low: [] };
}

/**
 * GET /api/applications/:id/resume-score: the posting's keywords against the linked resume, else the account's
 * default one; `no_resume` when there is none. An application tracked from the Jobs page scores its job's keywords
 * (the ones that page's match uses, so the two agree); one added by hand, or whose job is gone, its description's.
 */
export async function resumeScore(deps: ScoreDeps, userId: string, id: string): Promise<MatchResult> {
  const row = await loadOwnedRow(deps.db, userId, id);
  const keywords = (row.job_id !== null ? await jobKeywords(deps, row.job_id) : null) ?? (await descriptionKeywords(deps.db, row));
  const evidence =
    (row.resume_id ? await getResumeEvidence(deps, userId, row.resume_id) : null) ?? (await getResumeEvidence(deps, userId));
  if (!evidence) return noResumeMatch(keywords);
  return matchResult(evidence.text, keywords, evidence.resumeId);
}
