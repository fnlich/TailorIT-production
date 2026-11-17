import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { EMPLOYMENT_TYPES, EXPERIENCE_LEVELS, STATUS, type StatusKey } from '@tailorit/shared';
import { AUTOFILL_AGENT_STATES } from '@tailorit/shared/autofill';
import { MCP_REPORT_MISSING_MAX, MCP_REPORT_REQUEST_MAX } from '@tailorit/shared/mcp';
import type { AppDeps } from '../../core/context';
import { MCP_ARG_DESCRIPTIONS, MCP_TOOL_DESCRIPTIONS } from '../../ai/prompts/mcp/tool-descriptions';
import { AppError } from '../../core/http/errors';
import { SOURCE_KINDS } from '../ingest/types';
import { PLATFORMS } from './platform';
import { MAX_DIRECT_IDS, SET_MAX_IDS } from './result-sets';
import {
  APP_FACETS,
  APP_FIELDS,
  applicationTimeline,
  listApplications,
  QUEUE_FACETS,
  QUEUE_FIELDS,
  queueClearFinishedTool,
  queueList,
  queueRemoveTool,
  saveJobsTool,
  unsaveJobsTool,
} from './tools-apps';
import {
  CLEARANCE_FILTERS,
  DETAIL_SECTIONS,
  JOB_FACETS,
  JOB_FIELDS,
  jobDetails,
  PAGE_MAX,
  searchJobs,
  SPONSORSHIP_FILTERS,
} from './tools-jobs';
import { reportUnsupported } from './tools-report';
import { applicationStats, STAT_GROUPS } from './tools-stats';

// v1.5 Q2: the MCP tools that let the person's own AI do the rest of TailorIT: search the jobs, save them, fill and
// filter the auto-apply queue, filter the tracker, count it, read one application, and report what it cannot do.
// server.ts registers them with one call (registerWorkTools). The descriptions are short and never change (an MCP
// client caches them), each with one or two examples of turning a person's words into arguments, and each ends with
// UNSUPPORTED. Answers are compact JSON (tables of rows under `cols`), never prose. The log names the tool, the
// account and done or refused, never an argument's value.

// v30 FIX-B (DECISIONS P6.4): the descriptions (and these two sentences) are ai/prompts/mcp/tool-descriptions.ts'.
export { MCP_UNSUPPORTED as UNSUPPORTED, MCP_WORK_INSTRUCTIONS as WORK_INSTRUCTIONS } from '../../ai/prompts/mcp/tool-descriptions';

const STATUS_KEYS = Object.keys(STATUS) as [StatusKey, ...StatusKey[]];
const Term = z.string().trim().min(1).max(60);
const JobIdList = z.array(z.number().int().positive()).max(MAX_DIRECT_IDS);
const Platform = z.string().refine((value) => PLATFORMS.includes(value), `One of: ${PLATFORMS.join(', ')}`);
const When = z.string().trim().min(1).max(40);
const Tz = z.string().trim().max(64).describe(MCP_ARG_DESCRIPTIONS.tz);
const Range = z.object({ period: When.optional(), from: When.optional(), to: When.optional() });
const Limit = z.number().int().min(1).max(PAGE_MAX);
const Cursor = z.string().max(80);

const Bulk = {
  ids: JobIdList.optional(),
  setId: z.string().max(40).optional(),
  exclude: JobIdList.optional(),
  limit: z.number().int().min(1).max(SET_MAX_IDS).optional(),
};

const AppFilterShape = {
  status: z.array(z.enum(STATUS_KEYS)).max(9).optional(),
  archived: z.enum(['exclude', 'only', 'include']).optional(),
  saved: Range.optional(),
  applied: Range.optional(),
  event: Range.extend({ status: z.enum(STATUS_KEYS) }).optional(),
  platform: z.array(Platform).max(10).optional(),
  company: z.string().max(120).optional(),
  title: z.string().max(120).optional(),
  text: z.string().max(120).optional(),
  draft: z.enum(['ready', 'any', 'none']).optional(),
  queue: z.enum(['queued', 'running', 'finished', 'any', 'none']).optional(),
};

/** Builds one request's tool runner: a JSON answer, a refusal as a tool error, logs without values. */
function runner(deps: AppDeps, userId: string) {
  const json = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  const refuse = (tool: string, error: unknown): CallToolResult => {
    if (error instanceof AppError && error.status < 500) {
      deps.log.debug(`[mcp] account ${userId}: ${tool} refused (${error.code})`);
      return { ...json({ error: { code: error.code, message: error.message } }), isError: true };
    }
    deps.log.error(`[mcp] account ${userId}: ${tool} failed`, error instanceof Error ? error.name : 'unknown');
    return { ...json({ error: { code: 'internal', message: "Something went wrong on TailorIT's side. Try again." } }), isError: true };
  };
  return async (tool: string, work: () => unknown): Promise<CallToolResult> => {
    try {
      const result = await work();
      deps.log.debug(`[mcp] account ${userId}: ${tool} done`);
      return json(result);
    } catch (error) {
      return refuse(tool, error);
    }
  };
}

/** A read (it keeps a result set, the person's AI's own cache, and changes nothing the person sees). */
const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

/** Registers the v1.5 Q2 tools on one request's server, for the token's account. */
export function registerWorkTools(server: McpServer, deps: AppDeps, userId: string, tokenId: string | null): void {
  const run = runner(deps, userId);

  server.registerTool(
    'search_jobs',
    {
      title: 'Search jobs',
      description: MCP_TOOL_DESCRIPTIONS.search_jobs,
      inputSchema: {
        query: z.string().max(200).optional(),
        anyOf: z.array(Term).max(40).optional(),
        allOf: z.array(Term).max(10).optional(),
        notAny: z.array(Term).max(20).optional(),
        expand: z.boolean().optional(),
        title: z.string().max(120).optional(),
        company: z.string().max(120).optional(),
        location: z.string().max(120).optional().describe(MCP_ARG_DESCRIPTIONS.location),
        remote: z.boolean().optional(),
        postedSince: When.optional().describe(MCP_ARG_DESCRIPTIONS.postedSince),
        postedBetween: z.tuple([When, When]).optional(),
        tz: Tz.optional(),
        seniority: z.array(z.enum(EXPERIENCE_LEVELS)).max(5).optional(),
        minYears: z.number().int().min(0).max(30).optional(),
        maxYears: z.number().int().min(0).max(30).optional(),
        clearance: z.enum(CLEARANCE_FILTERS).optional().describe(MCP_ARG_DESCRIPTIONS.clearance),
        sponsorship: z.enum(SPONSORSHIP_FILTERS).optional().describe(MCP_ARG_DESCRIPTIONS.sponsorship),
        platform: z.array(Platform).max(10).optional().describe(MCP_ARG_DESCRIPTIONS.platform),
        salaryMin: z.number().int().min(0).max(5_000_000).optional().describe(MCP_ARG_DESCRIPTIONS.salaryMin),
        source: z.array(z.enum(SOURCE_KINDS)).max(10).optional(),
        type: z.array(z.enum(EMPLOYMENT_TYPES)).max(4).optional(),
        excludeApplied: z.boolean().optional(),
        excludeSaved: z.boolean().optional(),
        excludeQueued: z.boolean().optional(),
        sort: z.enum(['relevance', 'newest']).optional(),
        countOnly: z.boolean().optional(),
        facets: z.array(z.enum(JOB_FACETS)).max(6).optional(),
        fields: z.array(z.enum(JOB_FIELDS)).max(JOB_FIELDS.length).optional(),
        limit: Limit.optional(),
        cursor: Cursor.optional().describe(MCP_ARG_DESCRIPTIONS.cursor),
      },
      annotations: READ,
    },
    (args) => run('search_jobs', () => searchJobs(deps, userId, args)),
  );

  server.registerTool(
    'job_details',
    {
      title: 'Job details',
      description: MCP_TOOL_DESCRIPTIONS.job_details,
      inputSchema: {
        jobId: z.number().int().positive().optional(),
        jobIds: z.array(z.number().int().positive()).max(10).optional(),
        maxChars: z.number().int().min(100).max(20_000).optional(),
        sections: z.array(z.enum(DETAIL_SECTIONS)).max(3).optional(),
        tz: Tz.optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => run('job_details', () => jobDetails(deps, userId, args)),
  );

  server.registerTool(
    'save_jobs',
    {
      title: 'Save jobs',
      description: MCP_TOOL_DESCRIPTIONS.save_jobs,
      inputSchema: { ...Bulk, date: When.optional().describe(MCP_ARG_DESCRIPTIONS.date), tz: Tz.optional() },
      annotations: { ...WRITE, idempotentHint: true },
    },
    (args) => run('save_jobs', () => saveJobsTool(deps, userId, args)),
  );

  server.registerTool(
    'unsave_jobs',
    {
      title: 'Unsave jobs',
      description: MCP_TOOL_DESCRIPTIONS.unsave_jobs,
      inputSchema: Bulk,
      annotations: { ...WRITE, idempotentHint: true },
    },
    (args) => run('unsave_jobs', () => unsaveJobsTool(deps, userId, args)),
  );

  // v2.0 P5: queue_add is removed (A4): jobs reach the queue only through prepare_start and the saves.

  server.registerTool(
    'queue_remove',
    {
      title: 'Remove from the auto-apply queue',
      description: MCP_TOOL_DESCRIPTIONS.queue_remove,
      inputSchema: Bulk,
      annotations: { ...WRITE, idempotentHint: true },
    },
    (args) => run('queue_remove', () => queueRemoveTool(deps, userId, args)),
  );

  server.registerTool(
    'queue_clear_finished',
    {
      title: 'Clear finished queue rows',
      description: MCP_TOOL_DESCRIPTIONS.queue_clear_finished,
      inputSchema: {},
      annotations: { ...WRITE, idempotentHint: true },
    },
    () => run('queue_clear_finished', () => queueClearFinishedTool(deps, userId)),
  );

  server.registerTool(
    'queue_list',
    {
      title: 'Auto-apply queue',
      description: MCP_TOOL_DESCRIPTIONS.queue_list,
      inputSchema: {
        state: z.array(z.enum(AUTOFILL_AGENT_STATES)).max(6).optional(),
        platform: z.array(Platform).max(10).optional(),
        company: z.string().max(120).optional(),
        title: z.string().max(120).optional(),
        source: z.array(z.enum(['manual', 'rule'])).max(2).optional(),
        run: z.array(z.enum(['agent', 'tab', 'manual'])).max(3).optional(),
        countOnly: z.boolean().optional(),
        facets: z.array(z.enum(QUEUE_FACETS)).max(4).optional(),
        fields: z.array(z.enum(QUEUE_FIELDS)).max(QUEUE_FIELDS.length).optional(),
        limit: Limit.optional(),
        cursor: Cursor.optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => run('queue_list', () => queueList(deps, userId, args)),
  );

  server.registerTool(
    'list_applications',
    {
      title: 'Job Tracker entries',
      description: MCP_TOOL_DESCRIPTIONS.list_applications,
      inputSchema: {
        ...AppFilterShape,
        tz: Tz.optional(),
        sort: z.enum(['updated', 'applied', 'saved']).optional(),
        countOnly: z.boolean().optional(),
        facets: z.array(z.enum(APP_FACETS)).max(4).optional(),
        fields: z.array(z.enum(APP_FIELDS)).max(APP_FIELDS.length).optional(),
        limit: Limit.optional(),
        cursor: Cursor.optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => run('list_applications', () => listApplications(deps, userId, args)),
  );

  server.registerTool(
    'application_stats',
    {
      title: 'Application statistics',
      description: MCP_TOOL_DESCRIPTIONS.application_stats,
      inputSchema: {
        metric: z.enum(['count']).optional(),
        groupBy: z.array(z.enum(STAT_GROUPS)).max(2).optional(),
        event: z.enum(STATUS_KEYS).optional(),
        period: When.optional(),
        from: When.optional(),
        to: When.optional(),
        tz: Tz.optional(),
        filters: z.object(AppFilterShape).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => run('application_stats', () => applicationStats(deps, userId, args)),
  );

  server.registerTool(
    'application_timeline',
    {
      title: 'One application',
      description: MCP_TOOL_DESCRIPTIONS.application_timeline,
      inputSchema: { applicationId: z.string().min(1).max(64) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ applicationId }) => run('application_timeline', () => applicationTimeline(deps, userId, applicationId)),
  );

  server.registerTool(
    'report_unsupported',
    {
      title: 'Report an unsupported request',
      description: MCP_TOOL_DESCRIPTIONS.report_unsupported,
      inputSchema: {
        request: z.string().trim().min(1).max(MCP_REPORT_REQUEST_MAX),
        missing: z.string().trim().min(1).max(MCP_REPORT_MISSING_MAX),
        triedTools: z.array(z.string().max(64)).max(20).optional(),
      },
      annotations: { ...WRITE, idempotentHint: false },
    },
    (args) => run('report_unsupported', () => reportUnsupported(deps, userId, tokenId, args)),
  );
}
