import type { CliThinking } from '../../config/models';

// The command line for one `claude -p` turn. Pure, so the flag set is asserted in tests without spawning anything.

/**
 * Flags this provider must never pass. `--bare` makes Anthropic auth "strictly ANTHROPIC_API_KEY or apiKeyHelper
 * (OAuth and keychain are never read)": the opposite of running on the subscription seat. `--safe-mode` is the flag
 * that turns off CLAUDE.md, skills, plugins, hooks and MCP while leaving the sign-in alone.
 */
export const FORBIDDEN_FLAGS = ['--bare'] as const;

export const CLI_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type CliEffort = (typeof CLI_EFFORTS)[number];

/** Stands in for an empty system text: Claude Code's coding-agent system prompt is always replaced. */
export const BASE_SYSTEM_PROMPT =
  'Answer exactly what the message asks for and nothing else: no preamble and no commentary. ' +
  'You have no tools and no files; write the whole answer in your reply.';

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/;

/** A model name the CLI can be handed safely: an alias or a full id, never something that reads as a flag. */
export function isCliModelName(name: string): boolean {
  return MODEL_NAME.test(name);
}

export function normalizeEffort(value: string): CliEffort | null {
  const effort = value.trim().toLowerCase();
  return (CLI_EFFORTS as readonly string[]).includes(effort) ? (effort as CliEffort) : null;
}

/**
 * v1.3 C (decision 9): AI_CLI_THINKING. `on` (the default) passes nothing and the CLI decides, as before v1.3. `off`
 * passes `--settings {"alwaysThinkingEnabled":false}`, the setting Claude Code's own thinking switch writes, so a call
 * writes its answer without hidden reasoning first (the owner's tailor_builder0 measured three times the output tokens
 * with thinking on, at low effort). Checked with `claude --help` (CLI 2.1.316): --settings takes a file or a JSON
 * string, and the CLI accepts it beside every flag below. Not the default: Sonnet 5.5 and Opus 5.5 refuse
 * `thinking: {type: "disabled"}` with a 400 on the API, and only a real call shows what the CLI makes of the setting,
 * so the owner tries `off` with Admin › AI's test prompt on each model in use first.
 */
export const THINKING_OFF_SETTINGS = JSON.stringify({ alwaysThinkingEnabled: false });

export interface ClaudeArgvOptions {
  model: string;
  effort: CliEffort;
  /**
   * v1.3 C (decision 10): the file holding the system text (claudeCli.ts writes one per call in the CLI's work folder
   * and deletes it after). On the command line the text would leave a long system prompt (a person's facts and a job's
   * text) to spill onto stdin at Windows' 32k limit, where it is no longer the cached system part.
   */
  systemPromptFile: string;
  fallbackModel?: string | null;
  /** v1.3 C: AI_CLI_THINKING; `on` (no flag) when unsaid. */
  thinking?: CliThinking;
}

export function buildClaudeArgv(options: ClaudeArgvOptions): string[] {
  if (!isCliModelName(options.model)) throw new Error(`"${options.model}" is not a Claude model name.`);
  if (!options.systemPromptFile.trim()) throw new Error('A system prompt file is required.');
  const argv = [
    '-p',
    // stream-json, so a turn that dies still yields the events that arrived, and the first event (system/init, which
    // names the credential) can stop a metered call before the model answers.
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose', // required by stream-json
    '--model',
    options.model,
    '--effort',
    options.effort,
    // No tools at all: the answer is text, and a tool call is a way for the turn to end without one.
    '--tools',
    '',
    // The operator's CLAUDE.md, skills, plugins, hooks and MCP servers have no business steering this call.
    '--safe-mode',
    '--strict-mcp-config',
    '--disable-slash-commands',
    // Nothing may wait for a person who is not there.
    '--permission-prompts',
    'none',
    // One stateless completion; otherwise every call leaves a transcript in the CLI's config directory.
    '--no-session-persistence',
    '--system-prompt-file',
    options.systemPromptFile,
  ];
  if (options.thinking === 'off') argv.push('--settings', THINKING_OFF_SETTINGS);
  const fallback = options.fallbackModel?.trim();
  // The CLI refuses a fallback equal to the main model.
  if (fallback && fallback !== options.model && isCliModelName(fallback)) argv.push('--fallback-model', fallback);
  return argv;
}

/** The system text as the file holds it: the base prompt for none. */
export function systemFileText(system: string): string {
  return system.trim() || BASE_SYSTEM_PROMPT;
}
