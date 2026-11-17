import { defineEnrichmentStep } from './registry';

// v30 E1: the `ats_board` step (docs/design/part2/13-company-enrichment.md §7: "ATS board name and intro: every ingest
// run, already fetched"). A board's words about its company are read by the board's own ingest run (resolveCompany
// keeps them as the company's ats_board source), so this step reads nothing itself: it makes the company's enabled
// board sources due now, and the ingest worker's due queue reads them at its next look (with their pace, holds and
// robots.txt). New companies are never queued for it (resolve.ts NEW_COMPANY_STEPS); Admin › Companies' "Refresh now"
// is.
export const atsBoardStep = defineEnrichmentStep({
  name: 'ats_board',
  handles: ['ats_board'],
  async run(deps, work) {
    await deps.db.run('UPDATE job_sources SET next_run_at = LEAST(next_run_at, CAST(? AS timestamptz)) WHERE company_id = ? AND enabled', [
      work.at,
      work.companyId,
    ]);
    return { kind: 'done' };
  },
});
