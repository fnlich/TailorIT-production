import {
  canonicalCertification,
  canonicalSoftSkill,
  domainOf,
  evidenceHas,
  findCertifications,
  findDomains,
  findSoftSkills,
  inferStatedYears,
  isEducationLine,
  isHardSoftOverlap,
  MAX_ANALYSIS_CERTIFICATIONS,
  MAX_ANALYSIS_DOMAINS,
  MAX_ANALYSIS_HARD_SKILLS,
  MAX_ANALYSIS_ROLES,
  MAX_ANALYSIS_SOFT_SKILLS,
  prepareEvidence,
  rangesOfEntries,
  ResumeAnalysisDataSchema,
  softKey,
  softSkillScanner,
  synonymKey,
  synonymsOf,
  tidyText,
  certificationKey,
  type PreparedEvidence,
  type ResumeAnalysisData,
  type SkillLists,
} from '@tailorit/shared';
import type { ResumeAnalysisOutput } from '../../../ai/prompts/resumes/resume-analysis';

// The `resume_analysis` answer grounded in the upload's text (v30 ST1: moved unchanged from analysis/prompt.ts, whose
// prompt is now apps/api/src/ai/prompts/resumes/resume-analysis.ts). The rule is the editable copy's: copy, never
// infer; what the text does not say is dropped, so an invented skill, title or year never reaches the stored reading.

// ------------------------------------------------------------------------------------------------ grounding

const MAX_SKILL_LENGTH = 100;
const MAX_TERM_LENGTH = 120;
const MAX_ENTRIES = 50;

/** Adds tidy strings in order, once each by `key`, up to `max`. */
function collector(key: (value: string) => string, max: number, maxLength: number) {
  const values: string[] = [];
  const seen = new Set<string>();
  return {
    values,
    add(raw: string) {
      const value = tidyText(raw);
      if (!value || value.length > maxLength || values.length >= max) return;
      const k = key(value);
      if (!k || seen.has(k)) return;
      seen.add(k);
      values.push(value);
    },
  };
}

const LIBRARY = new WeakMap<readonly string[], Map<string, string>>();

/** Synonym key -> the skill library's spelling (its synonym group's canonical spelling when listed, else the first). */
function libraryOf(hard: readonly string[]): Map<string, string> {
  let library = LIBRARY.get(hard);
  if (!library) {
    library = new Map();
    const canonical = new Set<string>();
    for (const raw of hard) {
      const term = tidyText(raw);
      if (!term) continue;
      const key = synonymKey(term);
      const isCanonical = synonymsOf(term)[0] === term;
      if (!library.has(key) || (isCanonical && !canonical.has(key))) library.set(key, term);
      if (isCanonical) canonical.add(key);
    }
    LIBRARY.set(hard, library);
  }
  return library;
}

/** Whether the text says a phrase as a whole word or phrase, a hyphen and a space read alike ("decision-making"). */
function says(evidence: PreparedEvidence, phrase: string): boolean {
  const text = tidyText(phrase);
  if (!text) return false;
  const spaced = text.replace(/[-\u2010\u2011]+/g, ' ');
  const hyphened = text.replace(/ /g, '-');
  return [text, spaced, hyphened].some((variant, index, all) => all.indexOf(variant) === index && evidenceHas(evidence, variant));
}

/** Every 4-digit year the text writes. */
function yearsWritten(text: string): Set<string> {
  return new Set(text.match(/(?<![\p{N}])(?:19|20)\d{2}(?![\p{N}])/gu) ?? []);
}

/** The totals of years the text states, line by line ("8+ years of experience"). */
function statedTotals(text: string): Set<number> {
  const totals = new Set<number>();
  for (const line of text.split(/\r?\n/)) {
    const years = inferStatedYears(line);
    if (years !== null) totals.add(years);
  }
  return totals;
}

/**
 * Claude's answer as a stored reading, grounded in the upload's text: each item stays only when the text says it.
 * - Hard skills: one of their spellings is in the text; written in the skill library's spelling when it lists them. A
 *   listed soft skill that is not a hard one too is read as a soft skill instead.
 * - Soft skills: by their canonical names (`canonicalSoftSkill`, else the first one the scanner finds in the item);
 *   the item or its canonical name must be in the text; one that is also a hard skill stays out (it is a hard skill).
 * - Roles and the person's name: as written, when the text says them.
 * - Certifications: by canonical name, when the text names the certification (as written, or one of its forms).
 * - Industries: INDUSTRIES ids (`domainOf`), when the text names that industry.
 * - Dates: each role's, when every 4-digit year in them is in the text and the role is not a degree
 *   (`rangesOfEntries`, as written).
 * - A total of years: only when the text states that total.
 */
export function finishResumeAnalysis(output: ResumeAnalysisOutput, text: string, lists: SkillLists): ResumeAnalysisData {
  const evidence = prepareEvidence(text);
  const scanner = softSkillScanner(lists.soft, lists.hard);
  const library = libraryOf(lists.hard);

  const hard = collector(synonymKey, MAX_ANALYSIS_HARD_SKILLS, MAX_SKILL_LENGTH);
  const softItems = [...output.softSkills];
  for (const raw of output.hardSkills) {
    const term = tidyText(raw);
    if (!term || term.length > MAX_SKILL_LENGTH) continue;
    const label = library.get(synonymKey(term));
    if (!label && canonicalSoftSkill(term, scanner) && !isHardSoftOverlap(term, scanner)) {
      softItems.push(term);
      continue;
    }
    if (!synonymsOf(term).some((spelling) => says(evidence, spelling))) continue;
    hard.add(label ?? term);
  }

  const soft = collector(softKey, MAX_ANALYSIS_SOFT_SKILLS, MAX_SKILL_LENGTH);
  for (const raw of softItems) {
    const item = tidyText(raw);
    if (!item || item.length > MAX_TERM_LENGTH) continue;
    const name = canonicalSoftSkill(item, scanner) ?? findSoftSkills(item, scanner, { max: 1 })[0] ?? null;
    if (!name || isHardSoftOverlap(name, scanner)) continue;
    if (says(evidence, item) || says(evidence, name)) soft.add(name);
  }

  const roles = collector((value) => value.toLowerCase(), MAX_ANALYSIS_ROLES, MAX_TERM_LENGTH);
  for (const raw of output.roles) if (says(evidence, raw)) roles.add(raw);

  const certifications = collector(certificationKey, MAX_ANALYSIS_CERTIFICATIONS, MAX_TERM_LENGTH);
  const namedCertifications = new Set(findCertifications(evidence, { max: 100 }));
  for (const raw of output.certifications) {
    const item = tidyText(raw);
    if (!item) continue;
    const canonical = canonicalCertification(item);
    if (canonical && namedCertifications.has(canonical)) certifications.add(canonical);
    else if (says(evidence, item)) certifications.add(canonical ?? item);
  }

  const domains = collector((id) => id, MAX_ANALYSIS_DOMAINS, MAX_TERM_LENGTH);
  const namedDomains = new Set<string>(findDomains(evidence, 100));
  for (const raw of output.industries) {
    const id = domainOf(raw);
    if (id && (namedDomains.has(id) || says(evidence, raw))) domains.add(id);
  }

  const written = yearsWritten(text);
  const entries = output.experience.filter((entry) => {
    const years = `${entry.startDate} ${entry.endDate}`.match(/(?<![\p{N}])\d{4}(?![\p{N}])/gu) ?? [];
    // A degree listed as a role counts no years of work.
    return years.length > 0 && years.every((year) => written.has(year)) && !isEducationLine(`${entry.title} ${entry.company}`);
  });
  const experience = rangesOfEntries(entries.slice(0, MAX_ENTRIES)).map(
    ([start, end]) => [start, end] as [number, number | null],
  );

  const total = output.totalYearsExperience;
  const yearsStated = total !== null && statedTotals(text).has(total) ? total : null;
  const name = tidyText(output.personName).slice(0, MAX_TERM_LENGTH).trim();

  return ResumeAnalysisDataSchema.parse({
    hardSkills: hard.values,
    softSkills: soft.values,
    keywords: { roles: roles.values, certifications: certifications.values, domains: domains.values },
    experience,
    yearsStated,
    yearsStatedBasis: yearsStated !== null ? 'stated' : null,
    personName: name && says(evidence, name) ? name : null,
  });
}
