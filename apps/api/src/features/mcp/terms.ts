import { getSkillLibrary } from '../../core/skills-vocabulary';
import { phraseQuery } from '../jobs/fts';
import { tokensOf as projectionTokens } from '../jobs/search-projection/vectors';

// v1.5 Q2: search_jobs' words as one text query over the posting. What the AI writes is never parsed by the
// database: each term becomes a phrase of the search projection's own tokens (lower case, accents removed, letters
// and digits only), so operators, quotes and field names in a term mean nothing. A term ending in "*" matches as a
// prefix ("engineer*" finds "engineering"); every other term matches whole tokens ("java" never finds "javascript").
//   query    every word, anywhere in the posting
//   allOf    every term, anywhere
//   anyOf    at least one term, anywhere
//   notAny   none of the terms, anywhere
//   title    every word in the title (each a prefix from 3 letters, as the Jobs page's search reads them)
//   company  every word in the company's name (prefixes likewise)
// `expand` replaces each allOf / anyOf / notAny term by its family in TailorIT's skill library: the main skill and
// its aliases ("k8s" -> Kubernetes; "React" -> React, Redux, React Router, ...), at most FAMILY_MAX spellings each.
// v3.0 PG-SEARCH: the expression is tsquery text over job_search.body_tsv (title A, company B, places C, the posting's
// text D: 11-database.md §7.2), where FTS5's MATCH over jobs_fts was: a title or company word is restricted to its
// field's weight ('eng':*A), and relevance is ts_rank with bm25's weights.

export const FAMILY_MAX = 12;
/** The most phrases one expression holds after `expand` (the database is fast with far more; this keeps it bounded). */
export const PHRASES_MAX = 240;

/** The projection's tokens of a text: "Node.js" -> ["node", "js"], "CI/CD" -> ["ci", "cd"]. */
export function tokensOf(text: string): string[] {
  return projectionTokens(text);
}

/**
 * One term as a tsquery phrase ("site reliability" -> ('site' <-> 'reliability')), a prefix when it ends in "*";
 * `weights` restricts it to fields of the posting ('A' the title, 'B' the company).
 */
export function phraseOf(term: string, options: { prefixFrom?: number; weights?: string } = {}): string | null {
  const trimmed = term.trim();
  const starred = trimmed.endsWith('*');
  const tokens = tokensOf(trimmed);
  if (tokens.length === 0) return null;
  const last = tokens[tokens.length - 1]!;
  const prefix = (starred && last.length >= 2) || (options.prefixFrom !== undefined && last.length >= options.prefixFrom);
  return phraseQuery(tokens, prefix, options.weights ?? '');
}

interface Families {
  byKey: Map<string, readonly string[]>;
}

let families: Families | null = null;

/** Each spelling of the skill library (a main skill or an alias, folded) -> its family, main skill first. */
function libraryFamilies(): Families {
  if (families) return families;
  const byKey = new Map<string, readonly string[]>();
  for (const entry of getSkillLibrary().hard) {
    const family = [entry.skill, ...entry.aliases];
    for (const spelling of family) {
      const key = tokensOf(spelling).join(' ');
      if (key && !byKey.has(key)) byKey.set(key, family);
    }
  }
  families = { byKey };
  return families;
}

/** The term's family in the skill library (the term first), or the term alone when the library does not hold it. */
export function familyOf(term: string): string[] {
  const key = tokensOf(term).join(' ');
  const family = key ? libraryFamilies().byKey.get(key) : undefined;
  if (!family) return [term];
  const out = [term, ...family.filter((spelling) => tokensOf(spelling).join(' ') !== key)];
  return out.slice(0, FAMILY_MAX);
}

export interface TermInput {
  query?: string;
  allOf?: readonly string[];
  anyOf?: readonly string[];
  notAny?: readonly string[];
  title?: string;
  company?: string;
  expand?: boolean;
}

export interface MatchExpression {
  /** The tsquery text of the positive groups, every group required (null when there is none). */
  match: string | null;
  /** The phrases no posting may hold, as one OR group (null when none). */
  exclude: string | null;
  /** The terms the expression used after `expand`, for the answer's `expanded` (only the ones that grew). */
  expanded: Record<string, string[]>;
}

function orGroup(phrases: readonly string[]): string {
  return phrases.length === 1 ? phrases[0]! : `(${phrases.join(' | ')})`;
}

/** search_jobs' words as tsquery texts (see the module's note). */
export function matchExpression(input: TermInput): MatchExpression {
  const expanded: Record<string, string[]> = {};
  let phrases = 0;
  const grow = (term: string): string[] => {
    if (!input.expand) return [term];
    const family = familyOf(term);
    if (family.length > 1) expanded[term] = family.slice(1);
    return family;
  };
  const phrasesOf = (terms: readonly string[]): string[] => {
    const out: string[] = [];
    for (const term of terms) {
      const phrase = phraseOf(term);
      if (phrase && !out.includes(phrase) && phrases < PHRASES_MAX) {
        out.push(phrase);
        phrases += 1;
      }
    }
    return out;
  };

  const groups: string[] = [];
  for (const word of (input.query ?? '').split(/\s+/).filter(Boolean).slice(0, 20)) {
    const phrase = phraseOf(word);
    if (phrase) groups.push(phrase);
  }
  for (const term of input.allOf ?? []) {
    const alternatives = phrasesOf(grow(term));
    if (alternatives.length > 0) groups.push(orGroup(alternatives));
  }
  const any = phrasesOf((input.anyOf ?? []).flatMap(grow));
  if (any.length > 0) groups.push(orGroup(any));
  // A field's words: each required, in that field only (its weight in body_tsv: the title A, the company B).
  const words = (text: string | undefined, weights: string) => {
    for (const word of (text ?? '').split(/\s+/).filter(Boolean).slice(0, 10)) {
      const phrase = phraseOf(word, { prefixFrom: 3, weights });
      if (phrase) groups.push(phrase);
    }
  };
  words(input.title, 'A');
  words(input.company, 'B');
  const not = phrasesOf((input.notAny ?? []).flatMap(grow));
  return {
    match: groups.length > 0 ? groups.join(' & ') : null,
    exclude: not.length > 0 ? orGroup(not) : null,
    expanded,
  };
}
