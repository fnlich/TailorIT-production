import { firstOf, isRecord, refuse, refuseWith } from './refuse';

// v1.5 Q1: a cover letter the person's AI saved (prepare_save_cover_letter), normalized strictly to what TailorIT's
// own letter prompts answer: the body alone, as 2 to 4 paragraphs of plain text (TailorLetterOutputSchema). It may come
// as paragraphs, as one string, or as {"body"} / {"paragraphs"}; paragraphs are split on blank lines. By rule:
// - markdown emphasis and heading marks are dropped;
// - a greeting ("Dear Hiring Manager,") at the start and a sign-off ("Best regards," and the name lines under it) at
//   the end are cut: TailorIT's letter template writes both;
// - more than 4 paragraphs: the two neighbours with the fewest characters together are merged, until there are 4;
// - one paragraph of several sentences is split in two at the sentence boundary nearest its middle.
// Refused: no text, a single sentence, a paragraph over 3,000 characters, or a placeholder left in ("[Your Name]"); the
// message names the field and the shape expected.

export const LETTER_SHAPE =
  'the letter body as 2 to 4 paragraphs of plain text: "paragraphs": ["...", "..."], or "letter": "..." with a blank ' +
  'line between paragraphs (no greeting, no sign-off)';
export const LETTER_LIMITS = { min: 2, max: 4, length: 3000 } as const;
/** The most paragraphs a save may send before they are merged to 4. */
export const MAX_SENT_PARAGRAPHS = 20;

/** A greeting line ("Dear Hiring Manager,"), and what follows it on the line: group 1 the greeting, group 2 the rest. */
const GREETING =
  /^((?:dear|hi|hello|hey|greetings|good (?:morning|afternoon|day)|to whom it may concern)\b[^,:;!.?\n]{0,60}(?:[,:;!]|$))\s*(.*)$/i;
const SIGN_OFF =
  /^(sincerely|best|best regards|best wishes|kind regards|warm regards|warmest regards|regards|respectfully|cheers|thanks|many thanks|thank you|thank you for your (time|consideration)|yours (truly|sincerely|faithfully)|with (gratitude|appreciation)|all the best)\s*[,.!]?$/i;
const PLACEHOLDER = /\[(?:your|insert|company|hiring|recipient|name|date|position|job)[^\]]{0,40}\]|<(?:your|insert)[^>]{0,40}>/i;

/** Markdown marks dropped: **bold**, __bold__, *em*, a heading's #. */
function plain(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(^|[\s(])\*(\S[^*]*?)\*(?=[\s).,!?]|$)/g, '$1$2')
    .replace(/^#{1,6}\s+/gm, '')
    .trim();
}

/** A text's paragraphs: split on blank lines, each paragraph's lines joined. */
function paragraphsOf(text: string): string[] {
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))
    .filter((lines) => lines.length > 0)
    .map((lines) => lines.join('\n'));
}

/** The paragraphs as sent: from "paragraphs", "letter" (a string, {"body"} or {"paragraphs"}). */
function sentParagraphs(input: { paragraphs?: unknown; letter?: unknown }): { texts: string[]; field: string } {
  if (input.paragraphs !== undefined && input.letter !== undefined) {
    throw refuseWith('paragraphs', 'send the letter once: "paragraphs" or "letter", not both.');
  }
  let value = input.paragraphs ?? input.letter;
  let field = input.paragraphs !== undefined ? 'paragraphs' : 'letter';
  if (isRecord(value)) {
    const inner = firstOf(value, ['paragraphs', 'body', 'text', 'letter']);
    if (!inner) throw refuse(field, LETTER_SHAPE, value);
    field = `${field}.${inner[0]}`;
    value = inner[1];
  }
  if (typeof value === 'string') return { texts: [value], field };
  if (!Array.isArray(value)) throw refuse(field, LETTER_SHAPE, value);
  if (value.length > MAX_SENT_PARAGRAPHS) throw refuse(field, `at most ${MAX_SENT_PARAGRAPHS} paragraphs`);
  return {
    texts: value.map((item, index) => {
      if (typeof item !== 'string') throw refuse(`${field}[${index}]`, 'a paragraph of plain text (a string)', item);
      return item;
    }),
    field,
  };
}

/** The greeting line cut from the first paragraph, the sign-off and every line after it from the last. */
function withoutGreetingAndSignOff(paragraphs: string[]): string[] {
  const out = paragraphs.map((paragraph) => paragraph.split('\n'));
  const first = out[0];
  const greeting = first ? GREETING.exec(first[0]!) : null;
  if (first && greeting) {
    if (greeting[2]!.trim()) first[0] = greeting[2]!.trim();
    else first.shift();
  }
  for (let index = out.length - 1; index >= 0; index -= 1) {
    const lines = out[index]!;
    const at = lines.findIndex((line) => SIGN_OFF.test(line));
    // A sign-off line: it and the name lines under it (at most 3) go; a paragraph that is only those goes.
    if (at >= 0 && lines.length - at <= 4) {
      lines.splice(at);
      if (lines.length > 0) break;
      continue;
    }
    break;
  }
  return out.map((lines) => lines.join(' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** A paragraph's sentences (abbreviations such as "e.g." do not end one). */
function sentencesOf(text: string): string[] {
  const guarded = text.replace(/\b(e\.g|i\.e|vs|etc|Mr|Ms|Mrs|Dr|Inc|Ltd|Co)\./g, (word) => word.replace(/\./g, '\u0000'));
  return (guarded.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) ?? [guarded])
    .map((sentence) => sentence.split('\u0000').join('.').trim())
    .filter(Boolean);
}

/** Four paragraphs at most: the two neighbours with the fewest characters together merged, again and again. */
function mergedToMax(paragraphs: string[]): string[] {
  const out = [...paragraphs];
  while (out.length > LETTER_LIMITS.max) {
    let best = 0;
    for (let index = 1; index < out.length - 1; index += 1) {
      if (out[index]!.length + out[index + 1]!.length < out[best]!.length + out[best + 1]!.length) best = index;
    }
    out.splice(best, 2, `${out[best]} ${out[best + 1]}`);
  }
  return out;
}

/** One paragraph split in two at the sentence boundary nearest its middle; null for a single sentence. */
function splitInTwo(paragraph: string): string[] | null {
  const sentences = sentencesOf(paragraph);
  if (sentences.length < 2) return null;
  const total = sentences.join(' ').length;
  let cut = 1;
  let length = sentences[0]!.length;
  let bestGap = Math.abs(total / 2 - length);
  for (let index = 1; index < sentences.length - 1; index += 1) {
    length += sentences[index]!.length + 1;
    const gap = Math.abs(total / 2 - length);
    if (gap < bestGap) {
      bestGap = gap;
      cut = index + 1;
    }
  }
  return [sentences.slice(0, cut).join(' '), sentences.slice(cut).join(' ')];
}

/** The letter as 2 to 4 paragraphs of plain text, or a refusal naming the field. */
export function normalizeLetter(input: { paragraphs?: unknown; letter?: unknown }): string[] {
  if (input.paragraphs === undefined && input.letter === undefined) throw refuse('paragraphs', LETTER_SHAPE);
  const { texts, field } = sentParagraphs(input);
  const split = texts.flatMap((text) => paragraphsOf(plain(text)));
  let paragraphs = withoutGreetingAndSignOff(split);
  const placeholder = paragraphs.map((paragraph) => PLACEHOLDER.exec(paragraph)?.[0]).find(Boolean);
  if (placeholder) {
    throw refuseWith(field, `holds the placeholder "${placeholder}". Write the real words, or leave it out: TailorIT's template adds the name, the date and the greeting.`);
  }
  if (paragraphs.length === 0) throw refuse(field, LETTER_SHAPE, '');
  if (paragraphs.length === 1) {
    const two = splitInTwo(paragraphs[0]!);
    if (!two) throw refuseWith(field, `is a single sentence; expected ${LETTER_SHAPE}.`);
    paragraphs = two;
  }
  paragraphs = mergedToMax(paragraphs);
  const long = paragraphs.findIndex((paragraph) => paragraph.length > LETTER_LIMITS.length);
  if (long >= 0) throw refuseWith(`${field}`, `paragraph ${long + 1} is over ${LETTER_LIMITS.length.toLocaleString('en-US')} characters; expected ${LETTER_SHAPE}.`);
  return paragraphs;
}
