import type { RoleArchetype, RoleTailoring } from '@tailorit/shared';
import { ARCHETYPE_DEFAULTS, withArticle, type FamilyPack } from './pack';

// v33 PROMPTS (F5): each slot's replacement (slots.ts), as a template filled from a family's words: its vocabulary
// pack, the archetype's defaults for what the pack leaves out, and the archetype's numbers (RoleTailoring, so a slot's
// bullet counts and list sizes are the ones the pipeline keeps). One template per slot serves every non-technical
// family; the technical family never gets here (its prompts are tailor_builder0's words).

/** What a slot's template reads: the pack with every default filled, its numbers and its article. */
export interface SlotWords extends Required<Omit<FamilyPack, 'article'>> {
  archetype: Exclude<RoleArchetype, 'technical'>;
  numbers: RoleTailoring;
  /** "a nurse", "an accountant". */
  aPerson: string;
}

/** A pack with its archetype's defaults and numbers. */
export function slotWords(pack: FamilyPack, archetype: Exclude<RoleArchetype, 'technical'>, numbers: RoleTailoring): SlotWords {
  const { article: _article, ...rest } = pack;
  return { ...ARCHETYPE_DEFAULTS[archetype], ...rest, archetype, numbers, aPerson: withArticle(pack) } as SlotWords;
}

const cap = (text: string) => (text ? `${text[0]!.toUpperCase()}${text.slice(1)}` : text);
const SMALL_WORDS = new Set(['a', 'an', 'and', 'for', 'in', 'of', 'on', 'or', 'the', 'to']);
const titleCase = (text: string) => text.split(' ').map((word, at) => (at > 0 && SMALL_WORDS.has(word) ? word : cap(word))).join(' ');
const q = (text: string) => `"${text}"`;
/** "a" or "an" before a word ("an IT part", "an HR part", "a clinical part"). */
const article = (word: string) => (/^([aeiou]|HR\b)/i.test(word) ? 'an' : 'a');
/** "A, B, C, and D", as tailor_builder0 lists a parent and its parts. */
const andList = (items: readonly string[]) =>
  items.length <= 2 ? items.join(' and ') : `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
const unique = (items: readonly string[]) => [...new Set(items)];

/** "5 to 7, then 4 to 6, then 3 to 4, then 2 to 3": the newest roles' bullets, then the older roles'. */
export function bulletRanges(numbers: RoleTailoring): string {
  const ranges = numbers.bulletsPerRole.map((max, index) => `${numbers.minBulletsPerRole[index] ?? numbers.olderRoleMinBullets} to ${max}`);
  return [...ranges, `${numbers.olderRoleMinBullets} to ${numbers.olderRoleBullets}`].join(', then ');
}

/** "the newest role holds up to 7 bullets, the next 6, the next 4, older roles 3". */
export function bulletLimits(numbers: RoleTailoring): string {
  const [newest, ...next] = numbers.bulletsPerRole;
  return [`the newest role holds up to ${newest} bullets`, ...next.map((max) => `the next ${max}`), `older roles ${numbers.olderRoleBullets}`].join(', ');
}

type Template = (words: SlotWords) => string;

const variant: Template = (w) => `an obvious variant such as "${w.abbr[0]}" for "${w.abbr[1]}"`;
const listCount: Template = () => "(a list of tool or system names doesn't count)";

/** The template of every slot, by its key (`<prompt>/<name>`, slots.ts). */
export const SLOT_TEMPLATES: Readonly<Record<string, Template>> = {
  // analyze-job-description
  'analyze-job-description/role': (w) => `You are an ATS keyword analyst and expert ${w.recruiter ? `${w.recruiter} ` : ''}recruiter.`,
  'analyze-job-description/variant': variant,
  'analyze-job-description/tool-kind': (w) => `- "tool" (type "hard"): ${w.toolKinds} (e.g. ${w.tools.join(', ')}).`,
  'analyze-job-description/competency-kind': (w) =>
    `- "competency" (type "hard"): ${w.practice} practices and concepts (${w.practices.join(', ')}) and domain, industry, and ` +
    `compliance terms (${unique([...w.domains, ...w.compliance]).join(', ')}).`,
  'analyze-job-description/activities': (w) =>
    `- ${cap(w.practice)} activities (${w.activities.join(', ')}) are ${w.practice} keywords, not soft skills.`,
  'analyze-job-description/perk': (w) => `(a "stipend for ${w.certs[0]} courses" is a perk, not a requirement)`,
  'analyze-job-description/certifications': (w) =>
    `certifications or licenses a person holds (e.g., ${w.certs.join(', ')}). Standards and rules the work happens under ` +
    `(${w.compliance.join(', ')}) are not certifications; they stay keywords.`,
  'analyze-job-description/mixed': (w) => `"${w.mixed[0][0]}" gives ${w.mixed[0][1]}. "${w.mixed[1][0]}" gives ${w.mixed[1][1]}.`,
  'analyze-job-description/alternatives': (w) => `"${w.alternatives[0]}", "${w.alternatives[1]}": list each term.`,
  'analyze-job-description/lists': (w) =>
    `"${w.list[0]} (${w.list[1].join(', ')})" gives ${andList([w.list[0], ...w.list[1]])}, all at the parent's priority. ` +
    `"${w.slash[0]} / ${w.slash[1]}" gives "${w.slash[0]}" and "${w.slash[1]}". Keep fixed names whole (${w.fixed.map(q).join(', ')}).`,
  'analyze-job-description/qualifiers': (w) => `"strong experience with ${w.tools[0]}" gives ${w.tools[0]};`,
  'analyze-job-description/stack': (w) =>
    `- Workplace and company descriptions ("Our team uses:", "We work with..."): industry-standard ${w.toolWord} there are ` +
    'keywords, but they stay nice_to_have unless they also appear in the responsibilities or requirements.',
  'analyze-job-description/proprietary': (w) =>
    `From "${w.proprietary[0]}, ${w.proprietary[1]}", keep "${w.proprietary[2]}" and drop "${w.proprietary[0]}".`,
  'analyze-job-description/colleagues': (w) => `("${w.colleagues}")`,
  'analyze-job-description/two-part': (w) =>
    `A phrase with ${article(w.practice)} ${w.practice} part and an interpersonal part ("lead ${w.lead}") gives ` +
    `${article(w.practice)} ${w.practice} keyword (${w.lead}) and a soft skill (leadership).`,
  'analyze-job-description/capitalize': (w) => `("${w.lower[0]}" becomes "${cap(w.lower[0])}")`,
  'analyze-job-description/duties': (w) => `("${w.duties[0]}", "${w.duties[1]}")`,
  'analyze-job-description/multiword': (w) => `Keep multi-word names whole ("${w.multiword}").`,
  'analyze-job-description/title-priority': (w) => `named in the job title (e.g. ${w.titleKeyword[0]} in "${w.titleKeyword[1]}")`,
  'analyze-job-description/nice-to-have': () => 'or found only in the company or workplace description.',
  'analyze-job-description/title': (w) => `usually the first heading ("${w.title}")`,
  'analyze-job-description/must-include': (w) => `("${w.years}")`,
  'analyze-job-description/rows': (w) =>
    `    ["${cap(w.tools[0]!)}", "hard", "tool", "must_have"],\n    ["${cap(w.practices[0]!)}", "hard", "competency", "strong"],`,

  // review-job-keywords
  'review-job-keywords/stack': () => 'including the workplace and company description,',
  'review-job-keywords/variant': variant,
  'review-job-keywords/tool-kind': (w) => `- kind "tool": named ${w.toolKinds}, and product categories (e.g. ${w.tools.slice(1, 4).join(', ')})`,
  'review-job-keywords/competency-kind': (w) =>
    `- kind "competency": ${w.practice} practices and concepts of 1-4 words (${w.practices.slice(1, 4).map(cap).join(', ')}), ` +
    `and domain, industry, and compliance terms (${w.domains.slice(0, 3).map(cap).join(', ')}),`,
  'review-job-keywords/row': (w) => `{ "missing": [["${cap(w.practices[4]!)}", "hard", "competency", "strong"]] }`,
  'review-job-keywords/nice-to-have': () => 'or only in the workplace or company description)',

  // tailor-resume
  'tailor-resume/person': (w) => `still read like a capable ${w.person} typed it on a quiet Sunday.`,
  'tailor-resume/casing': (w) =>
    `Lowercase the common words ("${w.lower[0]}", "${w.lower[1]}") and keep the capitals of product names and acronyms ` +
    `(${w.names.join(', ')}).`,
  'tailor-resume/list-count': listCount,
  'tailor-resume/weaken': (w) => `(don't turn "${w.weaken[0]}" into "${w.weaken[1]}")`,
  'tailor-resume/older-tools': (w) =>
    `use only ${w.toolWord} that existed in those years. Older and more junior roles get simpler work and smaller scope.`,
  'tailor-resume/one-system': (w) => `- One ${w.mainSystem} per role, and no tool or system renamed in the next role.`,
  'tailor-resume/filler': (w) => `("Handled ${w.lower[0]} tasks.")`,
  'tailor-resume/acronym': (w) => `("${cap(w.abbr[1])} (${w.abbr[0]})")`,
  'tailor-resume/lead-with': (w) => `(${w.leadWith})`,
  'tailor-resume/bullets': (w) =>
    `- Bullets per role, newest first: ${bulletRanges(w.numbers)}. At most ${w.numbers.maxTotalBullets} in total, and never ` +
    "fewer than a role has achievements with metrics. A bullet you add carries no new metrics and fits that role's company and work.",
  'tailor-resume/hard-skills': (w) =>
    `hardSkills: ${w.numbers.hardSkills.min} to ${w.numbers.hardSkills.max} ${w.hardSkills[0]} (${w.hardSkills[1]}). Standards the ` +
    `work happens under (${w.compliance.join(', ')}) are fine. Never duties, role titles or domain knowledge ("${w.domains[0]}"), ` +
    'which go in bullets.',
  'tailor-resume/standard-names': (w) => `Use standard names (${w.tools.slice(0, 3).join(', ')}).`,
  'tailor-resume/one-form': (w) =>
    `- One form per skill ("${w.abbr[0]}", not also "${titleCase(w.abbr[1])}"). Capitalize unless the name's own spelling is lowercase.`,
  'tailor-resume/areas': (w) =>
    `- List it the way ${w.aPerson} knows their own work. For each area they work in (${w.areas.join(', ')}), name the 3 to 5 ` +
    'skills they used there, rather than one skill from many unrelated areas.',
  'tailor-resume/soft-skills': (w) => `softSkills: ${w.numbers.softSkills.min} to ${w.numbers.softSkills.max}, chosen only from`,
  'tailor-resume/picture': (w) => `Picture ${w.aPerson} typing their own resume. They remember ${w.remember}, they name ${w.nameThings},`,
  'tailor-resume/verbs': (w) => `For example ${w.verbs.join(', ')}.`,
  'tailor-resume/numbers': (w) => `(${w.untidy})`,
  'tailor-resume/figures': (w) => `(${w.figures})`,

  // revise-resume-ats
  'revise-resume-ats/bullets': (w) => `(${bulletLimits(w.numbers)}, and the newest may take one more if nothing else fits)`,
  'revise-resume-ats/list-count': listCount,
  'revise-resume-ats/casing': (w) => `Lowercase common words ("${w.lower[1]}")`,

  // the letters
  'write-cover-letter/story': (w) => `covering ${w.storyNeed}, what I did and what changed.`,
  'generate-cover-letter/verbs': (w) => `Plain verbs over inflated ones: ${w.verbs.slice(0, 5).join(', ')};`,
};
