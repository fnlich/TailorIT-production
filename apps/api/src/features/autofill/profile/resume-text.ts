import type { DegreeLevel } from '@tailorit/shared/autofill';

// How "Fill from my resume" reads the words of a resume that the profile keeps as parts: a person's name, a degree
// and a GPA. Pure and small on purpose: what these cannot read is left for the person to check (the seed's notes).

export interface PersonName {
  first: string;
  middle: string;
  last: string;
  suffix: string;
}

/** Name suffixes, compared without dots and in lower case ("Ph.D." is "phd"). */
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v', 'phd', 'md']);
/** Credentials written after a name ("Jane Doe, CPA"), compared the same way: they go to `suffix` with the suffixes. */
const CREDENTIALS = new Set([
  'cpa',
  'cfa',
  'cfp',
  'cma',
  'rn',
  'lpn',
  'bsn',
  'msn',
  'np',
  'pa',
  'pe',
  'pmp',
  'mba',
  'ms',
  'ma',
  'mph',
  'msw',
  'esq',
  'dds',
  'dmd',
  'do',
  'dpt',
  'pharmd',
  'dvm',
  'lcsw',
  'cissp',
]);
/** Credentials that are also names ("Anh Do", "Pa Vang", "Jane Ma"): see suffixKind. */
const NAME_LIKE_CREDENTIALS = new Set(['do', 'pa', 'pe', 'ma']);
/** A credential with a dot after each letter ("P.E.", "D.O."): never a name. */
const DOTTED = /^(?:\p{L}\.){2,}$/u;
/** Titles before a name ("Dr. Jane Doe"), compared the same way: dropped. */
const HONORIFICS = new Set(['dr', 'mr', 'mrs', 'ms', 'mx', 'prof']);
/** Words that begin a last name ("van Beethoven", "de la Cruz", "bin Salman"). */
const PARTICLES = new Set([
  'da',
  'de',
  'del',
  'della',
  'der',
  'di',
  'du',
  'dos',
  'la',
  'le',
  'van',
  'von',
  'bin',
  'al',
  'ten',
  'ter',
]);

const wordsOf = (text: string) => text.split(/\s+/).filter(Boolean);
/** A word as the lists above compare it: no dots, lower case. */
const bareOf = (word: string) => word.toLowerCase().replace(/\./g, '');

/**
 * Whether a word is a suffix or a credential as written, after a comma (`afterComma`) or not. A lone "V." is an
 * initial, not the fifth. Without a comma, a credential counts only as credentials are written, in capitals or with a
 * dot ("Jane Doe CPA", "Esq."), so "Jean Mba" keeps its last name. One that is also a name ("Anh Do") counts with a dot
 * after each letter ("D.O."), or after a comma in capitals ("Jane Doe, DO"), and then not in a name written in capitals
 * (`capitals`): case cannot tell it from a last name, which French-style resumes write in capitals ("Thi Ha DO").
 */
function suffixKind(word: string, afterComma: boolean, capitals: boolean): 'suffix' | 'credential' | null {
  const bare = bareOf(word);
  if (SUFFIXES.has(bare)) return bare === 'v' && word.endsWith('.') ? null : 'suffix';
  if (!CREDENTIALS.has(bare)) return null;
  const inCapitals = word === word.toUpperCase();
  const written = NAME_LIKE_CREDENTIALS.has(bare)
    ? DOTTED.test(word) || (afterComma && inCapitals && !capitals)
    : afterComma || inCapitals || word.includes('.');
  return written ? 'credential' : null;
}

/**
 * Pops the suffixes and credentials at the end of `words`, in the order written: one word always stays, and a
 * credential goes only while two words of the name stay, counting `others` (the name's words elsewhere): "Léon MBA".
 */
function takeSuffixes(words: string[], others: number, capitals: boolean): string[] {
  const taken: string[] = [];
  while (words.length > 1) {
    const kind = suffixKind(words[words.length - 1]!, false, capitals);
    if (kind === null || (kind === 'credential' && words.length - 1 + others < 2)) break;
    taken.unshift(words.pop()!);
  }
  return taken;
}

/**
 * A resume's name line without what is written beside the name: text in brackets ("(she/her)"), anything after a bar,
 * a middle dot, a bullet, a long dash or a hyphen between spaces ("| US Citizen", " - Software Engineer"), and pronouns
 * (a word with a slash, or a part after a comma that holds one: "she/her", "Pronouns: they/them"). None of it is a
 * name, and pronouns or a work authorization are sensitive answers, which the seed never fills. `cut`: something went.
 */
export function nameOf(text: string): { name: string; cut: boolean } {
  const [line = ''] = text.replace(/\([^()]*\)|\[[^[\]]*\]/g, ' ').split(/[|·•–—]|\s-\s/);
  const [written = '', ...after] = line.split(',');
  const kept = [written, ...after.filter((part) => !part.includes('/'))].join(',');
  const name = wordsOf(kept)
    .filter((word) => !word.includes('/'))
    .join(' ');
  return { name, cut: name !== wordsOf(text).join(' ') };
}

/**
 * A full name as its parts. "Last, First Middle" is turned around; suffixes (Jr, Sr, II to V, PhD, MD) and
 * credentials (CPA, RN, MBA...) go to `suffix`, after a comma or not ("Ada Lovelace, PhD", "Jane Doe CPA"); a title
 * before the name (Dr, Mr, Ms, Prof...) is dropped; a particle (da, de, van, von, bin, al...) starts the last name; one
 * word is the first name only; the words between the first and the last name are the middle name.
 */
export function splitPersonName(text: string): PersonName {
  // In a name written all in capitals ("ANH DO"), case cannot tell a credential from a name.
  const capitals = !/\p{Ll}/u.test(text);
  const parts = text
    .split(',')
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const suffixes: string[] = [];
  const afterName = (part: string) => wordsOf(part).every((word) => suffixKind(word, true, capitals) !== null);
  while (parts.length > 1 && afterName(parts[parts.length - 1]!)) suffixes.unshift(parts.pop()!);

  let given: string[];
  let family: string[] | null = null;
  if (parts.length > 1) {
    // "Lovelace, Ada King": the last name first.
    family = wordsOf(parts[0]!);
    given = wordsOf(parts.slice(1).join(' '));
    suffixes.unshift(...takeSuffixes(family, given.length, capitals));
  } else {
    given = wordsOf(parts[0] ?? '');
  }
  suffixes.unshift(...takeSuffixes(given, family?.length ?? 0, capitals));
  // "Dr. Jane Doe": the title goes when a given name follows it and two words of the name remain ("Dr. Doe" keeps it).
  if (given.length > 1 && HONORIFICS.has(bareOf(given[0]!)) && given.length - 1 + (family?.length ?? 0) >= 2) {
    given.shift();
  }
  const suffix = suffixes.join(', ');

  if (family) return { first: given[0] ?? '', middle: given.slice(1).join(' '), last: family.join(' '), suffix };
  if (given.length <= 1) return { first: given[0] ?? '', middle: '', last: '', suffix };
  const particle = given.findIndex(
    (word, index) => index > 0 && index < given.length - 1 && PARTICLES.has(word.toLowerCase()),
  );
  const lastFrom = particle > 0 ? particle : given.length - 1;
  return {
    first: given[0]!,
    middle: given.slice(1, lastFrom).join(' '),
    last: given.slice(lastFrom).join(' '),
    suffix,
  };
}

export interface DegreeReading {
  level: DegreeLevel;
  /** "BS", "MBA"; '' when only the level is known. */
  type: string;
  /** The field of study; the whole text when the degree could not be read. */
  field: string;
}

const APOSTROPHE = "(?:'|’)";
/** "Bachelor", "Bachelor's", "Bachelors", each with an optional "degree". */
const generic = (word: string) => `${word}(?:${APOSTROPHE}s|s)?(?:\\s+degree)?`;
/** "Bachelor of Science", also written "Bachelor's of Science" and "Bachelors of Science". */
const named = (word: string, subject: string) => `${word}${APOSTROPHE}?s?\\s+of\\s+${subject}`;

/** More letters, each with its dot, after a dotted degree: "B.S." of "B.S.E.E." and "B.S.Ed.", "M.A." of "M.A.Ed.". */
const DOTTED_MORE = '(?:\\p{L}{1,2}\\.){1,3}';

/** Degree words, most specific first: the level and the type each says. */
const DEGREES: ReadonlyArray<{ words: string; level: DegreeLevel; type: string }> = [
  { words: 'b\\.?s\\.?n\\.?', level: 'bachelor', type: 'BSN' },
  { words: 'b\\.?s\\.?e\\.?', level: 'bachelor', type: 'BSE' },
  // A longer dotted bachelor's, master's or associate's ("B.S.E.E.", "B.A.Sc.", "M.S.Ed.", "A.A.S."): its level only.
  { words: `b\\.[sa]\\.${DOTTED_MORE}`, level: 'bachelor', type: '' },
  { words: `${named('bachelor', 'science')}|b\\.?\\s?sc\\.?|b\\.?s\\.?`, level: 'bachelor', type: 'BS' },
  { words: `${named('bachelor', 'arts')}|b\\.?a\\.?`, level: 'bachelor', type: 'BA' },
  { words: `${named('bachelor', 'engineering')}|b\\.?\\s?eng\\.?|b\\.?e\\.?`, level: 'bachelor', type: 'BEng' },
  { words: `${named('bachelor', 'business administration')}|b\\.?b\\.?a\\.?`, level: 'bachelor', type: 'BBA' },
  { words: `${named('bachelor', 'fine arts')}|b\\.?f\\.?a\\.?`, level: 'bachelor', type: 'BFA' },
  { words: generic('bachelor'), level: 'bachelor', type: '' },
  {
    words: `${named('master', 'business administration')}|(?:executive\\s+)?m\\.?b\\.?a\\.?`,
    level: 'professional',
    type: 'MBA',
  },
  { words: 'm\\.?s\\.?n\\.?', level: 'master', type: 'MSN' },
  { words: 'm\\.?s\\.?w\\.?', level: 'master', type: 'MSW' },
  { words: 'm\\.?s\\.?e\\.?', level: 'master', type: 'MSE' },
  { words: `m\\.[sa]\\.${DOTTED_MORE}`, level: 'master', type: '' },
  { words: `${named('master', 'science')}|m\\.?\\s?sc\\.?|m\\.?s\\.?`, level: 'master', type: 'MS' },
  { words: `${named('master', 'arts')}|m\\.?a\\.?`, level: 'master', type: 'MA' },
  { words: `${named('master', 'engineering')}|m\\.?\\s?eng\\.?`, level: 'master', type: 'MEng' },
  { words: generic('master'), level: 'master', type: '' },
  { words: 'doctor of philosophy|ph\\.?\\s?d\\.?', level: 'doctorate', type: 'PhD' },
  { words: 'doctorate|doctoral degree', level: 'doctorate', type: '' },
  { words: 'juris doctor|j\\.?d\\.?', level: 'professional', type: 'JD' },
  { words: 'doctor of medicine|m\\.?d\\.?', level: 'professional', type: 'MD' },
  { words: `a\\.[as]\\.${DOTTED_MORE}`, level: 'associate', type: '' },
  { words: `${named('associate', 'science')}|a\\.?s\\.?`, level: 'associate', type: 'AS' },
  { words: `${named('associate', 'arts')}|a\\.?a\\.?`, level: 'associate', type: 'AA' },
  { words: generic('associate'), level: 'associate', type: '' },
  { words: '(?:high|secondary)\\s+school(?:\\s+diploma)?', level: 'highSchool', type: '' },
  { words: 'g\\.?e\\.?d\\.?', level: 'highSchool', type: 'GED' },
];

/**
 * Degree words at the start ("B.S. in Physics"), or at the end after a comma or in brackets ("Physics, B.S."); `exact`
 * is the words alone. At the start, an abbreviation goes on to its last letter: "B.S.N." is never "B.S." and ".N.".
 */
const DEGREE_PATTERNS = DEGREES.map((degree) => ({
  ...degree,
  start: new RegExp(`^(?:${degree.words})(?![\\p{L}\\p{N}]|\\.\\p{L})`, 'iu'),
  end: new RegExp(`(?:^|,|\\()\\s*(?:${degree.words})\\)?$`, 'iu'),
  exact: new RegExp(`^(?:${degree.words})$`, 'iu'),
}));

/** Text that is a degree of `level` and nothing more ("MBA", "B.S.N."). */
const readsAs = (text: string, level: DegreeLevel) =>
  DEGREE_PATTERNS.some((degree) => degree.level === level && degree.exact.test(text.trim()));

const LEADING_SEPARATORS = /^[\s,:;/–—-]+/;

/**
 * The field once the degree words are gone: separators and a leading "in" or "of" dropped, a field in brackets
 * unwrapped ("(Computer Science)"), and brackets before it dropped ("(B.S.) in Physics", "(Hons) Physics"). The degree
 * named again in brackets is no field ("Master of Business Administration (MBA)", "Nursing (BSN)"), and neither is the
 * rest of its name ("Bachelor of Arts and Sciences"): then only what follows "in" is.
 */
function fieldOf(rest: string, level: DegreeLevel): string {
  let field = rest.replace(LEADING_SEPARATORS, '').replace(/[\s,]+$/, '');
  const again = /\s*\(([^()]*)\)$/.exec(field);
  if (again && readsAs(again[1]!, level)) field = field.slice(0, again.index);
  const bracketed = /^\(([^()]*)\)$/.exec(field);
  if (bracketed) return bracketed[1]!.trim();
  field = field.replace(/^\([^()]*\)/, '').replace(LEADING_SEPARATORS, '');
  if (/^(?:and|&)\s/i.test(field)) field = /\sin\s+(.+)$/i.exec(field)?.[1] ?? '';
  return field.replace(/^(?:in|of)\s+/i, '').trim();
}

/**
 * The level, type and field a degree's text says: B.S., BSc or Bachelor of Science is a bachelor's "BS", BSN a
 * bachelor's too, M.S. or MSc a master's, a longer dotted one ("B.S.E.E.", "M.S.Ed.") its level with no type, Ph.D. a
 * doctorate, MBA, JD and MD professional degrees, Associate an associate's, High School or GED high school; "... in X"
 * (or what follows the degree words) is the field. Of two degrees written with a slash ("BS/MS in Computer Science"),
 * the first is read. Text it cannot read is level `other`, the whole text the field.
 */
export function parseDegreeText(text: string): DegreeReading {
  const tidy = text.replace(/\s+/g, ' ').trim();
  for (const degree of DEGREE_PATTERNS) {
    const start = degree.start.exec(tidy);
    if (!start) continue;
    let rest = tidy.slice(start[0].length);
    const slash = /^\s*\/\s*/.exec(rest);
    if (slash) {
      const after = rest.slice(slash[0].length);
      const second = DEGREE_PATTERNS.map((other) => other.start.exec(after)).find((found) => found !== null);
      if (second) rest = after.slice(second[0].length);
    }
    return { level: degree.level, type: degree.type, field: fieldOf(rest, degree.level) };
  }
  for (const degree of DEGREE_PATTERNS) {
    const end = degree.end.exec(tidy);
    if (end && end.index > 0) {
      return { level: degree.level, type: degree.type, field: fieldOf(tidy.slice(0, end.index), degree.level) };
    }
  }
  return { level: 'other', type: '', field: tidy };
}

export interface GpaReading {
  value: number;
  scale: number;
  /** A bare value, read on a scale of 4. */
  assumedScale: boolean;
}

const NUMBER = '(\\d{1,3}(?:[.,]\\d{1,3})?)';
const GPA_PAIR = new RegExp(`^${NUMBER}\\s*(?:/|out of|of)\\s*${NUMBER}$`, 'i');
const GPA_BARE = new RegExp(`^${NUMBER}$`);
const GPA_LABEL = '\\b(?:c?gpa|grade point average)\\b\\s*:?';
const toNumber = (text: string) => Number(text.replace(',', '.'));

/**
 * "3.8/4.0", "3.8 out of 4", "GPA: 3.8", "Cumulative GPA: 3.7"; a note after it is dropped ("3.80/4.00, Dean's
 * List"); a bare value up to 4 is read on a scale of 4. Null when it is not a GPA.
 */
export function parseGpa(text: string): GpaReading | null {
  const tidy = text
    .replace(/\([^)]*\)/g, ' ')
    // A note after a semicolon or a comma; a comma inside a number stays ("3,8/4,0").
    .replace(/[;,](?!\d).*$/s, '')
    // The words before the label go with it ("Cumulative GPA:", "Major GPA").
    .replace(new RegExp(`^[\\p{L}\\s'’-]*?${GPA_LABEL}`, 'iu'), ' ')
    .replace(new RegExp(GPA_LABEL, 'gi'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const pair = GPA_PAIR.exec(tidy);
  if (pair) {
    const value = toNumber(pair[1]!);
    const scale = toNumber(pair[2]!);
    return scale > 0 && scale <= 100 && value <= scale ? { value, scale, assumedScale: false } : null;
  }
  const bare = GPA_BARE.exec(tidy);
  if (bare && toNumber(bare[1]!) <= 4) return { value: toNumber(bare[1]!), scale: 4, assumedScale: true };
  return null;
}
