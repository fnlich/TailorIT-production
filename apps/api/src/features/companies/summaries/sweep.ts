import { COMPANY_SUMMARY_PROMPT_VERSION } from '../../../ai/prompts/companies/summary';
import type { DailyStep } from '../../../core/feature';
import { summaryStep, type SummaryDeps } from './step';

// v30 E3: the daily sweep (Feature.daily `company-summaries.sweep`): the enrichment queue's `ai` step runs for a new
// company, a hiring-organisation hand-off and an admin's "Refresh now"; the inputs of a summary also change when a
// source is read again (a board's new intro, a posting's About section, a Wikidata description, a fact). Each pass looks
// again (step.ts) at the shared companies with open jobs that are not pending and whose summary sources changed since
// their last look, that had no open jobs at their last look, whose last answer is of an older prompt version, or that
// were never looked at. A look that finds nothing new costs a few reads; a due one is marked for the batch runner.

/** Companies one pass looks at, in pages of SWEEP_PAGE (each look a short transaction of its own). */
export const SWEEP_MAX_PER_PASS = 20_000;
const SWEEP_PAGE = 500;

/** The kinds of source whose rows change what a summary reads (its texts, its facts, an admin's lock). */
const LOOKED_KINDS = ['company_site', 'ats_board', 'job_posting', 'wikidata', 'sec', 'gleif', 'admin'];

const SWEEP_SQL = `SELECT c.id FROM companies c
  LEFT JOIN company_summaries s ON s.company_id = c.id
  WHERE c.id > ? AND c.owner_user_id IS NULL AND c.merged_into_id IS NULL AND NOT c.do_not_fetch
    AND s.due_at IS NULL
    AND EXISTS (SELECT 1 FROM jobs j WHERE j.company_id = c.id AND j.active AND j.owner_user_id IS NULL AND j.held_since IS NULL)
    AND (s.company_id IS NULL
         OR s.last_check = 'no_jobs'
         OR (s.outcome IS NOT NULL AND s.prompt_version <> ?)
         OR EXISTS (SELECT 1 FROM company_sources cs WHERE cs.company_id = c.id
                      AND cs.kind = ANY(CAST(string_to_array(?, ',') AS text[])) AND cs.retrieved_at > s.checked_at))
  ORDER BY c.id LIMIT ?`;

/** One pass of the sweep: answers how many companies it marked pending. */
export async function sweepCompanySummaries(deps: SummaryDeps, max = SWEEP_MAX_PER_PASS): Promise<number> {
  let after = 0;
  let looked = 0;
  let marked = 0;
  while (looked < max) {
    const ids = await deps.db.all<{ id: number }>(SWEEP_SQL, [after, COMPANY_SUMMARY_PROMPT_VERSION, LOOKED_KINDS.join(','), Math.min(SWEEP_PAGE, max - looked)]);
    if (ids.length === 0) break;
    for (const { id } of ids) {
      const step = await summaryStep(deps, Number(id));
      if (step.dueAt !== null) marked += 1;
      after = Number(id);
      looked += 1;
    }
  }
  return marked;
}

/** Feature.daily: `company-summaries.sweep`. */
export const summarySweepStep: DailyStep = { name: 'sweep', run: (deps) => sweepCompanySummaries(deps) };
