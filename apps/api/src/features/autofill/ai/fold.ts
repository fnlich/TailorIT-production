// Folding for detection (work package AF, Phase 4 review, T-F1): TailorIT's copy of the extension's detection views
// (src/core/guard/fold.ts there, docs/design/core.md §7.1), so a look-alike letter, a combining mark, an invisible
// character or letters written one by one cannot hide a word from the screen (screen.ts) or from the check for talk of
// being an AI (tasks.ts). The patterns run over these views, never over the page's own spelling. Unlike untrustedText
// it decomposes (NFKD) and drops combining marks, and it keeps punctuation. Nothing here is quoted to Claude.

/** Letters with no Unicode decomposition, spelt out (the extension's LETTERS_WITHOUT_DECOMPOSITION). */
const LETTERS_WITHOUT_DECOMPOSITION: ReadonlyMap<string, string> = new Map([
  ['ß', 'ss'], ['ẞ', 'SS'], ['æ', 'ae'], ['Æ', 'AE'], ['œ', 'oe'], ['Œ', 'OE'], ['ø', 'o'], ['Ø', 'O'],
  ['đ', 'd'], ['Đ', 'D'], ['ł', 'l'], ['Ł', 'L'], ['þ', 'th'], ['Þ', 'TH'], ['ı', 'i'],
]);
const LETTERS = /[ßẞæÆœŒøØđĐłŁþÞı]/g;
/** Combining marks, deleted after the compatibility decomposition. */
const MARKS = /\p{M}/gu;
/** The spacing acute accent, which pages write for an apostrophe: an apostrophe before the decomposition. */
const ACUTE_ACCENT = /\u00B4/g;

/** Cherokee capitals that look like Latin letters; their small letters are added beside them. */
const CHEROKEE: ReadonlyArray<readonly [number, string]> = [
  [0x13a0, 'd'], [0x13a1, 'r'], [0x13a2, 't'], [0x13a5, 'i'], [0x13a9, 'y'], [0x13aa, 'a'], [0x13ab, 'j'],
  [0x13ac, 'e'], [0x13b3, 'w'], [0x13b7, 'm'], [0x13bb, 'h'], [0x13bd, 'y'], [0x13c0, 'g'], [0x13c2, 'h'],
  [0x13c3, 'z'], [0x13cf, 'b'], [0x13d2, 'r'], [0x13d4, 'w'], [0x13d5, 's'], [0x13d9, 'v'], [0x13da, 's'],
  [0x13de, 'l'], [0x13df, 'c'], [0x13e2, 'p'], [0x13e6, 'k'], [0x13f4, 'b'],
];

/**
 * The extension's CONFUSABLES, by code point: Cyrillic, Greek, Armenian, Cherokee and Lisu letters that look like
 * Latin ones, the Latin small capitals and the IPA letters that pass for Latin ones, the negative circled and squared
 * capitals (which NFKD leaves alone), and the apostrophe look-alikes, so "you’re" reads "you're". A character is
 * looked up as written, then each letter of its decomposition.
 */
const CONFUSABLE_CODES: ReadonlyArray<readonly [number, string]> = [
  // Cyrillic capitals.
  [0x0410, 'a'], [0x0412, 'b'], [0x0421, 'c'], [0x0415, 'e'], [0x041d, 'h'], [0x0406, 'i'], [0x0408, 'j'],
  [0x041a, 'k'], [0x041c, 'm'], [0x041e, 'o'], [0x0420, 'p'], [0x0405, 's'], [0x0422, 't'], [0x0425, 'x'],
  [0x0423, 'y'], [0x04ae, 'y'], [0x04ba, 'h'], [0x04c0, 'i'], [0x0500, 'd'], [0x051a, 'q'], [0x051c, 'w'],
  [0x0474, 'v'], [0x0460, 'w'], [0x050c, 'g'], [0x0492, 'f'],
  // Cyrillic small letters, those shaped like Latin small capitals included.
  [0x0430, 'a'], [0x0441, 'c'], [0x0435, 'e'], [0x04bb, 'h'], [0x0456, 'i'], [0x0458, 'j'], [0x043e, 'o'],
  [0x0440, 'p'], [0x0455, 's'], [0x0445, 'x'], [0x0443, 'y'], [0x04af, 'y'], [0x04cf, 'l'], [0x0501, 'd'],
  [0x051b, 'q'], [0x051d, 'w'], [0x0432, 'b'], [0x0433, 'r'], [0x043a, 'k'], [0x043c, 'm'], [0x043d, 'h'],
  [0x043f, 'n'], [0x0442, 't'], [0x044c, 'b'], [0x0475, 'v'], [0x0461, 'w'], [0x0493, 'f'], [0x050d, 'g'],
  // Greek capitals.
  [0x0391, 'a'], [0x0392, 'b'], [0x0395, 'e'], [0x0396, 'z'], [0x0397, 'h'], [0x0399, 'i'], [0x039a, 'k'],
  [0x039c, 'm'], [0x039d, 'n'], [0x039f, 'o'], [0x03a1, 'p'], [0x03a4, 't'], [0x03a5, 'y'], [0x03a7, 'x'],
  [0x03f9, 'c'], [0x037f, 'j'], [0x03dc, 'f'],
  // Greek small letters.
  [0x03b1, 'a'], [0x03b3, 'y'], [0x03b9, 'i'], [0x03ba, 'k'], [0x03bd, 'v'], [0x03bf, 'o'], [0x03c1, 'p'],
  [0x03c5, 'u'], [0x03c7, 'x'], [0x03f2, 'c'], [0x03f3, 'j'], [0x03b7, 'n'], [0x03c3, 'o'], [0x03c4, 't'],
  [0x03c9, 'w'], [0x03f1, 'p'],
  // Armenian capitals and small letters.
  [0x053c, 'l'], [0x054d, 'u'], [0x0555, 'o'], [0x0566, 'q'], [0x0570, 'h'], [0x0575, 'j'], [0x0578, 'n'],
  [0x057d, 'u'], [0x0581, 'g'], [0x0585, 'o'],
  // Cherokee, capitals and small letters.
  ...CHEROKEE,
  ...CHEROKEE.map(([capital, latin]) => [String.fromCodePoint(capital).toLowerCase().codePointAt(0)!, latin] as const),
  // Lisu letters, which are shaped like Latin capitals.
  [0xa4d0, 'b'], [0xa4d1, 'p'], [0xa4d3, 'd'], [0xa4d4, 't'], [0xa4d6, 'g'], [0xa4d7, 'k'], [0xa4d9, 'j'],
  [0xa4da, 'c'], [0xa4dc, 'z'], [0xa4dd, 'f'], [0xa4df, 'm'], [0xa4e0, 'n'], [0xa4e1, 'l'], [0xa4e2, 's'],
  [0xa4e3, 'r'], [0xa4e6, 'v'], [0xa4e7, 'h'], [0xa4ea, 'w'], [0xa4eb, 'x'], [0xa4ec, 'y'], [0xa4ee, 'a'],
  [0xa4f0, 'e'], [0xa4f2, 'i'], [0xa4f3, 'o'], [0xa4f4, 'u'],
  // Latin small capitals.
  [0x1d00, 'a'], [0x0299, 'b'], [0x1d04, 'c'], [0x1d05, 'd'], [0x1d07, 'e'], [0xa730, 'f'], [0x0262, 'g'],
  [0x029c, 'h'], [0x026a, 'i'], [0x1d0a, 'j'], [0x1d0b, 'k'], [0x029f, 'l'], [0x1d0d, 'm'], [0x0274, 'n'],
  [0x1d0f, 'o'], [0x1d18, 'p'], [0xa7af, 'q'], [0x0280, 'r'], [0xa731, 's'], [0x1d1b, 't'], [0x1d1c, 'u'],
  [0x1d20, 'v'], [0x1d21, 'w'], [0x028f, 'y'], [0x1d22, 'z'],
  // IPA letters that pass for Latin ones: alpha, script g, iota, dotless j and the dental click.
  [0x0251, 'a'], [0x0261, 'g'], [0x0269, 'i'], [0x0237, 'j'], [0x01c0, 'l'],
  // Negative circled and negative squared capitals (U+1F150 and U+1F170 on).
  ...[0x1f150, 0x1f170].flatMap((base) =>
    Array.from({ length: 26 }, (_, offset) => [base + offset, String.fromCharCode(0x61 + offset)] as const),
  ),
  // Apostrophe look-alikes: the single quotation marks, the reversed comma, the modifier letters, the prime.
  [0x2018, "'"], [0x2019, "'"], [0x201b, "'"], [0x02b9, "'"], [0x02bb, "'"], [0x02bc, "'"], [0x2032, "'"],
];

const CONFUSABLES: ReadonlyMap<string, string> = new Map(
  CONFUSABLE_CODES.map(([code, latin]) => [String.fromCodePoint(code), latin] as const),
);

/** Deleted, or in the spaced reading read as a space between two letters or digits: every format character. */
const FORMAT = /\p{Cf}/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
/** Read as a space: control characters, whitespace, and the characters that render as a blank. */
const CONTROL = /\p{Cc}/u;
const SPACE = /\s/;
const BLANK = /[\u115F\u1160\u2800\u3164\uFFA0]/;
/** Any UTF-16 unit outside ASCII (astral characters count through their surrogates). */
const NON_ASCII = /[\u0080-\uFFFF]/;

/** One character's letters, decomposed, with no combining marks; case left alone. */
function foldLetters(character: string): string {
  return character
    .replace(ACUTE_ACCENT, "'")
    .normalize('NFKD')
    .replace(LETTERS, (letter) => LETTERS_WITHOUT_DECOMPOSITION.get(letter) ?? letter)
    .replace(MARKS, '');
}

/**
 * The extension's foldForDetection, without its map back to the original: lower case, letters decomposed and their
 * marks gone, look-alikes read as Latin, whitespace and control characters collapsed to single spaces and trimmed,
 * punctuation kept. Format characters are deleted, or (`formatAsSpace`) a run of them between two letters or digits
 * reads as one space.
 */
function foldText(original: string, formatAsSpace: boolean): string {
  let out = '';
  let lastIsSpace = true;
  let gap = false;
  const space = () => {
    gap = false;
    if (!lastIsSpace) out += ' ';
    lastIsSpace = true;
  };
  const text = (piece: string) => {
    const between = LETTER_OR_DIGIT.test(piece[0] ?? '') && LETTER_OR_DIGIT.test(out[out.length - 1] ?? '');
    if (gap && !lastIsSpace && between) out += ' ';
    gap = false;
    out += piece;
    lastIsSpace = false;
  };
  for (const character of original) {
    const code = character.charCodeAt(0);
    if (code < 0x80) {
      if (code <= 0x20 || code === 0x7f) space();
      else text(character.toLowerCase());
      continue;
    }
    if (FORMAT.test(character)) {
      if (formatAsSpace) gap = true;
      continue;
    }
    if (CONTROL.test(character) || SPACE.test(character) || BLANK.test(character)) {
      space();
      continue;
    }
    const confusable = CONFUSABLES.get(character);
    if (confusable !== undefined) {
      text(confusable);
      continue;
    }
    for (const letter of foldLetters(character)) {
      const latin = CONFUSABLES.get(letter) ?? letter.toLowerCase();
      if (SPACE.test(latin)) space();
      else text(latin);
    }
  }
  return out.trimEnd();
}

/** The extension's detectionText: the strict reading, with a fast path for ASCII text. */
function detectionText(original: string): string {
  if (NON_ASCII.test(original)) return foldText(original, false);
  return original.toLowerCase().replace(/[\p{Cc} ]+/gu, ' ').trim();
}

/** A joiner between two letters or digits: hyphens and dashes, the underscore, the full stop and the middle dots. */
const JOINER = /(?<=[\p{L}\p{N}])[-_.\u00B7\u2010-\u2015\u2027\u2212\u30FB](?=[\p{L}\p{N}])/gu;
/** Brackets, double quotes, guillemets and asterisks, which can split one phrase in two. */
const WRAPPER = /[()[\]{}"*\u00AB\u00BB\u201C\u201D]/g;

/** The extension's loose view: joiners between letters, brackets, double quotes and asterisks read as spaces. */
function looseView(folded: string): string {
  return folded.replace(JOINER, ' ').replace(WRAPPER, ' ');
}

/** Three or more letters or digits written one by one, a space between each ("g e n d e r", "s s n"). */
const SPACED_LETTERS = /(?<![\p{L}\p{N}])[\p{L}\p{N}](?: [\p{L}\p{N}]){2,}(?![\p{L}\p{N}])/gu;

/** A view with letters written one by one read as one word: "g e n d e r identity" reads "gender identity". */
function joinedView(view: string): string {
  return view.replace(SPACED_LETTERS, (run) => run.replace(/ /g, ''));
}

/**
 * The texts a pattern runs over for `original`, each in lower case: the extension's detection views (the folded text
 * and its loose view, then, when the text has a format character, its spaced reading and that reading's loose view),
 * and of each the reading with letters written one by one joined ("G e n d e r", "G.e.n.d.e.r"). A hit in any counts.
 */
export function detectionViews(original: string): string[] {
  const strict = detectionText(original);
  const views = [strict, looseView(strict)];
  if (FORMAT.test(original)) {
    const spaced = foldText(original, true);
    views.push(spaced, looseView(spaced));
  }
  for (const view of [...views]) views.push(joinedView(view));
  return [...new Set(views)];
}

/** Every format character, deleted for the case-keeping reading. */
const FORMAT_ALL = /\p{Cf}/gu;

/**
 * The extension's caseKept, for the acronyms screen.ts matches in capitals only: invisible characters deleted, a
 * look-alike letter read as its Latin letter (a capital as a capital), then decomposed with its combining marks
 * deleted, case kept, so "OPT" in Cyrillic or full-width capitals reads "OPT".
 */
export function caseKeptText(original: string): string {
  let out = '';
  for (const character of original.replace(FORMAT_ALL, '')) {
    const latin = CONFUSABLES.get(character);
    if (latin === undefined) out += character;
    else out += character !== character.toLowerCase() ? latin.toUpperCase() : latin;
  }
  return foldLetters(out);
}

/** The extension's SPACED_LETTERS: three or more single letters with one space or joiner between each. */
const SPACED_OUT = /(?<![\p{L}\p{N}])\p{L}(?:[ \-_.\u00B7]\p{L}(?![\p{L}\p{N}])){2,}/gu;

/** The extension's closedUp, case kept: letters spaced out one by one ("O P T", "O.P.T") closed up. */
export function closedUp(text: string): string {
  return text.replace(SPACED_OUT, (run) => run.replace(/[ \-_.\u00B7]/g, ''));
}
