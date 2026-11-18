import { RANK_WEIGHTS, rankSql, tokensOf } from './search-projection/vectors';

// The job search box as a PostgreSQL tsquery (11-database.md §7.2). What a person types is never parsed by the
// database: every word becomes the projection's own tokens (folded: lower case, accents removed; letters and digits
// only, so they need no escaping), and the query is written as tsquery text from them. Only the columns the search
// box is for are matched: title, company name and places (job_search.title_tsv; not the description).
// v3.0 PG-SEARCH: FTS5's MATCH syntax and bm25 gave way to the tsquery and ts_rank over job_search.

/** The most words of a search that count; the rest are ignored. */
export const MAX_SEARCH_WORDS = 10;

/** What the search box matches: the title, the company's name and the places (the title vector's three fields). */
export const SEARCH_COLUMNS = ['title', 'company_name', 'locations_text'] as const;

/** ts_rank's weights for the title vector (title A, company B, places C): bm25's 10, 6, 3 before v3.0; the rank. */
export { RANK_WEIGHTS, rankSql };

/**
 * The words of a search as token groups, at most MAX_SEARCH_WORDS. A word with several tokens ("node.js") stays one
 * group, matched as a phrase.
 */
export function searchWords(q: string | null | undefined): string[][] {
  if (typeof q !== 'string') return [];
  const groups: string[][] = [];
  for (const word of q.split(/\s+/)) {
    const tokens = tokensOf(word);
    if (tokens.length > 0) groups.push(tokens);
    if (groups.length >= MAX_SEARCH_WORDS) break;
  }
  return groups;
}

/** Shortest word matched as a prefix ("eng" finds "Engineer"); the last word, still being typed, from 2 letters. */
const PREFIX_MIN = 3;
const LAST_PREFIX_MIN = 2;

/**
 * One group of tokens as tsquery text: a phrase of its tokens (`'node' <-> 'js'`), its last token a prefix
 * (`'js':*`) when `prefix` says so; `weights` restricts every token to those fields (`'eng':*A`: the title only).
 */
export function phraseQuery(tokens: readonly string[], prefix: boolean, weights = ''): string {
  const one = (token: string, last: boolean) => {
    const marks = `${prefix && last ? '*' : ''}${weights}`;
    return `'${token}'${marks ? `:${marks}` : ''}`;
  };
  const phrase = tokens.map((token, index) => one(token, index === tokens.length - 1)).join(' <-> ');
  return tokens.length > 1 ? `(${phrase})` : phrase;
}

/**
 * The tsquery text of a search, or null when it has no searchable word. Every word must match (in any of the
 * searched fields). Words of 3+ characters match as prefixes (free_tailor's rule: "sen eng" finds "Senior Engineer"),
 * and so does the last word from 2 characters (search-as-you-type); shorter words must match whole, as a single
 * letter would match nearly everything.
 *
 *   "senior data en"  ->  'senior':* & 'data':* & 'en':*
 *   "node.js dev"     ->  ('node' <-> 'js') & 'dev':*
 */
export function buildSearchQuery(q: string | null | undefined): string | null {
  const groups = searchWords(q);
  if (groups.length === 0) return null;
  return groups
    .map((tokens, index) => {
      const lastToken = tokens[tokens.length - 1] ?? '';
      const min = index === groups.length - 1 ? LAST_PREFIX_MIN : PREFIX_MIN;
      return phraseQuery(tokens, lastToken.length >= min);
    })
    .join(' & ');
}
