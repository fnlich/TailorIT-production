import type { RoleArchetype, RoleFamilyKey } from '@tailorit/shared';

// v33 PROMPTS (F5): a role family's vocabulary pack, the words its renderings of tailor_builder0's prompts use in place
// of the software and DevOps examples (the "slots", slots.ts). Each field is an example of the field's own work: the
// prompts quote them as shapes, never as facts. The technical family has no pack: its prompts are tailor_builder0's,
// word for word. The archetype gives the defaults a pack may leave out (ARCHETYPE_DEFAULTS).

export interface FamilyPack {
  family: Exclude<RoleFamilyKey, 'technical'>;
  /** The person a resume of the field reads as typed by ("nurse", "warehouse associate"). */
  person: string;
  /** Its article when it is not the first letter's ("an HR generalist"). */
  article?: 'a' | 'an';
  /** The recruiter the analysis is: "healthcare" in "expert healthcare recruiter" ('' for "expert recruiter"). */
  recruiter: string;
  /** The field's kind of practice: "clinical" in "clinical practices and concepts". */
  practice: string;
  /** What the field's tools are, as the analysis's "tool" kind names them. */
  toolKinds: string;
  /** Named tools, software and equipment of the field (at least 8, most typical first). */
  tools: readonly string[];
  /** Practices and concepts (competencies), lowercase phrases (at least 6). */
  practices: readonly string[];
  /** Domain, industry and compliance terms (at least 4). */
  domains: readonly string[];
  /** The field's activities that are keywords, not soft skills (at least 4). */
  activities: readonly string[];
  /** Certifications and licences a person holds (never keywords). */
  certs: readonly string[];
  /** Standards and rules the work happens under (keywords, not certifications). */
  compliance: readonly string[];
  /** An abbreviation and its expansion: ["EHR", "electronic health records"]. */
  abbr: readonly [string, string];
  /** Three names whose capitals stay ("Epic, EKG, HIPAA"). */
  names: readonly [string, string, string];
  /** Two requirements with a condition, and the keyword each gives. */
  mixed: readonly [readonly [string, string], readonly [string, string]];
  /** Two "A or B" alternatives. */
  alternatives: readonly [string, string];
  /** A parent with its parts: "Microsoft Office (Word, Excel, Outlook)". */
  list: readonly [string, readonly string[]];
  /** Two names written "A / B". */
  slash: readonly [string, string];
  /** Three fixed names kept whole. */
  fixed: readonly [string, string, string];
  /** A proprietary name, what it is, and the practice to keep from it. */
  proprietary: readonly [string, string, string];
  /** People the candidate works with ("work with physicians and pharmacists"). */
  colleagues: string;
  /** The practice in "lead <it>". */
  lead: string;
  /** Two common phrases written in lowercase. */
  lower: readonly [string, string];
  /** Two duties written as sentences (never keywords). */
  duties: readonly [string, string];
  /** A multi-word name kept whole, capitalized. */
  multiword: string;
  /** A keyword named in a job title, and that title. */
  titleKeyword: readonly [string, string];
  /** A typical posted title. */
  title: string;
  /** A hard requirement quoted as the posting writes it (years). */
  years: string;
  /** A term, and the weaker wording a keyword must never be turned into. */
  weaken: readonly [string, string];
  /** The one system a role names ("health record system"). */
  mainSystem: string;
  /** The areas a person of the field lists skills by (at least 5). */
  areas: readonly string[];
  // Defaults from the archetype (ARCHETYPE_DEFAULTS):
  hardSkills?: readonly [string, string];
  toolWord?: string;
  leadWith?: string;
  remember?: string;
  nameThings?: string;
  verbs?: readonly string[];
  untidy?: string;
  figures?: string;
  storyNeed?: string;
}

/** What an archetype gives every pack of it that leaves the field out. */
export type ArchetypeDefaults = Required<Pick<FamilyPack, 'hardSkills' | 'toolWord' | 'leadWith' | 'remember' | 'nameThings' | 'verbs' | 'untidy' | 'figures' | 'storyNeed'>>;

export const ARCHETYPE_DEFAULTS: Readonly<Record<Exclude<RoleArchetype, 'technical'>, ArchetypeDefaults>> = {
  professional: {
    hardSkills: ['named software, tools, systems, methods and standards of the field', 'things you can name and use'],
    toolWord: 'tools and systems',
    leadWith: 'the years, the work, who it was for, the size of the team',
    remember: 'what they handled',
    nameThings: 'the tools and systems they used',
    verbs: ['ran', 'wrote', 'set up', 'fixed', 'cut', 'prepared', 'handled', 'tracked', 'moved', 'closed', 'planned', 'replaced', 'added', 'checked', 'led', 'trained'],
    untidy: '9 days down to 4, 3 regions, about $18k a month',
    figures: '14 accounts, a team of 6',
    storyNeed: 'what needed fixing or doing',
  },
  'hands-on': {
    hardSkills: ['named equipment, tools, machines, systems, procedures and safety standards', 'things you were trained to run, use or follow'],
    toolWord: 'equipment, tools and methods',
    leadWith: 'the years, the site, the equipment, the size of the crew',
    remember: 'what they ran and fixed on each shift',
    nameThings: 'the equipment and sites they worked with',
    verbs: ['ran', 'loaded', 'fixed', 'installed', 'checked', 'cleaned', 'moved', 'built', 'set up', 'replaced', 'packed', 'counted', 'served', 'cut', 'led', 'trained'],
    untidy: '40 minutes down to 25, 3 shifts, about 180 units a day',
    figures: 'a 12-person crew, 2 sites',
    storyNeed: 'what needed doing on the job',
  },
  care: {
    hardSkills: ['named care skills, procedures, equipment, systems and standards', 'things you were trained to do or use'],
    toolWord: 'equipment, systems and methods',
    leadWith: 'the years, the setting, the people served, the size of the team',
    remember: 'who they worked with and what changed for them',
    nameThings: 'the programs, equipment and systems they used',
    verbs: ['assessed', 'taught', 'planned', 'checked', 'gave', 'kept', 'ran', 'set up', 'wrote', 'moved', 'cut', 'added', 'fixed', 'tracked', 'led', 'trained'],
    untidy: '45 minutes down to 20, 3 units, about 40 people a week',
    figures: 'a caseload of 24, a team of 6',
    storyNeed: 'what the people in my care needed',
  },
};

/** "a nurse", "an accountant", "an HR generalist". */
export function withArticle(pack: Pick<FamilyPack, 'person' | 'article'>): string {
  const article = pack.article ?? (/^[aeiou]/i.test(pack.person) ? 'an' : 'a');
  return `${article} ${pack.person}`;
}
