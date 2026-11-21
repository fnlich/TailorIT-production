import { resolveJobFamily, type RoleFamilyId } from '@tailorit/shared';
import type { AppDeps } from '../../core/context';

// v33 ROLES (F4): a job's family from the database, through the one shared resolver (`resolveJobFamily`: the AI
// analysis's category, then the job's stored one, then its title, then general). For Tailor, own-AI tailoring, the MCP
// step texts and the extension's tailoring (PROMPTS, wave 2); a job that is not stored (the extension may have only a
// title) is read by its title.

interface JobCategoryRow {
  title: string;
  category_id: string | null;
  subcategory_ids: string | null;
  ai_category_id: string | null;
  ai_subcategory_ids: string | null;
}

// The newest AI analysis of the job's text, as job-analysis/store.ts `bestAi` picks it.
const SELECT_JOB_CATEGORIES = `SELECT j.title, j.category_id, j.subcategory_ids::text AS subcategory_ids,
    a.category_id AS ai_category_id, a.subcategory_ids::text AS ai_subcategory_ids
  FROM jobs j
  LEFT JOIN LATERAL (
    SELECT category_id, subcategory_ids FROM job_analyses
     WHERE content_hash = j.content_hash AND source = 'ai' ORDER BY version DESC, id DESC LIMIT 1
  ) a ON true
  WHERE j.id = ?`;

function list(text: string | null): string[] {
  if (!text) return [];
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/** A job's family: the stored job's when `jobId` names one, else its title's (general when the title says nothing). */
export async function jobFamilyOf(
  deps: Pick<AppDeps, 'db'>,
  job: { jobId?: number | null; title?: string | null },
): Promise<RoleFamilyId> {
  const row = job.jobId ? await deps.db.one<JobCategoryRow>(SELECT_JOB_CATEGORIES, [job.jobId]) : undefined;
  if (!row) return resolveJobFamily({ title: job.title ?? null });
  return resolveJobFamily({
    aiCategoryId: row.ai_category_id,
    aiSubcategoryIds: list(row.ai_subcategory_ids),
    categoryId: row.category_id,
    subcategoryIds: list(row.subcategory_ids),
    title: row.title || job.title || null,
  });
}
