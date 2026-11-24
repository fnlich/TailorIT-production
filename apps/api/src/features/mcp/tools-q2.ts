import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EMPLOYMENT_TYPES, EXPERIENCE_LEVELS, STATUS, type StatusKey } from '@tailorit/shared';
import { AUTOFILL_AGENT_STATES } from '@tailorit/shared/autofill';
import { MCP_REPORT_MISSING_MAX, MCP_REPORT_REQUEST_MAX } from '@tailorit/shared/mcp';
import { MCP_ARG_DESCRIPTIONS, MCP_TOOL_DESCRIPTIONS } from '../../ai/prompts/mcp/tool-descriptions';
import { SOURCE_KINDS } from '../ingest/types';
import { PLATFORMS } from './platform';
import { ProfileArg, type McpSession } from './profiles'; // v33 SHARE-8
import { MAX_DIRECT_IDS, SET_MAX_IDS } from './result-sets';
import { refuseFencedData } from './save'; // v33 SHARE-8 (review)
import { toolMeta } from './tool-meta'; // v34 MCPDIR
import { onManyOrOne, saveJobsOnMany, unsaveJobsOnMany } from './tools-fanout'; // v34 MCPFAN
import { refuseWrittenLeaks } from './written'; // v34 MCPDIR
import {
  APP_FACETS,
  APP_FIELDS,
  APP_STATUS_FILTERS, // v33 TRACKER
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
// client caches them), some with an example of turning a person's words into arguments. Answers are compact JSON (tables of rows under `cols`), never prose. The log names the tool, the
// account and done or refused, never an argument's value.

// v30 FIX-B (DECISIONS P6.4): the descriptions are ai/prompts/mcp/tool-descriptions.ts'. v34 MCPDIR: they no longer end
// with "Else: report_unsupported." (its own description and the instructions say when to report).

const STATUS_KEYS = Object.keys(STATUS) as [StatusKey, ...StatusKey[]];
const Term = z.string().trim().min(1).max(60);
const JobIdList = z.array(z.number().int().positive()).max(MAX_DIRECT_IDS);
const Platform = z.string().refine((value) => PLATFORMS.includes(value), `One of: ${PLATFORMS.join(', ')}`);
const When = z.string().trim().min(1).max(40);
const Tz = z.string().trim().max(64).describe(MCP_ARG_DESCRIPTIONS.tz);
const Range = z.object({ period: When.optional(), from: When.optional(), to: When.optional() });
const Limit = z.number().int().min(1).max(PAGE_MAX);
const Cursor = z.string().max(80);

/** v34 MCPDIR: a removal's confirmation, the count its refusal named (the tool's description says so). */
const Confirm = z.number().int().nonnegative().optional();

const Bulk = {
  ids: JobIdList.optional(),
  setId: z.string().max(40).optional(),
  exclude: JobIdList.optional(),
  limit: z.number().int().min(1).max(SET_MAX_IDS).optional(),
};

const AppFilterShape = {
  status: z.array(z.enum(APP_STATUS_FILTERS)).max(9).optional(), // v33 TRACKER (F1): `draft` still read, as saved + queued
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

/** v33 SHARE-8: a tool's arguments without `profile` (the session reads it; a result set never keeps it). */
function argsOf<T extends { profile?: string }>(args: T): Omit<T, 'profile'> {
  const { profile: _profile, ...rest } = args;
  return rest;
}

/**
 * Registers the v1.5 Q2 tools on one request's server, for the token's account. v33 SHARE-8: each takes `profile`
 * (report_unsupported: the caller's own) and runs on the profile the session decides (profiles.ts); its result sets are
 * the caller's on that profile (ctx.sets).
 */
export function registerWorkTools(server: McpServer, session: McpSession): void {
  const run = session.run;

  server.registerTool(
    'search_jobs',
    {
      ...toolMeta('search_jobs'),
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
        profile: ProfileArg,
      },
    },
    (args) => run('search_jobs', args, (ctx) => searchJobs(ctx.deps, ctx.userId, argsOf(args), ctx.sets)),
  );

  server.registerTool(
    'job_details',
    {
      ...toolMeta('job_details'),
      description: MCP_TOOL_DESCRIPTIONS.job_details,
      inputSchema: {
        jobId: z.number().int().positive().optional(),
        jobIds: z.array(z.number().int().positive()).max(10).optional(),
        maxChars: z.number().int().min(100).max(20_000).optional(),
        sections: z.array(z.enum(DETAIL_SECTIONS)).max(3).optional(),
        tz: Tz.optional(),
        profile: ProfileArg,
      },
    },
    // A job id here is a job of the pool, not a Prepare: the profile is "me" unless named.
    (args) => run('job_details', { profile: args.profile }, (ctx) => jobDetails(ctx.deps, ctx.userId, argsOf(args))),
  );

  server.registerTool(
    'save_jobs',
    {
      ...toolMeta('save_jobs'),
      description: MCP_TOOL_DESCRIPTIONS.save_jobs,
      inputSchema: { ...Bulk, date: When.optional().describe(MCP_ARG_DESCRIPTIONS.date), tz: Tz.optional(), profile: ProfileArg },
    },
    // v34 MCPFAN: several profiles ("all", or keys joined by commas) answer per profile (tools-fanout.ts).
    (args) =>
      onManyOrOne(
        session,
        'save_jobs',
        args,
        (own, many) => saveJobsOnMany(session, own, many, argsOf(args)),
        () => run('save_jobs', args, (ctx) => saveJobsTool(ctx.deps, ctx.userId, argsOf(args), ctx.sets)),
      ),
  );

  server.registerTool(
    'unsave_jobs',
    {
      ...toolMeta('unsave_jobs'),
      description: MCP_TOOL_DESCRIPTIONS.unsave_jobs,
      inputSchema: { ...Bulk, confirm: Confirm, profile: ProfileArg },
    },
    // v34 MCPFAN
    (args) =>
      onManyOrOne(
        session,
        'unsave_jobs',
        args,
        (own, many) => unsaveJobsOnMany(session, own, many, argsOf(args)),
        // v36 FIX-API (D1): on a shared profile, its share decides whether queued jobs leave the queue.
        () =>
          run('unsave_jobs', args, (ctx) =>
            unsaveJobsTool(ctx.deps, ctx.userId, argsOf(args), ctx.sets, ctx.profile.grant ? { grantId: ctx.profile.grant.id, actorId: ctx.caller.id } : null),
          ),
      ),
  );

  // v2.0 P5: queue_add is removed (A4): jobs reach the queue only through prepare_start and the saves.

  server.registerTool(
    'queue_remove',
    {
      ...toolMeta('queue_remove'),
      description: MCP_TOOL_DESCRIPTIONS.queue_remove,
      inputSchema: { ...Bulk, confirm: Confirm, profile: ProfileArg },
    },
    (args) => run('queue_remove', args, (ctx) => queueRemoveTool(ctx.deps, ctx.userId, argsOf(args), ctx.sets)),
  );

  server.registerTool(
    'queue_clear_finished',
    {
      ...toolMeta('queue_clear_finished'),
      description: MCP_TOOL_DESCRIPTIONS.queue_clear_finished,
      inputSchema: { confirm: Confirm, profile: ProfileArg },
    },
    (args) => run('queue_clear_finished', args, (ctx) => queueClearFinishedTool(ctx.deps, ctx.userId, args.confirm)),
  );

  server.registerTool(
    'queue_list',
    {
      ...toolMeta('queue_list'),
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
        profile: ProfileArg,
      },
    },
    (args) => run('queue_list', args, (ctx) => queueList(ctx.deps, ctx.userId, argsOf(args), ctx.sets)),
  );

  server.registerTool(
    'list_applications',
    {
      ...toolMeta('list_applications'),
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
        profile: ProfileArg,
      },
    },
    (args) => run('list_applications', args, (ctx) => listApplications(ctx.deps, ctx.userId, argsOf(args), ctx.sets)),
  );

  server.registerTool(
    'application_stats',
    {
      ...toolMeta('application_stats'),
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
        profile: ProfileArg,
      },
    },
    (args) => run('application_stats', args, (ctx) => applicationStats(ctx.deps, ctx.userId, argsOf(args))),
  );

  server.registerTool(
    'application_timeline',
    {
      ...toolMeta('application_timeline'),
      description: MCP_TOOL_DESCRIPTIONS.application_timeline,
      inputSchema: { applicationId: z.string().min(1).max(64), profile: ProfileArg },
    },
    ({ applicationId, profile }) =>
      run('application_timeline', { profile }, (ctx) => applicationTimeline(ctx.deps, ctx.userId, applicationId)),
  );

  server.registerTool(
    'report_unsupported',
    {
      ...toolMeta('report_unsupported'),
      description: MCP_TOOL_DESCRIPTIONS.report_unsupported,
      inputSchema: {
        request: z.string().trim().min(1).max(MCP_REPORT_REQUEST_MAX),
        missing: z.string().trim().min(1).max(MCP_REPORT_MISSING_MAX),
        triedTools: z.array(z.string().max(64)).max(20).optional(),
      },
    },
    // v33 SHARE-8: the caller's own report (Settings › Integrations), whatever profile the AI worked on.
    // v33 SHARE-8 (review): a report is a save too: refused when it holds a tripwire of the caller's grants.
    (args) =>
      run('report_unsupported', {}, async (ctx) => {
        refuseFencedData(ctx, [args.request, args.missing, args.triedTools ?? []]);
        await refuseWrittenLeaks(ctx, [args.request, args.missing]); // v34 MCPDIR
        return reportUnsupported(ctx.deps, ctx.caller.id, session.tokenId, args);
      }),
  );
}
