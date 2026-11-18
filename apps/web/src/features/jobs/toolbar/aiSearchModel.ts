import { AiTaskAcceptedSchema, type AiTaskAccepted } from '@tailorit/shared/ai';
import {
  AiJobSearchResultSchema,
  EMPLOYMENT_TYPE_LABEL,
  EXPERIENCE_LEVEL_LABEL,
  LEADERSHIP_LABEL,
  WORK_ARRANGEMENT_LABEL,
  industryLabel,
  jobCategoryLabel,
  jobSubcategoryLabel,
  type AiJobSearchResult,
  type JobsQuery,
} from '@tailorit/shared/jobs';
// Relative, not '@/': the web tests read these.
import { api } from '../../../lib/api';
import { formatSalary } from '../../../lib/format';

// v2.0 (A16): Jobs › AI search (docs/design/v2.0/08-ui.md, "Jobs: the AI search mode"; 04-accounts-limits.md §4). A
// Paid account describes the jobs it wants in a sentence; TailorIT's AI turns it into the classic search's filters,
// which go into the address, so the classic search runs them and every filter stays editable by hand. A Free account
// sees the Paid-only message instead, and no request is made (the server refuses one anyway).

export type SearchMode = 'classic' | 'ai';

export const AI_SEARCH_COPY = {
  modeLabel: 'Search mode',
  // v31 FIX-JOBS: the two modes' names are constants (LABEL_JOBS_MODE_KEYWORDS, LABEL_JOBS_MODE_AI).
  paid: 'Paid',
  placeholder: 'Describe the jobs you want, e.g. remote senior React roles over $150k',
  label: 'Describe the jobs you want',
  reading: 'Reading your search...',
  summary: 'AI search:',
  noFilters: 'no filters, every job',
  editFilters: 'Edit filters',
  dismiss: 'Dismiss the AI search summary',
  failed: 'The AI search did not work',
} as const;

/** POST /api/jobs/ai-search: 202 {taskId}; the page follows the task (GET /api/ai/tasks/:id). */
export function startAiSearch(text: string): Promise<AiTaskAccepted> {
  return api.post<AiTaskAccepted>('/api/jobs/ai-search', { text }, { schema: AiTaskAcceptedSchema });
}

/** A finished job_search task's result, or null when it is not one. */
export function readAiSearchResult(result: unknown): AiJobSearchResult | null {
  const parsed = AiJobSearchResultSchema.safeParse(result);
  return parsed.success ? parsed.data : null;
}

/** The query the address gets: the AI's filters, with the person's sort kept and the first page. */
export function queryFromAiResult(current: JobsQuery, result: AiJobSearchResult): JobsQuery {
  return { ...result.query, sort: current.sort, cursor: undefined };
}

/** A query's filters, for comparing what the AI set with what the address holds now (sort and page left out). */
export function filtersKey(query: JobsQuery): string {
  return JSON.stringify(Object.entries(query).filter(([key]) => key !== 'sort' && key !== 'cursor'));
}

/** The chips' words: "remote · Senior · React · $150k+". */
export function aiSearchSummary(query: JobsQuery): string[] {
  const parts: string[] = [];
  for (const value of query.arrangements) parts.push(WORK_ARRANGEMENT_LABEL[value as keyof typeof WORK_ARRANGEMENT_LABEL] ?? value);
  if (query.remote) parts.push(`Remote in ${query.remote}`);
  for (const value of query.levels) parts.push(EXPERIENCE_LEVEL_LABEL[value as keyof typeof EXPERIENCE_LEVEL_LABEL] ?? value);
  for (const value of query.jobTypes) parts.push(EMPLOYMENT_TYPE_LABEL[value as keyof typeof EMPLOYMENT_TYPE_LABEL] ?? value);
  for (const value of query.leadership) parts.push(LEADERSHIP_LABEL[value as keyof typeof LEADERSHIP_LABEL] ?? value);
  if (query.q) parts.push(query.q);
  for (const value of query.categories) parts.push(jobCategoryLabel(value) || value);
  for (const value of query.subcategories) parts.push(jobSubcategoryLabel(value) || value);
  for (const value of query.industries) parts.push(industryLabel(value) || value);
  for (const value of query.locations) parts.push(value);
  if (query.minSalary) parts.push(`${formatSalary(query.minSalary)}+`);
  if (query.h1b) parts.push('Sponsors H1B');
  return parts;
}
