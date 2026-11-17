import type { AtsKeyword, JobAnalysis, KeywordPriority, Profile, TailoredContent } from './types';

// tailor_builder0's services/atsScore.ts, ported (the owner's permission of 2026-11-09).

// A Jobscan-style match report: how well a tailored resume covers the job's hard
// skills (named tools plus competency phrases) and soft skills, plus basic
// searchability checks. Keyword matching is literal, like the scanners it
// imitates, with case, hyphens and punctuation ignored.
//
// The posted job title is reported but not scored: it never goes on the resume
// (only titles the candidate held do), so scoring it would punish the rule.

export interface AtsKeywordMatch {
  keyword: string;
  jobCount: number;
  resumeCount: number;
}

export interface AtsCheck {
  label: string;
  passed: boolean;
}

export interface AtsReport {
  score: number;
  hardSkills: { score: number; matched: number; total: number; keywords: AtsKeywordMatch[] };
  softSkills: { score: number; matched: number; total: number; keywords: AtsKeywordMatch[] };
  jobTitle: { title: string; found: boolean };
  searchability: { score: number; checks: AtsCheck[] };
  missingHardSkills: string[];
  missingSoftSkills: string[];
}

// Share of the overall score. Hard skills dominate, as they do in Jobscan.
const WEIGHTS = { hardSkills: 65, softSkills: 15, searchability: 20 } as const;

// Domain-knowledge entries ending in one of these describe the employer's own
// product ("Affiliate tracking platform"), not something a candidate lists.
const EMPLOYER_NOUNS = new Set([
  'platform', 'platforms', 'product', 'products', 'app', 'apps', 'application', 'applications', 'website', 'business',
]);

// Lowercase words separated by single spaces, so "High-availability," matches
// "high availability". Characters that belong to skill names (CI/CD, C++, C#,
// Node.js) are kept; a period only survives inside a word.
function toMatchWords(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9+#/.]+/g, ' ')
    .replace(/\.(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Singular form of a plain English plural, so "data pipelines" matches "data
// pipeline" the way scanners treat them. Applied to both sides of every match,
// so the occasional odd stem ("kubernetes" -> "kubernete") still matches itself.
function singularize(word: string): string {
  if (word.length <= 3 || !/^[a-z]+$/.test(word)) return word;
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith('sses')) return word.slice(0, -2);
  if (word.endsWith('s') && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

// Match form: lowercase singular words separated by single spaces. Case,
// hyphens, punctuation and plurals never block a match.
export function toKeywordMatchForm(text: string): string {
  return toMatchWords(text).split(' ').map(singularize).join(' ');
}

// Every piece of text that ends up on the rendered resume body.
export function getTailoredResumeText(tailored: TailoredContent): string {
  return [
    tailored.title ?? '',
    tailored.summary ?? '',
    ...(tailored.experience ?? []).flatMap((exp) => [
      exp.title ?? '',
      exp.description ?? '',
      ...(exp.achievements ?? []),
    ]),
    ...(tailored.strengths ?? []).flatMap((s) => [s.title ?? '', s.description ?? '']),
    ...(tailored.hardSkills ?? []),
    ...(tailored.softSkills ?? []),
  ].join(' \n ');
}

// Competency phrases worth scoring and adding to a resume: short, no numbers
// ("24/7 operations"), and not the employer's own product.
export function isCompetencyPhrase(term: string): boolean {
  const words = term.trim().split(/\s+/);
  if (term.length < 3 || term.length > 40 || words.length > 4 || /\d/.test(term)) return false;
  return !EMPLOYER_NOUNS.has((words[words.length - 1] ?? '').toLowerCase());
}

// Whole-phrase occurrences of `phrase` in `text`, both already in match form.
function countPhrase(matchText: string, phrase: string): number {
  if (!phrase) return 0;
  const haystack = ` ${matchText} `;
  const needle = ` ${phrase} `;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length - 1);
  }
  return count;
}

function uniqueByMatchForm(terms: string[]): string[] {
  const seen = new Set<string>();
  return terms.filter((term) => {
    const key = toKeywordMatchForm(term);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function getAtsHardSkillKeywords(jobAnalysis: JobAnalysis): string[] {
  if (jobAnalysis.atsKeywords?.length) {
    return uniqueByMatchForm(jobAnalysis.atsKeywords.filter((k) => k.type === 'hard').map((k) => k.term));
  }
  // Analyses saved before atsKeywords existed.
  const skills = jobAnalysis.skills ?? { required: [], preferred: [], tools: [], technologies: [] };
  return uniqueByMatchForm([
    ...(skills.required ?? []),
    ...(skills.preferred ?? []),
    ...(skills.tools ?? []),
    ...(skills.technologies ?? []),
    ...(jobAnalysis.domainKnowledge ?? []).filter(isCompetencyPhrase),
  ]);
}

export function getAtsSoftSkillKeywords(jobAnalysis: JobAnalysis): string[] {
  if (jobAnalysis.atsKeywords?.length) {
    return uniqueByMatchForm(jobAnalysis.atsKeywords.filter((k) => k.type === 'soft').map((k) => k.term));
  }
  return uniqueByMatchForm(jobAnalysis.softSkills ?? []);
}

// Whole-phrase occurrences of a keyword in raw text. "EKS/Kubernetes" and
// "ECS/Fargate" name both tools, and scanners such as Jobscan match each half,
// so a keyword without a slash also matches beside one. A keyword with a slash
// ("CI/CD", "ALB/NLB") still matches only as a whole.
export function countKeyword(text: string, keyword: string): number {
  const source = keyword.includes('/') ? text : text.replace(/\//g, ' ');
  return countPhrase(toKeywordMatchForm(source), toKeywordMatchForm(keyword));
}

// Uses needed for full keyword credit: as often as the posting, up to twice.
export function requiredUses(jobCount: number): number {
  return Math.min(Math.max(jobCount, 1), 2);
}

function matchKeywords(keywords: string[], jobText: string, resumeText: string): AtsKeywordMatch[] {
  return keywords
    .map((keyword) => {
      const phrase = toKeywordMatchForm(keyword);
      return {
        keyword,
        // An extracted keyword always appears at least once in the posting,
        // even if its wording there differs slightly.
        jobCount: Math.max(1, countPhrase(jobText, phrase)),
        resumeCount: countPhrase(resumeText, phrase),
      };
    })
    .sort((a, b) => b.jobCount - a.jobCount || a.keyword.localeCompare(b.keyword));
}

// Weighted by how often the posting repeats a keyword (capped at 3). Full
// credit once the resume uses it as often as the posting, up to twice; a
// single mention of a repeated keyword earns most of the credit.
function scoreKeywords(matches: AtsKeywordMatch[]): { score: number; matched: number } {
  if (matches.length === 0) return { score: 1, matched: 0 };
  let earned = 0;
  let possible = 0;
  let matched = 0;
  for (const match of matches) {
    const weight = Math.min(match.jobCount, 3);
    possible += weight;
    if (match.resumeCount === 0) continue;
    matched += 1;
    earned += match.resumeCount >= requiredUses(match.jobCount) ? weight : weight * 0.75;
  }
  return { score: earned / possible, matched };
}

function buildSearchabilityChecks(tailored: TailoredContent, profile?: Profile): AtsCheck[] {
  const experience = tailored.experience ?? [];
  return [
    { label: 'Email address', passed: Boolean(profile?.contact?.email?.trim()) },
    { label: 'Phone number', passed: Boolean(profile?.contact?.phone?.trim()) },
    { label: 'Location', passed: Boolean(profile?.contact?.location?.trim()) },
    { label: 'Summary section', passed: Boolean(tailored.summary?.trim()) },
    { label: 'Professional Experience section', passed: experience.length > 0 },
    {
      label: 'Every role has dates',
      passed: experience.length > 0 && experience.every((exp) => Boolean(exp.startDate?.trim() && exp.endDate?.trim())),
    },
    { label: 'Education section', passed: (profile?.education ?? []).length > 0 },
  ];
}

export function buildAtsReport(tailored: TailoredContent, jobAnalysis: JobAnalysis, profile?: Profile): AtsReport {
  const jobText = toKeywordMatchForm(jobAnalysis.sourceJobDescription ?? '');
  const resumeText = toKeywordMatchForm(getTailoredResumeText(tailored));

  const hardMatches = matchKeywords(getAtsHardSkillKeywords(jobAnalysis), jobText, resumeText);
  const softMatches = matchKeywords(getAtsSoftSkillKeywords(jobAnalysis), jobText, resumeText);
  const hard = scoreKeywords(hardMatches);
  const soft = scoreKeywords(softMatches);

  const title = jobAnalysis.jobMeta?.title?.trim() ?? '';
  const titleFound = title ? countPhrase(resumeText, toKeywordMatchForm(title)) > 0 : false;

  const checks = buildSearchabilityChecks(tailored, profile);
  const searchabilityScore = checks.filter((check) => check.passed).length / checks.length;

  const score = Math.round(
    hard.score * WEIGHTS.hardSkills + soft.score * WEIGHTS.softSkills + searchabilityScore * WEIGHTS.searchability
  );

  return {
    score,
    hardSkills: { score: Math.round(hard.score * 100), matched: hard.matched, total: hardMatches.length, keywords: hardMatches },
    softSkills: { score: Math.round(soft.score * 100), matched: soft.matched, total: softMatches.length, keywords: softMatches },
    jobTitle: { title, found: titleFound },
    searchability: { score: Math.round(searchabilityScore * 100), checks },
    missingHardSkills: hardMatches.filter((m) => m.resumeCount === 0).map((m) => m.keyword),
    missingSoftSkills: softMatches.filter((m) => m.resumeCount === 0).map((m) => m.keyword),
  };
}

// The analysis keyword list; analyses from before atsKeywords existed are
// converted from their older fields.
export function getAtsKeywords(jobAnalysis: JobAnalysis): AtsKeyword[] {
  if (jobAnalysis.atsKeywords?.length) return jobAnalysis.atsKeywords;
  const required = new Set((jobAnalysis.skills?.required ?? []).map(toKeywordMatchForm));
  return [
    ...getAtsHardSkillKeywords(jobAnalysis).map((term) => ({
      term,
      type: 'hard' as const,
      kind: (jobAnalysis.domainKnowledge ?? []).includes(term) ? ('competency' as const) : ('tool' as const),
      required: required.has(toKeywordMatchForm(term)),
    })),
    ...getAtsSoftSkillKeywords(jobAnalysis).map((term) => ({ term, type: 'soft' as const, kind: 'soft' as const, required: false })),
  ];
}

export interface KeywordTarget extends AtsKeyword {
  timesInPosting: number;
  targetUses: number;
}

const PRIORITY_RANK: Record<KeywordPriority, number> = { must_have: 0, strong: 1, nice_to_have: 2 };

/** A keyword's tier; analyses from before tiers existed fall back to the required flag. */
export function keywordPriority(keyword: AtsKeyword): KeywordPriority {
  return keyword.priority ?? (keyword.required ? 'strong' : 'nice_to_have');
}

// The keyword plan handed to the tailor prompt: every keyword with how often the
// posting uses it and how many times the resume should (1-3), most important first.
export function getKeywordTargets(jobAnalysis: JobAnalysis): KeywordTarget[] {
  const jobText = toKeywordMatchForm(jobAnalysis.sourceJobDescription ?? '');
  const keywords = getAtsKeywords(jobAnalysis);
  return keywords
    .map((keyword) => {
      const timesInPosting = Math.max(1, countPhrase(jobText, toKeywordMatchForm(keyword.term)));
      // Once, or twice at most: more reads as stuffing and earns no extra credit.
      return { ...keyword, timesInPosting, targetUses: Math.min(timesInPosting, 2) };
    })
    .sort(
      (a, b) =>
        Number(b.type === 'hard') - Number(a.type === 'hard') ||
        PRIORITY_RANK[keywordPriority(a)] - PRIORITY_RANK[keywordPriority(b)] ||
        b.timesInPosting - a.timesInPosting
    );
}

// Words that never start or end a keyword phrase.
const PHRASE_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have', 'in', 'into', 'is', 'it', 'its',
  'of', 'on', 'or', 'our', 'so', 'that', 'the', 'their', 'this', 'to', 'we', 'will', 'with', 'you', 'your', 'who',
  'what', 'how', 'all', 'any', 'can', 'across', 'about', 'more', 'other', 'such', 'than', 'these', 'those', 'etc',
  'including', 'within', 'using', 'while', 'where', 'which', 'would', 'should', 'must', 'may', 'also', 'both',
  'each', 'every', 'well', 'not', 'but', 'if', 'us', 'they', 'them', 'he', 'she', 'his', 'her', 'i', 'my', 'me',
  'experience', 'years', 'year', 'strong', 'ability', 'work', 'working', 'team', 'teams', 'role', 'job', 'new',
  'plus', 'preferred', 'required', 'requirements', 'responsibilities', 'qualifications', 'e.g', 'i.e',
]);

// Phrases of 1-4 words the posting uses at least twice. The analysis prompt gets
// these as candidates, since the terms a posting repeats are the ones scanners
// weigh most and the easiest for a model to overlook.
export function findRepeatedPhrases(jobDescription: string, limit = 80): Array<{ phrase: string; count: number }> {
  const words = toMatchWords(jobDescription).split(' ').filter(Boolean);
  const counts = new Map<string, number>();
  for (let size = 1; size <= 4; size += 1) {
    for (let start = 0; start + size <= words.length; start += 1) {
      const gram = words.slice(start, start + size);
      if (PHRASE_STOPWORDS.has(gram[0]!) || PHRASE_STOPWORDS.has(gram[gram.length - 1]!)) continue;
      if (gram.every((word) => /^[\d.+#/]+$/.test(word))) continue;
      const phrase = gram.join(' ');
      if (phrase.length < 2) continue;
      counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    }
  }

  const repeated = [...counts.entries()].filter(([, count]) => count >= 2);
  // Drop a phrase when a longer phrase containing it appears just as often:
  // "load" adds nothing next to "load balancing" if both occur twice.
  const kept = repeated.filter(
    ([phrase, count]) =>
      !repeated.some(([other, otherCount]) => other !== phrase && otherCount === count && ` ${other} `.includes(` ${phrase} `))
  );
  return kept
    .sort((a, b) => b[1] - a[1] || b[0].split(' ').length - a[0].split(' ').length)
    .slice(0, limit)
    .map(([phrase, count]) => ({ phrase, count }));
}

// Two words are forms of the same word when they share a long enough prefix:
// "prioritizing" / "prioritization", "collaborative" / "collaboration",
// "communication" / "communicator". Short words must match exactly.
export function sameWordFamily(a: string, b: string): boolean {
  if (a === b) return true;
  const shorter = Math.min(a.length, b.length);
  if (shorter < 5) return false;
  let prefix = 0;
  while (prefix < shorter && a[prefix] === b[prefix]) prefix += 1;
  return prefix >= Math.max(5, Math.ceil(shorter * 0.7));
}

/**
 * The posting's own wording for a keyword the model wrote in another word form
 * ("Prioritization" when the posting says "prioritizing"). Literal-matching
 * scanners like Ashby only count the posting's form. Null when the posting has
 * no such phrase.
 */
export function findPostingForm(term: string, jobDescription: string): string | null {
  const termWords = toMatchWords(term).split(' ').filter(Boolean);
  if (termWords.length === 0) return null;
  const postingWords = toMatchWords(jobDescription).split(' ').filter(Boolean);
  for (let start = 0; start + termWords.length <= postingWords.length; start += 1) {
    const window = postingWords.slice(start, start + termWords.length);
    if (window.every((word, index) => sameWordFamily(word, termWords[index]!))) {
      const phrase = window.join(' ');
      return phrase.charAt(0).toUpperCase() + phrase.slice(1);
    }
  }
  return null;
}
