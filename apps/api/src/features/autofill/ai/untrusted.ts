// Page text as the autofill AI prompts quote it (work package AF, Phase 4). The extension cleans every text it sends
// the same way (its asUntrusted, src/core/text/untrusted.ts), and TailorIT does it again here, so a prompt never holds
// what could hide from the person or break out of the <untrusted> wrapper. That is a speed bump: the real boundary is
// the closed answer (an option's number, a category from a list) that the handlers check in code before storing it.

/** Invisible and bidi characters: every format character (zero-width, bidi controls, tags), the combining grapheme
 *  joiner, Khmer inherent vowels and variation selectors, as the extension's list. */
const INVISIBLE = /[\p{Cf}\u{34F}\u{17B4}\u{17B5}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;
/** Control characters and the Hangul fillers become spaces, so no text starts a line of its own. */
const CONTROL = /[\p{Cc}\u{115F}\u{1160}\u{3164}\u{FFA0}]/gu;
/** An opening or closing wrapper tag, attributes included when a '>' follows soon. */
const WRAPPER_TAG = /<\s*\/?\s*untrusted(?:[^<>]{0,100}>)?/gi;
/** The sentinels the AI layer's JSON reader looks for (ai/json.ts), in any spacing or case. */
const SENTINEL = /@@\s*(?:begin|end)[\s_-]*json\s*@@/gi;
/** The tag the fake Claude CLI picks its scenario by (`[feature:<kind>]`, tools/fake-claude), in any spacing. */
const SCENARIO_TAG = /\[\s*feature\s*:/gi;

export const TAG_REMOVED = '[tag removed]';
export const MARKER_REMOVED = '[marker removed]';
export const SCENARIO_DEFUSED = '[feature :';

/**
 * A text as a prompt may quote it: compatibility forms folded (NFKC, so a full-width "＜/untrusted＞" is
 * caught), invisible and bidi characters removed, control characters made spaces, wrapper tags, JSON sentinels and the
 * fake CLI's scenario tag defused, whitespace collapsed to single spaces, and at most `max` code points kept.
 */
export function untrustedText(text: string, max: number): string {
  const cleaned = text
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(CONTROL, ' ')
    .replace(WRAPPER_TAG, TAG_REMOVED)
    .replace(SENTINEL, MARKER_REMOVED)
    .replace(SCENARIO_TAG, SCENARIO_DEFUSED)
    .replace(/\s+/g, ' ')
    .trim();
  const points = [...cleaned];
  return points.length <= max ? cleaned : points.slice(0, Math.max(0, max)).join('').trimEnd();
}

/** The wrapper tags, the JSON sentinels and the scenario tag, matched once (no global state). */
const PROMPT_MARKUP = [WRAPPER_TAG, SENTINEL, SCENARIO_TAG].map((pattern) => new RegExp(pattern.source, 'i'));

/**
 * True when a text holds what could open or close the prompt's wrapper, fake the JSON sentinels or switch the fake
 * CLI's scenario, in any spacing, case or compatibility form, invisible characters aside: a draft holding one is
 * discarded (reason `wrapper`).
 */
export function holdsPromptMarkup(text: string): boolean {
  const view = text.normalize('NFKC').replace(INVISIBLE, '');
  return PROMPT_MARKUP.some((pattern) => pattern.test(view));
}

/** One page text in its wrapper. */
export const untrusted = (text: string, max: number): string => `<untrusted>${untrustedText(text, max)}</untrusted>`;

/**
 * A page text of several lines, cleaned line by line as untrustedText cleans a text, so no line holds a wrapper tag, a
 * sentinel or a break of its own; blank lines between paragraphs kept, one in a row, none at either end; at most `max`
 * code points of text in all. What untrustedBlock wraps, and what a cover letter keeps as its job description.
 */
export function untrustedLines(text: string, max: number): string {
  const lines: string[] = [];
  let left = max;
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (left <= 0) break;
    const line = untrustedText(raw, left);
    if (line === '' && (lines.length === 0 || lines[lines.length - 1] === '')) continue;
    lines.push(line);
    left -= [...line].length;
  }
  while (lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/**
 * A page text of several lines (a field's current answer, sent to be rewritten; a cover letter's job description) in
 * one wrapper on lines of its own, its line breaks kept, cleaned as untrustedLines cleans it.
 */
export function untrustedBlock(text: string, max: number): string {
  return `<untrusted>\n${untrustedLines(text, max)}\n</untrusted>`;
}

/**
 * A numbered list of page texts (a field's options) in one wrapper, a line each: `[number] text`. The numbers are
 * TailorIT's and start each line; a page text never holds a line break, so it cannot start a line of its own.
 */
export function untrustedList(lines: ReadonlyArray<readonly [number, string]>, max: number): string {
  const body = lines.map(([number, text]) => `[${number}] ${untrustedText(text, max)}`).join('\n');
  return `<untrusted>\n${body}\n</untrusted>`;
}
