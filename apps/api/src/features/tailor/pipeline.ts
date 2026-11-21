import { TECHNICAL_FAMILY_ID, roleTailoringOf, type RoleFamilyId, type RoleTailoring } from '@tailorit/shared';
import type { RunPrompt, RunPromptOptions } from '../../ai/index';
import { untrusted, untrustedText } from '../autofill/ai/untrusted';
import {
  buildAtsReport,
  countKeyword,
  getAtsHardSkillKeywords,
  getAtsKeywords,
  getKeywordTargets,
  getTailoredResumeText,
  keywordPriority,
  requiredUses,
  sameWordFamily,
  toKeywordMatchForm,
  type AtsReport,
  type KeywordTarget,
} from './ats';
import {
  COMPANY_PLACEHOLDER,
  dropTackedOnClause,
  findStyleIssues,
  humanizeContent,
  humanizeText,
  roleLabel,
  type StyleIssue,
  withoutNightCliches,
} from './humanize';
import { isComplianceFramework } from './keywords';
import { generateCoverLetterPrompt } from '../../ai/prompts/tailor/generate-cover-letter';
import type { PromptValues } from '../../ai/prompts/tailor/render';
import { RETRY_NOTE } from '../../ai/prompts/tailor/retry-note';
import { reviseResumePrompt } from '../../ai/prompts/tailor/revise-resume-ats';
import { tailorResumePrompt } from '../../ai/prompts/tailor/tailor-resume';
import { writeCoverLetterPrompt } from '../../ai/prompts/tailor/write-cover-letter';
import { baseSkillName, combinedSkillName, namesIn, partsOf, skillsShown, withoutPart } from './skills/names';
import {
  classifyReferenceSkill,
  hasSkillsReference,
  isSkillLibrary,
  loadSkillsReference,
  referenceAliases,
  referenceForms,
  referenceCategory,
  referenceOrder,
  referenceFor,
  referenceSkillsInText,
  referenceSpelling,
  type SkillsReference,
} from './skills/reference';
import type { Experience, JobAnalysis, Profile, TailoredContent, TailoredExperience, TailoredStrength } from './types';

export { combinedSkillName } from './skills/names';

// tailor_builder0's services/tailoring/tailor.ts, ported with the owner's permission of 2026-11-09. Its rules, limits
// and checks are unchanged; its model calls go through TailorIT's prompt runner (a task's runPrompt, `TailorRun`), its
// console logging is gone (TailorIT logs no word of a resume or a posting), and the posting's words are quoted to the
// model in <untrusted> wrappers.

// Steps 2-4 of tailoring: write the resume against a keyword plan, score it,
// revise (up to twice) while keywords are missing from the prose, figures from the
// profile are lost, or lines read as machine-written, then list anything still
// missing in the skills section.

// The most bullets a role keeps, newest role first: 5-7, 4-6, 3-4, then 2-3 for older
// roles, and 18 on the whole resume. The revision may add one more to the newest role
// when a keyword can't fit otherwise.
// v33 PROMPTS (F5): those numbers, and the skills lists' sizes (hard 20-25, soft 8-12), are the technical archetype's
// (packages/shared roles ARCHETYPE_TAILORING, pinned equal to v3.2's constants by a test); a tailoring for another
// family works to its archetype's (TailorFit.numbers), and routes its lists by its family's skill library.
const MAX_SUMMARY_SENTENCES = 4;
const MAX_REVISION_ROUNDS = 2;
const MAX_SKILL_WORDS = 6;
// The header reads "<your title> | <2-4 of the job's main tools>".
const HEADER_PHRASES = 3;
const MAX_HEADER_PHRASE_WORDS = 3;
// Reference soft skills that are also everyday words in engineering writing
// ("service reliability", "the organization"), so the text naming them doesn't
// show the trait.
const AMBIGUOUS_SOFT_SKILLS = new Set([
  'reliability', 'organization', 'integrity', 'flexibility', 'resilience', 'planning', 'estimation', 'initiative',
  'leadership', 'hiring', 'interviewing', 'consistency', 'networking', 'efficiency', 'accuracy', 'focus', 'execution',
  'training', 'scheduling', 'forecasting', 'energy', 'abstraction', 'synthesis', 'simplification', 'analysis',
]);
const MAX_STRENGTHS = 6;
// The revision call runs only for problems the skills list can't fix well: a missing
// keyword that belongs in the text, a profile figure the resume lost, or a line that
// reads as machine-written. Under-repeated keywords are fixed too when it runs, but
// don't trigger it; keywords that belong in a skills list just go there.

type RawResume = {
  title?: unknown;
  summary?: unknown;
  experience?: unknown;
  hardSkills?: unknown;
  softSkills?: unknown;
  strengths?: unknown;
  coverLetter?: unknown;
};

type RawExperience = {
  company?: unknown;
  title?: unknown;
  description?: unknown;
  achievements?: unknown;
};

function asText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function asBullet(value: unknown): string {
  return asText(value).replace(/^[-•*·▪●]+\s*/, '');
}

function uniqueTerms(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = toKeywordMatchForm(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * v33 PROMPTS (F5): what a tailoring is written for: the role family (the person's, or the job's when the person's is
 * general), its archetype's numbers and its skill library. The technical family's are v3.2's constants and
 * tailor_builder0's library, so a technical tailoring runs exactly as before. Every step takes it explicitly.
 */
export interface TailorFit {
  family: RoleFamilyId;
  numbers: RoleTailoring;
  skills: SkillsReference;
}

/** The fit of a family; missing reads as technical (a task queued before v3.3, and every caller that names none). */
export function tailorFitOf(family?: RoleFamilyId | null): TailorFit {
  const id = family ?? TECHNICAL_FAMILY_ID;
  return { family: id, numbers: roleTailoringOf(id), skills: referenceFor(id) };
}

/** The technical archetype's numbers (v3.2's constants). */
const TECHNICAL_NUMBERS = roleTailoringOf(TECHNICAL_FAMILY_ID);

function bulletLimit(roleIndex: number, numbers: RoleTailoring): number {
  return numbers.bulletsPerRole[roleIndex] ?? numbers.olderRoleBullets;
}

function minBullets(roleIndex: number, numbers: RoleTailoring): number {
  return numbers.minBulletsPerRole[roleIndex] ?? numbers.olderRoleMinBullets;
}

// --- The profile's own figures -------------------------------------------------
// Percentages, dollar amounts, counts and durations in the profile are facts: they
// stay, unchanged, in the role they came from.

// A number with an optional % / k / M / x suffix, not part of a name like "S3" or "EC2".
const FIGURE = /(?<![A-Za-z0-9])\$?\d[\d,]*(?:\.\d+)?(?:%|[kKmMbB]\b|x\b|(?![A-Za-z]))/g;

const figureKey = (figure: string) => figure.replace(/^\$/, '');

/** The figures in a piece of text, as comparable keys ("$18k" and "18k" are one figure). Years don't count. */
function figuresIn(text: string): string[] {
  const keys = new Set<string>();
  for (const match of humanizeText(text).matchAll(FIGURE)) {
    const key = figureKey(match[0].replace(/,/g, '').toLowerCase());
    if (!/^(19|20)\d{2}$/.test(key)) keys.add(key);
  }
  return [...keys];
}

function roleFigures(role: Experience): string[] {
  return figuresIn([role.description ?? '', ...(role.achievements ?? [])].join(' \n '));
}

// Cuts a role to its limit from the end, never dropping a bullet that carries one of
// the profile's figures (a role keeps at least as many bullets as it has figures).
function capBullets(bullets: string[], limit: number, protectedFigures: string[]): string[] {
  const result = [...bullets];
  for (let index = result.length - 1; index >= 0 && result.length > limit; index -= 1) {
    if (!figuresIn(result[index]!).some((figure) => protectedFigures.includes(figure))) result.splice(index, 1);
  }
  return result;
}

// At most 18 bullets on the resume (the archetype's cap): shorten the oldest roles first, down to their minimum.
function trimToTotalBullets(experience: TailoredExperience[], protectedByRole: string[][], numbers: RoleTailoring): TailoredExperience[] {
  const total = () => experience.reduce((sum, role) => sum + role.achievements.length, 0);
  let trimmed = true;
  while (total() > numbers.maxTotalBullets && trimmed) {
    trimmed = false;
    for (let index = experience.length - 1; index >= 0 && total() > numbers.maxTotalBullets; index -= 1) {
      const bullets = experience[index]!.achievements;
      const last = bullets[bullets.length - 1];
      if (bullets.length > minBullets(index, numbers) && !figuresIn(last ?? '').some((figure) => protectedByRole[index]?.includes(figure))) {
        bullets.pop();
        trimmed = true;
      }
    }
  }
  return experience;
}

/** First sentences of `text`, at most `max`. Common abbreviations don't end a sentence. */
function limitSentences(text: string, max: number): string {
  const guarded = text.replace(/\b(e\.g|i\.e|vs|etc)\./gi, (abbreviation) => abbreviation.replace(/\./g, '\u0000'));
  const sentences = guarded.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) ?? [guarded];
  if (sentences.length <= max) return text;
  return sentences.slice(0, max).map((sentence) => sentence.trim()).join(' ').split('\u0000').join('.');
}

/**
 * The header title: the candidate's own title, then the job's main named tools
 * ("Senior Software Engineer | Terraform, Kubernetes & AWS"). The posted job title never
 * goes on the resume. Only tools the skills list already carries are used, so the header
 * doesn't stand in for a mention in the text.
 * v33 PROMPTS (F5): the archetype's header. `tools` (technical): as above. `specialties`: the job's main hard keywords,
 * named tools or practices ("Account Executive | Salesforce, Pipeline management & Cold calling").
 * `specialties-licences` (hands-on and care): a licence the candidate holds that the job asks for, then specialties
 * ("Registered Nurse | RN license, Telemetry & Wound care").
 */
export function buildHeaderTitle(profile: Profile, jobAnalysis: JobAnalysis, fit: TailorFit = tailorFitOf()): string {
  const base = profile.title?.trim() || profile.experience?.[0]?.title?.trim() || '';
  const baseKey = ` ${toKeywordMatchForm(base)} `;
  const phrases: string[] = [];
  // v33 FIX-1: each phrase's forms (its own, unprefixed, its library aliases): one skill is named once ("Illustrator"
  // and "Adobe Illustrator", "Excel" and "Microsoft Excel" were both listed, from the analysis's two spellings).
  const named: Array<Set<string>> = [];
  const style = fit.numbers.header;
  const add = (term: string) => {
    const key = toKeywordMatchForm(term);
    const forms = referenceForms(term, fit.skills);
    if (baseKey.includes(` ${key} `) || named.some((known) => [...forms].some((form) => known.has(form)))) return;
    phrases.push(term);
    named.push(forms);
  };
  if (style === 'specialties-licences') heldLicences(profile, jobAnalysis).slice(0, 1).forEach(add);
  for (const keyword of getKeywordTargets(jobAnalysis)) {
    if (phrases.length === HEADER_PHRASES) break;
    if (keyword.type !== 'hard' || keyword.kind === 'certification') continue;
    const isTool =
      style !== 'tools' || (hasSkillsReference(fit.skills) ? placementOf(keyword.term, keyword.type, fit.skills) === 'hardSkills' : keyword.kind === 'tool');
    if (!isTool || keyword.term.split(' ').length > MAX_HEADER_PHRASE_WORDS) continue;
    add(keyword.term);
  }
  if (!base || phrases.length < 2) return base;
  return `${base} | ${phrases.slice(0, -1).join(', ')} & ${phrases[phrases.length - 1]}`;
}

/** v33 PROMPTS: the candidate's certifications and licences the job names (its posting or its hard requirements). */
function heldLicences(profile: Profile, jobAnalysis: JobAnalysis): string[] {
  const asked = [jobAnalysis.sourceJobDescription ?? '', ...(jobAnalysis.keywords?.mustInclude ?? [])].join('\n');
  return (profile.certifications ?? [])
    .map((certification) => certification.name?.trim() ?? '')
    .filter((name) => name && name.split(' ').length <= MAX_HEADER_PHRASE_WORDS && countKeyword(asked, name) > 0);
}

function asRawExperienceList(value: unknown): RawExperience[] {
  return Array.isArray(value) ? value.filter((item): item is RawExperience => Boolean(item) && typeof item === 'object') : [];
}

// Employer, title, dates and location always come from the profile; the model
// only writes the description and bullets. Model entries are matched by company,
// falling back to position.
function mergeExperience(profile: Profile, rawEntries: RawExperience[], numbers: RoleTailoring): TailoredExperience[] {

  if (!profile.experience?.length) {
    return rawEntries.map((entry, index) => {
      const raw = entry as RawExperience & Record<string, unknown>;
      return {
        title: asText(raw.title),
        company: asText(raw.company),
        startDate: asText(raw.startDate),
        endDate: asText(raw.endDate),
        location: asText(raw.location),
        description: asText(raw.description),
        achievements: (Array.isArray(raw.achievements) ? raw.achievements : []).map(asBullet).filter(Boolean).slice(0, bulletLimit(index, numbers)),
      };
    });
  }

  // One entry per profile role. A role takes the entry with its company and title, so two roles at
  // one company (a promotion) each get their own; then the next unused entry for the company; then the
  // entry in the same position. An entry is used once, so one role's content is never copied onto another.
  const unused = new Set(rawEntries);
  const takeEntry = (role: Experience, index: number): RawExperience => {
    const company = toKeywordMatchForm(role.company ?? '');
    const title = toKeywordMatchForm(role.title ?? '');
    const sameCompany = [...unused].filter((entry) => toKeywordMatchForm(asText(entry.company)) === company);
    // The entry in the same position, unless it is another profile role's (the model named a company we know).
    const candidate = rawEntries[index];
    const belongsElsewhere =
      candidate && profile.experience.some((other) => toKeywordMatchForm(other.company ?? '') === toKeywordMatchForm(asText(candidate.company)));
    const samePosition = candidate && unused.has(candidate) && !belongsElsewhere ? candidate : undefined;
    const entry = sameCompany.find((item) => toKeywordMatchForm(asText(item.title)) === title) ?? sameCompany[0] ?? samePosition;
    if (entry) unused.delete(entry);
    return entry ?? {};
  };

  const protectedByRole = profile.experience.map(roleFigures);
  const experience = profile.experience.map((role, index) => {
    const raw = takeEntry(role, index);
    const bullets = (Array.isArray(raw.achievements) ? raw.achievements : []).map(asBullet).filter(Boolean);
    return {
      title: role.title ?? '',
      company: role.company ?? '',
      startDate: role.startDate ?? '',
      endDate: role.endDate ?? '',
      location: role.location ?? '',
      description: asText(raw.description) || asText(role.description),
      achievements: capBullets(
        bullets.length > 0 ? bullets : (role.achievements ?? []).map(asBullet).filter(Boolean),
        bulletLimit(index, numbers),
        protectedByRole[index]!
      ),
    };
  });
  return trimToTotalBullets(experience, protectedByRole, numbers);
}

function asStrengths(value: unknown): TailoredStrength[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      title: asText((item as Record<string, unknown>)?.title),
      description: asText((item as Record<string, unknown>)?.description),
    }))
    .filter((item) => item.title && item.description)
    .slice(0, MAX_STRENGTHS);
}

// Certifications the candidate doesn't hold are never listed.
function heldCertification(term: string, profile: Profile): boolean {
  const profileText = JSON.stringify({ certifications: profile.certifications ?? [], skills: profile.skills ?? [] });
  return countKeyword(profileText, term) > 0;
}

function cleanSkillList(values: unknown, blocked: Set<string>): string[] {
  const list = Array.isArray(values) ? values.map(asText) : [];
  return uniqueTerms(
    list.filter((skill) => skill && skill.split(' ').length <= MAX_SKILL_WORDS && !blocked.has(toKeywordMatchForm(skill)))
  );
}

// Compliance frameworks (ISO 27001, SOC 2) are never blocked, even in an
// analysis made before they stopped being labeled certifications.
function blockedCertifications(jobAnalysis: JobAnalysis, profile: Profile): Set<string> {
  return new Set(
    getAtsKeywords(jobAnalysis)
      .filter((k) => k.kind === 'certification' && !isComplianceFramework(k.term) && !heldCertification(k.term, profile))
      .map((k) => toKeywordMatchForm(k.term))
  );
}

// Where a keyword belongs: a skills list when the skills reference lists it
// (hard or soft, as the reference says), otherwise the resume text. Without a
// reference file, keywords go to the list matching their own type.
type Placement = 'hardSkills' | 'softSkills' | 'text';

function placementOf(term: string, fallbackType: 'hard' | 'soft', reference: SkillsReference): Placement {
  if (!hasSkillsReference(reference)) return fallbackType === 'soft' ? 'softSkills' : 'hardSkills';
  const type = classifyReferenceSkill(term, reference);
  return type === 'hard' ? 'hardSkills' : type === 'soft' ? 'softSkills' : 'text';
}

// Both skills lists hold only reference skills, each in the list the reference
// assigns; anything else belongs in the resume text.
function routeSkillLists(hard: string[], soft: string[], reference: SkillsReference): { hardSkills: string[]; softSkills: string[] } {
  if (!hasSkillsReference(reference)) return { hardSkills: hard, softSkills: soft };
  const hardSkills: string[] = [];
  const softSkills: string[] = [];
  for (const [skill, listed] of [...hard.map((s) => [s, 'hard'] as const), ...soft.map((s) => [s, 'soft'] as const)]) {
    const placement = placementOf(skill, listed, reference);
    if (placement === 'hardSkills') hardSkills.push(skill);
    else if (placement === 'softSkills') softSkills.push(skill);
  }
  return { hardSkills: uniqueTerms(hardSkills), softSkills: uniqueTerms(softSkills) };
}

// Skills the job asks for or the candidate's own profile lists.
function wantedSkills(jobAnalysis: JobAnalysis, profile: Profile): Set<string> {
  return new Set([...getAtsKeywords(jobAnalysis).map((keyword) => keyword.term), ...(profile.skills ?? [])].map(toKeywordMatchForm));
}

// Everyday engineering words ("Reliability", "Consistency", "Networking") are on the soft skills list because
// a technical line uses them. They are listed only when the job asks for them or the profile does.
function withoutEverydayWords(skills: string[], jobAnalysis: JobAnalysis, profile: Profile): string[] {
  const wanted = wantedSkills(jobAnalysis, profile);
  return skills.filter((skill) => {
    const key = toKeywordMatchForm(skill);
    return !AMBIGUOUS_SOFT_SKILLS.has(key) || wanted.has(key);
  });
}

function normalizeResume(raw: RawResume, profile: Profile, jobAnalysis: JobAnalysis, fit: TailorFit): TailoredContent {
  const blocked = blockedCertifications(jobAnalysis, profile);
  const lists = routeSkillLists(cleanSkillList(raw.hardSkills, blocked), cleanSkillList(raw.softSkills, blocked), fit.skills);
  const { hardSkills } = lists;
  return {
    // Never the posted job title: only a title the candidate held goes on the resume.
    title: buildHeaderTitle(profile, jobAnalysis, fit),
    summary: limitSentences(asText(raw.summary), MAX_SUMMARY_SENTENCES),
    experience: mergeExperience(profile, asRawExperienceList(raw.experience), fit.numbers),
    hardSkills,
    skills: hardSkills,
    softSkills: withoutEverydayWords(lists.softSkills, jobAnalysis, profile),
    strengths: asStrengths(raw.strengths),
    coverLetter: typeof raw.coverLetter === 'string' ? raw.coverLetter.trim() : '',
  };
}

// Last step. A keyword the skills reference lists always goes into its skills
// list (in the posting's wording), even when the text already uses it. Without
// a reference, a keyword is listed only when the resume doesn't mention it at
// all. Keywords that belong in the text are left to the tailor and revision prompts.
export function fillMissingKeywords(
  tailored: TailoredContent,
  jobAnalysis: JobAnalysis,
  profile: Profile,
  fit: TailorFit = tailorFitOf(),
): TailoredContent {
  // The header repeats the job's main tools; it never stands in for the skills list.
  const resumeText = getTailoredResumeText({ ...tailored, title: '' });
  const blocked = blockedCertifications(jobAnalysis, profile);
  const withReference = hasSkillsReference(fit.skills);
  const inList = (list: string[], term: string) => {
    const key = toKeywordMatchForm(term);
    return list.some((item) => toKeywordMatchForm(item) === key);
  };

  const toHard: string[] = [];
  const toSoft: string[] = [];
  for (const keyword of getAtsKeywords(jobAnalysis)) {
    if (blocked.has(toKeywordMatchForm(keyword.term))) continue;
    const placement = placementOf(keyword.term, keyword.type, fit.skills);
    const absent = countKeyword(resumeText, keyword.term) === 0;
    if (placement === 'text') {
      // Left to the tailor and revision prompts.
    } else if (placement === 'hardSkills' && !inList(tailored.hardSkills, keyword.term) && (withReference || absent)) {
      toHard.push(keyword.term);
    } else if (placement === 'softSkills' && !inList(tailored.softSkills, keyword.term) && (withReference || absent)) {
      toSoft.push(keyword.term);
    }
  }

  if (toHard.length === 0 && toSoft.length === 0) return tailored;

  const hardSkills = uniqueTerms([...tailored.hardSkills, ...toHard]);
  const softSkills = uniqueTerms([...tailored.softSkills, ...toSoft]);
  return { ...tailored, hardSkills, skills: hardSkills, softSkills };
}

// Skills are shown in title case ("Operational Efficiency"). Only all-lowercase
// words change, so iOS, jQuery and AWS keep their casing; small joining words
// stay lowercase unless they start the skill. Matching ignores case, so the ATS
// score is unaffected.
const LOWERCASE_JOINERS = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);

function capitalizeSkill(skill: string): string {
  return skill
    .split(' ')
    .map((word, index) => {
      if (word !== word.toLowerCase()) return word;
      if (index > 0 && LOWERCASE_JOINERS.has(word)) return word;
      return word.replace(/[a-z]/, (letter) => letter.toUpperCase());
    })
    .join(' ');
}

// A job keyword keeps the posting's wording (scanners match it literally); any other skill is written the
// way the skill library spells it ("GitHub Actions", "eBPF", "kubectl").
function withCapitalizedSkills(tailored: TailoredContent, jobAnalysis: JobAnalysis, reference: SkillsReference): TailoredContent {
  const keywords = new Set(getAtsKeywords(jobAnalysis).map((keyword) => toKeywordMatchForm(keyword.term)));
  const spell = (skill: string) => {
    const library = isSkillLibrary(reference) && !keywords.has(toKeywordMatchForm(skill)) ? referenceSpelling(skill, reference) : null;
    return library ?? capitalizeSkill(skill);
  };
  const hardSkills = tailored.hardSkills.map(spell);
  return { ...tailored, hardSkills, skills: hardSkills, softSkills: tailored.softSkills.map(spell) };
}

// How much a skill needs its place in a list, lowest first: job keywords the
// resume text never names (the list is their only match), then job keywords the
// text already names, then everything else. Among keywords, the ones the posting
// repeats most come first, then must-haves before the rest. Everything else, and
// ties, follow the skill library's order: its headings, then its priorities, so
// related skills sit together.
type SkillPriority = (skill: string) => number[];

const TIERS = ['must_have', 'strong', 'nice_to_have'];

function skillPriority(jobAnalysis: JobAnalysis, resumeText: string, reference: SkillsReference): SkillPriority {
  const targets = new Map(getKeywordTargets(jobAnalysis).map((k) => [toKeywordMatchForm(k.term), k]));
  return (skill) => {
    const target = targets.get(toKeywordMatchForm(skill));
    const order = referenceOrder(skill, reference);
    if (!target) return [2, 0, 0, order];
    const absent = countKeyword(resumeText, skill) === 0;
    return [absent ? 0 : 1, -(target.timesInPosting ?? 1), TIERS.indexOf(keywordPriority(target)), order];
  };
}

function byPriority(priority: SkillPriority): (a: string, b: string) => number {
  return (a, b) => {
    const [pa, pb] = [priority(a), priority(b)];
    for (let index = 0; index < pa.length; index += 1) if (pa[index] !== pb[index]) return pa[index]! - pb[index]!;
    return 0;
  };
}

// An alias is another name for the same skill ("EKS" and "Amazon EKS", "Kafka" and "Apache Kafka"), so
// listing both says it twice. The first in priority order is kept, except that a job keyword always stays:
// the posting's own wording has to appear.
function withoutDuplicateNames(sorted: string[], priority: SkillPriority, reference: SkillsReference): string[] {
  const covered = new Set<string>();
  return sorted.filter((skill) => {
    const names = [skill, ...referenceAliases(skill, reference)].map(toKeywordMatchForm);
    const isKeyword = priority(skill)[0]! < 2;
    if (!isKeyword && names.some((name) => covered.has(name))) return false;
    names.forEach((name) => covered.add(name));
    return true;
  });
}

// Orders a list by priority, so capping it drops the skills that matter least
// (a posting can name more listed skills than fit), then tops up a short list
// from the extras (skipping another name for a listed skill, "EKS" next to
// "Amazon Elastic Kubernetes Service") and caps it.
function sizeSkillList(
  list: string[],
  priority: SkillPriority,
  extras: () => string[],
  range: { readonly min: number; readonly max: number },
  reference: SkillsReference,
): string[] {
  // Array.prototype.sort is stable, so equal skills keep the model's order.
  const sized = withoutDuplicateNames(uniqueTerms(list).sort(byPriority(priority)), priority, reference);
  if (sized.length >= range.min) return sized.slice(0, range.max);

  const listed = new Set(sized.flatMap((skill) => [skill, ...referenceAliases(skill, reference)]).map(toKeywordMatchForm));
  for (const extra of extras()) {
    if (sized.length >= range.min) break;
    const names = [extra, ...referenceAliases(extra, reference)].map(toKeywordMatchForm);
    if (names.some((name) => listed.has(name))) continue;
    sized.push(extra);
    names.forEach((name) => listed.add(name));
  }
  return sized;
}

// The candidate's own hard skills a list may take more of: the profile's skills, then reference skills the
// resume text already names. Never one of the soft skills, and never a certification the job doesn't allow.
function hardSkillEvidence(tailored: TailoredContent, jobAnalysis: JobAnalysis, profile: Profile, reference: SkillsReference): string[] {
  const blocked = blockedCertifications(jobAnalysis, profile);
  const profileSkills = cleanSkillList(profile.skills, blocked);
  const text = getTailoredResumeText({ ...tailored, title: '', hardSkills: [], softSkills: [] });
  const soft = new Set(tailored.softSkills.map(toKeywordMatchForm));
  const skills = hasSkillsReference(reference)
    ? [...profileSkills.filter((s) => placementOf(s, 'hard', reference) === 'hardSkills'), ...referenceSkillsInText(text, 'hard', reference)]
    : profileSkills;
  return cleanSkillList(skills, blocked).filter((skill) => !soft.has(toKeywordMatchForm(skill)));
}

// Hard skills 20-25, soft skills 8-10 (v33: the archetype's sizes). A short list is topped up with the
// candidate's own skills: first the profile's skills, then reference skills the
// resume text already names. With a skills reference, only reference skills are
// used, each in the list the reference assigns.
function sizeSkillLists(tailored: TailoredContent, jobAnalysis: JobAnalysis, profile: Profile, fit: TailorFit): TailoredContent {
  const reference = fit.skills;
  const blocked = blockedCertifications(jobAnalysis, profile);
  const withReference = hasSkillsReference(reference);
  const profileSkills = cleanSkillList(profile.skills, blocked);
  const inOtherList = (skill: string, other: string[]) =>
    other.some((item) => toKeywordMatchForm(item) === toKeywordMatchForm(skill));
  const text = getTailoredResumeText({ ...tailored, title: '', hardSkills: [], softSkills: [] });
  const priority = skillPriority(jobAnalysis, text, reference);
  const usable = (skills: string[], other: string[]) =>
    cleanSkillList(skills, blocked).filter((skill) => !inOtherList(skill, other));

  const hardSkills = sizeSkillList(
    tailored.hardSkills,
    priority,
    () => hardSkillEvidence(tailored, jobAnalysis, profile, reference),
    fit.numbers.hardSkills,
    reference,
  );
  const softSkills = sizeSkillList(
    tailored.softSkills,
    priority,
    () =>
      withReference
        ? usable(
            [
              ...profileSkills.filter((s) => placementOf(s, 'soft', reference) === 'softSkills'),
              ...referenceSkillsInText(text, 'soft', reference).filter((s) => !AMBIGUOUS_SOFT_SKILLS.has(toKeywordMatchForm(s))),
            ],
            hardSkills
          )
        : [],
    fit.numbers.softSkills,
    reference,
  );
  return { ...tailored, hardSkills, skills: hardSkills, softSkills };
}

// The last step of every tailoring flow: job keywords into their lists, lists
// sized, skills capitalized, then the lists tidied the way a person writes them.
function finishSkillLists(tailored: TailoredContent, jobAnalysis: JobAnalysis, profile: Profile, fit: TailorFit): TailoredContent {
  const finished = withCapitalizedSkills(
    sizeSkillLists(fillMissingKeywords(tailored, jobAnalysis, profile, fit), jobAnalysis, profile, fit),
    jobAnalysis,
    fit.skills,
  );
  return withListsTidied(finished, jobAnalysis, hardSkillEvidence(finished, jobAnalysis, profile, fit.skills), fit);
}

// The ATS score, and each job keyword's uses it counts: as many as the resume has, up to what the posting asks.
function countedKeywordUses(tailored: TailoredContent, jobAnalysis: JobAnalysis, fit: TailorFit): { score: number; uses: Map<string, number> } {
  const report = buildAtsReport(tailored, jobAnalysis, undefined, fit.numbers);
  const uses = new Map(
    [...report.hardSkills.keywords, ...report.softSkills.keywords].map((k) => [k.keyword, Math.min(k.resumeCount, requiredUses(k.jobCount))])
  );
  return { score: report.score, uses };
}

/**
 * The skills lists as a person writes them, without costing the ATS score anything. One skill under two names
 * is written once ("Google Cloud Platform (GCP)"), parts go under their technology ("AWS (EC2, S3)"), one soft
 * skill isn't listed in two word forms, and the hard skills go by the library's heading, then priority.
 *
 * The score counts each job keyword's uses, up to what the posting asks. It doesn't care about order, but a
 * tidy-up that removes a name can cost a counted use: "Mentoring" dropped as a second form of "Mentor" when
 * both are job keywords. So every edit is checked on its own against the score's own count, and one that
 * would cost a counted use is skipped. The rest still apply. Each heading then gets 3 to 5 skills (see
 * withHeadingsBalanced), under the same check, from `evidence`: the candidate's own skills.
 */
export function withListsTidied(
  tailored: TailoredContent,
  jobAnalysis: JobAnalysis,
  evidence: string[] = [],
  fit: TailorFit = tailorFitOf(),
): TailoredContent {
  const reference = fit.skills;
  const baseline = countedKeywordUses(tailored, jobAnalysis, fit);
  const withLists = (hardSkills: string[], softSkills: string[]): TailoredContent => ({ ...tailored, hardSkills, skills: hardSkills, softSkills });
  const keepsScore = (candidate: TailoredContent) => {
    const after = countedKeywordUses(candidate, jobAnalysis, fit);
    return after.score >= baseline.score && [...baseline.uses].every(([keyword, uses]) => (after.uses.get(keyword) ?? 0) >= uses);
  };

  let hard = withSameSkillsCombined(tailored.hardSkills, (list) => keepsScore(withLists(list, tailored.softSkills)));
  const nested = withFamiliesNested(hard, reference);
  if (keepsScore(withLists(nested, tailored.softSkills))) hard = nested;
  const keywords = getAtsHardSkillKeywords(jobAnalysis);
  hard = withHeadingsBalanced(
    hard,
    {
      evidence: evidence.map((skill) => referenceSpelling(skill, reference) ?? skill),
      accept: (list) => keepsScore(withLists(list, tailored.softSkills)),
      // The job's keyword itself or another name for it ("Microsoft Azure" for Azure), not a product named after it.
      isKeyword: (name) => keywords.some((keyword) => combinedSkillName(name, keyword) !== null),
      maxTotal: fit.numbers.hardSkills.max,
    },
    reference,
  );
  hard = inLibraryOrder(hard, reference);
  const soft = withoutSameWordTwice(tailored.softSkills, (list) => keepsScore(withLists(hard, list)));
  return withLists(hard, soft);
}

// A heading of the hard skills list shows this many skills, as a person lists the tools of one area.
export const SKILLS_PER_HEADING = { min: 3, max: 5 };

/**
 * Each heading of the hard skills list ("Cloud", "Containers") with 3 to 5 skills, counted as the names shown:
 * "AWS (EC2, S3)" is 3, "Google Cloud Platform (GCP)" is 1. Every change must pass `accept` (the ATS check),
 * so a keyword use the score counts is never lost, and a heading that can't be fixed that way stays as it is.
 *
 * A heading over 5 drops its least wanted skills first: a part before a whole entry ("S3" of "AWS (EC2, S3)"),
 * a skill the job doesn't name before one it does, a lower priority before a higher, a later one before an
 * earlier. A heading under 3 takes more of the candidate's own skills of that heading (`evidence`): another
 * technology first, then a part of one it lists ("EC2" written under AWS). When the list is full, room is made
 * by dropping, in the same order, from the heading with the most skills. No heading is started from evidence,
 * since it would hold one skill.
 */
export function withHeadingsBalanced(
  skills: string[],
  options: { evidence: string[]; accept: (list: string[]) => boolean; isKeyword: (name: string) => boolean; maxTotal?: number },
  reference = loadSkillsReference()
): string[] {
  if (!isSkillLibrary(reference)) return skills;
  const { min, max } = SKILLS_PER_HEADING;
  const maxTotal = options.maxTotal ?? TECHNICAL_NUMBERS.hardSkills.max;
  const headingOf = (entry: string) => referenceCategory(baseSkillName(entry), reference);
  const count = (list: string[], heading: string) =>
    list.filter((entry) => headingOf(entry) === heading).reduce((sum, entry) => sum + skillsShown(entry, [heading]), 0);
  const total = (list: string[]) => list.reduce((sum, entry) => sum + skillsShown(entry), 0);
  const headings = (list: string[]) => [...new Set(list.map(headingOf).filter((heading): heading is string => Boolean(heading)))];

  // The lists one drop from the heading would leave, least wanted first.
  const drops = (list: string[], heading: string): string[][] => {
    const found: Array<{ list: string[]; keyword: boolean; part: boolean; siblings: number; order: number; index: number }> = [];
    list.forEach((entry, index) => {
      if (headingOf(entry) !== heading || skillsShown(entry, [heading]) === 0) return;
      const parts = partsOf(entry);
      parts.forEach((part, position) => {
        const next = list.map((item, i) => (i === index ? withoutPart(entry, part) : item));
        found.push({ list: next, keyword: options.isKeyword(part), part: true, siblings: parts.length, order: referenceOrder(part, reference), index: index + position / 100 });
      });
      if (parts.length === 0) {
        const next = list.filter((_item, i) => i !== index);
        found.push({ list: next, keyword: namesIn(entry).some(options.isKeyword), part: false, siblings: 0, order: referenceOrder(baseSkillName(entry), reference), index });
      }
    });
    return found
      .sort(
        (a, b) =>
          Number(a.keyword) - Number(b.keyword) ||
          Number(b.part) - Number(a.part) ||
          // Detail evens out: parts go first from the entry with the most of them.
          b.siblings - a.siblings ||
          b.order - a.order ||
          b.index - a.index
      )
      .map((option) => option.list);
  };

  let list = [...skills];
  for (const heading of headings(list)) {
    while (count(list, heading) > max) {
      const next = drops(list, heading).find(options.accept);
      if (!next) break;
      list = next;
    }
  }

  // One more skill from `evidence` under `heading`, when it is the candidate's, not shown yet, and (in the family
  // pass) a part of a technology already listed. Room is made first when the list is full.
  const added = (current: string[], candidate: string, heading: string, familyPass: boolean): string[] | null => {
    if (classifyReferenceSkill(candidate, reference) !== 'hard') return null;
    const shown = current.flatMap(namesIn);
    if (shown.some((name) => combinedSkillName(name, candidate) !== null)) return null;
    // Another name in the family of a listed technology is a part of it, written under it in the second pass.
    const family = new Set(referenceAliases(candidate, reference).map(toKeywordMatchForm));
    if (shown.some((name) => family.has(toKeywordMatchForm(name))) !== familyPass) return null;
    let room = current;
    if (total(room) >= maxTotal) {
      const fullest = headings(room)
        .filter((other) => other !== heading && count(room, other) > min)
        .sort((a, b) => count(room, b) - count(room, a))[0];
      const freed = fullest ? drops(room, fullest).find(options.accept) : undefined;
      if (!freed) return null;
      room = freed;
    }
    const next = withFamiliesNested([...room, candidate], reference);
    return options.accept(next) ? next : null;
  };

  for (const heading of headings(list)) {
    for (const familyPass of [false, true]) {
      for (const candidate of options.evidence) {
        if (count(list, heading) >= min) break;
        if (headingOf(candidate) !== heading) continue;
        list = added(list, candidate, heading, familyPass) ?? list;
      }
    }
  }

  // Headings of one group share a line when they are short ("Security and Compliance"). A group whose short
  // headings still make fewer than 3, with no line of the group that has room for them, takes the candidate's
  // skills from its other headings ("HashiCorp Vault" beside "SOC 2, PCI DSS").
  const shortOf = (current: string[], categories: string[]) =>
    categories.map((heading) => count(current, heading)).filter((n) => n > 0 && n < min).reduce((sum, n) => sum + n, 0);
  const groupFilled = (current: string[], categories: string[]) => {
    const short = shortOf(current, categories);
    return short === 0 || short >= min || categories.some((heading) => count(current, heading) >= min && count(current, heading) + short <= max);
  };
  for (const group of reference.groups) {
    for (const candidate of options.evidence) {
      if (groupFilled(list, group.categories)) break;
      const heading = headingOf(candidate);
      if (!heading || !group.categories.includes(heading) || count(list, heading) >= min) continue;
      list = added(list, candidate, heading, false) ?? list;
    }
  }
  return list;
}

/**
 * The hard skills as the resume shows them: by the library's heading, then its priority. The list was cut to
 * size in order of what the job wants most, so no keyword is lost to the cut; equal skills keep that order.
 * Without the skill library (the markdown reference has no headings) the list stays as it is.
 */
export function inLibraryOrder(skills: string[], reference: SkillsReference = loadSkillsReference()): string[] {
  const position = (skill: string) => referenceOrder(baseSkillName(skill), reference);
  return skills.map((skill, index) => ({ skill, index })).sort((a, b) => position(a.skill) - position(b.skill) || a.index - b.index).map(({ skill }) => skill);
}

/**
 * Parts of one technology written under it, as a person writes them: "AWS (EC2, S3, IAM, EKS)", not "AWS, EC2,
 * S3, IAM, EKS". A skill goes under another when the library files it as one of that skill's names and that skill
 * is listed too. The parts keep their own wording, so a scanner still finds each. A part whose head isn't listed
 * stays a skill of its own.
 */
export function withFamiliesNested(skills: string[], reference = loadSkillsReference()): string[] {
  const headName = (skill: string) => reference.aliases.get(toKeywordMatchForm(baseSkillName(skill)))?.[0] ?? baseSkillName(skill);
  const headOf = (skill: string) => toKeywordMatchForm(headName(skill));
  // The head itself, or the head under another name for the same skill ("Microsoft Azure" for "Azure").
  const isHead = (skill: string) => combinedSkillName(baseSkillName(skill), headName(skill)) !== null;
  const listedHeads = new Set(skills.filter(isHead).map(headOf));

  const parts = new Map<string, string[]>();
  const kept: string[] = [];
  for (const skill of skills) {
    const head = headOf(skill);
    if (!isHead(skill) && listedHeads.has(head)) parts.set(head, [...(parts.get(head) ?? []), skill]);
    else kept.push(skill);
  }
  return kept.map((skill) => {
    const under = isHead(skill) ? parts.get(headOf(skill)) : undefined;
    if (!under?.length) return skill;
    // "Google Cloud Platform (GCP)" takes its parts inside the same parentheses.
    const open = skill.match(/^(.*)\(([^)]*)\)\s*$/);
    return open ? `${open[1]}(${[open[2], ...under].join(', ')})` : `${skill} (${under.join(', ')})`;
  });
}


/**
 * The hard skills with each skill listed once: two names for it share the first one's place in the list. Each
 * merge is made only when `accept` takes the whole list it would leave (the ATS check in withListsTidied).
 */
export function withSameSkillsCombined(skills: string[], accept: (list: string[]) => boolean = () => true): string[] {
  let list = [...skills];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const combined = combinedSkillName(list[i]!, list[j]!);
      if (combined === null) continue;
      const candidate = list.map((skill, index) => (index === i ? combined : skill)).filter((_skill, index) => index !== j);
      if (!accept(candidate)) continue;
      list = candidate;
      j -= 1;
    }
  }
  return list;
}

/**
 * The soft skills without one word twice in two forms ("Mentor" and "Mentoring"). The list is sorted with the
 * job's own wording first, so that form is the one kept.
 */
export function withoutSameWordTwice(skills: string[], accept: (list: string[]) => boolean = () => true): string[] {
  let list = [...skills];
  for (let i = list.length - 1; i > 0; i -= 1) {
    const words = toKeywordMatchForm(list[i]!).split(' ');
    const twin = list.slice(0, i).some((other) => {
      const otherWords = toKeywordMatchForm(other).split(' ');
      return otherWords.length === words.length && otherWords.every((word, index) => sameWordFamily(word, words[index]!));
    });
    // A later form is dropped only when `accept` takes the list without it (the ATS check in withListsTidied).
    const candidate = list.filter((_skill, index) => index !== i);
    if (twin && accept(candidate)) list = candidate;
  }
  return list;
}

export function describeProfile(profile: Profile): string {
  // Contact details and ids don't help the writing and are rendered from the profile.
  const { id: _id, contact: _contact, createdAt: _c, updatedAt: _u, preferredTemplate: _t, disabled: _d, ...rest } = profile;
  // Compact JSON: indentation costs tokens and tells the model nothing.
  return JSON.stringify(rest);
}

const isBlank = (value: unknown) => value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);

function withoutBlanks<T extends object>(entry: T): Partial<T> {
  return Object.fromEntries(Object.entries(entry).filter(([, value]) => !isBlank(value))) as Partial<T>;
}

/**
 * The profile as the prompts get it, compact JSON with only what changes what the model writes. Contact
 * details and ids are rendered from the profile itself, and a role's location, a school's dates and place,
 * and the candidate's name change nothing in the resume or letter, so none of them is sent.
 */
export function profileForPrompt(profile: Profile): string {
  return JSON.stringify(
    withoutBlanks({
      title: profile.title,
      totalYearsExperience: profile.totalYearsExperience,
      summary: profile.summary,
      experience: (profile.experience ?? []).map(({ title, company, startDate, endDate, description, achievements }) =>
        withoutBlanks({ title, company, startDate, endDate, description, achievements })
      ),
      education: (profile.education ?? []).map(({ degree, institution }) => withoutBlanks({ degree, institution })),
      certifications: (profile.certifications ?? []).map(({ name, issuer }) => withoutBlanks({ name, issuer })),
      skills: profile.skills,
      strengths: profile.strengths,
    })
  );
}

/**
 * One keyword per line as term|kind|priority|goesIn|uses, plus "aka" and the other names it goes by.
 * goesIn is hard (the hard skills list), soft (the soft skills list) or text (a bullet or description).
 * The prompt explains the columns, so no names are repeated on every row.
 */
function keywordPlanText(targets: KeywordTarget[], reference: SkillsReference): string {
  return targets
    .map((k) => {
      const placement = placementOf(k.term, k.type, reference);
      // A few other names are enough to show which skill this is; a long list of companions is noise.
      const aliases = referenceAliases(k.term, reference).slice(0, MAX_PLAN_ALIASES);
      const goesIn = placement === 'hardSkills' ? 'hard' : placement === 'softSkills' ? 'soft' : 'text';
      // A keyword that lives in the prose is mentioned once. Two forced mentions of every one of dozens of
      // practice terms is what crams five keywords into a bullet. Tools and skills in a list still get their
      // second use in a bullet.
      const uses = placement === 'text' ? 1 : k.targetUses;
      return [inSentenceCase(k.term, placement, k.kind), k.kind, keywordPriority(k), goesIn, uses, ...(aliases.length > 0 ? [`aka ${aliases.join(' / ')}`] : [])].join('|');
    })
    .join('\n');
}

/**
 * How a prose keyword is shown to the model. The analysis writes a common phrase with a capital first
 * letter ("Capacity planning"), and a model that is told to use the term as written copies the capital into the
 * middle of a sentence ("Ran Capacity planning reviews"). Scanners ignore case, so a plain phrase is shown in
 * lowercase. Names, acronyms and anything already in mixed case ("RBAC Administration", "Release Management")
 * are left as they are for the model to judge.
 */
export function inSentenceCase(term: string, placement: Placement, kind: string): string {
  if (placement !== 'text' || kind === 'tool') return term;
  return /^[A-Z][a-z]+(?:[ -][a-z]+)*$/.test(term) ? `${term[0]!.toLowerCase()}${term.slice(1)}` : term;
}

// The soft skills the model may choose from: the library's own, without the everyday words that are only
// listed when the job or profile asks for them. Without a library, any short label will do.
const MAX_SOFT_SKILL_OPTIONS = 200;

function softSkillOptions(reference: SkillsReference): string {
  const names = [...reference.soft]
    .filter((key) => !AMBIGUOUS_SOFT_SKILLS.has(key))
    .map((key) => reference.display.get(key))
    .filter((name): name is string => Boolean(name));
  return names.length > 0 && names.length <= MAX_SOFT_SKILL_OPTIONS ? names.join(', ') : 'any short labels in title case';
}

// The letter works one or two keywords in; the most important dozen are plenty to choose from.
const COVER_LETTER_KEYWORDS = 12;
const MAX_PLAN_ALIASES = 3;
/** A term or a duty as the prompts quote it (parseKeywords keeps terms to 60 characters). */
const MAX_QUOTED_LINE = 500;

/** A list of the posting's own lines (its duties, its requirements) as JSON in one <untrusted> wrapper. */
function quotedList(lines: readonly string[]): string {
  return untrusted(JSON.stringify(lines.map((line) => untrustedText(line, MAX_QUOTED_LINE))), 20_000);
}

/** A keyword plan row's term, cleaned as page text is (it is the posting's own wording). */
const cleanTerm = (term: string) => untrustedText(term, MAX_QUOTED_LINE);

export function tailorPromptValues(profile: Profile, jobAnalysis: JobAnalysis, fit: TailorFit = tailorFitOf()): PromptValues {
  return {
    profileJson: profileForPrompt(profile),
    keywordPlanJson: keywordPlanText(getKeywordTargets(jobAnalysis).map((k) => ({ ...k, term: cleanTerm(k.term) })), fit.skills),
    responsibilitiesJson: quotedList(jobAnalysis.responsibilities ?? []),
    mustIncludeJson: quotedList(jobAnalysis.keywords?.mustInclude ?? []),
    softSkillOptionsJson: softSkillOptions(fit.skills),
  };
}

export function coverLetterPromptValues(profile: Profile, jobAnalysis: JobAnalysis, companyName?: string): PromptValues {
  const company = companyName?.trim();
  return {
    jobTitle: untrusted(jobAnalysis.jobMeta?.title?.trim() || 'Not specified', 300),
    // Previews don't know the company yet; the placeholder is filled in when files are generated.
    companyName: company ? untrusted(company, 200) : COMPANY_PLACEHOLDER,
    profileJson: profileForPrompt(profile),
    responsibilitiesJson: quotedList(jobAnalysis.responsibilities ?? []),
    keywordsJson: quotedList(getKeywordTargets(jobAnalysis).slice(0, COVER_LETTER_KEYWORDS).map((k) => k.term)),
  };
}

/** generate-cover-letter's values: the profile, the company and the role (no posting text). */
export function generateLetterPromptValues(profile: Profile, companyName: string, role: string): PromptValues {
  return {
    profileJson: describeProfile(profile),
    companyName: untrusted(companyName.trim() || 'Not specified', 200),
    role: untrusted(role.trim() || 'Not specified', 300),
  };
}

/**
 * How the pipeline calls the model: a task's runPrompt, the options of every call, and who hears each step. v33
 * PROMPTS (F5): and what the tailoring is written for (the person's fit; missing: technical).
 */
export interface TailorRun {
  runPrompt: RunPrompt;
  promptOptions?: RunPromptOptions;
  onStep?: (step: 'writing' | 'revising' | 'saving') => void;
  fit?: TailorFit;
}

/** A run's fit: the one it was given, else the technical family's. */
export const fitOfRun = (run: Pick<TailorRun, 'fit'>): TailorFit => run.fit ?? tailorFitOf();

// The cover letter call returns plain text; strip stray fences or quotes.
function asCoverLetter(content: string): string {
  return content
    .trim()
    .replace(/^```\w*\n?|```$/g, '')
    .replace(/^"|"$/g, '')
    .trim();
}

/** A letter's paragraphs as tailor_builder0's plain-text letter: one blank line between them. */
export function letterText(paragraphs: readonly string[]): string {
  return asCoverLetter(paragraphs.map((paragraph) => paragraph.trim()).filter(Boolean).join('\n\n'));
}

/** A plain-text letter's paragraphs. */
export function letterParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

async function writeCoverLetter(
  run: TailorRun,
  profile: Profile,
  jobAnalysis: JobAnalysis,
  companyName?: string
): Promise<string> {
  try {
    const values = coverLetterPromptValues(profile, jobAnalysis, companyName);
    const answer = await run.runPrompt(writeCoverLetterPrompt, { values, family: fitOfRun(run).family }, run.promptOptions);
    return letterText(answer.paragraphs);
  } catch {
    // The caller writes a cover letter itself (generate-cover-letter) when this one is missing.
    return '';
  }
}

/** generate-cover-letter: the letter when there is no posting text to tailor to (tailor_builder0's route fallback). */
export async function generateCoverLetter(run: TailorRun, profile: Profile, companyName: string, role: string): Promise<string> {
  const values = generateLetterPromptValues(profile, companyName, role);
  const answer = await run.runPrompt(generateCoverLetterPrompt, { values, family: fitOfRun(run).family }, run.promptOptions);
  return humanizeText(letterText(answer.paragraphs));
}

function parseResume(content: unknown): RawResume {
  const parsed = (typeof content === 'string' ? JSON.parse(content) : content) as RawResume;
  if (!parsed || typeof parsed !== 'object') throw new Error('Tailored resume is not a JSON object');
  return parsed;
}

/**
 * Figures from the profile's own achievements that the tailored role no longer
 * contains. They are facts and must come back, unchanged, with the achievement they measure.
 */
export function findLostMetrics(tailored: TailoredContent, profile: Profile): StyleIssue[] {
  const issues: StyleIssue[] = [];
  tailored.experience.forEach((role, index) => {
    // Tailored roles follow the profile's, one for one; a company with two roles is told apart by title.
    const roles = profile.experience ?? [];
    const sameCompany = (item: Experience) => toKeywordMatchForm(item.company ?? '') === toKeywordMatchForm(role.company);
    const original =
      roles[index] && sameCompany(roles[index])
        ? roles[index]
        : roles.find((item) => sameCompany(item) && toKeywordMatchForm(item.title ?? '') === toKeywordMatchForm(role.title)) ?? roles.find(sameCompany);
    if (!original) return;
    const kept = new Set(figuresIn([role.description, ...role.achievements].join(' \n ')));
    const lost = roleFigures(original).filter((figure) => !kept.has(figure));
    if (lost.length === 0) return;
    const source = (original.achievements ?? []).find((bullet) => figuresIn(bullet).includes(lost[0]!)) ?? original.description ?? '';
    issues.push({
      where: `${roleLabel(role, tailored.experience)} bullets`,
      problem: `no longer contains ${lost.map((figure) => `"${figure}"`).join(', ')} from the profile ("${source}"); put each figure back, unchanged, in the bullet about that same work (add a bullet if none covers it)`,
      serious: true,
      essential: true,
    });
  });
  return issues;
}

/**
 * TailorIT's last guard for the profile's own figures (decision 15: metrics never change), after the revisions: a
 * figure from a role's own text that the tailored role still lacks (findLostMetrics after the two rounds) brings back
 * the profile's own bullet that states it, word for word, at the end of that role's bullets; a figure only the role's
 * description gave brings back that description. Tailored roles follow the profile's one for one (mergeExperience).
 */
export function withProfileFiguresKept(tailored: TailoredContent, profile: Profile): TailoredContent {
  const roles = profile.experience ?? [];
  if (roles.length === 0) return tailored;
  const experience = tailored.experience.map((role, index) => {
    const original = roles[index];
    if (!original) return role;
    const kept = new Set(figuresIn([role.description, ...role.achievements].join(' \n ')));
    const lost = () => roleFigures(original).filter((figure) => !kept.has(figure));
    if (lost().length === 0) return role;
    const achievements = [...role.achievements];
    for (const bullet of original.achievements ?? []) {
      const figures = figuresIn(bullet);
      const missing = lost();
      if (missing.length === 0) break;
      if (!figures.some((figure) => missing.includes(figure))) continue;
      achievements.push(asBullet(bullet));
      figures.forEach((figure) => kept.add(figure));
    }
    const description = lost().length > 0 && original.description?.trim() ? asText(original.description) : role.description;
    return { ...role, description, achievements };
  });
  return { ...tailored, experience };
}

// What the revision step is asked to fix.
export type RevisionIssues = {
  missing: string[];
  underused: Array<{ term: string; uses: number; target: number }>;
  style: StyleIssue[];
};

// Keywords the revision must work into the text: every keyword that belongs in
// the resume text (the skills lists can't take it) and is missing, hard or soft.
// Without a skills reference, only missing required hard keywords.
function findIssues(report: AtsReport, jobAnalysis: JobAnalysis, profile: Profile, reference: SkillsReference): RevisionIssues {
  const blocked = blockedCertifications(jobAnalysis, profile);
  const keywords = getAtsKeywords(jobAnalysis);
  const textKeywords = hasSkillsReference(reference)
    ? new Set(keywords.filter((k) => placementOf(k.term, k.type, reference) === 'text').map((k) => toKeywordMatchForm(k.term)))
    : new Set(keywords.filter((k) => k.required && k.type === 'hard').map((k) => toKeywordMatchForm(k.term)));
  const tier = new Map(keywords.map((k) => [toKeywordMatchForm(k.term), ['must_have', 'strong', 'nice_to_have'].indexOf(keywordPriority(k))]));
  const tierOf = (term: string) => tier.get(toKeywordMatchForm(term)) ?? 2;
  return {
    // Most repeated first, then the higher tier; a long posting can leave dozens
    // missing, and asking for all of them made the revision slow and stuffed.
    missing: [...report.hardSkills.keywords, ...report.softSkills.keywords]
      .filter((k) => k.resumeCount === 0 && textKeywords.has(toKeywordMatchForm(k.keyword)) && !blocked.has(toKeywordMatchForm(k.keyword)))
      .sort((a, b) => b.jobCount - a.jobCount || tierOf(a.keyword) - tierOf(b.keyword))
      .slice(0, MAX_REVISION_KEYWORDS)
      .map((k) => k.keyword),
    // A keyword that lives in the prose is mentioned once (see keywordPlanText), so it is never "underused".
    underused: report.hardSkills.keywords
      .filter((k) => k.resumeCount > 0 && k.resumeCount < requiredUses(k.jobCount) && placementOf(k.keyword, 'hard', reference) !== 'text')
      .slice(0, MAX_REVISION_KEYWORDS)
      .map((k) => ({ term: k.keyword, uses: k.resumeCount, target: requiredUses(k.jobCount) })),
    style: [],
  };
}

// Keywords of each kind the revision is asked to work into the text.
const MAX_REVISION_KEYWORDS = 10;

// A revision call costs several thousand tokens, most of them output, so it runs only when it has to.
// Under-repeated keywords and minor style issues are fixed when a revision runs but don't trigger one.
// A vague trailing clause never reaches the model: the final cleanup cuts it for free. After the first
// round, only what a rewrite is still needed for counts (a keyword still missing, a profile figure still
// lost). A style slip that survived one rewrite is left alone, since another call rarely fixes it.
export function styleIssuesForRound(style: StyleIssue[], round: number): StyleIssue[] {
  return style.filter((issue) => !issue.fixedByCode && (round === 1 || issue.essential));
}

export function needsRevision(issues: RevisionIssues, round = 1): boolean {
  return issues.missing.length > 0 || styleIssuesForRound(issues.style, round).some((issue) => issue.serious);
}

type RevisionEdit = { company?: unknown; title?: unknown; bullet?: unknown; text?: unknown; description?: unknown };

// The revision returns only what it changes: a new summary, bullet replacements
// or additions by company, role descriptions, and possibly a new cover letter.
// Everything it doesn't mention stays as tailored.
export function applyRevisionEdits(
  tailored: TailoredContent,
  revised: Record<string, unknown>,
  numbers: RoleTailoring = TECHNICAL_NUMBERS,
): TailoredContent {
  const experience = tailored.experience.map((role) => ({ ...role, achievements: [...role.achievements] }));
  // A role is named by its company, and by its title when the company has two roles; without a
  // title, the first role at the company.
  const roleIndexFor = (company: string, title: string) => {
    const key = toKeywordMatchForm(company);
    const titleKey = toKeywordMatchForm(title);
    const indexes = experience.map((_role, index) => index);
    const exact = indexes.filter((index) => toKeywordMatchForm(experience[index]!.company) === key);
    const matches = exact.length > 0 ? exact : indexes.filter((index) => key && toKeywordMatchForm(experience[index]!.company).includes(key));
    return matches.find((index) => titleKey && toKeywordMatchForm(experience[index]!.title) === titleKey) ?? matches[0] ?? -1;
  };

  for (const raw of Array.isArray(revised.edits) ? (revised.edits as RevisionEdit[]) : []) {
    if (!raw || typeof raw !== 'object') continue;
    const roleIndex = roleIndexFor(asText(raw.company), asText(raw.title));
    const role = experience[roleIndex];
    if (!role) continue;
    const description = asText(raw.description);
    if (description) role.description = description;
    const text = asBullet(raw.text);
    const bullet = Number(raw.bullet);
    if (!text || !Number.isInteger(bullet)) continue;
    if (bullet === 0) {
      // A role may grow to its limit; the newest one gets one more when a keyword can't fit otherwise.
      if (role.achievements.length < bulletLimit(roleIndex, numbers) + (roleIndex === 0 ? 1 : 0)) role.achievements.push(text);
    } else if (bullet >= 1 && bullet <= role.achievements.length) {
      role.achievements[bullet - 1] = text;
    }
  }

  const coverLetter = typeof revised.coverLetter === 'string' ? revised.coverLetter.trim() : '';
  return {
    ...tailored,
    summary: asText(revised.summary) || tailored.summary,
    experience,
    ...(coverLetter ? { coverLetter } : {}),
  };
}

async function reviseForKeywords(run: TailorRun, tailored: TailoredContent, issues: RevisionIssues, fit: TailorFit): Promise<TailoredContent> {
  // The cover letter is sent only when it has an issue to fix.
  const letterIssue = issues.style.some((issue) => issue.where === 'cover letter');
  const values = {
    resumeJson: JSON.stringify({
      summary: tailored.summary,
      experience: tailored.experience.map(({ title, company, description, achievements }) => ({
        title,
        company,
        description,
        achievements,
      })),
      ...(letterIssue ? { coverLetter: tailored.coverLetter ?? '' } : {}),
    }),
    missingKeywordsJson: JSON.stringify(issues.missing.map(cleanTerm)),
    underusedKeywordsJson: JSON.stringify(issues.underused.map((item) => ({ ...item, term: cleanTerm(item.term) }))),
    styleIssuesJson: JSON.stringify(issues.style.map(({ where, problem }) => ({ where, problem }))),
  };
  const revised = await run.runPrompt(reviseResumePrompt, { values, family: fit.family }, run.promptOptions);
  return humanizeContent(applyRevisionEdits(tailored, revised, fit.numbers));
}

// Turns a raw model reply into tailored content, without the cover letter or revision step.
export function normalizeTailorResumeModelContent(
  content: string | Record<string, unknown>,
  profile: Profile,
  jobAnalysis: JobAnalysis,
  jobDescription: string,
  fit: TailorFit = tailorFitOf(),
): TailoredContent {
  const analysis = jobAnalysis.sourceJobDescription ? jobAnalysis : { ...jobAnalysis, sourceJobDescription: jobDescription };
  const written = humanizeContent(normalizeResume(parseResume(content), profile, analysis, fit));
  return finishSkillLists(withoutNightMentions(written, profile), analysis, profile, fit);
}

// A 2 a.m. page, a midnight deploy or "the middle of the night" reads as machine-written, so mentions of the
// small hours come out of every text field, unless the candidate's own profile says it.
function withoutNightMentions(tailored: TailoredContent, profile: Profile): TailoredContent {
  const source = describeProfile(profile);
  const clean = (text: string) => withoutNightCliches(text, source);
  return {
    ...tailored,
    summary: clean(tailored.summary),
    experience: tailored.experience.map((role) => ({
      ...role,
      description: clean(role.description),
      achievements: role.achievements.map(clean),
    })),
    strengths: tailored.strengths.map((strength) => ({ ...strength, title: clean(strength.title), description: clean(strength.description) })),
    ...(tailored.coverLetter ? { coverLetter: clean(tailored.coverLetter) } : {}),
  };
}

// A vague trailing clause that outlived the revisions is cut; ending on the result is allowed.
function withoutTackedOnClauses(tailored: TailoredContent, keywordTerms: string[]): TailoredContent {
  return {
    ...tailored,
    experience: tailored.experience.map((role) => ({
      ...role,
      description: dropTackedOnClause(role.description, keywordTerms),
      achievements: role.achievements.map((bullet) => dropTackedOnClause(bullet, keywordTerms)),
    })),
  };
}

/**
 * Whether a model reply holds a resume: a summary and, for a candidate with experience, bullets under at
 * least one role. Now and then the model answers with valid JSON that has none of it (an empty copy of the
 * output format). Used as it is, that becomes a resume of the profile's own untailored text.
 */
export function isUsableDraft(content: unknown, profile: Profile): boolean {
  try {
    const raw = parseResume(content);
    const withBullets = asRawExperienceList(raw.experience).some((entry) => Array.isArray(entry.achievements) && entry.achievements.length > 0);
    return asText(raw.summary) !== '' && (withBullets || !(profile.experience ?? []).length);
  } catch {
    return false;
  }
}

// The resume call. A reply with no resume in it (or none that parses) is asked for once more, which costs one
// call in a few drafts, where keeping it would cost the whole resume. The second try says what was wrong
// (RETRY_NOTE): the model has answered a sparse profile with a request for more information, or with an empty
// copy of the output format.
async function writeResumeDraft(run: TailorRun, profile: Profile, jobAnalysis: JobAnalysis, fit: TailorFit): Promise<Record<string, unknown>> {
  const values = tailorPromptValues(profile, jobAnalysis, fit);
  const content = await run.runPrompt(tailorResumePrompt, { values, family: fit.family }, run.promptOptions);
  if (isUsableDraft(content, profile)) return content;
  return run.runPrompt(tailorResumePrompt, { values, note: RETRY_NOTE, family: fit.family }, run.promptOptions);
}

/** What the revise loop did, for the task's log line (counts only). */
export interface TailorStats {
  revisions: number;
  firstScore: number;
  finalScore: number;
}

export async function tailorResume(
  run: TailorRun,
  profile: Profile,
  jobAnalysis: JobAnalysis,
  companyName?: string,
  options: { coverLetter?: boolean; stats?: TailorStats } = {}
): Promise<TailoredContent> {
  run.onStep?.('writing');
  const fit = fitOfRun(run);
  // The cover letter doesn't depend on the bullets, so it's written alongside
  // the resume instead of making the resume call longer.
  const [content, coverLetter] = await Promise.all([
    writeResumeDraft(run, profile, jobAnalysis, fit),
    options.coverLetter === false ? Promise.resolve('') : writeCoverLetter(run, profile, jobAnalysis, companyName),
  ]);

  let tailored: TailoredContent;
  try {
    tailored = humanizeContent(normalizeResume({ ...parseResume(content), coverLetter }, profile, jobAnalysis, fit));
  } catch {
    throw new Error('The model did not write a resume after two tries.');
  }

  // Every keyword has to appear, so a revision that leaves some out gets a second pass.
  const keywordTerms = getAtsKeywords(jobAnalysis).map((k) => k.term);
  for (let round = 1; round <= MAX_REVISION_ROUNDS; round += 1) {
    const report = buildAtsReport(tailored, jobAnalysis, profile, fit.numbers);
    if (round === 1 && options.stats) options.stats.firstScore = report.score;
    const issues = findIssues(report, jobAnalysis, profile, fit.skills);
    issues.style = [...findStyleIssues(tailored, keywordTerms, describeProfile(profile)), ...findLostMetrics(tailored, profile)];
    const toFix = styleIssuesForRound(issues.style, round);
    if (!needsRevision(issues, round)) break;

    run.onStep?.('revising');
    try {
      tailored = await reviseForKeywords(run, tailored, { ...issues, style: toFix }, fit);
      if (options.stats) options.stats.revisions = round;
    } catch (error) {
      // A cancelled task stops here; any other failure keeps the draft, and the fill step covers what's missing.
      if (run.promptOptions?.signal?.aborted) throw error;
      break;
    }
  }

  const finalTailored = finishSkillLists(withoutNightMentions(withoutTackedOnClauses(tailored, keywordTerms), profile), jobAnalysis, profile, fit);
  if (options.stats) options.stats.finalScore = buildAtsReport(finalTailored, jobAnalysis, profile, fit.numbers).score;
  return finalTailored;
}

// v1.5 M: tailorResume's code steps for a resume the person's own AI wrote (features/mcp, Prepare with "my own AI").
// TailorIT's Claude writes nothing here: the AI's tailor-resume answer goes through normalizeResume (employers, titles,
// dates and places from the profile, bullets capped, figures kept) and humanize, exactly as tailorResume reads its own
// model's answer; a revise-resume-ats answer is applied with applyRevisionEdits and humanized, as reviseForKeywords
// does. The issues of a round are tailorResume's (findIssues, findStyleIssues, findLostMetrics, styleIssuesForRound),
// and the finishing is its last line. The cover letter is not part of it (the MCP tools save it on its own).

/** A tailor-resume answer as tailorResume reads its model's: normalized and humanized, before the finishing steps. */
export function draftFromAnswer(content: unknown, profile: Profile, jobAnalysis: JobAnalysis, fit: TailorFit = tailorFitOf()): TailoredContent {
  const raw = parseResume(content);
  return humanizeContent(normalizeResume({ ...raw, coverLetter: '' }, profile, jobAnalysis, fit));
}

/** A revise-resume-ats answer applied to the draft it revises, as reviseForKeywords applies its model's. */
export function draftWithRevision(draft: TailoredContent, revision: Record<string, unknown>, fit: TailorFit = tailorFitOf()): TailoredContent {
  return humanizeContent(applyRevisionEdits(draft, { ...revision, coverLetter: '' }, fit.numbers));
}

/**
 * What a draft still needs at revision round `round` (1, 2...): tailorResume's check before each revise call. v1.5 Q1:
 * `rounds` is how many revisions may follow the first draft (the person's own AI: their setting, 0 to 5); TailorIT's
 * own tailoring keeps its two.
 */
export function revisionRound(
  draft: TailoredContent,
  jobAnalysis: JobAnalysis,
  profile: Profile,
  round: number,
  rounds: number = MAX_REVISION_ROUNDS,
  fit: TailorFit = tailorFitOf(),
): { report: AtsReport; issues: RevisionIssues; revise: boolean } {
  const report = buildAtsReport(draft, jobAnalysis, profile, fit.numbers);
  const issues = findIssues(report, jobAnalysis, profile, fit.skills);
  const keywordTerms = getAtsKeywords(jobAnalysis).map((k) => k.term);
  issues.style = [...findStyleIssues(draft, keywordTerms, describeProfile(profile)), ...findLostMetrics(draft, profile)];
  const revise = round <= rounds && needsRevision(issues, round);
  return { report, issues: { ...issues, style: styleIssuesForRound(issues.style, round) }, revise };
}

/** tailorResume's finishing steps on a draft (clauses cut, night mentions out, skill lists filled and tidied). */
export function finishedDraft(draft: TailoredContent, jobAnalysis: JobAnalysis, profile: Profile, fit: TailorFit = tailorFitOf()): TailoredContent {
  const keywordTerms = getAtsKeywords(jobAnalysis).map((k) => k.term);
  return finishSkillLists(withoutNightMentions(withoutTackedOnClauses(draft, keywordTerms), profile), jobAnalysis, profile, fit);
}

/** The revision rounds tailorResume runs at most. */
export const REVISION_ROUNDS = MAX_REVISION_ROUNDS;
// end v1.5 M
