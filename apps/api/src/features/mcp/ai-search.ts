import type { JobsQuery } from '@tailorit/shared';
import { assertFeature } from '../../core/accounts/entitlements';
import { aiUnavailableError } from '../../core/accounts/refusals';
import { constantsOf } from '../../core/constants/service';
import type { SaveContext } from './save'; // v33 SHARE-8
import { AppError, validationFailed } from '../../core/http/errors'; // v34 FIX-API: AppError
import { assertServerAi } from '../../core/seams';
import { searchJobs, type SearchArgs } from './tools-jobs';

// v2.0 P5 (A16; 04-accounts-limits.md §4, 07-mcp.md): ai_search_jobs, the one MCP tool that runs TailorIT's own AI.
// Paid only: assertFeature('ai_job_search') refuses a Free account (403 paid_feature, MSG_PAID_AI_SEARCH) before
// anything else; then the AI gate (ai_unavailable, ai_usage_exhausted, P1); then P6a's AiSearchService queues the
// `job_search` task charged to the person (it checks both again) and the tool waits for it, up to AI_SEARCH_WAIT_MS.
// The sentence becomes the classic search's filters (JobsQuery), which this tool runs as search_jobs does and answers
// the same way, with the filters it used and the ones search_jobs has no place for. The classic search_jobs stays for
// everyone: there the person's own AI reads their words.

/** A message after a field's name and a colon: its first letter in lower case. */
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** How long the tool waits for the task. */
export const AI_SEARCH_WAIT_MS = 60_000;

/** v34 FIX-API (the final directory review, D10): the free way, after a plan's refusal of AI job search over MCP. */
export const SEARCH_JOBS_INSTEAD = 'Search with search_jobs instead: it is on every plan.';

/** The Jobs page's filters MCP's search has no place for: named in the answer, never silently dropped. */
const UNMAPPED = ['categories', 'subcategories', 'leadership', 'industries', 'companySizes', 'companies'] as const;

/** The classic search's query as search_jobs' arguments, and the filters that have no place there. */
export function searchArgsOf(query: JobsQuery): { args: SearchArgs; notApplied: string[] } {
  const args: SearchArgs = {};
  const notApplied: string[] = UNMAPPED.filter((key) => query[key].length > 0);
  if (query.q) args.query = query.q;
  if (query.locations.length > 0) args.location = query.locations[0]!;
  if (query.locations.length > 1) notApplied.push('locations (only the first is searched)');
  if (query.remote || query.arrangements.includes('remote')) args.remote = true;
  const otherArrangements = query.arrangements.filter((arrangement) => arrangement !== 'remote');
  if (otherArrangements.length > 0) notApplied.push('arrangements');
  if (query.jobTypes.length > 0) args.type = [...query.jobTypes];
  if (query.levels.length > 0) args.seniority = [...query.levels];
  if (query.minSalary !== undefined) {
    if (query.payPeriod === undefined || query.payPeriod === 'year') args.salaryMin = query.minSalary;
    else notApplied.push('minSalary (not yearly)');
  }
  if (query.h1b) args.sponsorship = 'yes';
  if (query.clearance === 'required') args.clearance = 'required';
  if (query.clearance === 'not_required') args.clearance = 'none';
  if (query.hideApplied) args.excludeApplied = true;
  if (query.updatedWithin !== undefined) args.postedSince = `${query.updatedWithin}d`;
  args.sort = query.sort === 'posted' ? 'newest' : 'relevance';
  return { args, notApplied };
}

export async function aiSearchJobs(
  ctx: Pick<SaveContext, 'deps' | 'userId' | 'profile' | 'sets'>,
  input: { text: string; limit?: number },
): Promise<Record<string, unknown>> {
  // v33 SHARE-8 (SHARE-3's edit 7): the caller pays and their plan decides, on every profile (payerOfGrant(grant,
  // 'mcp') on another person's: B's budget, B's Paid feature; A's spend stays 0). The search reads the profile's flags.
  const { deps, userId } = ctx;
  const payer = ctx.profile.payer;
  try {
    await assertFeature(deps, payer, 'ai_job_search');
  } catch (error) {
    // v34 FIX-API (the final directory review, D10): the refusal names the free way (search_jobs).
    if (error instanceof AppError && error.code === 'paid_feature') throw new AppError('paid_feature', `${error.message} ${SEARCH_JOBS_INSTEAD}`);
    throw error;
  }
  const text = input.text.trim();
  const max = constantsOf(deps).get('AI_SEARCH_TEXT_MAX_CHARS');
  if (!text) throw validationFailed('text: say what jobs the person is looking for.');
  // v2.0 FIX-C (REQ-3): MSG_TEXT_TOO_LONG, after the field's name as before ("text: use at most 500 characters.").
  if ([...text].length > max) throw validationFailed(`text: ${lowerFirst(constantsOf(deps).message('MSG_TEXT_TOO_LONG', { max }))}`);
  await assertServerAi(deps, payer);
  const service = deps.services.aiSearch;
  if (!service) throw aiUnavailableError(deps);
  const { taskId } = await service.start(userId, text, payer);
  const result = await service.result(userId, taskId, AI_SEARCH_WAIT_MS);
  const { args, notApplied } = searchArgsOf(result.query);
  const answer = await searchJobs(deps, userId, { ...args, ...(input.limit !== undefined ? { limit: input.limit } : {}) }, ctx.sets);
  deps.log.debug(`[mcp] account ${userId}: ai_search_jobs searched`);
  return {
    ...answer,
    filters: args,
    explanation: result.explanation,
    ...(notApplied.length > 0 ? { notApplied } : {}),
  };
}
