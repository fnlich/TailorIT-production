import { MCP_TOOL_CATALOG, type McpCatalogTool, type McpToolCatalog } from '@tailorit/shared/mcp-catalog';

// v34 HELP (PLAN G6): the tool reference's words for people. The tools themselves (names, titles, annotations, whether
// they take a profile) come from the server (@tailorit/shared/mcp-catalog, generated from tools/list); this map adds a
// one-line summary and the group each is listed under. help.test.ts checks that every tool of the catalogue has exactly
// one entry here and none is extra: after `npm run help:tools` adds a tool, add its line.

export const TOOL_GROUPS = [
  { id: 'find', title: 'Find jobs' },
  { id: 'track', title: 'Save and track' },
  { id: 'queue', title: 'The auto-apply queue' },
  { id: 'prepare', title: 'Prepare & Queue with your AI' },
  { id: 'documents', title: 'Documents with your AI' },
  { id: 'setup', title: 'Rules, settings and reports' },
] as const;
export type ToolGroup = (typeof TOOL_GROUPS)[number]['id'];

export interface ToolSummary {
  group: ToolGroup;
  /** One line in plain words: what the tool does for you. */
  summary: string;
  /**
   * v34 FIX-COPY (final review dir D6): a tool that changes no data but is not read only because each call spends the
   * account's AI use (ai_search_jobs: readOnlyHint false, destructiveHint false; docs/directory/LISTING.md says so too).
   */
  spendsAi?: true;
}

/** Every tool's line, by tool name. */
export const TOOL_SUMMARIES: Readonly<Record<string, ToolSummary>> = {
  search_jobs: { group: 'find', summary: 'Searches every job TailorIT holds by words, date, place, remote, pay, clearance, sponsorship and more; counts first.' },
  ai_search_jobs: {
    group: 'find',
    summary: "Paid accounts: TailorIT's own AI turns your sentence into search filters. It changes nothing; each call counts toward your AI use.",
    spendsAi: true,
  },
  job_details: { group: 'find', summary: "One line per job: seniority, years asked, salary, top keywords; the posting's text only when asked." },
  // v34 MCPFAN (the review round, spec L10): the three that also take several profiles say so.
  add_job: {
    group: 'track',
    summary: 'Adds a job from its posting link (TailorIT reads the posting) and saves it on one, several or all profiles.',
  },
  save_jobs: {
    group: 'track',
    summary: 'Saves jobs (by id or a whole search result) to the Job Tracker, on one, several or all profiles; a tracked job keeps its status.',
  },
  unsave_jobs: { group: 'track', summary: 'Archives saved jobs on one, several or all profiles; a job you applied to is never touched.' },
  list_applications: { group: 'track', summary: 'Lists your Job Tracker entries by status, dates, company, title or platform.' },
  application_stats: { group: 'track', summary: 'Counts your applications: by status, by week or month, by platform or company.' },
  application_timeline: { group: 'track', summary: "One application's story: each status change with its day, and its queue row." },
  queue_list: { group: 'queue', summary: 'The auto-apply queue: what is running, waiting and finished, and why a job needs you.' },
  queue_remove: { group: 'queue', summary: 'Takes jobs out of the auto-apply queue (a job being applied to right now stays).' },
  queue_clear_finished: { group: 'queue', summary: 'Removes every finished row from the auto-apply queue.' },
  filter_jobs: { group: 'prepare', summary: 'Runs your saved Prepare filters over your saved jobs and says which pass and why.' },
  custom_filter_verdicts: { group: 'prepare', summary: 'Saves your AI\'s verdicts for the Custom filter, judged only against your own words.' },
  prepare_start: { group: 'prepare', summary: 'Starts Prepare & Queue with your AI for every job that passed the filters.' },
  prepare_queue: { group: 'prepare', summary: 'The jobs waiting for your AI to write their kit, on every profile at once.' },
  prepare_job_context: { group: 'prepare', summary: 'One job to prepare: its resume, whether a letter is wanted, its keywords, its questions and the next step.' },
  prepare_prompt: { group: 'prepare', summary: "TailorIT's prompt for one step of a job's kit (analyze, review, tailor, revise, letter, answers)." },
  prepare_save_analysis: { group: 'prepare', summary: "Saves the job's keyword analysis; TailorIT keeps only words the posting really has." },
  prepare_save_resume: { group: 'prepare', summary: "Saves the tailored resume; TailorIT keeps your employers, titles, dates and figures, and scores it." },
  prepare_save_cover_letter: { group: 'prepare', summary: "Saves the letter's paragraphs on the profile's letter template." },
  prepare_save_answers: { group: 'prepare', summary: "Saves answers to a job's known questions; an answer TailorIT refuses comes back with the reason." },
  prepare_mark: { group: 'prepare', summary: 'Marks a job (or one part of its kit) failed or skipped, with a reason you read.' },
  own_ai_context: { group: 'documents', summary: "TailorIT's prompt for work your AI does in TailorIT's place: an editable copy, bullets, a letter, a tailored resume." },
  own_ai_save: { group: 'documents', summary: "Saves that work, checked as TailorIT's own AI's would be." },
  instructions: { group: 'setup', summary: "TailorIT's rules for your AI, and your own custom instructions." },
  // v34 INT-A (MCPDIR's split, PLAN G8 addendum): prepare_settings reads; set_prepare_settings changes your own.
  prepare_settings: {
    group: 'setup',
    summary: "Reads your AI settings (revision rounds, prompts, custom instructions, any change waiting for your OK) and the profile's letter and resume settings.",
  },
  set_prepare_settings: {
    group: 'setup',
    summary: 'Changes your own AI settings when you ask: revision rounds, prompts, letters; new custom instructions wait for your OK in Integrations.',
  },
  // v34 MCPFAN (PLAN G5, the G8 addendum): the filters' read and write apart, on one, several or all profiles.
  prepare_filters: {
    group: 'setup',
    summary: 'Reads the Prepare filters of one, several or all profiles; the sponsorship and clearance switches stay hidden from your AI.',
  },
  set_prepare_filters: {
    group: 'setup',
    summary:
      "Changes only the Prepare filters you name, on one, several or all profiles, when you ask; a custom filter's text only on your own profile, and on a shared profile the eligibility switches only if you may change its sensitive answers.",
  },
  report_unsupported: { group: 'setup', summary: 'Tells TailorIT what you asked that no tool can do; you see it in Integrations.' },
};

export interface ToolRow extends McpCatalogTool {
  summary: string;
}

/** The catalogue's tools under their groups, each group in the order of TOOL_SUMMARIES. */
export function toolsByGroup(catalog: McpToolCatalog = MCP_TOOL_CATALOG): Array<{ id: ToolGroup; title: string; tools: ToolRow[] }> {
  const order = Object.keys(TOOL_SUMMARIES);
  const sorted = [...catalog.tools].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  return TOOL_GROUPS.map((group) => ({
    id: group.id,
    title: group.title,
    tools: sorted.flatMap((tool) => {
      const words = TOOL_SUMMARIES[tool.name];
      return words?.group === group.id ? [{ ...tool, summary: words.summary }] : [];
    }),
  })).filter((group) => group.tools.length > 0);
}

/**
 * What a tool does to your data, as its annotations say: reads only; uses AI and changes nothing (v34 FIX-COPY, dir D6);
 * changes (adds); or can remove, replace or start work (destructive: archiving, removing, overwriting, and starting or
 * ending a Prepare: the final review's G-L2 and dir D7).
 */
export type ToolEffect = 'reads' | 'uses-ai' | 'changes' | 'removes';
export function toolEffect(tool: McpCatalogTool): ToolEffect {
  if (tool.annotations.readOnlyHint === true) return 'reads';
  if (tool.annotations.destructiveHint === true) return 'removes';
  return TOOL_SUMMARIES[tool.name]?.spendsAi === true ? 'uses-ai' : 'changes';
}

export const TOOL_EFFECT_LABEL: Readonly<Record<ToolEffect, string>> = {
  reads: 'Reads only',
  'uses-ai': 'Counts toward AI use',
  changes: 'Changes data',
  removes: 'Can remove, replace or start work',
};
