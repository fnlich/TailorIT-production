import { constantsOf } from '../../core/constants/service';
import type { AppDeps } from '../../core/context';

// v34 MCPDIR (PLAN G8 "A result-size guard and a per-tool time limit"; Claude's Connectors Directory review: answers
// within about 150,000 characters and 240 seconds, frugal with tokens, never a generic error). profiles.ts runs every
// tool through these. Each tool's own caps (pages of at most 100 rows, 20,000 characters of posting text) keep almost
// every answer far below MCP_RESULT_MAX_CHARS: the guard is a safety net, by tool (the MCPDIR security review, findings
// 2, 3, 6, 9):
// - A read that pages (search_jobs, list_applications, queue_list, ai_search_jobs, filter_jobs, prepare_queue) keeps
//   the most rows that fit and REPLACES its cursor with one that continues after the last row kept.
// - A tool that changes things (prepare_start) keeps its counts and the first rows: the change is done, and the answer
//   says how many rows it does not show. It never asks for the call again. v34 MCPFAN: a change on several profiles
//   keeps its first per-profile lines (`results`) the same way.
// - job_details (with its posting texts) has its longest texts cut in their middle, each text's start and end kept (a
//   fence's opening tag and its end and label); its rows, like application_stats', are cut with the argument to narrow.
// - A prompt (a string answer), the job context and own_ai_context (documents the AI writes from) are never cut: an
//   answer too large is refused with what to do. So is anything else that cannot be cut.
// A call that takes longer than MCP_TOOL_TIME_LIMIT_MS answers MSG_MCP_TOOL_TOO_SLOW, with the read that shows whether
// its change finished; its late outcome is still logged and, on a shared profile, counted in the share's activity.

/** What the constants service needs. */
type ConstantDeps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** A table's rows kept, of how many, and what to do (an answer's `truncated`). */
export interface Truncated {
  rows?: number;
  of?: number;
  texts?: number;
  how: string;
}

/** How a tool's answer may be cut. */
export interface AnswerPolicy {
  tool: string;
  /** True for a tool that changes things (its answer reports a change that is already made). */
  changes: boolean;
  /** The call's arguments: its cursor, for the cursor that replaces the answer's own. */
  args?: { cursor?: unknown };
}

/** The reads that page: which field holds the cursor, and whether it is a set's "<setId>.<offset>" or an offset. */
const PAGING: Record<string, { field: 'next' | 'nextCursor'; set: 'setId' | 'runId' | null; via?: string }> = {
  search_jobs: { field: 'next', set: 'setId' },
  list_applications: { field: 'next', set: 'setId' },
  queue_list: { field: 'next', set: 'setId' },
  // A second AI search may pick other filters and spends usage: the rest comes through search_jobs' cursor.
  ai_search_jobs: { field: 'next', set: 'setId', via: 'search_jobs' },
  filter_jobs: { field: 'nextCursor', set: 'runId' },
  prepare_queue: { field: 'nextCursor', set: null },
};

/** What narrows a read whose rows do not page (named only where the tool takes it). */
const NARROW: Record<string, string> = {
  job_details: 'ask for fewer jobIds',
  application_stats: 'ask for fewer groupBy fields or a shorter range',
};

/** What to do when a whole answer is too large, by tool (only arguments the tool takes). */
const TOO_LARGE_ADVICE: Record<string, string> = {
  prepare_prompt: 'For write_answers, ask for fewer jobIds; otherwise tell the person (the server holds answers smaller than this prompt).',
  prepare_job_context: 'Ask with "fields" for fewer parts, or without "includePosting" or "includeResume".',
  own_ai_context: 'Tell the person: the server holds answers smaller than this task.',
  job_details: 'Ask for fewer jobIds or a smaller "maxChars".',
};

export const rowsCutNote = (kept: number, of: number, max: number, how: string) =>
  `TailorIT kept ${kept} of ${of} rows to stay under ${max} characters: ${how}.`;

/** The paging read's note: the replaced cursor continues after the last row kept. */
const pagingHow = (field: string, via?: string) =>
  `the "${field}" cursor continues after the last row kept${via ? ` (with ${via})` : ''}`;

/** A change tool's note: the change is done; some rows are not shown. */
const changeHow = (hidden: number) => `the change is done; ${hidden} more rows are not shown`;

/** How to get a text job_details shortened. */
export const textsCutNote = (max: number) =>
  `TailorIT shortened the longest texts to stay under ${max} characters. Ask for fewer jobIds or a smaller "maxChars" ` +
  'to get them whole.';

/** The line written where a text was cut in its middle. */
export const cutMark = (cut: number) => `\n[TailorIT cut ${cut} characters here: this answer has a size limit.]\n`;

/** The refusal of an answer too large to send, with what to do. */
export const tooLargeMessage = (tool: string, length: number, max: number) =>
  `This answer would hold ${length} characters, more than the ${max} one answer may. ` +
  (TOO_LARGE_ADVICE[tool] ?? 'Ask for less in one call, or tell the person.');

/** After a time limit: what shows whether the change finished, so a retry neither repeats nor loses work. */
const CHECKS: Record<string, string> = {
  prepare_save_analysis: 'prepare_job_context shows what was saved for the job',
  prepare_save_resume: 'prepare_job_context shows the saved resume and its rounds',
  prepare_save_cover_letter: 'prepare_job_context shows the saved letter',
  prepare_save_answers: 'prepare_job_context shows the answers saved',
  prepare_mark: 'prepare_queue shows whether the job still waits',
  prepare_start: 'prepare_queue shows the jobs that started (a start never starts a job twice)',
  set_prepare_settings: 'prepare_settings shows the settings',
  set_prepare_filters: 'prepare_filters shows the filters', // v34 MCPFAN
  save_jobs: 'list_applications shows the Job Tracker',
  unsave_jobs: 'list_applications shows the Job Tracker',
  add_job: 'list_applications shows the Job Tracker (adding the same link again changes nothing)',
  queue_remove: 'queue_list shows the queue',
  queue_clear_finished: 'queue_list shows the queue',
  custom_filter_verdicts: 'filter_jobs shows the verdicts',
  own_ai_save: "the person's Documents page shows what was stored; calling again may store another copy, so ask the person",
  report_unsupported: "the person's Settings list the reports; calling again records another",
};

/** The time limit's refusal (MSG_MCP_TOOL_TOO_SLOW, an admin may reword it), with the read that verifies its change. */
export function tooSlowMessage(deps: ConstantDeps, tool: string, ms: number, changes = tool in CHECKS): string {
  const check =
    tool === 'ai_search_jobs'
      ? "Each call spends the account's TailorIT AI usage: ask the person before trying again, or use search_jobs."
      : changes
        ? `A change it was making may still complete: ${CHECKS[tool] ?? 'check with a read'} before calling it again.`
        : 'It changes nothing, so calling it again is safe; ask for less in one call.';
  return constantsOf(deps).message('MSG_MCP_TOOL_TOO_SLOW', { tool, seconds: Math.round(ms / 1000), check });
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** `text` cut in its middle to at most `max` characters: its start and its end kept, at line breaks when it can. */
export function cutMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const tailWanted = Math.min(1_000, Math.floor(max / 4));
  const room = max - cutMark(text.length).length;
  if (room <= 0) return text.slice(0, max);
  // The tail starts at a line break when that keeps at least half of it, else at a space, else where it falls.
  let tailStart = (() => {
    const at = text.length - tailWanted;
    const line = text.indexOf('\n', at);
    if (line >= 0 && text.length - (line + 1) >= tailWanted / 2) return line + 1;
    const space = text.indexOf(' ', at);
    return space >= 0 && text.length - (space + 1) >= tailWanted / 2 ? space + 1 : at;
  })();
  // Never half of a character written as two code units (an emoji, a rare letter).
  if (isLowSurrogate(text.charCodeAt(tailStart))) tailStart += 1;
  const tail = text.slice(tailStart);
  let headEnd = Math.max(0, room - tail.length);
  const line = text.lastIndexOf('\n', headEnd);
  if (line > headEnd / 2) headEnd = line;
  if (headEnd > 0 && isHighSurrogate(text.charCodeAt(headEnd - 1))) headEnd -= 1;
  return `${text.slice(0, headEnd)}${cutMark(tailStart - headEnd)}${tail}`;
}

/** Every string leaf of a JSON value, with how to set it (object members and array items alike). */
function stringLeaves(value: unknown, out: Array<{ get: () => string; set: (text: string) => void }> = []) {
  if (Array.isArray(value)) {
    value.forEach((item, at) => {
      if (typeof item === 'string') out.push({ get: () => value[at] as string, set: (text) => (value[at] = text) });
      else stringLeaves(item, out);
    });
  } else if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const item = record[key];
      if (typeof item === 'string') out.push({ get: () => record[key] as string, set: (text) => (record[key] = text) });
      else stringLeaves(item, out);
    }
  }
  return out;
}

/** The offset a call's cursor starts at ("<setId>.<offset>" or an offset), 0 without one. */
function startOf(cursor: unknown): number {
  if (typeof cursor !== 'string') return 0;
  const offset = Number(cursor.slice(cursor.lastIndexOf('.') + 1));
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
}

/** A table answer with only its first `kept` rows and what to do about the rest. */
function withRows(answer: Record<string, unknown>, rows: unknown[], kept: number, max: number, policy: AnswerPolicy): Record<string, unknown> {
  const out: Record<string, unknown> = { ...answer, rows: rows.slice(0, kept) };
  const paging = PAGING[policy.tool];
  let how: string;
  if (paging && !policy.changes) {
    const next = startOf(policy.args?.cursor) + kept;
    const setId = paging.set ? answer[paging.set] : null;
    out[paging.field] = paging.set ? (typeof setId === 'string' ? `${setId}.${next}` : null) : String(next);
    how = pagingHow(paging.field, paging.via);
  } else if (policy.changes) {
    how = changeHow(rows.length - kept);
  } else {
    how = NARROW[policy.tool] ?? 'ask for less in one call';
  }
  out.truncated = { rows: kept, of: rows.length, how: rowsCutNote(kept, rows.length, max, how) } satisfies Truncated;
  return out;
}

/** The most rows of a table answer that fit (at least one), or null. */
function fitRows(answer: Record<string, unknown>, max: number, policy: AnswerPolicy): string | null {
  const rows = answer.rows as unknown[];
  let low = 1;
  let high = rows.length - 1;
  let best: string | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = JSON.stringify(withRows(answer, rows, middle, max, policy));
    if (candidate.length <= max) {
      best = candidate;
      low = middle + 1;
    } else high = middle - 1;
  }
  return best;
}

/** job_details' texts cut in their middle, longest first, until the answer fits; null when they cannot. */
function fitTexts(text: string, max: number): string | null {
  const copy = JSON.parse(text) as Record<string, unknown>;
  const leaves = stringLeaves(copy.texts).sort((a, b) => b.get().length - a.get().length);
  copy.truncated = { texts: 0, how: textsCutNote(max) } satisfies Truncated;
  let cut = 0;
  for (const leaf of leaves) {
    const over = JSON.stringify(copy).length - max;
    if (over <= 0) break;
    const current = leaf.get();
    if (current.length < 400) break;
    leaf.set(cutMiddle(current, Math.max(200, current.length - over - 40)));
    cut += 1;
    (copy.truncated as Truncated).texts = cut;
  }
  const fitted = JSON.stringify(copy);
  return fitted.length <= max ? fitted : null;
}

/** An answer as the text a tool result carries: a string as it is, anything else as compact JSON, at most `max` long. */
export function fittedAnswer(value: unknown, max: number, policy: AnswerPolicy): { text: string; cut: boolean; refused?: string } {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? 'null');
  if (text.length <= max) return { text, cut: false };
  const refused = { text: '', cut: false, refused: tooLargeMessage(policy.tool, text.length, max) };
  if (typeof value === 'string' || value === null || typeof value !== 'object' || Array.isArray(value)) return refused;
  const answer = value as Record<string, unknown>;
  if (policy.tool === 'job_details' && answer.texts !== undefined) {
    const fitted = fitTexts(text, max);
    if (fitted !== null) return { text: fitted, cut: true };
  }
  const cuttable = PAGING[policy.tool] !== undefined || policy.changes || NARROW[policy.tool] !== undefined;
  if (cuttable && Array.isArray(answer.rows) && answer.rows.length > 1) {
    const fitted = fitRows(answer, max, policy);
    if (fitted !== null) return { text: fitted, cut: true };
  }
  // v34 MCPFAN (the MCPFAN security review, L3): a change on several profiles is done: its per-profile lines are cut,
  // never refused as too large once the change is made.
  if (policy.changes && Array.isArray(answer.results) && answer.results.length > 1) {
    const fitted = fitResults(answer, answer.results, max);
    if (fitted !== null) return { text: fitted, cut: true };
  }
  return refused;
}

/** v34 MCPFAN: a change's per-profile answer with only its first `kept` lines, and how many are not shown. */
function withResults(answer: Record<string, unknown>, results: unknown[], kept: number, max: number): Record<string, unknown> {
  const how = `the change is done; ${results.length - kept} more profiles' lines are not shown`;
  return { ...answer, results: results.slice(0, kept), truncated: { rows: kept, of: results.length, how: rowsCutNote(kept, results.length, max, how) } };
}

/** v34 MCPFAN: the most per-profile lines of a change's answer that fit (at least one), or null. */
function fitResults(answer: Record<string, unknown>, results: unknown[], max: number): string | null {
  let low = 1;
  let high = results.length - 1;
  let best: string | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = JSON.stringify(withResults(answer, results, middle, max));
    if (candidate.length <= max) {
      best = candidate;
      low = middle + 1;
    } else high = middle - 1;
  }
  return best;
}

/** What `withinTime` resolves to when the time limit came first. */
export const TIMED_OUT: unique symbol = Symbol('timed out');

/** What happens to a call's work that finishes after the time limit. */
export interface LateOutcome<T> {
  done?: (value: T) => void;
  failed?: (error: unknown) => void;
}

/**
 * `work`'s result, or TIMED_OUT when it takes longer than `ms`. The work is not stopped (a database change may finish
 * after): its late outcome goes to `late` (logged; counted in a share's activity), a late failure included.
 */
export async function withinTime<T>(work: () => Promise<T>, ms: number, late: LateOutcome<T> = {}): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const running = work();
  running.then(
    (value) => {
      if (timedOut) late.done?.(value);
    },
    (error: unknown) => {
      if (timedOut) late.failed?.(error);
    },
  );
  const limit = new Promise<typeof TIMED_OUT>((done) => {
    timer = setTimeout(() => {
      timedOut = true;
      done(TIMED_OUT);
    }, ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([running, limit]);
  } finally {
    clearTimeout(timer);
  }
}
