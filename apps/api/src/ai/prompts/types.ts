import type { z } from 'zod';
import type { AiTaskKind } from '@tailorit/shared';
import type { PromptModule } from '../runPrompt';

// v30 ST0: the prompt catalogue's types (the owner's "move all prompts into one folder"; PLAN §6). Every prompt
// TailorIT writes lives in `ai/prompts/<area>/<name>.ts`, one module per prompt: its words, its version, its input
// schema and (for a prompt TailorIT's own AI answers) its output schema. Each area's `index.ts` lists its prompts and
// `ai/prompts/index.ts` joins the areas into one catalogue (PROMPTS), so a developer reads every prompt in one folder.
// `apps/api/test/structure-prompts.test.ts` refuses prompt text anywhere else.
//
// Two forms:
// - a MODEL prompt (definePrompt): what TailorIT's own AI is asked, run by the AI queue's runPrompt. It IS a
//   PromptModule (system, context, user, output), so `ctx.runPrompt(prompt, input)` takes it as it is;
// - a TEXT prompt (defineTextPrompt): words TailorIT hands to someone else's AI (the MCP server's instructions and
//   step prompts) or a shared part other prompts quote. TailorIT runs nothing against it.

/** The prompt areas, one folder each under `ai/prompts/`. A new area is a new folder plus its line here. */
export const PROMPT_AREAS = [
  'resumes',
  'cover-letters',
  'job-analysis',
  'tailor',
  'prepare-filters',
  'mcp',
  'autofill',
  'jobs',
  'companies',
  // v30 ST0: the AI layer's own words (the JSON instruction every model prompt ends with, the admin's connectivity test).
  'system',
] as const;
export type PromptArea = (typeof PROMPT_AREAS)[number];

interface PromptMeta<I> {
  /** `<area>/<name>`: unique in the catalogue, and the module's path under `ai/prompts/` without `.ts`. */
  readonly id: string;
  readonly area: PromptArea;
  /** The module's file name without `.ts` (kebab or camel case, as the area writes them). */
  readonly name: string;
  /** Bump when the words change, so stored answers and caches can tell the wordings apart. An integer from 1. */
  version: number;
  /** One sentence: what the prompt asks, and who reads the answer. */
  readonly description: string;
  /** The input's schema, when the input comes from outside the module (optional: many inputs are built in code). */
  readonly inputSchema?: z.ZodType<I>;
}

/** A prompt TailorIT's own AI answers: a PromptModule with its catalogue facts. */
export interface ModelPrompt<I, O> extends PromptMeta<I>, PromptModule<I, O> {
  readonly form: 'model';
}

/** Words TailorIT gives another AI (MCP), or a shared part of other prompts. */
export interface TextPrompt<I> extends PromptMeta<I> {
  readonly form: 'text';
  /** The words for one input. */
  text(input: I): string;
  /** What the other AI is asked to send back, when TailorIT checks it (MCP's save tools); absent when it does not. */
  readonly output?: z.ZodType<unknown>;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- the catalogue holds prompts of every input and output type */
/** One entry of the catalogue. */
export type CatalogPrompt = ModelPrompt<any, any> | TextPrompt<any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

type MetaSpec<I> = Omit<PromptMeta<I>, 'id'>;

/**
 * A model prompt: `system` (the rules), optional `context` (data that rides in the system text after its rules, the
 * same bytes for every call of one run, so the CLI's prompt cache reads it), `user` (the call's data), `output` (the
 * reply's schema) and `kind` (the AI task kind whose model and effort run it; runPrompt's `kind` option overrides it).
 */
export function definePrompt<I, O>(
  spec: MetaSpec<I> & {
    kind: AiTaskKind;
    system(input: I): string;
    context?(input: I): string;
    user(input: I): string;
    output: z.ZodType<O>;
  },
): ModelPrompt<I, O> {
  checkMeta(spec);
  return Object.freeze({ ...spec, form: 'model' as const, id: `${spec.area}/${spec.name}` });
}

/** A text prompt: `text(input)` gives the words. */
export function defineTextPrompt<I = void>(
  spec: MetaSpec<I> & { text(input: I): string; output?: z.ZodType<unknown> },
): TextPrompt<I> {
  checkMeta(spec);
  return Object.freeze({ ...spec, form: 'text' as const, id: `${spec.area}/${spec.name}` });
}

function checkMeta(spec: MetaSpec<unknown>): void {
  if (!(PROMPT_AREAS as readonly string[]).includes(spec.area)) throw new Error(`Unknown prompt area "${spec.area}".`);
  if (!/^[a-z][A-Za-z0-9-]*$/.test(spec.name)) throw new Error(`Prompt name "${spec.name}" must be a file name (letters, digits, dashes).`);
  if (!Number.isInteger(spec.version) || spec.version < 1) throw new Error(`Prompt ${spec.area}/${spec.name}: the version is an integer from 1.`);
  if (!spec.description.trim()) throw new Error(`Prompt ${spec.area}/${spec.name} needs a description.`);
}

/**
 * The problems of a catalogue (empty when it is sound): duplicate ids, an id that is not `<area>/<name>`, an entry
 * listed under another area's index.
 */
export function catalogueProblems(entries: ReadonlyArray<{ area: PromptArea; prompts: readonly CatalogPrompt[] }>): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const { area, prompts } of entries) {
    for (const prompt of prompts) {
      if (prompt.area !== area) problems.push(`${prompt.id} is listed in the ${area} area`);
      if (prompt.id !== `${prompt.area}/${prompt.name}`) problems.push(`${prompt.id} is not ${prompt.area}/${prompt.name}`);
      if (seen.has(prompt.id)) problems.push(`${prompt.id} is listed twice`);
      seen.add(prompt.id);
    }
  }
  return problems;
}
