import { countryDisplayName } from '@tailorit/shared/jobs';
import { isWithin, type AutofillDraft } from '../draft';
import { DEGREE_LEVEL_LABEL, LANGUAGE_PROFICIENCY_LABEL } from '../options';
import { ONCE_SECTIONS, onceChecklist } from './onceChecklist';

// v1.4 E (decision 19): Settings › Autofill › Profile as a step-by-step wizard, like jobright.ai's profile onboarding.
// The steps, which places of the draft each one edits, where a message or a "Answer" link belongs, what Next does
// with the draft as it stands, and what the Review step says of each step. Pure, so the page only draws them.

export const WIZARD_STEP_IDS = [
  'import',
  'personal',
  'education',
  'experience',
  'skills',
  'authorization',
  'questions',
  'documents',
  'review',
] as const;
export type WizardStepId = (typeof WIZARD_STEP_IDS)[number];

export interface WizardStep {
  id: WizardStepId;
  /** The stepper's word. */
  label: string;
  /** The step's heading. */
  title: string;
  description: string;
  /** The places of the draft the step edits ("profile.education"): its checks and its messages. */
  places: readonly string[];
}

export const WIZARD_STEPS: readonly WizardStep[] = [
  {
    id: 'import',
    label: 'Import',
    title: 'Import from your resume',
    description: 'Start from a resume: TailorIT fills every empty field it can, and you check them in the next steps.',
    places: [],
  },
  {
    id: 'personal',
    label: 'Personal',
    title: 'Personal & contact',
    description: 'Your name, how employers reach you, and your links.',
    places: ['profile.name', 'profile.contact', 'profile.links'],
  },
  {
    id: 'education',
    label: 'Education',
    title: 'Education',
    description: 'Your schools and degrees, for forms that ask about each one.',
    places: ['profile.education'],
  },
  {
    id: 'experience',
    label: 'Experience',
    title: 'Experience',
    description: 'Your jobs, for forms that ask about each one.',
    places: ['profile.experience'],
  },
  {
    id: 'skills',
    label: 'Skills',
    title: 'Skills, languages & certifications',
    description: 'What you can do and the languages you speak.',
    places: ['profile.languages', 'profile.skills', 'profile.certifications'],
  },
  {
    id: 'authorization',
    label: 'Authorization',
    title: 'Work authorization & self-identification',
    description: 'Answered once here, never guessed and never sent to AI.',
    places: ['sensitive.workAuthorization', 'sensitive.eeo'],
  },
  {
    id: 'questions',
    label: 'Questions',
    title: 'Questions & preferences',
    description: 'Answers many forms ask for in the same words, screening questions, and a note for the AI.',
    places: ['profile.preferences', 'sensitive.legal', 'sensitive.compensation', 'profile.anythingElse'],
  },
  {
    id: 'documents',
    label: 'Documents',
    title: 'Documents & templates',
    description: 'The resume the extension attaches, and the templates tailoring writes on.',
    places: ['profile.documents'],
  },
  {
    id: 'review',
    label: 'Review',
    title: 'Review your profile',
    description: 'Everything the extension fills applications with. Edit any part.',
    places: [],
  },
];

const BY_ID = new Map(WIZARD_STEPS.map((step) => [step.id, step]));

export function wizardStep(id: WizardStepId): WizardStep {
  return BY_ID.get(id)!;
}

export function isWizardStepId(value: unknown): value is WizardStepId {
  return typeof value === 'string' && BY_ID.has(value as WizardStepId);
}

export function stepIndex(id: WizardStepId): number {
  return WIZARD_STEP_IDS.indexOf(id);
}

/** The step `delta` away, or null past either end. */
export function neighbourStep(id: WizardStepId, delta: -1 | 1): WizardStepId | null {
  return WIZARD_STEP_IDS[stepIndex(id) + delta] ?? null;
}

/**
 * The step the address names (`&step=`), else where a visit starts: the import for a profile never saved, the
 * Review (the profile at a glance) for one already saved.
 */
export function readWizardStep(value: string | null, revision: number): WizardStepId {
  if (isWizardStepId(value)) return value;
  return revision === 0 ? 'import' : 'review';
}

/** The step that edits a place ("profile.education.0.endDate", or a field key); null for none (a whole part). */
export function stepOfPlace(place: string): WizardStepId | null {
  for (const step of WIZARD_STEPS) {
    if (step.places.some((prefix) => isWithin(place, prefix))) return step.id;
  }
  return null;
}

/** The messages of the places a step edits. */
export function messagesIn(step: WizardStepId, messages: Readonly<Record<string, string>>): Record<string, string> {
  const own: Record<string, string> = {};
  for (const [place, message] of Object.entries(messages)) if (stepOfPlace(place) === step) own[place] = message;
  return own;
}

/**
 * The messages of a step and of the steps before it (already passed through): Next shows these, so a refusal on one
 * step keeps an earlier step's messages, and the steps not reached yet are checked when they are.
 */
export function messagesUpTo(step: WizardStepId, messages: Readonly<Record<string, string>>): Record<string, string> {
  const last = stepIndex(step);
  const shown: Record<string, string> = {};
  for (const [place, message] of Object.entries(messages)) {
    const owner = stepOfPlace(place);
    if (owner !== null && stepIndex(owner) <= last) shown[place] = message;
  }
  return shown;
}

/**
 * The steps that hold a message, in the wizard's order. A place no step edits counts for the Review, where the whole
 * profile is.
 */
export function stepsWithMessages(places: Iterable<string>): WizardStepId[] {
  const found = new Set<WizardStepId>();
  for (const place of places) found.add(stepOfPlace(place) ?? 'review');
  return WIZARD_STEP_IDS.filter((id) => found.has(id));
}

/** Where an "Answer these once" link's card is. */
export function stepOfSection(section: string): WizardStepId | null {
  switch (section) {
    case ONCE_SECTIONS.workAuthorization:
    case ONCE_SECTIONS.selfIdentification:
      return 'authorization';
    case ONCE_SECTIONS.otherQuestions:
    case ONCE_SECTIONS.screening:
      return 'questions';
    default:
      return null;
  }
}

/**
 * What moving on from a step does, given the checks of the whole draft (`messages`, by place):
 * - `fix-here`: this step has fields that need a change; their messages show and the step stays;
 * - `move`: nothing changed, so nothing is saved;
 * - `save`: the draft is saved with the profile's revision, then the wizard moves;
 * - `move-unsaved`: only a later step needs a change: the wizard moves on and the draft waits, unsaved, for it;
 * - `fix-elsewhere`: an earlier step needs a change before anything can be saved.
 */
export type WizardAdvance =
  | { kind: 'fix-here' }
  | { kind: 'move'; to: WizardStepId }
  | { kind: 'save'; to: WizardStepId }
  | { kind: 'move-unsaved'; to: WizardStepId; waitingFor: WizardStepId[] }
  | { kind: 'fix-elsewhere'; steps: WizardStepId[] };

export function planAdvance(input: {
  from: WizardStepId;
  to: WizardStepId;
  dirty: boolean;
  messages: Readonly<Record<string, string>>;
}): WizardAdvance {
  const { from, to, dirty, messages } = input;
  if (Object.keys(messagesIn(from, messages)).length > 0) return { kind: 'fix-here' };
  if (!dirty) return { kind: 'move', to };
  const steps = stepsWithMessages(Object.keys(messages));
  if (steps.length === 0) return { kind: 'save', to };
  if (steps.every((step) => stepIndex(step) > stepIndex(from))) return { kind: 'move-unsaved', to, waitingFor: steps };
  return { kind: 'fix-elsewhere', steps };
}

/** What "Save & exit" (and the Review's Save changes) does: the whole draft is checked, wherever its fields are. */
export type WizardSave = { kind: 'fix-here' } | { kind: 'fix-elsewhere'; steps: WizardStepId[] } | { kind: 'save' } | { kind: 'nothing' };

export function planSave(input: {
  from: WizardStepId;
  dirty: boolean;
  messages: Readonly<Record<string, string>>;
}): WizardSave {
  const { from, dirty, messages } = input;
  if (Object.keys(messages).length > 0) {
    if (Object.keys(messagesIn(from, messages)).length > 0) return { kind: 'fix-here' };
    return { kind: 'fix-elsewhere', steps: stepsWithMessages(Object.keys(messages)) };
  }
  return dirty ? { kind: 'save' } : { kind: 'nothing' };
}

// ---------------------------------------------------------------------------------------------------------------------
// The Review step: each step as a few lines, and whether it holds anything yet.

export interface StepSummary {
  /** Something is filled in (the stepper's check). */
  filled: boolean;
  /** What the Review says of the step: a few lines; none when nothing is filled in. */
  lines: string[];
}

/** What the Review needs beyond the draft: how to name the chosen resume and templates. */
export interface SummaryNames {
  resume?: (id: string) => string | null;
  resumeTemplate?: (id: string) => string | null;
  letterTemplate?: (id: string) => string | null;
}

const MAX_LISTED = 3;
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2021-09" as "Sep 2021", "2021" as itself. */
function monthYear(value: string | null): string {
  if (!value) return '';
  const match = /^(\d{4})(?:-(\d{2}))?$/.exec(value);
  if (!match) return value;
  const month = match[2] ? MONTH_NAMES[Number(match[2]) - 1] : undefined;
  return month ? `${month} ${match[1]}` : match[1]!;
}

/** "Sep 2019 - Jun 2023", "Sep 2019 - now", "" without dates. */
export function periodText(start: string | null, end: string | null, current: boolean): string {
  const from = monthYear(start);
  const to = current ? 'now' : monthYear(end);
  if (!from && !to) return '';
  if (!to) return from;
  return `${from || '?'} - ${to}`;
}

/** The first three, then "and 2 more". */
function listed(items: readonly string[]): string[] {
  if (items.length <= MAX_LISTED) return [...items];
  return [...items.slice(0, MAX_LISTED), `and ${items.length - MAX_LISTED} more`];
}

const joined = (...parts: Array<string | null | undefined | false>) => parts.filter(Boolean).join(' · ');
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function personal(draft: AutofillDraft): StepSummary {
  const { name, contact, links } = draft.profile;
  const fullName = [name.first, name.middle, name.last, name.suffix].map((part) => part.trim()).filter(Boolean).join(' ');
  const address = contact.address;
  const place = [address.city.trim(), address.region.trim(), address.country ? countryDisplayName(address.country) : '']
    .filter(Boolean)
    .join(', ');
  const linkNames = [
    links.linkedin && 'LinkedIn',
    links.github && 'GitHub',
    links.portfolio && 'Portfolio',
    links.website && 'Website',
    links.x && 'X',
    links.telegram && 'Telegram',
    ...links.other.filter((link) => link.url).map((link) => link.label || 'Another link'),
  ].filter((value): value is string => Boolean(value));
  const lines = [
    fullName && (name.preferred.trim() ? `${fullName} (goes by ${name.preferred.trim()})` : fullName),
    joined(contact.email.trim(), contact.phone.number.trim()),
    place,
    linkNames.length > 0 ? `Links: ${linkNames.join(', ')}` : '',
  ].filter(Boolean);
  return { filled: Boolean(name.first.trim() && name.last.trim()), lines };
}

function education(draft: AutofillDraft): StepSummary {
  const list = draft.profile.education;
  const lines = list.map((entry) => {
    const degree = [entry.degree.type.trim() || DEGREE_LEVEL_LABEL[entry.degree.level], entry.degree.field.trim()]
      .filter(Boolean)
      .join(', ');
    const school = entry.institution.canonicalName.trim() || 'A school';
    return joined(`${school}: ${degree}`, periodText(entry.startDate, entry.endDate, entry.current));
  });
  return { filled: list.length > 0, lines: listed(lines) };
}

function experience(draft: AutofillDraft): StepSummary {
  const list = draft.profile.experience;
  const lines = list.map((entry) => {
    const role = [entry.title.trim(), entry.company.trim()].filter(Boolean).join(' at ') || 'A job';
    return joined(role, periodText(entry.startDate, entry.endDate, entry.current));
  });
  return { filled: list.length > 0, lines: listed(lines) };
}

function skills(draft: AutofillDraft): StepSummary {
  const { languages, skills: list, certifications } = draft.profile;
  const spoken = languages
    .filter((row) => row.language.trim())
    .map((row) => (row.proficiency ? `${row.language.trim()} (${LANGUAGE_PROFICIENCY_LABEL[row.proficiency]})` : row.language.trim()));
  const named = list.filter((skill) => skill.trim());
  const certs = certifications.filter((row) => row.name.trim());
  const lines = [
    spoken.length > 0 ? `Languages: ${spoken.join(', ')}` : '',
    named.length > 0 ? `${plural(named.length, 'skill', 'skills')}: ${listed(named).join(', ')}` : '',
    certs.length > 0 ? `${plural(certs.length, 'certification', 'certifications')}: ${listed(certs.map((row) => row.name.trim())).join(', ')}` : '',
  ].filter(Boolean);
  return { filled: lines.length > 0, lines };
}

function authorization(draft: AutofillDraft): StepSummary {
  const { workAuthorization, eeo } = draft.sensitive;
  const countries = workAuthorization.map((row) => countryDisplayName(row.country));
  const eeoAnswers = [eeo.gender, eeo.hispanicOrLatino, eeo.races, eeo.veteran, eeo.disability];
  const given = eeoAnswers.filter((answer) => answer.state !== 'not_provided').length;
  const lines = [
    countries.length > 0 ? `Work authorization for ${countries.join(', ')}` : '',
    given > 0 ? `Equal opportunity: ${given} of ${eeoAnswers.length} answered` : '',
  ].filter(Boolean);
  return { filled: lines.length > 0, lines };
}

function questions(draft: AutofillDraft): StepSummary {
  const { preferences, anythingElse } = draft.profile;
  const { legal, compensation } = draft.sensitive;
  const legalAnswers = [
    legal.atLeast18,
    legal.criminalRecord,
    legal.restrictiveAgreement,
    legal.essentialFunctions,
    legal.governmentService,
    legal.relativesAt,
    legal.clearance,
    legal.citizenships,
  ];
  const answered = legalAnswers.filter((answer) => answer.state !== 'not_provided').length;
  const facts = [
    preferences.earliestStartDate && `Earliest start ${preferences.earliestStartDate}`,
    preferences.noticePeriodWeeks !== null && `${plural(preferences.noticePeriodWeeks, 'week', 'weeks')}' notice`,
    preferences.willingToRelocate && (preferences.willingToRelocate === 'yes' ? 'Willing to relocate' : 'Not relocating'),
    compensation.expectedSalary.state === 'value' && 'Expected salary given',
  ].filter((value): value is string => Boolean(value));
  const lines = [
    facts.join(' · '),
    answered > 0 ? `Legal and screening questions: ${answered} of ${legalAnswers.length} answered` : '',
    anythingElse.trim() ? `A note for the AI (${plural(anythingElse.trim().length, 'character', 'characters')})` : '',
  ].filter(Boolean);
  return { filled: lines.length > 0, lines };
}

/** The documents step's choices: the resume to attach, and the templates tailoring writes on (decision 18). */
function documents(draft: AutofillDraft, names: SummaryNames): StepSummary {
  const chosen = draft.profile.documents;
  const resume = chosen.resumeId ? (names.resume?.(chosen.resumeId) ?? 'A resume that was deleted') : 'Best match for each job';
  const resumeTemplate = chosen.resumeTemplateId
    ? (names.resumeTemplate?.(chosen.resumeTemplateId) ?? 'A template no longer offered')
    : "The resume's own template";
  const letterTemplate = chosen.coverLetterTemplateId
    ? (names.letterTemplate?.(chosen.coverLetterTemplateId) ?? 'A template')
    : 'No template';
  return {
    filled: chosen.resumeId !== null || chosen.resumeTemplateId !== null || chosen.coverLetterTemplateId !== null,
    lines: [`Resume to attach: ${resume}`, `Resume template: ${resumeTemplate}`, `Cover letter template: ${letterTemplate}`],
  };
}

/** What the Review says of a step, and whether it holds anything. The import and the Review itself hold nothing. */
export function stepSummary(step: WizardStepId, draft: AutofillDraft, names: SummaryNames = {}): StepSummary {
  switch (step) {
    case 'personal':
      return personal(draft);
    case 'education':
      return education(draft);
    case 'experience':
      return experience(draft);
    case 'skills':
      return skills(draft);
    case 'authorization':
      return authorization(draft);
    case 'questions':
      return questions(draft);
    case 'documents':
      return documents(draft, names);
    case 'import':
      return { filled: personal(draft).filled || education(draft).filled || experience(draft).filled, lines: [] };
    case 'review':
      return { filled: false, lines: [] };
  }
}

/** "Answer these once" in a line: "5 of 9 answered". */
export function onceLine(draft: AutofillDraft): string {
  const items = onceChecklist(draft);
  const answered = items.filter((item) => item.state !== 'not_provided').length;
  return `${answered} of ${items.length} answered`;
}

/** "Education", "Education and Experience", "Personal, Education and Experience": the steps a notice names. */
export function stepNames(steps: readonly WizardStepId[]): string {
  const names = steps.map((id) => wizardStep(id).title);
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
