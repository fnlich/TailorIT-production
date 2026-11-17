import { toKeywordMatchForm } from './ats';
import type { TailoredContent } from './types';

// tailor_builder0's services/tailoring/humanize.ts, ported (the owner's permission of 2026-11-09).

// Wording that makes a resume read as machine-written. Some of it has a safe
// mechanical fix ("utilized" -> "used", "nine" -> "9", "40 percent" -> "40%"),
// applied in code at no cost; the rest needs a rewrite and is handed to the
// revision call as style issues.

export interface StyleIssue {
  /** Where the line is, as the revision prompt names it ("Acme bullet 2", "summary"). */
  where: string;
  problem: string;
  /** Serious tells justify a revision call on their own; minor ones ride along when one runs. */
  serious: boolean;
  /** Code fixes this at the end (a trailing clause is cut), so the model is never asked to. */
  fixedByCode?: boolean;
  /** Still worth another revision round if the first didn't fix it (a lost figure, unlike a style slip). */
  essential?: boolean;
}

type FormSwap = [RegExp, (word: string) => string];

// Swaps every form of a verb: forms and replacements line up by position.
// Word boundaries keep "reuse" or "leveraged buyout" style compounds out of reach.
function verbSwap(forms: string[], replacements: string[]): FormSwap {
  return [
    new RegExp(`\\b(?:${forms.join('|')})\\b`, 'gi'),
    (word) => replacements[forms.indexOf(word.toLowerCase())] ?? replacements[0]!,
  ];
}

const WORD_SWAPS: FormSwap[] = [
  verbSwap(['utilize', 'utilizes', 'utilized', 'utilizing', 'utilization'], ['use', 'uses', 'used', 'using', 'use']),
  verbSwap(['leverage', 'leverages', 'leveraged', 'leveraging'], ['use', 'uses', 'used', 'using']),
  verbSwap(['spearhead', 'spearheads', 'spearheaded', 'spearheading'], ['lead', 'leads', 'led', 'leading']),
  verbSwap(['streamline', 'streamlines', 'streamlined', 'streamlining'], ['simplify', 'simplifies', 'simplified', 'simplifying']),
  // "orchestration" (Kubernetes, container) is a noun and isn't touched.
  verbSwap(['orchestrate', 'orchestrates', 'orchestrated', 'orchestrating'], ['coordinate', 'coordinates', 'coordinated', 'coordinating']),
  verbSwap(['championed', 'championing'], ['pushed for', 'pushing for']),
  [/\bin order to\b/gi, () => 'to'],
  [/\bhelped to\b/gi, () => 'helped'],
  // "day-to-day work" is "daily work". "from day to day" is a different phrase and stays.
  [/(?<!from )\bday[- ]to[- ]day\b/gi, () => 'daily'],
];

// Phrases with no safe swap. A phrase that is also a job keyword is allowed.
const BANNED_PHRASES = [
  // Inflated words and slogans
  'synergy', 'fast-paced', 'cutting-edge', 'seamless', 'seamlessly', 'robust', 'thought leadership',
  'digital transformation', 'best-in-class', 'world-class', 'go-getter', 'stakeholder value',
  'resulting in', 'facilitated', 'facilitating', 'harnessed', 'harnessing', 'empowered', 'empowering',
  'fostered', 'fostering', 'enterprise-grade', 'scalable solutions', 'innovative',
  // Adjective self-description
  'passionate', 'results-driven', 'proven track record', 'track record', 'highly skilled', 'highly motivated',
  'self-starter', 'seasoned', 'detail-oriented', 'team player', 'strong background in', 'extensive experience',
  'deep background', 'deep expertise', 'comfortable across', 'broad background',
  'wealth of experience', 'adept at', 'strong understanding of', 'comfortable owning', 'comfortable with',
  'good at', 'skilled at',
  // More words that read as machine-written
  'pioneered', 'revolutionized', 'transformed', 'showcased', 'delved', 'comprehensive', 'holistic', 'pivotal',
  'meticulous', 'state-of-the-art', 'mission-critical', 'end-to-end', 'elevated',
  // Filler, and adjectives that praise the work
  'responsible for', 'tasked with', 'day to day', 'day-to-day', 'hands-on experience with', 'demonstrating',
  'showcasing', 'successfully', 'effectively', 'various', 'worked on', 'helped with', 'efficient', 'elegant',
  'high-quality',
  // The sentence the prompt used to suggest for the target title
  'role centers on',
];

// Openings and closings that mark a template cover letter.
const COVER_LETTER_CLICHES = [
  'i am excited to apply', 'i am writing to express', 'i believe my skills', 'i look forward to hearing',
  'thank you for your consideration', 'i would be a great fit', 'i am confident that', 'well-suited',
  'maps closely', 'i would welcome the opportunity', 'bring that same approach', 'i am thrilled',
  'i am eager to',
];

// ", ensuring X", ", helping Y", ", keeping Z": a participle clause bolted onto the end
// of a line, usually restating the result the line already gave. ", using X" and
// friends describe how the work was done and are fine.
const TAIL_PARTICIPLE = /,\s+([a-z]+ing)\b[^,.]*[.]?$/i;
const TAIL_PARTICIPLE_OK = new Set(['using', 'including', 'working', 'following', 'according', 'regarding', 'depending', 'excluding', 'during']);
const TAIL_CLAUSE = /,\s+(?:which\s+(?:allowed|helped|led to|meant)|while adjusting to)\b[^,.]*[.]?$/i;
// ", which kept the same failures from repeating": fine once, a habit when every bullet has one.
const WHICH_TAIL = /,\s+which\s+\w+[^,.]*[.]?$/i;
// "A, B, and C": a list of three or more things in one line.
const SERIES = /,\s+[^,.]+,\s+(?:and|or)\s+/i;
// A sentence that starts with a third-person verb ("Runs 3 clusters"); resume prose is implied first person.
const THIRD_PERSON_OPENING =
  /(?:^|[.!?]\s+)(Runs|Brings|Builds|Leads|Delivers|Specializes|Focuses|Combines|Offers|Provides|Drives|Owns|Manages|Develops|Designs|Maintains|Has|Is|Works|Ensures|Helps)\b/;

// A tail with a figure in it ("..., covering 14 services") is a concrete detail, not a vague
// benefit, so it isn't flagged.
function tackedOnClause(text: string): string | null {
  const participle = text.match(TAIL_PARTICIPLE);
  const clause =
    participle && !TAIL_PARTICIPLE_OK.has(participle[1]!.toLowerCase()) ? participle[0].trim() : text.match(TAIL_CLAUSE)?.[0].trim();
  return clause && !/\d/.test(clause) ? clause : null;
}

/**
 * The last resort for a vague trailing clause the revision didn't fix: end the line
 * before it ("or just stop"). A clause that names a job keyword stays, since the keyword
 * has to appear somewhere.
 */
export function dropTackedOnClause(text: string, keywordTerms: string[] = []): string {
  const clause = tackedOnClause(text);
  if (!clause || keywordTerms.some((term) => containsPhrase(clause, term))) return text;
  const start = text.lastIndexOf(clause);
  if (start <= 0) return text;
  return `${text.slice(0, start).trimEnd()}${/[.!]$/.test(text.trim()) ? '.' : ''}`;
}

// The small hours of the night (a 2 a.m. page, a midnight deploy, "in the middle of the night") are the most
// overused way to show that on-call work mattered, and a resume that mentions one reads as machine-written.
// 1 to 5 a.m. in any spelling ("2 a.m.", "2am", "3:30 AM"), midnight, and the middle of the night.
const SMALL_HOURS = String.raw`(?<![\d:])[1-5](?::[0-5]\d)?\s?(?:a\.m\.|am\b)`;
const NIGHT_TIME = String.raw`(?:${SMALL_HOURS}|\bmidnight\b|(?:\bin )?the middle of the night)`;
const NIGHT_PREPOSITION = String.raw`\s+(?:at|around|by|until|past|after|since)\s+`;
const nightCliche = () => new RegExp(String.raw`(?:${NIGHT_PREPOSITION})?${NIGHT_TIME}(?!\w)`, 'gi');

const normalizeSpaces = (text: string) => text.toLowerCase().replace(/\s+/g, ' ');

// What a match is about without the preposition in front of it ("at 2 a.m." -> "2 a.m.").
const nightCore = (match: string) => match.replace(new RegExp(`^${NIGHT_PREPOSITION}`, 'i'), '').trim();

/**
 * The first night-time mention in `text` that the candidate's own profile doesn't make, or null. A profile
 * that really says "3 a.m. maintenance windows" has given the fact, so it is the candidate's to keep.
 */
export function findNightCliche(text: string, sourceText = ''): string | null {
  const source = normalizeSpaces(sourceText);
  for (const match of text.matchAll(nightCliche())) {
    const core = nightCore(match[0]);
    if (!source.includes(normalizeSpaces(core))) return core;
  }
  return null;
}

/**
 * Takes the night-time mentions out of a line ("... the on-call rotation now uses at 2 a.m." ends at "uses"),
 * except ones the candidate's own profile makes. The rest of the line, and its keywords, stay.
 */
export function withoutNightCliches(text: string, sourceText = ''): string {
  if (!findNightCliche(text, sourceText)) return text;
  const source = normalizeSpaces(sourceText);
  let result = text.replace(nightCliche(), (match) => (source.includes(normalizeSpaces(nightCore(match))) ? match : ''));
  result = result
    // Two mentions joined by "and" leave it hanging: at the end of the line, or in front of what followed them.
    .replace(/\s+(?:and|or)\s*(?=[,.;!?]|$)/gi, '')
    .replace(/\s+(?:and|or)\s+(?=(?:for|to|in|on|from|with|by|during|across|over|so|when|while)\b)/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;!?])/g, '$1')
    .replace(/,\s*,/g, ',')
    .trim();
  // The period of "a.m." may have been the sentence's own.
  return /\.\s*$/.test(text) && !/[.!?]$/.test(result) ? `${result}.` : result;
}

// Sentences the prompts use as examples. A model copies them, and then every resume says the same
// thing, claims included. A line that reuses one is flagged unless the candidate's own profile says it.
const PROMPT_EXAMPLES = [
  'per-service modules so each environment came up from one plan',
  'the support team now uses at 2 a.m',
  'stopped paging on-call for status checks',
  'kept timing out on large branches',
  'replaced the nightly cron jobs with airflow',
  'to meet healthtech compliance needs',
  'ran stakeholder communication for the cluster upgrade',
  'terraform for everything except the legacy rds',
  'moved the batch jobs to event-driven processing',
  'with working knowledge of payments and pci-scoped systems',
  'the onboarding guide new hires followed in their first week',
];

// Pitching the candidate toward a role: the summary says what they have done, not what they want.
const PITCH_PHRASES = ['seeking', 'eager', 'looking for', 'looking to', 'passionate about', 'excited to'];
// First-person words; resume prose is implied first person.
const FIRST_PERSON = /\b(?:I|my|we|our|My|We|Our)\b/;

// Of the bullets, at most this share may carry a number the profile doesn't give.
const MAX_INVENTED_NUMBER_SHARE = 0.5;
// Job keywords one line may name. The summary isn't for keywords, so it holds hardly any.
const MAX_KEYWORDS_PER_LINE = 4;
const MAX_KEYWORDS_IN_SUMMARY = 2;
// One bullet per role may list three or more things.
const MAX_SERIES_PER_ROLE = 1;
const SHORT_BULLET_WORDS = 12;
const MAX_BULLET_WORDS = 35;
const MIN_BULLETS_FOR_LENGTH_CHECK = 6;
// Real work rarely lands on a multiple of 5; "40%, 50%, 60%" everywhere reads as made up.
const MAX_PERCENT_LINES = 2;

function keepCase(original: string, replacement: string): string {
  return original[0] === original[0]?.toUpperCase() ? replacement[0]!.toUpperCase() + replacement.slice(1) : replacement;
}

// --- Numbers as digits -------------------------------------------------------

const SMALL_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const NUMBER_WORD = [...Object.keys(SMALL_NUMBERS), ...Object.keys(TENS), 'hundred', 'thousand'].join('|');

// "nine", "twenty-five", "two hundred and fifty", "a hundred", "three thousand" runs,
// optionally followed by "million"/"billion" ("two million"). An "a" is taken only
// when it belongs to the number ("a hundred"), not in "a three-person team".
const NUMBER_RUN = new RegExp(
  `\\b(?:a\\s+(?=(?:hundred|thousand)\\b))?(?:${NUMBER_WORD})(?:(?:-|\\s+and\\s+|\\s+)(?:${NUMBER_WORD}))*\\b(?:\\s+(million|billion)\\b)?`,
  'gi'
);

// "one" is also a pronoun ("no one", "one of", "one-on-one"), so it becomes 1 only
// before a thing that gets counted, or beside another number ("one or two").
const COUNTED_THING =
  'year|month|week|day|hour|minute|team|cluster|region|account|service|pipeline|platform|environment|engineer|developer|person|' +
  'project|release|sprint|quarter|site|server|database|cloud|repo|repository|application|product|vendor|tool|migration|outage|incident';
const ONE_AS_COUNT = new RegExp(`^\\s*(?:(?:${COUNTED_THING})s?\\b|(?:or|to)\\s+(?:${NUMBER_WORD})\\b)`, 'i');

// For runs that aren't one number: the words that are safe to convert alone ("one" isn't).
const SINGLE_NUMBER_WORD = new RegExp(
  `\\b(?:${[...Object.keys(SMALL_NUMBERS), ...Object.keys(TENS)].filter((word) => word !== 'one').join('|')})\\b`,
  'gi'
);

type NumberKind = 'start' | 'small' | 'tens' | 'hundred' | 'thousand';
const NEXT_KINDS: Record<NumberKind, NumberKind[]> = {
  start: ['small', 'tens'],
  small: ['hundred', 'thousand'],
  tens: ['small', 'thousand'],
  hundred: ['small', 'tens', 'thousand'],
  thousand: ['small', 'tens'],
};

function kindOf(word: string): NumberKind {
  if (word in SMALL_NUMBERS) return 'small';
  if (word in TENS) return 'tens';
  return word === 'hundred' ? 'hundred' : 'thousand';
}

/** The value of number words ("two hundred fifty" -> 250), or null when they don't form one number. */
function parseNumberWords(words: string[], startsWithA: boolean): number | null {
  let total = 0;
  let current = 0;
  let last: NumberKind = startsWithA ? 'small' : 'start';
  for (const word of words) {
    const kind = kindOf(word);
    if (!NEXT_KINDS[last].includes(kind)) return null;
    // "twenty" takes 1-9 only: "twenty eleven" isn't a number.
    if (last === 'tens' && kind === 'small' && SMALL_NUMBERS[word]! >= 10) return null;
    if (kind === 'small') current += SMALL_NUMBERS[word]!;
    else if (kind === 'tens') current += TENS[word]!;
    else if (kind === 'hundred') current = (current || 1) * 100;
    else {
      total += (current || 1) * 1000;
      current = 0;
    }
    last = kind;
  }
  return total + current;
}

function formatCount(value: number): string {
  return value >= 1000 ? value.toLocaleString('en-US') : String(value);
}

function startsSentence(text: string, index: number): boolean {
  const before = text.slice(0, index).trimEnd();
  return before === '' || /[.!?:\n]$/.test(before);
}

/** Spelled-out numbers become digits: "nine years" -> "9 years", "twenty-five" -> "25". */
export function numberWordsToDigits(text: string): string {
  return text.replace(NUMBER_RUN, (match: string, scale: string | undefined, offset: number, whole: string) => {
    // "Two Sigma", "Twelve Labs": a capitalized number word inside a sentence is a name.
    if (/^[A-Z]/.test(match) && !startsSentence(whole, offset)) return match;

    const body = scale ? match.slice(0, match.search(/\s+(?:million|billion)\s*$/i)) : match;
    const startsWithA = /^a\s+/i.test(body);
    const words = body
      .replace(/^a\s+/i, '')
      .toLowerCase()
      .split(/-|\s+and\s+|\s+/);
    if (words.length === 1 && words[0] === 'one' && !ONE_AS_COUNT.test(whole.slice(offset + match.length))) return match;

    const value = parseNumberWords(words, startsWithA);
    // Words that don't form one number ("five and six") are converted one by one.
    if (value === null) return match.replace(SINGLE_NUMBER_WORD, (word) => String(SMALL_NUMBERS[word.toLowerCase()] ?? TENS[word.toLowerCase()]));
    if (scale) return value < 1000 ? `${value} ${scale.toLowerCase()}` : match;
    return formatCount(value);
  });
}

// --- Symbols as symbols ------------------------------------------------------

/** "40 percent" -> "40%", "18,000 dollars" -> "$18,000", "10 plus years" -> "10+ years", "$18k per month" -> "$18k/month". */
export function wordsToSymbols(text: string): string {
  return text
    .replace(/(\d[\d,]*(?:\.\d+)?)\s*(?:percent|per cent)\b/gi, '$1%')
    .replace(
      /\b(\d[\d,]*(?:\.\d+)?)(\s*(?:thousand|million|billion|k|m|b))?\s+(?:US\s+|U\.S\.\s+)?dollars?\b/gi,
      (_match, amount: string, scale?: string) => {
        const unit = scale?.trim() ?? '';
        return `$${amount}${unit && (unit.length === 1 ? unit : ` ${unit}`)}`;
      }
    )
    .replace(/(\d)-plus\b/gi, '$1+')
    .replace(/(\d[\d,]*)\s+plus\b(?!\s+\d)/gi, '$1+')
    .replace(/\b(?:approximately|approx\.?)\s+(?=[$~]?\d)/gi, '~')
    .replace(/(\d[\d,.]*[kmb]?)\s+per\s+(second|minute|hour|day|week|month|quarter|year)\b/gi, '$1/$2')
    .replace(/\b(\d+(?:\.\d+)?)\s+times\s+(?=(?:faster|slower|more|less|larger|smaller|bigger|as)\b)/gi, '$1x ');
}

// A heading word in front of a colon ("Impact: ..."). The heading goes and the line reads as a sentence.
const LEAD_IN_LABELS = new Set([
  'result', 'results', 'key results', 'impact', 'outcome', 'outcomes', 'tools', 'tool', 'tech', 'technologies', 'stack',
  'tech stack', 'scope', 'context', 'challenge', 'solution', 'summary', 'note', 'notes', 'environment', 'skills', 'highlights',
  'achievements', 'responsibilities',
]);
// Under this many words, what comes before a colon or semicolon is a lead-in or a list item, not a sentence.
const MIN_WORDS_FOR_SENTENCE = 3;
// A piece after the mark this long is a clause of its own, however short the lead-in.
const MIN_WORDS_FOR_TAIL_CLAUSE = 4;
const MAX_WORDS_IN_LIST_TAIL = 8;

// A word that already has a capital, a digit or a dot ("Terraform", "iOS", "k8s", "node.js") keeps its case at a sentence start.
const keepsItsCase = (word: string) => /[A-Z0-9./]/.test(word);

/**
 * Semicolons and colons read as machine-written, so none survive. Two clauses become two sentences,
 * a short lead-in or a list gets a comma ("Skills used: Python; Go" -> "Skills used, Python, Go"),
 * and a heading like "Impact:" is dropped. A clock time or ratio ("9:30", "3:1") and a URL
 * ("https://") keep their colon.
 */
export function withoutSemicolonsAndColons(text: string): string {
  if (!/[;:]/.test(text)) return text;
  const marks = /[ \t]*([;:])[ \t]*/g;
  let result = '';
  let last = 0;
  let pieceStart = 0; // where the text since the last mark (or the start) begins in `result`
  let capitalizeNext = false;
  const append = (segment: string) => {
    if (capitalizeNext && segment) {
      const word = segment.split(/\s/)[0];
      result += keepsItsCase(word!) ? segment : segment[0]!.toUpperCase() + segment.slice(1);
      capitalizeNext = false;
    } else {
      result += segment;
    }
  };

  for (let match = marks.exec(text); match; match = marks.exec(text)) {
    append(text.slice(last, match.index));
    last = marks.lastIndex;
    const mark = match[1];
    const after = text.slice(last);

    const tight = match[0] === mark;
    if (mark === ':' && tight && ((/\d$/.test(result) && /^\d/.test(after)) || after.startsWith('//'))) {
      result += mark;
      continue;
    }
    // Nothing follows on the line, so there is nothing to join.
    if (/^(?:\n|$)/.test(after)) continue;

    const sentenceStart = Math.max(result.lastIndexOf('. '), result.lastIndexOf('! '), result.lastIndexOf('? '), result.lastIndexOf('\n')) + 1;
    const sentence = result.slice(sentenceStart).trim();
    if (mark === ':' && LEAD_IN_LABELS.has(sentence.toLowerCase())) {
      result = result.slice(0, sentenceStart) + (sentenceStart > 0 && !result.slice(0, sentenceStart).endsWith('\n') ? ' ' : '');
      pieceStart = result.length;
      capitalizeNext = true;
      continue;
    }

    // A mark right after a full stop is only a break between sentences.
    if (/[.!?]$/.test(result)) {
      result += ' ';
      capitalizeNext = true;
      pieceStart = result.length;
      continue;
    }

    // Judge the piece before the mark, not the whole sentence, so "Python; Go; Rust" stays one list.
    const piece = result.slice(Math.max(sentenceStart, pieceStart)).trim();
    const pieceWords = piece ? piece.split(/\s+/).length : 0;
    // What follows, up to the next mark or the end of the sentence: "auth, billing, and search" is a list, "nobody paged me again" a clause.
    const tail = after.split(/[;:]|[.!?](?:\s|$)/)[0] ?? '';
    const tailWords = tail.split(/\s+/).filter(Boolean).length;
    const tailIsList = tail.includes(',') && tailWords <= MAX_WORDS_IN_LIST_TAIL;
    const startsClause = (pieceWords >= MIN_WORDS_FOR_SENTENCE || tailWords >= MIN_WORDS_FOR_TAIL_CLAUSE) && !tailIsList;
    if (startsClause) {
      result += '. ';
      capitalizeNext = true;
    } else {
      result += /,$/.test(result) ? ' ' : ', ';
    }
    pieceStart = result.length;
  }
  append(text.slice(last));
  return result;
}

/** Safe mechanical fixes: em dashes, semicolons and colons, a few inflated verbs, numbers as digits, symbols as symbols. */
export function humanizeText(text: string): string {
  let result = withoutSemicolonsAndColons(text)
    // An em dash (or " -- " typed as one), or a spaced en dash between words, becomes
    // a comma. Number ranges ("2019–2021") keep their dash.
    .replace(/\s*—\s*/g, ', ')
    .replace(/\s+--\s+/g, ', ')
    .replace(/(\D)\s+–\s+(\D)/g, '$1, $2');
  for (const [pattern, swap] of WORD_SWAPS) {
    result = result.replace(pattern, (word) => keepCase(word, swap(word)));
  }
  result = wordsToSymbols(numberWordsToDigits(result));
  return result.replace(/,\s*,/g, ',').replace(/\s+,/g, ',');
}

/** Applies humanizeText to every prose field. Skills lists are names and stay as they are. */
export function humanizeContent(tailored: TailoredContent): TailoredContent {
  return {
    ...tailored,
    summary: humanizeText(tailored.summary),
    experience: tailored.experience.map((role) => ({
      ...role,
      description: humanizeText(role.description),
      achievements: role.achievements.map((bullet) => humanizeText(bullet)),
    })),
    strengths: tailored.strengths.map((s) => ({
      ...s,
      title: humanizeText(s.title),
      description: humanizeText(s.description),
    })),
    ...(tailored.coverLetter ? { coverLetter: humanizeText(tailored.coverLetter) } : {}),
  };
}

function containsPhrase(text: string, phrase: string): boolean {
  return ` ${toKeywordMatchForm(text)} `.includes(` ${toKeywordMatchForm(phrase)} `);
}

function percentages(text: string): string[] {
  return [...text.matchAll(/(\d+(?:\.\d+)?)%/g)].map((m) => m[1]!);
}

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

type Line = { where: string; text: string };
type RoleRef = { company: string; title: string };

/** How a line names its role: the company, plus the title when the company has two roles. */
export function roleLabel(role: RoleRef, experience: RoleRef[]): string {
  const key = toKeywordMatchForm(role.company);
  const rolesHere = experience.filter((other) => toKeywordMatchForm(other.company) === key).length;
  return rolesHere > 1 && role.title ? `${role.company} (${role.title})` : role.company;
}

// Words that carry a line's meaning, for telling whether two lines say the same thing.
const LINE_FILLER = new Set(['the', 'and', 'for', 'with', 'that', 'from', 'into', 'this', 'were', 'was', 'are', 'across', 'using', 'used', 'our', 'their']);
const REPEATED_LINE_SIMILARITY = 0.6;
const MIN_WORDS_TO_COMPARE = 4;

function contentWords(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9+#./]{3,}/g) ?? []).filter((word) => !LINE_FILLER.has(word)));
}

function similarity(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return a.size === 0 || b.size === 0 ? 0 : shared / (a.size + b.size - shared);
}

/**
 * Finds what still reads as machine-written after humanizeContent. Job keywords
 * are exempt, so a posting that asks for a "team player" can still get one.
 * `sourceText` is what the candidate's own profile says: a percentage or number that
 * is theirs is a fact, not an invented figure.
 */
export function findStyleIssues(tailored: TailoredContent, keywordTerms: string[] = [], sourceText = ''): StyleIssue[] {
  const keywordKeys = new Set(keywordTerms.map(toKeywordMatchForm));
  const banned = BANNED_PHRASES.filter((phrase) => !keywordKeys.has(toKeywordMatchForm(phrase)));
  const knownPercents = new Set(percentages(humanizeText(sourceText)));
  const knownNumbers = new Set(humanizeText(sourceText).match(/\d[\d,.]*\d|\d/g) ?? []);
  const issues: StyleIssue[] = [];

  // `prose` lines (summary, role descriptions) are sentences; bullets are fragments that start with a verb.
  const labels = tailored.experience.map((role) => roleLabel(role, tailored.experience));
  const bulletsByRole: Line[][] = tailored.experience.map((role, roleIndex) =>
    role.achievements.map((text, index) => ({ where: `${labels[roleIndex]} bullet ${index + 1}`, text })).filter((line) => line.text)
  );
  const lines: Array<Line & { prose: boolean }> = [
    { where: 'summary', text: tailored.summary, prose: true },
    ...tailored.experience.flatMap((role, roleIndex) => [
      { where: `${labels[roleIndex]} description`, text: role.description, prose: true },
      ...bulletsByRole[roleIndex]!.map((line) => ({ ...line, prose: false })),
    ]),
  ];

  const withPercent: string[] = [];
  for (const { where, text, prose } of lines) {
    if (!text) continue;
    const phrases = banned.filter((phrase) => containsPhrase(text, phrase));
    if (phrases.length > 0) issues.push({ where, problem: `uses ${phrases.map((p) => `"${p}"`).join(', ')}`, serious: true });
    const clause = tackedOnClause(text);
    if (clause) issues.push({ where, problem: `ends with a tacked-on clause: "${clause}"`, serious: true, fixedByCode: true });
    const night = findNightCliche(text, sourceText);
    if (night) issues.push({ where, problem: `mentions "${night}", an overused cliché; say what the runbook, alert or fix covered instead`, serious: true, fixedByCode: true });
    const opening = prose ? text.match(THIRD_PERSON_OPENING) : null;
    if (opening) issues.push({ where, problem: `has a sentence that opens with "${opening[1]}"; write it as a fragment or in the past tense ("Ran 3 clusters...")`, serious: true });
    const copied = PROMPT_EXAMPLES.find((example) => containsPhrase(text, example) && !containsPhrase(sourceText, example));
    if (copied) {
      issues.push({ where, problem: `reuses the wording of an example from the instructions ("${copied}"); describe this candidate's own work instead`, serious: true });
    }
    const firstPerson = text.match(FIRST_PERSON);
    if (firstPerson) issues.push({ where, problem: `uses "${firstPerson[0]}"; resume lines have no first-person words`, serious: true });
    // Every keyword has to appear, which can crowd a line. Past the limit it reads as a list of terms, not work.
    const limit = where === 'summary' ? MAX_KEYWORDS_IN_SUMMARY : MAX_KEYWORDS_PER_LINE;
    // Only phrases count. A bullet that lists Maven, Gradle and npm is a list of tools, which reads fine.
    const named = [...new Set(keywordTerms.filter((term) => term.includes(' ') && containsPhrase(text, term)))];
    if (named.length > limit) {
      issues.push({
        where,
        problem: `names ${named.length} job keyword phrases (${named.slice(0, 5).map((term) => `"${term}"`).join(', ')}${named.length > 5 ? ', ...' : ''}); keep it to ${limit} and give the rest a short plain bullet of their own`,
        // A summary that strings practices together is the plainest sign of stuffing, so it earns a rewrite.
        // A crowded bullet is only fixed when a revision runs for another reason.
        serious: where === 'summary',
      });
    }
    if (where === 'summary') {
      const pitch = PITCH_PHRASES.filter((phrase) => containsPhrase(text, phrase));
      if (pitch.length > 0) {
        issues.push({ where, problem: `pitches the candidate toward a role (${pitch.map((p) => `"${p}"`).join(', ')}); the summary says what they have done, it is not a cover letter`, serious: true });
      }
    }
    if (!prose && wordCount(text) > MAX_BULLET_WORDS) {
      issues.push({ where, problem: `runs ${wordCount(text)} words; keep a bullet under ${MAX_BULLET_WORDS}`, serious: true });
    }
    const found = percentages(text);
    if (found.length > 0) withPercent.push(where);
    const round = found.filter((p) => Number(p) % 5 === 0 && !knownPercents.has(p));
    if (round.length > 0) {
      issues.push({
        where,
        problem: `states ${round.map((p) => `${p}%`).join(', ')}, a round figure the profile doesn't give; use a before and after value or a count instead, or leave the number out`,
        serious: true,
      });
    }
  }
  // Two roles that say the same thing (the same company's II and I, or any two jobs): each line
  // has to be about that role's own work.
  const roleLines: Line[][] = tailored.experience.map((role, roleIndex) =>
    [{ where: `${labels[roleIndex]} description`, text: role.description }, ...bulletsByRole[roleIndex]!].filter((line) => line.text)
  );
  roleLines.forEach((current, roleIndex) => {
    for (const line of current) {
      const words = contentWords(line.text);
      if (words.size < MIN_WORDS_TO_COMPARE) continue;
      for (let earlier = 0; earlier < roleIndex; earlier += 1) {
        const match = roleLines[earlier]!.find((other) => {
          const otherWords = contentWords(other.text);
          return otherWords.size >= MIN_WORDS_TO_COMPARE && similarity(words, otherWords) >= REPEATED_LINE_SIMILARITY;
        });
        if (!match) continue;
        issues.push({
          where: line.where,
          problem: `repeats a line from ${labels[earlier]} ("${match.text.split(/\s+/).slice(0, 8).join(' ')}..."); write what this role did differently, since the two roles had different scope`,
          serious: true,
        });
        break;
      }
    }
  });

  // A resume where most lines end in a percentage reads as a template.
  for (const where of withPercent.slice(MAX_PERCENT_LINES)) {
    issues.push({ where, problem: `is another line built around a % result (${withPercent.length} lines have one); reword it without a percentage`, serious: false });
  }

  // Habits that are fine once and a tell when they repeat. The first few are allowed.
  const flagRepeats = (items: Line[], matches: (text: string) => boolean, allowed: number, problem: string) => {
    for (const { where } of items.filter((item) => matches(item.text)).slice(allowed)) issues.push({ where, problem, serious: false });
  };
  const allBullets = bulletsByRole.flat();
  flagRepeats(allBullets, (text) => WHICH_TAIL.test(text), 1, 'ends with a ", which ..." clause like another bullet; end on the result instead');
  flagRepeats(
    allBullets,
    (text) => (text.match(/\d[\d,.]*\d|\d/g) ?? []).some((n) => !knownNumbers.has(n)),
    Math.ceil(allBullets.length * MAX_INVENTED_NUMBER_SHARE),
    "has a number the profile doesn't give, in a resume where most bullets do; reword it without the number unless the number is the point"
  );
  for (const roleBullets of bulletsByRole) {
    flagRepeats(roleBullets, (text) => SERIES.test(text), MAX_SERIES_PER_ROLE, 'lists three or more things like another bullet in the role; name one or two');
    // No two bullets in a role start with the same verb.
    const openings = new Map<string, string[]>();
    for (const { where, text } of roleBullets) {
      const verb = text.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, '');
      if (verb) openings.set(verb, [...(openings.get(verb) ?? []), where]);
    }
    for (const [verb, places] of openings) {
      if (places.length > 1) issues.push({ where: places.slice(1).join(', '), problem: `opens with "${verb}" like another bullet in the role`, serious: false });
    }
  }

  // Bullets that all run the same length read as generated; a person writes some short ones.
  if (allBullets.length >= MIN_BULLETS_FOR_LENGTH_CHECK && !allBullets.some((line) => wordCount(line.text) <= SHORT_BULLET_WORDS)) {
    const shortest = allBullets.reduce((a, b) => (wordCount(a.text) <= wordCount(b.text) ? a : b));
    issues.push({
      where: shortest.where,
      problem: `every bullet runs over ${SHORT_BULLET_WORDS} words; cut this one down to a short plain line of ${SHORT_BULLET_WORDS} words or fewer`,
      serious: false,
    });
  }

  const letter = tailored.coverLetter ?? '';
  const cliches = COVER_LETTER_CLICHES.filter((phrase) => letter.toLowerCase().includes(phrase));
  const letterBanned = banned.filter((phrase) => containsPhrase(letter, phrase));
  if (cliches.length > 0 || letterBanned.length > 0) {
    issues.push({ where: 'cover letter', problem: `uses ${[...cliches, ...letterBanned].map((p) => `"${p}"`).join(', ')}`, serious: true });
  }
  const letterNight = findNightCliche(letter, sourceText);
  if (letterNight) {
    issues.push({ where: 'cover letter', problem: `mentions "${letterNight}", an overused cliché`, serious: true, fixedByCode: true });
  }
  return issues;
}

export const COMPANY_PLACEHOLDER = '{company}';

/** Puts the company name into a cover letter written before it was known. */
export function fillCompanyName(text: string, companyName: string): string {
  return text.split(COMPANY_PLACEHOLDER).join(companyName.trim() || 'your company');
}
