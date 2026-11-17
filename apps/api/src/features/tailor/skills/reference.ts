import { readFileSync } from 'node:fs';
import { staticDir } from '../../../core/paths';
import { sameWordFamily, toKeywordMatchForm } from '../ats';

// tailor_builder0's services/tailoring/skillsReference.ts, ported (the owner's permission of 2026-11-09).
//
// The skills library decides where a job keyword goes: a keyword listed there belongs
// in the Hard Skills or Soft Skills list; anything else is written into the resume text
// instead. TailorIT ships tailor_builder0's library as static/skills/tailor-skills.json (each hard skill with a
// heading, a priority and aliases that are other names for the same skill, plus the soft
// skills), for tailoring only: TailorIT's own skills.json stays the matching library. The older markdown reference
// (parseSkillsReference) is kept for the ported tests, which also run the steps with no reference at all.

export type ReferenceSkillType = 'hard' | 'soft';

export interface SkillsReference {
  hard: Set<string>;
  soft: Set<string>;
  /** Alias match form -> every name for that skill (canonical first). */
  aliases: Map<string, string[]>;
  /** Match form -> the name as the reference writes it, for adding to a skills list. */
  display: Map<string, string>;
  /** Match form -> sort position: the library's heading order, then its priority (lower first). Empty for the markdown reference. */
  order: Map<string, number>;
  /** Match form -> the heading a hard skill is filed under ("Databases"). Empty for the markdown reference. */
  category: Map<string, string>;
  /** Headings that may share one line of a grouped skills list, in the order the lines go. */
  groups: SkillGroupDefinition[];
  /** Number of distinct terms, for logging. */
  size: number;
}

/** Categories that may share one line of a grouped skills list, and that line's heading. */
export interface SkillGroupDefinition {
  name: string;
  categories: string[];
}

export const EMPTY_REFERENCE: SkillsReference = {
  hard: new Set(), soft: new Set(), aliases: new Map(), display: new Map(), order: new Map(), category: new Map(), groups: [], size: 0,
};

// Vendor prefixes on a product name ("AWS Lambda" -> "Lambda"). Stripped from a
// posting's keyword, and from reference entries so "Amazon EC2" also lists "EC2".
const VENDOR_PREFIX = /^(aws|amazon|azure|microsoft|google cloud|google|gcp|apache)\s+/;

// What's left after the prefix is sometimes an ordinary word ("AWS Config",
// "Google Cloud Run"); those stay listed only under their full name.
const GENERIC_WITHOUT_PREFIX = new Set([
  'config', 'backup', 'organization', 'function', 'policy', 'run', 'build', 'deploy', 'storage', 'monitoring',
  'logging', 'platform', 'monitor', 'pipeline', 'armor', 'interconnect', 'web service', '365 administration', 'http server',
]);

// Words that only describe a skill's depth or scope ("Linux administration basics").
const TRAILING_QUALIFIERS = /\s+(basics|concepts|fundamentals|practices?|awareness|tools|tooling|\(.*\))$/i;

// Splits "A, B (C, D), E" on top-level commas and semicolons.
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(') depth += 1;
    if (char === ')') depth = Math.max(0, depth - 1);
    if ((char === ',' || char === ';') && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

// One list item ("Istio / Linkerd (service mesh)") -> every term it names.
function expandItem(item: string): string[] {
  const cleaned = item.replace(/\*\*/g, '').replace(/^and\s+/i, '').trim();
  if (!cleaned) return [];

  const terms: string[] = [];
  const inner = cleaned.match(/\(([^)]*)\)/);
  const outer = cleaned.replace(/\s*\([^)]*\)/g, '').trim();
  if (inner) {
    // "(EC2, S3, RDS)" lists named things; "(legacy)" or "(primary)" is a note.
    const innerParts = splitTopLevel(inner[1]!);
    if (innerParts.length > 1 || /^[A-Z0-9]/.test(innerParts[0] ?? '')) terms.push(...innerParts);
  }
  // "Collaboration / Teamwork" names two skills; "CI/CD" (no spaces) is one.
  for (const alternative of outer.split(/\s+\/\s+/)) {
    const term = alternative.trim();
    if (!term) continue;
    terms.push(term);
    const unqualified = term.replace(TRAILING_QUALIFIERS, '').trim();
    // "Cultural Awareness" is not "Cultural", but "Linux basics" is Linux.
    const keepsMeaning = !/\s+(awareness|practices?)$/i.test(term) || unqualified.includes(' ');
    if (unqualified && unqualified !== term && keepsMeaning) terms.push(unqualified);
    // "Creativity and innovation" names each half; "Identity and Access
    // Management" names "Access Management" but not a bare "Identity".
    if (/\s+and\s+/i.test(term) && term.split(/\s+/).length <= 6) {
      const halves = term.split(/\s+and\s+/i).map((half) => half.trim());
      const allSingleWords = halves.every((half) => !half.includes(' '));
      terms.push(...halves.filter((half) => allSingleWords || half.includes(' ')));
    }
  }
  return terms.filter((term) => term.length >= 1 && term.length <= 60);
}

// Labels before a colon that group items rather than name a skill.
const CATEGORY_LABELS = new Set([
  'languages', 'tools', 'others', 'relational', 'graph', 'search', 'time-series', 'key-value / cache', 'legacy',
  'hr / finance', 'payment and commerce', 'performance', 'ides and editors', 'command line', 'package managers',
  'containers', 'java/kotlin', 'python', 'node.js', '.net', 'go', 'erp', 'crm',
]);

function listItemsOf(line: string): string[] {
  // "Configuration management: Ansible, Chef" -> the items, plus the label when
  // it names a practice rather than a category.
  const body = line.replace(/^\s*(?:[-*]|\d+\.)\s+/, '');
  const colon = body.indexOf(': ');
  if (colon < 0 || colon >= 40) return splitTopLevel(body).flatMap(expandItem);
  const label = body.slice(0, colon).trim();
  const items = splitTopLevel(body.slice(colon + 2)).flatMap(expandItem);
  return CATEGORY_LABELS.has(label.toLowerCase()) ? items : [...expandItem(label), ...items];
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());
}

// Which table columns hold skills, based on the header row.
function skillColumns(header: string[]): number[] {
  const first = (header[0] ?? '').toLowerCase();
  if (first === 'skill') return [0];
  if (first === 'canonical') return [0, 1];
  if (['role', 'category', 'sub-role'].includes(first)) return [1];
  return [];
}

// Which list a "## " section feeds. Two layouts are supported: numbered
// sections ("## 2. Soft Skills", "## 3. ...") and named ones ("## Hard Skills (900)").
function sectionBucket(heading: string): ReferenceSkillType | null {
  const numbered = heading.match(/^(\d+)\./);
  if (numbered) {
    const number = Number(numbered[1]);
    return number === 2 ? 'soft' : number === 3 || number === 4 || number === 5 ? 'hard' : null;
  }
  if (/\bsoft skills?\b/i.test(heading)) return 'soft';
  if (/\bhard skills?\b/i.test(heading)) return 'hard';
  return null;
}

export function parseSkillsReference(markdown: string): SkillsReference {
  const hard = new Set<string>();
  const soft = new Set<string>();
  const aliases = new Map<string, string[]>();
  const display = new Map<string, string>();
  let bucket: ReferenceSkillType | null = null;
  let columns: number[] | null = null;

  const addOne = (term: string, type: ReferenceSkillType) => {
    const key = toKeywordMatchForm(term);
    if (!key) return;
    (type === 'hard' ? hard : soft).add(key);
    if (!display.has(key)) display.set(key, term.trim());
  };
  const add = (term: string, type: ReferenceSkillType) => {
    addOne(term, type);
    if (type !== 'hard') return;
    const unprefixed = term.trim().replace(new RegExp(VENDOR_PREFIX.source, 'i'), '');
    if (unprefixed !== term.trim() && unprefixed.length >= 2 && !GENERIC_WITHOUT_PREFIX.has(toKeywordMatchForm(unprefixed))) {
      addOne(unprefixed, type);
    }
  };

  for (const line of markdown.replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
    const section = line.match(/^##\s+(.*)$/);
    if (section) {
      bucket = sectionBucket(section[1]!.trim());
      columns = null;
      continue;
    }
    if (!bucket) continue;

    if (/^\s*\|/.test(line)) {
      const cells = tableCells(line);
      if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
      if (columns === null) {
        columns = skillColumns(cells);
        continue;
      }
      const names = columns.flatMap((index) => splitTopLevel(cells[index] ?? '').flatMap(expandItem));
      for (const name of names) add(name, bucket);
      if (columns.length === 2 && names.length > 1) {
        for (const name of names) aliases.set(toKeywordMatchForm(name), names);
      }
      continue;
    }
    columns = null;
    if (/^\s*(?:[-*]|\d+\.)\s+/.test(line)) {
      const terms = listItemsOf(line);
      for (const term of terms) add(term, bucket);
      // "Amazon Elastic Kubernetes Service (EKS)": the full name and its abbreviation.
      const named = line.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').match(/^([^(,:]+?)\s*\(([A-Za-z0-9/.+#-]+)\)\s*$/);
      if (named && terms.length === 2) {
        const pair = [named[1]!.trim(), named[2]!];
        for (const name of pair) aliases.set(toKeywordMatchForm(name), pair);
      }
    }
  }

  return { hard, soft, aliases, display, order: new Map(), category: new Map(), groups: [], size: new Set([...hard, ...soft]).size };
}

/**
 * The skill library (skills.json): `hard` entries { skill, priority 1-5, category, aliases } and `soft`
 * names. An alias is another name for its skill (a spelling, a version, a companion: "Kafka" for "Apache
 * Kafka"), so a skill and its aliases are one alias group and one sort position: the library's heading
 * order, then its priority. The library holds tools, languages, services, protocols and standards only;
 * practices and concepts ("Disaster Recovery") belong in the resume text, and backend/scripts/prune-skills.js
 * takes them out of a library that has them.
 */
export function parseSkillsLibrary(data: unknown): SkillsReference {
  const source = (data && typeof data === 'object' ? data : {}) as { hard?: unknown; soft?: unknown; groups?: unknown };
  const hard = new Set<string>();
  const soft = new Set<string>();
  const aliases = new Map<string, string[]>();
  const display = new Map<string, string>();
  const order = new Map<string, number>();
  const category = new Map<string, string>();
  const headings: string[] = [];
  const ranks: Array<{ key: string; heading: string; priority: number }> = [];

  for (const entry of Array.isArray(source.hard) ? source.hard : []) {
    const e = (entry ?? {}) as { skill?: unknown; priority?: unknown; category?: unknown; aliases?: unknown };
    const skill = typeof e.skill === 'string' ? e.skill.trim() : '';
    if (!skill) continue;
    const heading = typeof e.category === 'string' ? e.category.trim() : '';
    if (!headings.includes(heading)) headings.push(heading);
    const priority = typeof e.priority === 'number' ? Math.max(1, Math.min(5, Math.trunc(e.priority))) : 5;
    const names = [
      skill,
      ...(Array.isArray(e.aliases) ? e.aliases.filter((alias): alias is string => typeof alias === 'string').map((alias) => alias.trim()) : []),
    ].filter(Boolean);
    for (const name of names) {
      const key = toKeywordMatchForm(name);
      if (!key || hard.has(key)) continue; // the first entry to use a spelling keeps it
      hard.add(key);
      display.set(key, name);
      ranks.push({ key, heading, priority });
      if (heading) category.set(key, heading);
    }
    if (names.length > 1) for (const name of names) aliases.set(toKeywordMatchForm(name), names);
  }

  for (const item of Array.isArray(source.soft) ? source.soft : []) {
    const name = typeof item === 'string' ? item.trim() : '';
    const key = toKeywordMatchForm(name);
    if (!key) continue;
    soft.add(key);
    if (!display.has(key)) display.set(key, name);
  }

  // A spelling in both lists ("Documentation") is a soft skill.
  for (const key of soft) hard.delete(key);
  // Headings sort in the order the groups block lists them, so the flat list and the grouped lines agree.
  const groups = parseGroups(source.groups, headings);
  const inGroupOrder = groups.flatMap((group) => group.categories);
  for (const { key, heading, priority } of ranks) order.set(key, Math.max(0, inGroupOrder.indexOf(heading)) * 10 + priority);
  return { hard, soft, aliases, display, order, category, groups, size: new Set([...hard, ...soft]).size };
}

// The "groups" block, in file order. A heading no group names is a group of its own, so every heading has one.
function parseGroups(value: unknown, headings: string[]): SkillGroupDefinition[] {
  const groups: SkillGroupDefinition[] = [];
  const claimed = new Set<string>();
  for (const item of Array.isArray(value) ? value : []) {
    const g = (item ?? {}) as { name?: unknown; categories?: unknown };
    const name = typeof g.name === 'string' ? g.name.trim() : '';
    const categories = (Array.isArray(g.categories) ? g.categories : [])
      .filter((c): c is string => typeof c === 'string' && c.trim() !== '' && !claimed.has(c.trim()))
      .map((c) => c.trim());
    if (!name || categories.length === 0) continue;
    categories.forEach((c) => claimed.add(c));
    groups.push({ name, categories });
  }
  for (const heading of headings) if (heading && !claimed.has(heading)) groups.push({ name: heading, categories: [heading] });
  return groups;
}

let shipped: SkillsReference | null = null;
let override: SkillsReference | null = null;

/** The shipped library, read once (static/skills/tailor-skills.json); the empty reference if it cannot be read. */
function shippedLibrary(): SkillsReference {
  if (!shipped) {
    try {
      shipped = parseSkillsLibrary(JSON.parse(readFileSync(staticDir('skills', 'tailor-skills.json'), 'utf8')));
    } catch {
      shipped = EMPTY_REFERENCE;
    }
  }
  return shipped;
}

/** The reference every step reads: the shipped library, unless a test put another in its place (useSkillsReference). */
export function loadSkillsReference(): SkillsReference {
  return override ?? shippedLibrary();
}

/** Tests: run the steps against another reference (EMPTY_REFERENCE: none at all); null puts the library back. */
export function useSkillsReference(reference: SkillsReference | null): void {
  override = reference;
}

// Trailing words a posting adds to a skill name ("Communication skills").
const SKILL_SUFFIX = /\s+(skills?|abilities|ability)$/;

function lookup(candidate: string, reference: SkillsReference): ReferenceSkillType | null {
  // A term in both lists ("Documentation" is a soft skill and part of
  // "Documentation tools") is treated as soft.
  if (reference.soft.has(candidate)) return 'soft';
  if (reference.hard.has(candidate)) return 'hard';
  return null;
}

// Same number of words, each a form of the other ("prioritizing" /
// "prioritization"). Soft skills only: their word form varies with the
// sentence, while hard skills are names and must match exactly ("Analytical"
// is not the tool category "Analytics").
function lookupSoftWordFamily(candidate: string, reference: SkillsReference): ReferenceSkillType | null {
  const words = candidate.split(' ');
  const matches = (entry: string) => {
    const entryWords = entry.split(' ');
    return entryWords.length === words.length && entryWords.every((word, index) => sameWordFamily(word, words[index]!));
  };
  for (const entry of reference.soft) if (matches(entry)) return 'soft';
  return null;
}

/**
 * The reference list a keyword belongs to, or null when the reference doesn't
 * list it. Case, plurals, hyphens, vendor prefixes ("AWS Lambda"), a trailing
 * "skills" ("Communication skills"), and, for soft skills, other forms of the
 * same word ("Prioritizing" for "Prioritization") are all ignored. This only decides the
 * list; the resume keeps the posting's own wording.
 */
export function classifyReferenceSkill(term: string, reference = loadSkillsReference()): ReferenceSkillType | null {
  const key = toKeywordMatchForm(term);
  const candidates = [...new Set([key, key.replace(VENDOR_PREFIX, ''), key.replace(SKILL_SUFFIX, '')])].filter(Boolean);
  for (const candidate of candidates) {
    const found = lookup(candidate, reference);
    if (found) return found;
  }
  for (const candidate of candidates) {
    const found = lookupSoftWordFamily(candidate, reference);
    if (found) return found;
  }
  return null;
}

/** Other names for a keyword from the alias table (e.g. "SRE" -> "Site Reliability Engineering"). */
export function referenceAliases(term: string, reference = loadSkillsReference()): string[] {
  const key = toKeywordMatchForm(term);
  return (reference.aliases.get(key) ?? []).filter((name) => toKeywordMatchForm(name) !== key);
}

/**
 * Reference skills of one type that the text names, in the reference's own
 * spelling. A name with capitals ("Go", "Terraform") must appear with that exact
 * casing, so everyday words ("go", "organization") don't count as the skill.
 */
export function referenceSkillsInText(
  text: string,
  type: ReferenceSkillType,
  reference = loadSkillsReference()
): string[] {
  const textKey = ` ${toKeywordMatchForm(text)} `;
  const found: string[] = [];
  for (const key of type === 'hard' ? reference.hard : reference.soft) {
    if (type === 'hard' && reference.soft.has(key)) continue;
    const name = reference.display.get(key);
    if (!name || !textKey.includes(` ${key} `)) continue;
    if (type === 'hard' && name !== name.toLowerCase() && !text.includes(name)) continue;
    found.push(name);
  }
  return found;
}

export function hasSkillsReference(reference = loadSkillsReference()): boolean {
  return reference.size > 0;
}

/** True when the reference is the skill library, which has headings and an order. */
export function isSkillLibrary(reference = loadSkillsReference()): boolean {
  return reference.order.size > 0;
}

/** The library's own spelling of a skill ("GitHub Actions", "eBPF"), or null when it isn't listed. */
export function referenceSpelling(term: string, reference = loadSkillsReference()): string | null {
  return reference.display.get(toKeywordMatchForm(term)) ?? null;
}

/**
 * The heading a hard skill is filed under ("Databases"), or null when the library doesn't list it. "Google
 * Cloud Platform (GCP)", two names for one skill written as one, is looked up by its first name.
 */
export function referenceCategory(term: string, reference = loadSkillsReference()): string | null {
  const name = term.replace(/\s*\([^)]*\)\s*$/, '');
  return reference.category.get(toKeywordMatchForm(name)) ?? reference.category.get(toKeywordMatchForm(term)) ?? null;
}

/** Where a skill sorts among the others: the library's heading order, then priority. Unlisted skills last. */
export function referenceOrder(term: string, reference = loadSkillsReference()): number {
  return reference.order.get(toKeywordMatchForm(term)) ?? 1000;
}
