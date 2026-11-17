import type { z } from 'zod';
import type { AiTaskKind } from '@tailorit/shared';
import type { AppConfig } from '../config/env';
import { AiError } from './errors';
import { extractJSON, JsonExtractError } from './json';
import { jsonInstructionPrompt } from './prompts/system/json-instruction';
import type { AiProvider } from './provider/types';
import { addUsage, type AiUsage } from './usage';

/**
 * One AI feature's prompt, owned by the feature package (e.g. `features/resumes/prompts/entryBullets.ts`).
 * `system` is the instruction text, `user` the call's data, `output` the zod schema the reply must satisfy.
 * Bump `version` whenever the wording changes, so stored results can be told apart (e.g. a cache key).
 */
export interface PromptModule<I, O> {
  kind: AiTaskKind;
  version: number;
  system(input: I): string;
  /**
   * v1.3 C (decision 10): data that rides in the system prompt after its rules and the JSON instruction: the person's
   * facts and the job's text, the same bytes for every call of one run (every batch of one form), so the CLI reads them
   * from its prompt cache after the first call. Only `user` (the batch's items and what varies between batches) goes on
   * stdin. Absent or '' for none.
   */
  context?(input: I): string;
  user(input: I): string;
  output: z.ZodType<O>;
}

export interface RunPromptOptions {
  signal?: AbortSignal;
  /** Run under another kind's model/effort settings and scenario tag. Default: `module.kind`. */
  kind?: AiTaskKind;
  /**
   * Hears each reply's whole text, as the provider gave it and before it is parsed (prose outside the sentinels
   * included): once, or twice when the repair retry ran, whether the run succeeds or not. For checks the parsed value
   * cannot show, such as the autofill handlers' check for talk of being an AI. Never sent to the provider.
   */
  onReply?: (text: string) => void;
  /**
   * v5 (the autofill stream): hears the first reply's text as it streams (CompletionRequest.onText), before it is
   * parsed or checked; the repair retry's is never streamed. Never sent to the provider.
   */
  onText?: (text: string) => void;
  /**
   * v30 E3: run on this model instead of the kind's configured one (AI_MODEL_<KIND>, else its default): for a kind
   * whose model is an admin constant read at each run (company_summary: COMPANY_AI_MODEL). Blank: the configured one.
   */
  model?: string;
}

/** Runs a prompt module and returns its validated output. Throws AiError (an AppError) on every failure. */
export type RunPrompt = <I, O>(module: PromptModule<I, O>, input: I, options?: RunPromptOptions) => Promise<O>;

/** What one prompt run cost, for the task row and logs. */
export interface PromptCallInfo {
  tag: string;
  /** The model that answered (or the one requested when the CLI did not say). */
  model: string;
  /** CLI calls made: 1, or 2 when the repair retry ran. */
  calls: number;
  ms: number;
  /** v1.3 C (decision 8): what the calls used, added up over the repair retry; null when no call reported it. */
  usage: AiUsage | null;
  /** v1.3 C: the calls whose usage the CLI reported. */
  reportedCalls: number;
}

/**
 * Appended to every system prompt. The CLI enforces no JSON, so the answer is fenced by sentinels that extractJSON
 * keys on. The `[feature:<kind>]` tag is how the fake CLI (tools/fake-claude) picks its scenario. v30 ST0: its words
 * live in the prompt catalogue (ai/prompts/system/json-instruction.ts).
 */
export function jsonInstruction(tag: string): string {
  return jsonInstructionPrompt.text({ tag });
}

/**
 * The whole system text: the module's rules, the JSON instruction, then (v1.3 C) the module's context. The JSON
 * instruction comes before the context, so its `[feature:<kind>]` tag is the first in the text whatever the context
 * quotes.
 */
export function buildSystemText(system: string, tag: string, context = ''): string {
  return [system.trim(), jsonInstruction(tag), context.trim()].filter(Boolean).join('\n\n');
}

/** v1.3 C: the system text and the message a prompt module makes of an input, as the CLI gets them. */
export function promptTexts<I, O>(
  module: PromptModule<I, O>,
  input: I,
  kind: AiTaskKind = module.kind,
): { system: string; user: string } {
  return { system: buildSystemText(module.system(input), kind, module.context?.(input) ?? ''), user: module.user(input) };
}

const MAX_ISSUES = 8;

/** Parses and validates one reply; on failure returns the problems as one sentence for the retry message. */
function check<O>(text: string, schema: z.ZodType<O>): { ok: true; value: O } | { ok: false; problems: string } {
  let value: unknown;
  try {
    value = extractJSON(text);
  } catch (error) {
    if (error instanceof JsonExtractError) return { ok: false, problems: error.message };
    throw error;
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issues = parsed.error.issues.slice(0, MAX_ISSUES).map((issue) => {
    const where = issue.path.length ? issue.path.map(String).join('.') : 'the top-level value';
    return `${where}: ${issue.message}`.slice(0, 200);
  });
  const more = parsed.error.issues.length > MAX_ISSUES ? `; and ${parsed.error.issues.length - MAX_ISSUES} more` : '';
  return { ok: false, problems: `${issues.join('; ')}${more}.` };
}

export interface JsonCall<O> {
  tag: string;
  /** Full system text, including jsonInstruction (see buildSystemText). */
  system: string;
  user: string;
  output: z.ZodType<O>;
  model: string;
  effort: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  ignoreHolds?: boolean;
  /** RunPromptOptions.onReply: hears each reply's text; never sent to the provider. */
  onReply?: (text: string) => void;
  /** RunPromptOptions.onText: hears the first reply's text as it streams. */
  onText?: (text: string) => void;
}

/**
 * One prompt answered as validated JSON. A reply that does not parse or does not match the schema gets ONE stateless
 * retry (a new CLI call; the same system text; the message plus the problems found), then fails as `malformed`.
 * `report` hears what the run cost, whether it succeeded or not. v3.0 D2: an async report (the AI queue's usage and
 * charge writes) is awaited before the answer is given, so the caller goes on only once the run is recorded.
 */
export async function completeJson<O>(
  provider: AiProvider,
  call: JsonCall<O>,
  report?: (info: PromptCallInfo) => unknown,
): Promise<{ value: O; info: PromptCallInfo }> {
  const startedAt = Date.now();
  const { output, onReply, onText, ...request } = call;
  let user = call.user;
  let answeredBy: string | null = null;
  let calls = 0;
  let problems = '';
  let usage: AiUsage | null = null;
  let reportedCalls = 0;
  const heard = (used: AiUsage | null | undefined) => {
    if (!used) return;
    usage = addUsage(usage, used);
    reportedCalls += 1;
  };
  const info = (): PromptCallInfo => ({
    tag: call.tag,
    model: answeredBy ?? call.model,
    calls,
    ms: Date.now() - startedAt,
    usage,
    reportedCalls,
  });
  try {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      calls = attempt;
      // v5: only the first reply streams; a repair's answer is read whole.
      let reply;
      try {
        reply = await provider.complete({ ...request, user, ...(attempt === 1 && onText ? { onText } : {}) });
      } catch (error) {
        // v1.3 C: a failed call may still have used tokens.
        if (error instanceof AiError) heard(error.usage);
        throw error;
      }
      heard(reply.usage);
      answeredBy = reply.model ?? answeredBy;
      onReply?.(reply.text);
      const result = check(reply.text, output);
      if (result.ok) return { value: result.value, info: info() };
      problems = result.problems;
      user =
        `${call.user}\n\nYour previous reply did not match the required JSON. Problems: ${problems} ` +
        'Reply again with only the JSON.';
    }
    throw new AiError('malformed', { detail: `Two replies did not match the required JSON. Last: ${problems}` });
  } finally {
    await report?.(info());
  }
}

/** Binds runPrompt to a provider and the per-feature model/effort settings (`AI_MODEL_<FEATURE>`, ...). */
export function createRunPrompt(
  provider: AiProvider,
  ai: AppConfig['ai'],
  report?: (info: PromptCallInfo) => unknown,
): RunPrompt {
  return async (module, input, options = {}) => {
    const kind = options.kind ?? module.kind;
    const { model: configured, effort } = ai.features[kind];
    const model = options.model?.trim() || configured; // v30 E3
    const { system, user } = promptTexts(module, input, kind);
    const call = {
      tag: kind,
      system,
      user,
      output: module.output,
      model,
      effort,
      signal: options.signal,
      onReply: options.onReply,
      onText: options.onText,
    };
    return (await completeJson(provider, call, report)).value;
  };
}
