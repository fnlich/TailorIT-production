import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { McpToolName } from './profiles';

// v34 MCPDIR (PLAN G8 "Tools"; Claude's Connectors Directory review): every tool's title and its hints, in one table.
// The directory lists a tool by its title and asks whether it only reads (readOnlyHint: true; Claude runs it without a
// confirmation) or what it changes (destructiveHint: true for a removal or an overwrite; Claude always asks first).
// - Read tools: readOnlyHint true, openWorldHint false (destructiveHint and idempotentHint only mean something for a tool
//   that changes things, so they are left out). A read may keep a result set, the person's AI's own cache for paging
//   (search_jobs, filter_jobs); none changes what the person sees.
// - Change tools: all four hints given. v34 MCPDIR (PLAN G8 addendum, MCP 2025-11-25's meaning): destructiveHint true
//   where a call may overwrite, delete or end existing data, or start consequential work: unsave_jobs, queue_remove,
//   queue_clear_finished (remove or archive), own_ai_save (its default "replace" overwrites), prepare_mark (ends a
//   Prepare), prepare_start (queues jobs for auto-apply; rebuild remakes kits), set_prepare_settings (its
//   customInstructions "" clears them), set_prepare_filters (v34 MCPFAN: replaces saved filter values, on several
//   profiles at once). false (only additive): save_jobs, add_job, report_unsupported,
//   custom_filter_verdicts, the prepare_save_* tools (they replace only the AI's own unedited earlier output), and
//   ai_search_jobs, which is no read: each call spends the account's TailorIT AI usage. idempotentHint is true where the
//   same call again changes nothing more (a save that sets the same values, a removal of what is gone, an add of a link
//   already added); false where each call adds (a report, a revision round, an "append", an AI search) or starts
//   something (prepare_start).
// - openWorldHint is true only for add_job: TailorIT reads the posting at the address it is given.
// DIRKIT tells the owner to confirm the additive-write reading with Anthropic before submitting.
// test/mcp-tool-meta.test.ts pins this table against tools/list.

/** A tool's title and hints as tools/list serves them. */
export interface McpToolMeta {
  title: string;
  annotations: ToolAnnotations;
}

const READ = { readOnlyHint: true, openWorldHint: false } as const;
/** A change tool's hints: whether it removes or overwrites, and whether repeating it changes anything more. */
const change = (destructive: boolean, idempotent: boolean) =>
  ({ readOnlyHint: false, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: false }) as const;

/** Every MCP tool's title and annotations, by tool name. */
export const MCP_TOOL_META = {
  prepare_queue: { title: 'Jobs waiting for a kit', annotations: READ },
  prepare_job_context: { title: 'Job kit context', annotations: READ },
  // The analysis and answers are set by value (the same save again stores the same); a resume or letter save stores a
  // document and counts a revision round.
  prepare_save_analysis: { title: 'Save keyword analysis', annotations: change(false, true) },
  prepare_save_resume: { title: 'Save tailored resume', annotations: change(false, false) },
  prepare_save_cover_letter: { title: 'Save cover letter', annotations: change(false, false) },
  prepare_save_answers: { title: 'Save answers', annotations: change(false, true) },
  // Ends the job's Prepare (or a part of it). A job marked once has no active Prepare left: the same mark again is
  // refused and changes nothing.
  prepare_mark: { title: 'Mark a job failed or skipped', annotations: change(true, true) },
  prepare_prompt: { title: 'Get a Prepare step prompt', annotations: READ },
  // v34 MCPDIR (PLAN G8 addendum): the read and the write apart; customInstructions "" clears the person's own words.
  prepare_settings: { title: 'Settings for Prepare', annotations: READ },
  set_prepare_settings: { title: 'Change Prepare settings', annotations: change(true, true) },
  search_jobs: { title: 'Search jobs', annotations: READ },
  job_details: { title: 'Job details', annotations: READ },
  save_jobs: { title: 'Save jobs', annotations: change(false, true) },
  // Archives Saved entries (never deletes them; an applied entry is never touched).
  unsave_jobs: { title: 'Archive saved jobs', annotations: change(true, true) },
  queue_remove: { title: 'Remove from the auto-apply queue', annotations: change(true, true) },
  queue_clear_finished: { title: 'Clear finished queue rows', annotations: change(true, true) },
  queue_list: { title: 'Auto-apply queue', annotations: READ },
  list_applications: { title: 'List Job Tracker entries', annotations: READ },
  application_stats: { title: 'Application statistics', annotations: READ },
  application_timeline: { title: 'Application timeline', annotations: READ },
  // Each call records one more report.
  report_unsupported: { title: 'Report an unsupported request', annotations: change(false, false) },
  instructions: { title: 'TailorIT instructions', annotations: READ },
  filter_jobs: { title: 'Filter jobs', annotations: READ },
  custom_filter_verdicts: { title: 'Save custom filter verdicts', annotations: change(false, true) },
  // Starts Prepares and queues complete kits for auto-apply (a rebuild starts ready kits again): never a no-op to repeat.
  prepare_start: { title: 'Start preparing jobs', annotations: change(true, false) },
  // Each call spends the account's TailorIT AI usage (and may pick other filters): a change, additive, not idempotent.
  ai_search_jobs: { title: 'AI job search', annotations: change(false, false) },
  own_ai_context: { title: 'Get a document-writing task', annotations: READ },
  // "replace" (the default) overwrites; "append" adds again.
  own_ai_save: { title: 'Save a written document', annotations: change(true, false) },
  // Reads the posting's own site; adding the same link again changes nothing.
  add_job: { title: 'Add a job by link', annotations: { ...change(false, true), openWorldHint: true } },
  // v34 MCPFAN (PLAN G5, its G8 addendum): the filters' read and write apart; a change replaces saved filter values
  // (setting the same fields again changes nothing more).
  // v34 FIX-API (the final directory review, D9): a title, never an order ("prepare the filters"). v36 APPLYAPI (PLAN
  // A6): "Prepare & Queue" is "Prepare"; a read tool's title still never starts with the verb ("Filters for Prepare").
  prepare_filters: { title: 'Filters for Prepare', annotations: READ },
  set_prepare_filters: { title: 'Change Prepare filters', annotations: change(true, true) },
} as const satisfies Record<McpToolName, McpToolMeta>;

/** A tool's title and annotations, for its registerTool config. */
export const toolMeta = (tool: McpToolName): McpToolMeta => MCP_TOOL_META[tool];
