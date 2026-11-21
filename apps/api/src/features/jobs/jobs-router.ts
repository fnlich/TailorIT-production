import { Router, type Request } from 'express';
import {
  JOB_FACETS,
  JobFacetQuerySchema,
  JobIdParam,
  JobReportBodySchema,
  levelMatch,
  matchResult,
  noResumeMatch,
  readRowMatchIds, // v31 FIX-JOBS
  searchParamsToJobsQuery,
  type JobAnalysisView,
  type JobFacetResponse,
  type JobGlance, // v33 JOBDETAIL
  type JobInsights, // v33 JOBDETAIL: the shared contract
  type JobMatchWithLevel, // v33 JOBDETAIL: the shared contract
  type MatchResult,
} from '@tailorit/shared';
import { z } from 'zod';
import { actorOf, holds, isActing, requireUser, userOf } from '../../core/auth/guards'; // v33 SHARE-6: actorOf, isActing; FIX-2: holds
import type { AppDeps } from '../../core/context';
import { AppError, notFound, validationFailed } from '../../core/http/errors';
import { parseInput } from '../../core/http/validate';
import { postingBenefits } from '../job-analysis/benefits'; // v33 JOBDETAIL
import { getResumeEvidence } from '../resumes/evidence';
import { analysisForJob, jobLevels } from './analysis';
import { facetItems, facetsSummary } from './facets';
import { jobGlance } from './glance'; // v33 JOBDETAIL
import { rowMatches } from './matches'; // v31 FIX-JOBS
import { sanitizeDescription } from './html';
import { reportJob } from './report';
import { experienceLevelsOf, toJobDetail } from './rows';
import { countJobs, searchJobs, searchScopeOf } from './search';
import { plainTextOf } from './text'; // v33 JOBDETAIL
import {
  hiddenState,
  loadDetailRow,
  loadLocations,
  markViewed,
  preferredLevels,
  requireJob,
  setJobHidden,
} from './store';

// v33 JOBDETAIL: GET /api/jobs/:id/match's and /insights' shapes are the shared JobMatchWithLevel and JobInsights.

/**
 * The resume linked to the viewer's application for a job the Jobs page shows as tracked (saved, or applied and on,
 * archived or not), or null. An un-saved job (an archived application that never got past Saved) is not tracked.
 */
async function linkedResumeOf(deps: AppDeps, userId: string, jobId: number): Promise<string | null> {
  const row = await deps.db.one<{ resume_id: string }>(
    `SELECT resume_id FROM applications WHERE user_id = ? AND job_id = ? AND resume_id IS NOT NULL
       AND (archived_at IS NULL OR current_status >= 2)`,
    [userId, jobId],
  );
  return row?.resume_id ?? null;
}

/**
 * The card's match, with the experience-level check: a tracked job scores the resume linked to its application (the
 * one Resume Score and the tracker's picker score, so the three agree), any other job the default resume. With
 * `nameResume` the answer also names the resume it scored ("Scored with {label}") and which of the two it was.
 */
async function matchFor(
  deps: AppDeps,
  userId: string,
  job: { id: number; experience_levels: string },
  analysis: JobAnalysisView | null,
  options: { nameResume?: boolean } = {},
): Promise<JobMatchWithLevel> {
  const keywords = analysis?.keywords ?? { high: [], low: [] };
  const linkedId = await linkedResumeOf(deps, userId, job.id);
  const linked = linkedId ? await getResumeEvidence(deps, userId, linkedId) : null;
  const evidence = linked ?? (await getResumeEvidence(deps, userId));
  let match: MatchResult = noResumeMatch(keywords);
  if (evidence) {
    match = matchResult(evidence.text, keywords, evidence.resumeId);
    if (options.nameResume) match = { ...match, resumeLabel: evidence.label, resumeBasis: linked ? 'linked' : 'default' };
  }
  return {
    ...match,
    levelMatch: levelMatch(jobLevels(experienceLevelsOf(job.experience_levels), analysis), await preferredLevels(deps, userId)),
  };
}

/** A job id from the path; anything that is not one is a job that does not exist. */
export function jobIdOf(req: Request): number {
  const parsed = JobIdParam.safeParse(req.params.id);
  if (!parsed.success) throw notFound('That job');
  return parsed.data;
}

const FacetParam = z.enum(JOB_FACETS);

/** Mounted at /api/jobs. Every route needs a signed-in account. */
export function createJobsRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireUser);

  // The list: every filter of the page (the URL's own keys), 21 per page, "Found N jobs".
  router.get('/', async (req, res) => {
    const user = userOf(req);
    const query = searchParamsToJobsQuery(req.query as Record<string, unknown>);
    res.json(await searchJobs(deps.db, query, searchScopeOf(deps, user.id)));
  });

  router.get('/count', async (req, res) => {
    const user = userOf(req);
    const query = searchParamsToJobsQuery(req.query as Record<string, unknown>);
    res.json({ total: await countJobs(deps.db, query, searchScopeOf(deps, user.id)) });
  });

  // v31 FIX-JOBS: the feed's per-row keyword match, for the jobs a list page shows (ids=1,2,3). Before /:id.
  router.get('/matches', async (req, res) => {
    const ids = readRowMatchIds(req.query.ids);
    if (!ids) throw validationFailed('List the jobs by their ids, separated by commas.', { ids: 'Job ids, separated by commas' });
    res.json({ items: await rowMatches(deps, userOf(req).id, ids, linkedResumeOf) });
  });

  router.get('/facets/summary', async (req, res) => {
    res.json(await facetsSummary(deps, userOf(req).id));
  });

  router.get('/facets/:facet', async (req, res) => {
    const facet = FacetParam.safeParse(req.params.facet);
    if (!facet.success) throw new AppError('not_found', 'There is no such filter list.');
    const { q, limit } = parseInput(JobFacetQuerySchema, req.query, 'filter search');
    const items = await facetItems(deps, userOf(req).id, facet.data, q || undefined, limit);
    const body: JobFacetResponse = { facet: facet.data, items };
    res.json(body);
  });

  // A page job an upgrade closed answers as the shared job it gave way to (its detail's id says so: the page opens it).
  router.get('/:id', async (req, res) => {
    const user = userOf(req);
    const jobId = (await requireJob(deps, jobIdOf(req), user.id)).id;
    const row = await loadDetailRow(deps, user.id, jobId);
    const descriptionHtml = sanitizeDescription(row.description_html);
    const detail = toJobDetail(row, await loadLocations(deps, jobId), descriptionHtml, await hiddenState(deps, user.id, jobId, row.company_id));
    // v33 SHARE-6 (PLAN-sharing §4 "Explicit changes"): someone working on a shared profile never marks the owner's job
    // viewed (the owner's "new" marks stay theirs).
    if (!isActing(req)) await markViewed(deps, user.id, jobId);
    // v33 JOBDETAIL (F2): the posting's benefits, read from its own words (no AI). v33 FIX-2: a heading that is the job's
    // title is never a benefits part.
    res.json({ ...detail, benefits: postingBenefits(plainTextOf(descriptionHtml), { title: detail.title }) });
  });

  // The best analysis of the job so far. Opening a job queues Claude's analysis only with AI_JOB_ANALYSIS=lazy (J1's
  // service decides); by default the add-time backlog has Claude read every added job, and opening one queues nothing.
  router.get('/:id/analysis', async (req, res) => {
    const jobId = (await requireJob(deps, jobIdOf(req), userOf(req).id)).id;
    // v33 SHARE-6 (PLAN-sharing §4 "Explicit changes"): a lazy view's analysis counts in the hour of who opens the job.
    const analysis = await analysisForJob(deps, jobId, { queue: true, userId: actorOf(req).id });
    if (!analysis) throw notFound('That job');
    res.json(analysis);
  });

  // The card's match on its own, in its original shape (the tracker's Resume Score answers the same for a tracked job).
  router.get('/:id/match', async (req, res) => {
    const user = userOf(req);
    const job = await requireJob(deps, jobIdOf(req), user.id);
    const body: JobMatchWithLevel = await matchFor(deps, user.id, job, await analysisForJob(deps, job.id, { queue: false }));
    res.json(body);
  });

  // What the job page polls: the analysis (asked for as /analysis asks) and the match read off that same analysis. A
  // match that fails leaves the summary standing.
  router.get('/:id/insights', async (req, res) => {
    const user = userOf(req);
    const job = await requireJob(deps, jobIdOf(req), user.id);
    const jobId = job.id;
    const analysis = await analysisForJob(deps, jobId, { queue: true, userId: actorOf(req).id }); // v33 SHARE-6: the actor's hour
    if (!analysis) throw notFound('That job');
    let match: JobMatchWithLevel | null = null;
    try {
      match = await matchFor(deps, user.id, job, analysis, { nameResume: true });
    } catch (error) {
      deps.log.warn(`[jobs] the keyword match failed for job ${jobId}`, error);
    }
    // v33 JOBDETAIL (F2): Requirements at a glance, verdicts only (glance.ts). A glance that fails leaves the rest.
    let glance: JobGlance | undefined;
    try {
      const levels = jobLevels(experienceLevelsOf(job.experience_levels), analysis);
      // v33 FIX-2 (final review, security 2): on a share without Autofill info's See, the owner's Autofill profile
      // (degree, years, licences) never decides a verdict: the scored resume's reading alone.
      const withProfile = !isActing(req) || holds(req, 'autofill:view');
      glance = await jobGlance(deps, user.id, { id: jobId, levels, requiredYears: analysis.requiredYears }, match?.resumeId ?? null, { withProfile });
    } catch (error) {
      deps.log.warn(`[jobs] the requirements at a glance failed for job ${jobId}`, error);
    }
    const body: JobInsights = { analysis, match, ...(glance ? { glance } : {}) };
    res.json(body);
  });

  router.post('/:id/hide', async (req, res) => {
    const user = userOf(req);
    const jobId = (await requireJob(deps, jobIdOf(req), user.id)).id;
    await setJobHidden(deps, user.id, jobId, true);
    res.json({ hidden: true });
  });

  router.delete('/:id/hide', async (req, res) => {
    const user = userOf(req);
    const jobId = (await requireJob(deps, jobIdOf(req), user.id)).id;
    await setJobHidden(deps, user.id, jobId, false);
    res.json({ hidden: false });
  });

  router.post('/:id/report', async (req, res) => {
    const user = userOf(req);
    const asked = jobIdOf(req);
    const body = parseInput(JobReportBodySchema, req.body, 'report');
    const jobId = (await requireJob(deps, asked, user.id)).id;
    res.status(201).json(await reportJob(deps, user.id, jobId, body));
  });

  return router;
}
