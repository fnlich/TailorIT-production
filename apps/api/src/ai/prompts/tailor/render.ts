import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RoleFamilyId } from '@tailorit/shared';
import { POSTING_TEXT_RULE } from './posting-text-rule';

// v30 ST2: tailor_builder0's prompt rendering, moved unchanged from features/tailor/prompts/parts.ts and index.ts
// (it is how the tailor area's prompts, and the mcp area's renderings of them, are built). Not a prompt: the catalogue
// lists the prompts made with it.
//
// tailor_builder0's prompt rendering (services/promptService.ts: `[[var]]` placeholders and renderPromptParts), ported
// with the owner's permission of 2026-11-09. A prompt is one text; the part before the first paragraph that uses a
// per-request variable is the system prompt, the rest the message. A prompt's shared variables (the job's keyword plan,
// say) do not count as per-request: they are filled into the system part, so the calls about one job share it and the
// CLI's prompt cache keeps it.

const VARIABLE_PATTERN = /\[\[\s*([a-zA-Z0-9_.-]+)\s*\]\]/g;

/** A rendered prompt split into its fixed instructions and the per-request input. */
export interface PromptParts {
  /** Template text before the first paragraph that uses a per-request variable, the shared variables filled in. */
  instructions: string;
  /** Everything from that paragraph on, with the variables filled in. */
  input: string;
}

/** One of tailor_builder0's prompts: its text and the variables that stay in the cached system part. */
export interface TailorPromptText {
  id: string;
  content: string;
  sharedVariables: readonly string[];
}

export type PromptValues = Readonly<Record<string, string>>;

function renderPromptText(content: string, values: PromptValues): { rendered: string; missing: string[] } {
  const missing = new Set<string>();
  const rendered = content.replace(VARIABLE_PATTERN, (_match, variableName: string) => {
    const name = variableName.trim();
    if (!(name in values)) {
      missing.add(name);
      return `[[${name}]]`;
    }
    return values[name] ?? '';
  });
  return { rendered, missing: [...missing] };
}

/**
 * Renders a prompt in two parts so the CLI can cache the fixed instructions (system prompt) and send only the input
 * fresh. A prompt that opens with a changing variable has no fixed part and comes back entirely as input. Throws when
 * a value is missing (a programming error).
 */
export function renderPromptParts(prompt: TailorPromptText, values: PromptValues): PromptParts {
  const { rendered, missing } = renderPromptText(prompt.content, values);
  if (missing.length > 0) throw new Error(`Prompt "${prompt.id}" is missing runtime values for: ${missing.join(', ')}`);
  const shared = new Set(prompt.sharedVariables);
  let firstChanging = -1;
  for (const match of prompt.content.matchAll(VARIABLE_PATTERN)) {
    if (!shared.has((match[1] ?? '').trim())) {
      firstChanging = match.index ?? -1;
      break;
    }
  }
  if (firstChanging < 0) return { instructions: '', input: rendered };

  const paragraphBreak = prompt.content.lastIndexOf('\n\n', firstChanging);
  if (paragraphBreak < 0) return { instructions: '', input: rendered };
  // Rendering is positional, so the fixed part rendered alone is a prefix of the full prompt.
  const fixed = renderPromptText(prompt.content.slice(0, paragraphBreak), values).rendered;
  if (!fixed.trim() || !rendered.startsWith(fixed)) return { instructions: '', input: rendered };
  return { instructions: fixed.trim(), input: rendered.slice(fixed.length).trim() };
}

/** A sentence changed; throws at load when the original no longer holds `from` (the text was updated). */
export function adapt(original: string, id: string, changes: ReadonlyArray<readonly [string, string]>): string {
  let text = original;
  for (const [from, to] of changes) {
    if (!text.includes(from)) throw new Error(`The ${id} prompt no longer holds: ${from}`);
    // v33 PROMPTS: the words go in as they are ("$18k" is no replacement pattern).
    text = text.replace(from, () => to);
  }
  return text;
}

/** tailor_builder0's sentence saying the reply is the bare object (tailor-resume and revise-resume-ats). */
export const STARTS_WITH_BRACE = 'Your reply starts with { and has nothing before or after the object';
/** TailorIT's words for it: every answer is fenced by the sentinels runPrompt's instruction gives. */
export const BETWEEN_MARKERS =
  'Your reply is the object between the markers the instructions give, with nothing before or after them';

/**
 * What a tailoring prompt module is called with: its rendered values, and a note added to the message (a retry).
 * v33 PROMPTS (F5): and the role family the prompt is written for (missing: the technical family, tailor_builder0's
 * words): the job's for the analysis and the review, the person's for the resume, the revision and the letters.
 */
export interface TailorPromptInput {
  values: PromptValues;
  note?: string;
  family?: RoleFamilyId | null;
}

/** v33 PROMPTS: a prompt's text for a family (each module's memoised `<name>PromptFor`). */
export type TailorPromptFor = (family?: RoleFamilyId | null) => TailorPromptText;

/**
 * A prompt module's kind and parts (ai/runPrompt.ts) from one of tailor_builder0's prompts: the system part, then the
 * posting rule when the prompt quotes posting text; the message part, then the note. runPrompt adds the JSON sentinels
 * (buildSystemText). definePrompt takes them with the module's catalogue facts and its output schema. v33 PROMPTS: the
 * text is the input's family's (`promptFor`).
 */
export function tailorPromptParts(promptFor: TailorPromptFor, options: { quotesPosting: boolean }) {
  return {
    kind: 'tailor' as const,
    system: (input: TailorPromptInput) => {
      const { instructions } = renderPromptParts(promptFor(input.family), input.values);
      return options.quotesPosting ? `${instructions}\n\n${POSTING_TEXT_RULE}` : instructions;
    },
    user: (input: TailorPromptInput) => {
      const { input: message } = renderPromptParts(promptFor(input.family), input.values);
      return input.note ? `${message}\n\n${input.note}` : message;
    },
  };
}

/** sha256 of prompt texts, for the analysis store's key: a reworded prompt never reuses an older answer. */
export function promptHash(...prompts: readonly TailorPromptText[]): string {
  const hash = createHash('sha256');
  for (const prompt of prompts) hash.update(prompt.id).update('\u0000').update(prompt.content).update('\u0000');
  hash.update(POSTING_TEXT_RULE);
  return hash.digest('hex').slice(0, 32);
}

/** An answer read as an object of any shape: tailor_builder0 reads each answer leniently in code. */
export const AnyObjectSchema = z.record(z.string(), z.unknown());
