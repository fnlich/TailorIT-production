import { COMPANY_SUMMARY_MAX, COMPANY_TAGLINE_MAX, INDUSTRY_IDS, NOT_SPECIFIED_INDUSTRY, type IndustryId } from '@tailorit/shared';
import type { CompanySummaryAnswer, CompanySummaryProblem } from '../../../ai/prompts/companies/summary';
import { holdsPromptMarkup } from '../../autofill/ai/untrusted';

// v30 E3: the checks every AI summary passes before it is kept (docs/design/part2/13-company-enrichment.md §8, "Checks
// before storing"), deterministic and in code: the prompt asks the model to add nothing, and these refuse an answer
// that did.
//   - every digit run of the summary and the tagline is a digit run of its inputs (the name, the texts, the facts),
//     thousands separators aside ("4,500" is 4500): an invented year, count or amount is refused;
//   - every number word ("two", "hundreds", "million", ...) is one of the inputs' words;
//   - every capitalised word that does not start a sentence is one of the inputs' words (case-insensitive): an
//     invented company, product, person or place name is refused;
//   - v30 FIX-C SEC-4 (DECISIONS P6.7), the grounding check: every content word, lower case too, is a word of the
//     inputs (a plural, a past or an -ing form of one counts), besides function words and the few plain framing words
//     the prompt allows (FREE_WORDS): an invented claim ("a scam that steals data") is refused, not only a name;
//   - no link or e-mail address the inputs do not hold, no markup (HTML tags, the prompt's wrapper, the JSON sentinels);
//   - the lengths (COMPANY_SUMMARY_MAX, COMPANY_TAGLINE_MAX);
//   - the industry is an INDUSTRIES id (else it is dropped), and its quote is copied from the texts (else it is kept
//     at the lower confidence, never shown: 13 §6.2).
// A refused answer is asked for once more with these problems; then the company's own words stay (the fallback).

/** What the AI was given about one company: its name, its texts, its facts in words. */
export interface SummaryCheckInputs {
  name: string;
  texts: readonly string[];
  facts: readonly string[];
}

/** One answer, checked. */
export interface CheckedSummary {
  /** No problem: the summary and tagline may be kept. */
  ok: boolean;
  /** The model said its texts say too little (no summary and no tagline): nothing to keep, nothing refused. */
  declined: boolean;
  summary: string | null;
  tagline: string | null;
  /** An INDUSTRIES id (never "not specified"), or null. */
  industry: IndustryId | null;
  /** The industry's quote is copied from the texts. */
  industryQuoted: boolean;
  /** Why the summary or the tagline was refused (empty when ok), then the industry's notes. */
  problems: CompanySummaryProblem[];
}

/** Number words that state a quantity; each must be one of the inputs' words. "one" is left out ("one of the ..."). */
const NUMBER_WORDS = new Set([
  'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen',
  'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy',
  'eighty', 'ninety', 'hundred', 'hundreds', 'thousand', 'thousands', 'million', 'millions', 'billion', 'billions',
  'trillion', 'trillions', 'dozen', 'dozens', 'twice', 'thrice', 'half',
]);

/**
 * Words a summary may write that its inputs need not hold: function words, and the plain words of a neutral description
 * the prompt names ("describes itself as", "makes", "offers", "provides", "serves") with their forms. Never a word that
 * judges, warns or claims (no "scam", "avoid", "leading", "customer").
 */
const FREE_WORDS = new Set(
  `a an the and or but nor of in on at to for from by with without within into onto over under about above below across
  through throughout between among around as than then so such that this these those there here which who whom whose
  what when where why how it its it's itself they them their theirs he she his her we our us you your i me my is are
  was were be been being am has have had having do does did done can could may might will would shall should must not
  no also too very more most less many much few several some any each every all both either neither other another own
  same only just even still yet already again ever never always often usually mainly mostly largely primarily partly
  including include includes included like via per up down out off one ones while whose if because whether
  company companies business businesses firm firms organisation organisations organization organizations
  describe describes described describing call calls called based headquartered located
  make makes made making build builds built building offer offers offered offering provide provides provided providing
  sell sells sold selling serve serves served serving help helps helped helping develop develops developed developing
  design designs designed designing create creates created creating run runs ran running operate operates operated
  operating work works worked working focus focuses focused focusing support supports supported supporting
  use uses used using product products service services`
    .split(/\s+/)
    .filter(Boolean),
);

/** Compatibility forms folded, invisible characters gone, so a full-width digit counts as a digit. */
const fold = (text: string) => text.normalize('NFKC').replace(/[\p{Cf}]/gu, '');
/** "4,500,000" read as "4500000" (a thousands separator between digit groups). */
const joinThousands = (text: string) => text.replace(/(\d)[,\u00A0\u202F](?=\d{3}(?!\d))/g, '$1');

const DIGIT_RUN = /\p{Nd}+/gu;
/** A word: letters and digits, with inner apostrophes, hyphens, dots and ampersands ("O'Neil", "e-commerce", "Node.js"). */
const WORD = /[\p{L}\p{N}]+(?:['’.&-][\p{L}\p{N}]+)*/gu;
const ADDRESS = /\bhttps?:\/\/[^\s<>"')]+|\bwww\.[^\s<>"')]+|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/giu;
/** An HTML tag or entity: a summary is plain prose. */
const MARKUP = /<\/?[a-z][^<>]*>|&(?:[a-z]+|#\d+);/i;

/** The words of a text, lower case, possessives cut ("acme's" is "acme"), each whole and each part. */
function wordsOf(text: string): Set<string> {
  const words = new Set<string>();
  for (const match of fold(text).matchAll(WORD)) {
    const word = possessiveCut(match[0].toLowerCase());
    words.add(word);
    for (const part of word.split(/['’.&-]/)) if (part) words.add(part);
  }
  return words;
}

const possessiveCut = (word: string) => word.replace(/['’]s$/u, '');

/** A lower-case word and the forms it may stand for: its singular, its stem before -ed or -ing (a doubled last letter too). */
function formsOf(word: string): string[] {
  const forms = [word];
  const add = (form: string) => {
    if (form.length >= 2) forms.push(form);
  };
  if (word.endsWith('ies')) add(`${word.slice(0, -3)}y`);
  if (word.endsWith('es')) add(word.slice(0, -2));
  if (word.endsWith('s') && !word.endsWith('ss')) add(word.slice(0, -1));
  if (word.endsWith('ied')) add(`${word.slice(0, -3)}y`);
  for (const ending of ['ed', 'ing']) {
    if (!word.endsWith(ending)) continue;
    const stem = word.slice(0, -ending.length);
    add(stem);
    add(`${stem}e`);
    if (stem.length >= 3 && stem.at(-1) === stem.at(-2)) add(stem.slice(0, -1));
  }
  if (word.endsWith('ly')) add(word.slice(0, -2));
  return forms;
}

/** Every form of every word of a text (formsOf), for the grounding check. */
function formsOfText(words: ReadonlySet<string>): Set<string> {
  const forms = new Set<string>();
  for (const word of words) for (const form of formsOf(word)) forms.add(form);
  return forms;
}

/** Whether a lower-case word is grounded: a free word, or one of whose forms is a form of an input word. */
const grounded = (word: string, forms: ReadonlySet<string>) => FREE_WORDS.has(word) || formsOf(word).some((form) => forms.has(form));

const digitRuns = (text: string) => new Set([...joinThousands(fold(text)).matchAll(DIGIT_RUN)].map((match) => match[0]));

/** A text folded for a quote's comparison: lower case, one space between words, no quote marks. */
const quoteForm = (text: string) =>
  fold(text)
    .toLowerCase()
    .replace(/[“”"‘’`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

/** The sentences of a text (cut after . ! ? and a space, or a line break). */
const sentencesOf = (text: string) => fold(text).split(/(?<=[.!?])\s+|\n+/u);

/** The problems of one text of the answer (the summary or the tagline) against the inputs. */
function problemsOf(text: string, inputs: { words: Set<string>; forms: Set<string>; runs: Set<string>; folded: string }): CompanySummaryProblem[] {
  const problems: CompanySummaryProblem[] = [];
  const seen = new Set<string>();
  const add = (problem: CompanySummaryProblem) => {
    const key = `${problem.kind}:${problem.value ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    problems.push(problem);
  };
  for (const run of digitRuns(text)) if (!inputs.runs.has(run)) add({ kind: 'number', value: run });
  const prose = fold(text).replace(ADDRESS, ' ').replace(/<[^<>]*>/g, ' ');
  for (const sentence of sentencesOf(prose)) {
    let first = true;
    for (const match of sentence.matchAll(WORD)) {
      const word = match[0];
      const lower = possessiveCut(word.toLowerCase());
      if (NUMBER_WORDS.has(lower) && !inputs.words.has(lower)) add({ kind: 'number_word', value: word });
      // A capitalised word that does not start its sentence names something: the inputs must name it too (whole, or
      // each of its parts: "Acme-Built" for "Acme" and "built").
      let named = false;
      if (!first && /^\p{Lu}/u.test(word) && !inputs.words.has(lower)) {
        const parts = lower.split(/['’.&-]/).filter(Boolean);
        if (parts.length < 2 || !parts.every((part) => inputs.words.has(part))) {
          add({ kind: 'name', value: possessiveCut(word) });
          named = true;
        }
      }
      first = false;
      // The grounding check (see the module's note): numbers have their own checks; a name is refused already.
      if (named || NUMBER_WORDS.has(lower) || /\p{N}/u.test(lower)) continue;
      const parts = lower.split(/['’.&-]/).filter(Boolean);
      if (!grounded(lower, inputs.forms) && !(parts.length > 1 && parts.every((part) => grounded(part, inputs.forms)))) {
        add({ kind: 'ungrounded', value: possessiveCut(word) });
      }
    }
  }
  for (const match of fold(text).matchAll(ADDRESS)) {
    if (!inputs.folded.includes(match[0].toLowerCase())) add({ kind: 'address', value: match[0] });
  }
  if (MARKUP.test(text) || holdsPromptMarkup(text)) add({ kind: 'markup' });
  return problems;
}

const isIndustryId = (value: string): value is IndustryId => (INDUSTRY_IDS as readonly string[]).includes(value);

/** Checks one answer against what the AI was given (see the module's note). `mapIndustry`: an industry was asked for. */
export function checkSummaryAnswer(inputs: SummaryCheckInputs, answer: CompanySummaryAnswer, mapIndustry: boolean): CheckedSummary {
  const all = [inputs.name, ...inputs.texts, ...inputs.facts].join('\n');
  const words = wordsOf(all);
  const known = { words, forms: formsOfText(words), runs: digitRuns(all), folded: fold(all).toLowerCase() };
  const summary = answer.summary ?? null;
  const tagline = answer.tagline ? answer.tagline.replace(/\.$/, '') : null;
  const problems: CompanySummaryProblem[] = [];
  if (summary !== null) {
    if (summary.length > COMPANY_SUMMARY_MAX) problems.push({ kind: 'too_long' });
    problems.push(...problemsOf(summary, known));
  }
  if (tagline !== null) {
    if (tagline.length > COMPANY_TAGLINE_MAX) problems.push({ kind: 'tagline_too_long' });
    for (const problem of problemsOf(tagline, known)) {
      if (!problems.some((seen) => seen.kind === problem.kind && seen.value === problem.value)) problems.push(problem);
    }
  }
  const declined = summary === null && tagline === null;
  const ok = problems.length === 0;

  // The industry: only when it was asked for; an id of the list (never "not specified"); its quote from the texts.
  let industry: IndustryId | null = null;
  let industryQuoted = false;
  if (mapIndustry && answer.industry) {
    const id = answer.industry.trim().toLowerCase();
    if (isIndustryId(id) && id !== NOT_SPECIFIED_INDUSTRY) {
      industry = id;
      const quote = answer.industryQuote ? quoteForm(answer.industryQuote) : '';
      industryQuoted = quote.length >= 3 && inputs.texts.some((text) => quoteForm(text).includes(quote));
      if (!industryQuoted) problems.push({ kind: 'quote' });
    } else {
      problems.push({ kind: 'industry', value: answer.industry });
    }
  }
  return { ok, declined, summary: ok ? summary : null, tagline: ok ? tagline : null, industry, industryQuoted, problems };
}

/** The problems that refuse the summary (the industry's notes aside). */
export const refusingProblems = (checked: CheckedSummary): CompanySummaryProblem[] =>
  checked.problems.filter((problem) => problem.kind !== 'industry' && problem.kind !== 'quote');
