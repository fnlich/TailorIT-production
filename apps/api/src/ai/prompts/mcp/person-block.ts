import { defineTextPrompt } from '../types';

// v30 ST2: the fence around the person's own words, moved unchanged from features/mcp/instructions.ts. A shared part:
// the instructions (instructions.ts) and every step prompt's preferences (step-preferences.ts) quote the person's custom
// instructions in it.

/** What stands in for custom instructions the person never wrote. */
export const NO_CUSTOM_INSTRUCTIONS = '(none)';

// v2.0 FIX-C (SEC-3): the fence holds against a tag the text spells in pieces. One pass that took the tags out joined
// the text around them, so "</pe</person>rson>" became "</person>" and the words after it read as TailorIT's own.
// The text is now read as an AI reads it (compatibility forms folded, so a full-width "＜/person＞" is a tag; invisible
// characters gone, so "</per" + a zero-width space + "son>" is one), a tag in "<" or a bracket that looks like one is taken out, and that
// repeats until nothing changes, so no tag is left however it was split or nested.

/** Invisible characters: every format character (zero-width, bidi controls, tags), the combining grapheme joiner,
 *  Khmer inherent vowels and variation selectors (as the autofill prompts' untrustedText). */
const INVISIBLE = /[\p{Cf}\u{34F}\u{17B4}\u{17B5}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;
/** "<" and the brackets NFKC keeps that read as one (‹ 〈 ⟨ ❮ ˂ ᐸ), then their closing forms. */
const TAG_OPEN = '<‹〈〈⟨❮˂ᐸ';
const TAG_CLOSE = '>›〉〉⟩❯˃ᐳ';
/** An opening or closing fence tag, in any case or spacing, its closing bracket optional ("<person" alone counts). */
const FENCE_TAG = new RegExp(
  `[${TAG_OPEN}]\\s*[/⁄∕]?\\s*person(?![\\p{L}\\p{N}_])(?:\\s*[${TAG_CLOSE}])?`,
  'giu',
);

/** The person's text with every fence tag taken out, however it was written, split or nested. */
export function fenceSafe(custom: string): string {
  let text = custom.normalize('NFKC').replace(INVISIBLE, '');
  for (let before = ''; before !== text; ) {
    before = text;
    text = text.replace(FENCE_TAG, '');
  }
  return text;
}

/** The person's text fenced as theirs: a tag of the fence written inside it is taken out, so the fence holds. */
export function personBlock(custom: string): string {
  const text = fenceSafe(custom).trim();
  return `<person>\n${text || NO_CUSTOM_INSTRUCTIONS}\n</person>`;
}

export const personBlockPrompt = defineTextPrompt<{ custom: string }>({
  area: 'mcp',
  name: 'person-block',
  version: 1,
  description: "The person's custom instructions fenced as theirs (<person>), every fence tag written inside them taken out.",
  text: ({ custom }) => personBlock(custom),
});
