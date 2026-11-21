import { countKeyword, findPostingForm, findRepeatedPhrases, isComplianceFramework, toKeywordMatchForm } from './ats';
import { classifyReferenceSkill, hasSkillsReference, isSkillLibrary, loadSkillsReference, type SkillsReference } from './skills/reference';
import type { AtsKeyword, JobAnalysis, KeywordPriority } from './types';

// tailor_builder0's services/tailoring/jobAnalysis.ts, ported (the owner's permission of 2026-11-09): the filtering in
// code. The two model calls (analyze-job-description, then review-job-keywords) are pipeline.ts's, through TailorIT's
// prompt runner, and the answers are kept by store.ts.
//
// Step 1 of tailoring: turn a job posting into the ATS keyword list every later
// step works from. The model picks the keywords; code keeps only ones the posting
// really contains, since scanners match literally.

const MAX_TERM_WORDS = 5;
const MAX_TERM_LENGTH = 60;
const MAX_RESPONSIBILITIES = 8;

export type RawAnalysis = {
  title?: unknown;
  seniority?: unknown;
  industry?: unknown;
  department?: unknown;
  keywords?: unknown;
  responsibilities?: unknown;
  mustInclude?: unknown;
};

export function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function asTextList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(asText).filter(Boolean) : [];
}

const KINDS = new Set<AtsKeyword['kind']>(['tool', 'competency', 'certification', 'soft']);

// Compliance frameworks a team works under: ats.ts's (v33 FIX-1 moved them there, for its licence check).
export { isComplianceFramework };

// Terms the extraction rules never allow as keywords. The prompt says so too, and this
// catches what a model lets through: self-descriptions that aren't activities, generic
// filler words, work-arrangement words, and seniority words standing alone.
const EXCLUDED_TERMS = new Set(
  [
    // Traits and clichés
    'passionate', 'motivated', 'driven', 'self-starter', 'self starter', 'self-motivated', 'team player', 'rockstar',
    'ninja', 'go-getter', 'hardworking', 'hard-working', 'detail-oriented', 'detail oriented', 'adaptable', 'curious',
    'humble', 'results-driven', 'strong work ethic', 'fast-paced environment', 'fast-paced', 'wears many hats',
    // Generic filler and qualifiers
    'experience', 'skills', 'skill', 'knowledge', 'understanding', 'ability', 'abilities', 'solutions', 'technologies',
    'environment', 'systems', 'tools', 'best practices', 'team', 'teams', 'work', 'strong', 'excellent', 'proven', 'deep',
    'solid', 'hands-on', 'world-class', 'cutting-edge', 'scalable', 'robust',
    // Work arrangement and eligibility
    'remote', 'hybrid', 'on-site', 'onsite', 'relocation', 'travel', 'full-time', 'part-time', 'contract',
    'visa sponsorship', 'work authorization', 'security clearance',
    // Seniority
    'senior', 'staff', 'principal', 'lead', 'junior',
  ].map((term) => toKeywordMatchForm(term))
);

const SENIORITY_WORDS = new Set(['senior', 'sr', 'staff', 'principal', 'lead', 'junior', 'jr', 'associate']);

// The posted job title and the title without its seniority word are never keywords.
function titleForms(jobTitle: string): Set<string> {
  const form = toKeywordMatchForm(jobTitle);
  const withoutSeniority = form.split(' ').filter((word) => !SENIORITY_WORDS.has(word)).join(' ');
  return new Set([form, withoutSeniority].filter(Boolean));
}

const PRIORITIES: Record<string, KeywordPriority> = {
  must_have: 'must_have', must: 'must_have', strong: 'strong', nice_to_have: 'nice_to_have', nice: 'nice_to_have',
};

// A keyword arrives as an object ({ term, type, kind, priority }) or as a compact row
// ([term, type, kind, priority]); the last column used to be a required flag.
// (v1.5 MCP fix) A bare string is a term with no columns, as an AI client with no prompt to follow writes the list:
// a soft skill when tailor_builder0's skill library lists it as one, else a hard skill named as a tool, and strong.
// v33 PROMPTS (F5): the skill library is the tailoring's (its family's: TailorFit.skills), threaded through.
export function keywordFields(item: unknown, reference: SkillsReference = loadSkillsReference()): Record<string, unknown> | null {
  if (Array.isArray(item)) return { term: item[0], type: item[1], kind: item[2], priority: item[3] };
  if (typeof item === 'string') return termOnlyFields(item, reference);
  return item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
}

function termOnlyFields(term: string, reference: SkillsReference): Record<string, unknown> {
  const soft = classifyReferenceSkill(term, reference) === 'soft';
  return { term, type: soft ? 'soft' : 'hard', kind: soft ? 'soft' : 'tool', priority: 'strong' };
}

export function parseKeywords(
  value: unknown,
  jobDescription: string,
  _logDropped = false,
  jobTitle = '',
  reference: SkillsReference = loadSkillsReference(),
): AtsKeyword[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const keywords: AtsKeyword[] = [];
  const titles = titleForms(jobTitle);

  for (const item of value) {
    const raw = keywordFields(item, reference);
    if (!raw) continue;
    let term = asText(raw.term);
    if (!term || term.length > MAX_TERM_LENGTH || term.split(' ').length > MAX_TERM_WORDS) continue;
    const termForm = toKeywordMatchForm(term);
    if (EXCLUDED_TERMS.has(termForm) || titles.has(termForm)) {
      continue;
    }

    const rawKind = asText(raw.kind).toLowerCase() as AtsKeyword['kind'];
    const type: AtsKeyword['type'] = asText(raw.type).toLowerCase() === 'soft' || rawKind === 'soft' ? 'soft' : 'hard';
    let kind: AtsKeyword['kind'] = type === 'soft' ? 'soft' : KINDS.has(rawKind) && rawKind !== 'soft' ? rawKind : 'tool';
    if (kind === 'certification' && isComplianceFramework(term)) kind = 'competency';

    // Scanners such as Ashby match literally, so a keyword must be in the
    // posting's own words. A different word form ("Prioritization" for the
    // posting's "prioritizing") is replaced with the posting's form; a term the
    // posting doesn't contain in any form can't earn a match and is dropped.
    if (countKeyword(jobDescription, term) === 0) {
      const postingForm = findPostingForm(term, jobDescription);
      if (!postingForm) {
        continue;
      }
      term = postingForm;
    }

    const matchForm = toKeywordMatchForm(term);
    if (!matchForm || seen.has(matchForm)) continue;

    // Soft skills have no tiers in the extraction; they count as strong.
    const priority = PRIORITIES[asText(raw.priority).toLowerCase()] ?? (raw.priority === false || raw.required === false ? 'nice_to_have' : 'strong');

    seen.add(matchForm);
    keywords.push({ term, type, kind, required: priority !== 'nice_to_have', priority });
  }
  return keywords;
}

// Fills the older JobAnalysis fields the frontend still reads.
// Hard skills from the skills reference that the posting names word for word
// but the model left out. The model skips a different few on each run (often
// single mentions such as "debugging" in a nice-to-have line); scanners such as
// Jobscan still count them. Soft skills aren't added: the reference lists
// everyday words ("Planning") that would read as traits the posting never asked for.
// A name the posting may write in lowercase: a phrase ("Capacity Planning"). The older markdown
// reference also lists practice words ("Debugging", "Observability"), which count the same way. Any
// other capitalized one-word name must match its case, since many product names are also ordinary words.
const CASE_FREE_NAME = /\s|(ing|ity|tion)$/i;
const CASE_FREE_LIBRARY_NAME = /\s/;

// "EKS/Kubernetes" names two tools; "CI/CD" and "ALB/NLB" are one name each, so
// a pair stays whole when it is a listed skill or a side is under 3 letters.
function splitToolPairs(text: string, isListed: (name: string) => boolean): string {
  return text.replace(/\b([\w.+#-]+)\/([\w.+#-]+)\b/g, (pair, left: string, right: string) =>
    isListed(pair) || left.length < 3 || right.length < 3 ? pair : `${left} ${right}`
  );
}

function backfillReferenceSkills(keywords: AtsKeyword[], jobDescription: string, jobTitle: string, reference: SkillsReference): AtsKeyword[] {
  if (!hasSkillsReference(reference)) return keywords;
  const seen = new Set(keywords.map((k) => toKeywordMatchForm(k.term)));
  const posting = splitToolPairs(jobDescription, (name) => reference.hard.has(toKeywordMatchForm(name)));
  const postingKey = ` ${toKeywordMatchForm(posting)} `;
  // The library holds names only ("Spring" must not match "spring semester"); no practice words.
  const caseFree = isSkillLibrary(reference) ? CASE_FREE_LIBRARY_NAME : CASE_FREE_NAME;
  const added: AtsKeyword[] = [];
  for (const key of reference.hard) {
    const name = reference.display.get(key);
    // A one-letter language ("C", "R") would match "Series C funding" or "Plan B".
    if (!name || name.length < 2 || reference.soft.has(key) || seen.has(key) || !postingKey.includes(` ${key} `)) continue;
    if (name !== name.toLowerCase() && !caseFree.test(name) && !posting.includes(name)) continue;
    seen.add(key);
    // A skill named in the job title is a must-have; any other mention is a bonus.
    const inTitle = countKeyword(jobTitle, name) > 0;
    added.push({
      term: name,
      type: 'hard',
      kind: name === name.toLowerCase() || /\s/.test(name) ? 'competency' : 'tool',
      required: inTitle,
      priority: inTitle ? 'must_have' : 'nice_to_have',
    });
  }
  return [...keywords, ...added];
}

export function toJobAnalysis(raw: RawAnalysis, jobDescription: string, reference: SkillsReference = loadSkillsReference()): JobAnalysis {
  const atsKeywords = backfillReferenceSkills(
    parseKeywords(raw.keywords, jobDescription, true, asText(raw.title), reference),
    jobDescription,
    asText(raw.title),
    reference,
  );
  const hard = atsKeywords.filter((k) => k.type === 'hard');
  const named = hard.filter((k) => k.kind !== 'competency');

  return {
    jobMeta: {
      title: asText(raw.title),
      seniority: asText(raw.seniority),
      industry: asText(raw.industry),
      department: asText(raw.department),
    },
    skills: {
      required: named.filter((k) => k.required).map((k) => k.term),
      preferred: named.filter((k) => !k.required).map((k) => k.term),
      tools: named.filter((k) => k.kind === 'tool').map((k) => k.term),
      technologies: [],
    },
    responsibilities: asTextList(raw.responsibilities).slice(0, MAX_RESPONSIBILITIES),
    domainKnowledge: hard.filter((k) => k.kind === 'competency').map((k) => k.term),
    softSkills: atsKeywords.filter((k) => k.type === 'soft').map((k) => k.term),
    keywords: {
      actionVerbs: [],
      buzzwords: [],
      mustInclude: asTextList(raw.mustInclude),
    },
    sourceJobDescription: jobDescription,
    atsKeywords,
  };
}

export function analyzePromptValues(jobDescription: string): Record<string, string> {
  return {
    jobDescription,
    repeatedPhrasesJson: JSON.stringify(findRepeatedPhrases(jobDescription).map(({ phrase, count }) => `${phrase} (${count}x)`)),
  };
}

/**
 * A model answer (its JSON text, or the value already parsed) as the analysis: filtered in code. Throws when it is not
 * JSON or leaves no keyword.
 */
export function normalizeJobAnalysisModelContent(content: string | RawAnalysis, jobDescription: string): JobAnalysis {
  const parsed = (typeof content === 'string' ? JSON.parse(content) : content) as RawAnalysis;
  if (!parsed || typeof parsed !== 'object') throw new Error('Job analysis is not a JSON object');
  const analysis = toJobAnalysis(parsed, jobDescription);
  if (!analysis.atsKeywords?.length) {
    throw new Error('Job analysis returned no keywords');
  }
  return analysis;
}

/** The keywords a first pass found, in the posting's wording: what the review pass is shown as ALREADY FOUND. */
export function foundKeywordTerms(raw: RawAnalysis, jobDescription: string): string[] {
  return parseKeywords(raw.keywords, jobDescription, false, asText(raw.title)).map((k) => k.term);
}

/** The first pass with the review pass's missed keywords added (tailor_builder0's runJobAnalysis merge). */
export function withMissedKeywords(raw: RawAnalysis, missed: unknown[]): RawAnalysis {
  if (missed.length === 0) return raw;
  return { ...raw, keywords: [...(Array.isArray(raw.keywords) ? raw.keywords : []), ...missed] };
}

// A saved analysis goes through the same filtering as a fresh one. If today's rules leave it no keywords,
// it is as good as missing.
export function analysisFromSaved(
  raw: unknown,
  jobDescription: string,
  reference: SkillsReference = loadSkillsReference(),
): JobAnalysis | null {
  try {
    const analysis = toJobAnalysis(raw as RawAnalysis, jobDescription, reference);
    return analysis.atsKeywords?.length ? analysis : null;
  } catch {
    return null;
  }
}

// The role typed into the generator is the most reliable target title; it fills in
// when the analysis left jobMeta.title blank.
export function withTargetRoleTitle(jobAnalysis: JobAnalysis, role?: unknown): JobAnalysis {
  const roleTitle = typeof role === 'string' ? role.trim() : '';
  if (!roleTitle || jobAnalysis.jobMeta?.title?.trim()) return jobAnalysis;
  return { ...jobAnalysis, jobMeta: { ...jobAnalysis.jobMeta, title: roleTitle } };
}
