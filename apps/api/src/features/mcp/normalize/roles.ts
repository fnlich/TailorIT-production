import { toKeywordMatchForm } from '../../tailor/ats';

// v1.5 Q1: which of the source resume's roles a role the person's AI wrote is about, by its company and title,
// normalized and fuzzy but unique. A resume's employers, titles and dates are facts, so TailorIT keeps the resume's own
// (restored by the tailoring's mergeExperience); this decides which role a written entry's bullets belong to. An entry
// that matches no role (an employer the resume does not have), matches two roles equally, or matches a role another
// entry already took is dropped, and the save reports it. Without this step an unmatched entry would take the bullets
// slot of whichever role has none at its position (mergeExperience's fallback for TailorIT's own prompt, which copies
// the resume's companies), so a role the person never held could put its bullets under one they did.

export interface RoleRef {
  company: string;
  title: string;
}

export type DropReason = 'no_matching_role' | 'ambiguous' | 'duplicate';
export type RoleMatch = { role: number } | { role: null; reason: DropReason };

/** Words a company name carries that say nothing about which company it is. */
const CORPORATE = new Set([
  'inc', 'incorporated', 'llc', 'llp', 'lp', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'gmbh', 'plc',
  'ag', 'sa', 'bv', 'pty', 'the',
]);

/** Short forms of title words, read as the word. */
const TITLE_WORDS: Record<string, string> = {
  sr: 'senior',
  snr: 'senior',
  jr: 'junior',
  mgr: 'manager',
  eng: 'engineer',
  engr: 'engineer',
  dev: 'developer',
  swe: 'software engineer',
  sde: 'software development engineer',
  assoc: 'associate',
  asst: 'assistant',
  dir: 'director',
  vp: 'vice president',
  ops: 'operation',
  admin: 'administrator',
};

export function companyKey(company: string): string {
  return toKeywordMatchForm(company)
    .split(' ')
    .filter((word) => word && !CORPORATE.has(word))
    .join(' ');
}

export function titleKey(title: string): string {
  return toKeywordMatchForm(title)
    .split(' ')
    .filter(Boolean)
    .map((word) => TITLE_WORDS[word] ?? word)
    .join(' ');
}

/** Letter pairs of a text without spaces. */
function bigrams(text: string): string[] {
  const squeezed = text.replace(/\s+/g, '');
  const pairs: string[] = [];
  for (let index = 0; index < squeezed.length - 1; index += 1) pairs.push(squeezed.slice(index, index + 2));
  return pairs;
}

/** Dice similarity of two lists (0 to 1). */
function dice(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const item of a) counts.set(item, (counts.get(item) ?? 0) + 1);
  let shared = 0;
  for (const item of b) {
    const left = counts.get(item) ?? 0;
    if (left > 0) {
      shared += 1;
      counts.set(item, left - 1);
    }
  }
  return (2 * shared) / (a.length + b.length);
}

/**
 * How well two normalized names agree: 3 the same, 2 one holds the other word for word ("Northwind" in "Northwind
 * Traders"), 1 alike (a typo, a word more or less), 0 not the same name.
 */
export function nameScore(a: string, b: string, wordsAlike: number): number {
  if (!a || !b) return 0;
  if (a === b) return 3;
  if (` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `)) return 2;
  if (dice(bigrams(a), bigrams(b)) >= 0.8 || dice(a.split(' '), b.split(' ')) >= wordsAlike) return 1;
  return 0;
}

/** How well an entry fits a role: the company first, the title to tell a company's roles apart; 0 is no fit. */
function fit(entry: RoleRef, role: RoleRef): number {
  const title = nameScore(titleKey(entry.title), titleKey(role.title), 0.5);
  if (!companyKey(entry.company)) return title >= 2 ? title : 0;
  const company = nameScore(companyKey(entry.company), companyKey(role.company), 0.6);
  return company === 0 ? 0 : company * 4 + title;
}

const sameRole = (a: RoleRef, b: RoleRef) =>
  companyKey(a.company) === companyKey(b.company) && titleKey(a.title) === titleKey(b.title);

/**
 * The role each entry is about, each role taken once. Entries that fit best go first (an exact company and title before
 * a near one); a tie between two different roles is ambiguous. Two roles the same in every word (the same title at the
 * same company twice) are taken in the resume's order.
 */
export function matchRoles(entries: readonly RoleRef[], roles: readonly RoleRef[]): RoleMatch[] {
  const scores = entries.map((entry) => roles.map((role) => fit(entry, role)));
  const best = (index: number) => Math.max(0, ...scores[index]!);
  const order = entries.map((_entry, index) => index).sort((a, b) => best(b) - best(a));
  const taken = new Set<number>();
  const matches: RoleMatch[] = entries.map(() => ({ role: null, reason: 'no_matching_role' }));
  for (const index of order) {
    const row = scores[index]!;
    const free = row.map((score, role) => ({ score, role })).filter(({ score, role }) => score > 0 && !taken.has(role));
    if (free.length === 0) {
      matches[index] = { role: null, reason: row.some((score) => score > 0) ? 'duplicate' : 'no_matching_role' };
      continue;
    }
    const top = Math.max(...free.map(({ score }) => score));
    const tops = free.filter(({ score }) => score === top);
    if (tops.some(({ role }) => !sameRole(roles[role]!, roles[tops[0]!.role]!))) {
      matches[index] = { role: null, reason: 'ambiguous' };
      continue;
    }
    taken.add(tops[0]!.role);
    matches[index] = { role: tops[0]!.role };
  }
  return matches;
}

/** The one role an edit names (edits may name a role many times, so none is taken). */
export function matchRole(entry: RoleRef, roles: readonly RoleRef[]): RoleMatch {
  const scores = roles.map((role) => fit(entry, role));
  const top = Math.max(0, ...scores);
  if (top === 0) return { role: null, reason: 'no_matching_role' };
  const tops = scores.map((score, role) => ({ score, role })).filter(({ score }) => score === top);
  return tops.every(({ role }) => sameRole(roles[role]!, roles[tops[0]!.role]!))
    ? { role: tops[0]!.role }
    : { role: null, reason: 'ambiguous' };
}
