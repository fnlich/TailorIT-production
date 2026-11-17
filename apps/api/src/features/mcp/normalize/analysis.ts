import { keywordFields, type RawAnalysis } from '../../tailor/keywords';
import type { AtsKeyword, KeywordPriority } from '../../tailor/types';
import { firstOf, isRecord, optionalText, refuse, textList } from './refuse';

// v1.5 Q1: a keyword analysis the person's AI saved (prepare_save_analysis), normalized strictly to what
// analyze-job-description answers TailorIT's own tailoring: {title, seniority, industry, department, keywords as
// [term, type, kind, priority] rows, responsibilities, mustInclude}. It may come from TailorIT's prompt (rows already)
// or the person's own: rows, objects ({term, type, kind, priority}, or common other names for them) or bare terms.
// A bare term is typed as keywords.ts reads one (keywordFields: a soft skill when tailor_builder0's skill library lists
// it as one, else a hard skill named as a tool), and strong. The posting filter runs after, in code, as for the server's
// analysis (toJobAnalysis): only terms the posting holds in its own words are kept. Anything that cannot be read is
// refused with the field and the shape expected.

export type KeywordRow = [term: string, type: AtsKeyword['type'], kind: AtsKeyword['kind'], priority: KeywordPriority];

/** The analysis as stored (mcp_prepare_work.analysis_raw): analyze-job-description's answer, every field there. */
export interface NormalizedAnalysis extends RawAnalysis {
  title: string;
  seniority: string;
  industry: string;
  department: string;
  keywords: KeywordRow[];
  responsibilities: string[];
  mustInclude: string[];
}

export const KEYWORD_SHAPE =
  '[term, type, kind, priority] (type "hard" or "soft"; kind "tool", "competency", "certification" or "soft"; ' +
  'priority "must_have", "strong" or "nice_to_have"), {"term", "type", "kind", "priority"} or the term alone as a string';
export const ANALYSIS_SHAPE =
  'an object {"keywords": [...], "title", "seniority", "industry", "department", "responsibilities": [...], ' +
  '"mustInclude": [...]} (only keywords is required)';

/** The most keywords one save takes (as TailorIT's own analysis answer). */
export const MAX_KEYWORDS = 400;
export const MAX_MISSING = 200;

const key = (value: string) => value.trim().toLowerCase().replace(/[\s_-]+/g, ' ');

/** Each accepted word for a column, by TailorIT's value. */
function lookup<V extends string>(groups: Record<V, readonly string[]>): Map<string, V> {
  const map = new Map<string, V>();
  for (const [value, words] of Object.entries(groups) as Array<[V, readonly string[]]>) {
    for (const word of [value, ...words]) map.set(key(word), value);
  }
  return map;
}

const TYPES = lookup<AtsKeyword['type']>({
  hard: ['technical', 'tech', 'hard skill', 'hard skills'],
  soft: ['soft skill', 'soft skills', 'interpersonal'],
});
const KINDS = lookup<AtsKeyword['kind']>({
  tool: ['technology', 'tech', 'framework', 'language', 'programming language', 'platform', 'library', 'software', 'product', 'database', 'cloud', 'service'],
  competency: ['skill', 'practice', 'methodology', 'method', 'concept', 'domain', 'domain knowledge', 'process', 'knowledge', 'area', 'activity'],
  certification: ['certificate', 'cert', 'license', 'licence', 'credential'],
  soft: ['soft skill', 'trait', 'behavior', 'behaviour'],
});
const PRIORITIES = lookup<KeywordPriority>({
  must_have: ['must', 'required', 'requirement', 'critical', 'essential', 'mandatory', 'high'],
  strong: ['important', 'core', 'key', 'medium', 'responsibility'],
  nice_to_have: ['nice', 'optional', 'bonus', 'plus', 'preferred', 'low'],
});

const TYPE_WORDS = '"hard" or "soft"';
const KIND_WORDS = '"tool", "competency", "certification" or "soft"';
const PRIORITY_WORDS = '"must_have", "strong" or "nice_to_have"';

/** One column's value: TailorIT's word for it, null when absent; an unknown word is refused. */
function column<V extends string>(value: unknown, words: Map<string, V>, field: string, expected: string): V | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw refuse(field, expected, value);
  const found = words.get(key(value));
  if (!found) throw refuse(field, expected, value);
  return found;
}

/** A priority: a word, or the older required flag (true: strong, false: nice_to_have, as keywords.ts reads it). */
function priorityOf(value: unknown, field: string): KeywordPriority | null {
  if (typeof value === 'boolean') return value ? 'strong' : 'nice_to_have';
  return column(value, PRIORITIES, field, PRIORITY_WORDS);
}

/** One keyword as a row; refused when it has no term or a column TailorIT cannot read. */
export function normalizeKeyword(item: unknown, field: string): KeywordRow {
  let term: unknown;
  let type: unknown;
  let kind: unknown;
  let priority: unknown;
  let fieldOf = (name: string) => `${field}.${name}`;
  if (typeof item === 'string') {
    term = item;
  } else if (Array.isArray(item)) {
    [term, type, kind, priority] = item as unknown[];
    const columns = ['term', 'type', 'kind', 'priority'];
    fieldOf = (name: string) => `${field}[${columns.indexOf(name)}]`;
    if (item.length === 0 || item.length > 4) throw refuse(field, KEYWORD_SHAPE, item);
  } else if (isRecord(item)) {
    term = firstOf(item, ['term', 'keyword', 'name', 'skill', 'text', 'value', 'label'])?.[1];
    type = firstOf(item, ['type', 'skillType', 'skill_type'])?.[1];
    kind = firstOf(item, ['kind', 'category'])?.[1];
    priority = firstOf(item, ['priority', 'importance', 'level', 'tier', 'required'])?.[1];
    // "category": "hard" names the type, not the kind.
    if (type === undefined && typeof kind === 'string' && TYPES.has(key(kind)) && !KINDS.has(key(kind))) {
      type = kind;
      kind = undefined;
    }
  } else {
    throw refuse(field, KEYWORD_SHAPE, item);
  }
  if (typeof term !== 'string' || !term.trim()) throw refuse(fieldOf('term'), 'the keyword as a non-empty string', term);
  const text = term.trim().replace(/\s+/g, ' ');
  let typed = column(type, TYPES, fieldOf('type'), TYPE_WORDS);
  let kinded = column(kind, KINDS, fieldOf('kind'), KIND_WORDS);
  const prioritized = priorityOf(priority, fieldOf('priority'));
  if (kinded === 'soft' || typed === 'soft') {
    typed = 'soft';
    kinded = 'soft';
  }
  if (!typed) {
    // As keywords.ts reads a bare term: the skill library's list, else a hard skill.
    const guessed = keywordFields(text) as { type: AtsKeyword['type']; kind: AtsKeyword['kind'] } | null;
    typed = guessed?.type === 'soft' ? 'soft' : 'hard';
    if (typed === 'soft') kinded = 'soft';
  }
  return [text, typed, kinded ?? (typed === 'soft' ? 'soft' : 'tool'), prioritized ?? 'strong'];
}

/** A keyword list: an array of keywords (each as normalizeKeyword reads it). */
export function normalizeKeywords(value: unknown, field: string, limits: { min: number; max: number }): KeywordRow[] {
  if (!Array.isArray(value)) throw refuse(field, `an array of keywords, each ${KEYWORD_SHAPE}`, value);
  if (value.length < limits.min) throw refuse(field, `at least ${limits.min} keyword, each ${KEYWORD_SHAPE}`, value);
  if (value.length > limits.max) throw refuse(field, `at most ${limits.max} keywords`);
  return value.map((item, index) => normalizeKeyword(item, `${field}[${index}]`));
}

/** analyze-job-description's answer, normalized; refused when it cannot be. */
export function normalizeAnalysis(value: unknown): NormalizedAnalysis {
  if (!isRecord(value)) throw refuse('analysis', ANALYSIS_SHAPE, value);
  const keywords = firstOf(value, ['keywords', 'atsKeywords', 'terms']);
  if (!keywords) throw refuse('analysis.keywords', `an array of keywords, each ${KEYWORD_SHAPE}`);
  return {
    title: optionalText(value.title, 'analysis.title'),
    seniority: optionalText(value.seniority, 'analysis.seniority'),
    industry: optionalText(value.industry, 'analysis.industry'),
    department: optionalText(value.department, 'analysis.department'),
    keywords: normalizeKeywords(keywords[1], `analysis.${keywords[0]}`, { min: 1, max: MAX_KEYWORDS }),
    responsibilities: textList(value.responsibilities, 'analysis.responsibilities'),
    mustInclude: textList(value.mustInclude, 'analysis.mustInclude'),
  };
}

/** review-job-keywords' missing keywords: its array, or its whole answer ({"missing": [...]}). */
export function normalizeMissing(value: unknown): KeywordRow[] {
  const list = isRecord(value) && Array.isArray(value.missing) ? value.missing : value;
  return normalizeKeywords(list, 'missing', { min: 0, max: MAX_MISSING });
}
