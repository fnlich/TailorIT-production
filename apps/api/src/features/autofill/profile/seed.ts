import {
  CA_PROVINCES,
  documentPlainText,
  languageLevelOf,
  parseLocations,
  parsePeriod,
  printedDocument,
  US_STATES,
  type ParsedLocation,
  type Period,
  type ResumeDocument,
} from '@tailorit/shared';
import {
  AutofillEducationSchema,
  AutofillProfileSchema,
  CountryCodeSchema,
  EMPTY_AUTOFILL_PROFILE,
  LANGUAGE_PROFICIENCIES,
  WebUrlSchema,
  WORK_ARRANGEMENTS,
  type AutofillEducation,
  type AutofillExperience,
  type AutofillPlace,
  type AutofillProfile,
  type AutofillSeed,
} from '@tailorit/shared/autofill';
import type { AppDeps, SessionUser } from '../../../core/context';
import { capUtf16 } from '../../../core/files/index';
import { notFound } from '../../../core/http/errors';
import { getPreferences } from '../../me/preferences';
import { getResumeEvidence } from '../../resumes/evidence';
import { RESUME_NOT_FOUND } from '../../resumes/repository';
import { nameOf, parseDegreeText, parseGpa, splitPersonName } from './resume-text';

// "Fill from my resume" (GET /api/autofill/profile/seed): a whole autofill profile made from one resume, the account
// and the job preferences, which the Settings page merges into its empty fields only. It writes nothing, and nothing
// sensitive is ever seeded (min_salary is a job filter, not an expectation). A built resume is read as it prints
// (printedDocument, then its words: documentPlainText), so a hidden field, a switched-off section or a contact detail
// hidden on the resume seeds nothing from it; an upload has no structure TailorIT keeps, so it seeds contact details
// and links only, from the account and the preferences.

const NAME_NOTE = 'Check how your name was split.';
const NAME_CUT_NOTE = 'Check your name: what was written beside it was left out.';
const IMPORT_NOTE = 'Import this resume into the editor to fill in education and experience.';
const PHONE_NOTE = 'Check your phone number: it could not be read, so it was left empty.';
const REGION_NOTE = 'Check your state or province: it could not be read, so it was left empty.';

const EDUCATION_MAX = 10;
const EXPERIENCE_MAX = 30;
const LANGUAGES_MAX = 20;
const SKILLS_MAX = 200;
const DESCRIPTION_MAX = 4000;

const EmailSchema = AutofillProfileSchema.shape.contact.shape.email;
const EntryIdSchema = AutofillEducationSchema.shape.id;

/** Text on one line, trimmed and cut to `max` characters (never between the halves of a surrogate pair). */
function fit(text: string | null | undefined, max: number): string {
  return capUtf16((text ?? '').replace(/\s+/g, ' ').trim(), max).trim();
}

/** The first candidate `read` makes something of ('' when none does). */
function firstRead(candidates: ReadonlyArray<string | null | undefined>, read: (text: string) => string): string {
  for (const candidate of candidates) {
    const value = read((candidate ?? '').trim());
    if (value) return value;
  }
  return '';
}

/**
 * An address the contract's email rule takes, else '': sign-in takes some it refuses ("jane&co@example.com"), and an
 * answer must parse as the contract says. GET /profile fills an empty email through this too.
 */
export const readEmail = (text: string) => (text && EmailSchema.safeParse(text).success ? text : '');

/** A host and maybe a path, written without a scheme ("linkedin.com/in/x"). */
const BARE_LINK = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/?#]|$)/i;

/** A link as the profile keeps one: http(s), at most 300 characters; "linkedin.com/in/x" gets https://. */
function readLink(text: string): string {
  if (!text || /\s/.test(text)) return '';
  const link = /^https?:\/\//i.test(text) ? text : BARE_LINK.test(text) ? `https://${text}` : '';
  return link && WebUrlSchema.safeParse(link).success ? link : '';
}

const PHONE = /^[0-9+().\s-]*\d[0-9+().\s-]*$/;

/**
 * "+1 (512) 555-0100 ext. 12" (or "#12") as a number and an extension, any label before it dropped ("Telephone:",
 * "Tel.:", "Ph:"); null when it is not a phone number the profile keeps.
 */
function readPhone(text: string): { number: string; extension: string } | null {
  const withExtension = /^(.*?)[\s,;]*(?:ext\.?|extension|x|#)\s*(\d{1,8})$/i.exec(text);
  const number = (withExtension ? withExtension[1]! : text)
    // The longer label first: "Telephone" is not "Tel" and "ephone".
    .replace(/^(?:telephone|phone|tel|mobile|cell|ph)\.?\s*:?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (number.length > 30 || !PHONE.test(number)) return null;
  return { number, extension: withExtension ? withExtension[2]! : '' };
}

/** A US ZIP code, a Canadian postal code or a UK postcode. */
const POSTAL_CODE = '(?:\\d{5}(?:-\\d{4})?|[A-Z]\\d[A-Z][ -]?\\d[A-Z]\\d|[A-Z]{1,2}\\d[A-Z\\d]? ?\\d[A-Z]{2})';
const ONLY_POSTAL_CODE = new RegExp(`^${POSTAL_CODE}$`, 'i');
/** A postal code after a space, ending its part ("TX 78701") or followed by more of it ("IL 60601 USA"). */
const POSTAL_CODE_IN_PART = new RegExp(`\\s+${POSTAL_CODE}(?:\\s+|$)`, 'i');
/** Outside North America, a code of digits before the city ("10115 Berlin", "1012 AB Amsterdam") or ending a part. */
const CODE_BEFORE_CITY = /^(?:\d{4} ?[A-Z]{2}|\d{4,5})\s+(?=\p{L})/u;
const CODE_ENDING_PART = /\s+\d{4,6}$/;
const ONLY_DIGITS_CODE = /^\d{4,6}$/;

/** Text the location reader reads as a country alone ("USA", "Canada"). */
function isCountry(text: string): boolean {
  const place = parseLocations(text)[0];
  return place !== undefined && !place.city && !place.region && place.countryCode !== null;
}

/**
 * Location text without its postal codes, which the location reader does not know ("New York, NY 10001" would be the
 * region "NY 10001"): a comma-separated part that is one goes, one ending a part is dropped, and one between a part
 * and a country becomes a comma ("Chicago, IL 60601 USA" is "Chicago, IL, USA"). Where the country is known and is
 * neither the US nor Canada, a code of digits goes too, before the city or ending a part ("10115 Berlin, Germany",
 * "Sydney NSW 2000, Australia", "Karnataka 560001"). Other numbers ("12345 Main St, Austin, TX") stay.
 */
function withoutPostalCodes(text: string): string {
  const country = parseLocations(text)[0]?.countryCode ?? null;
  const abroad = country !== null && country !== 'US' && country !== 'CA';
  return text
    .split(',')
    .map((part) => {
      const words = abroad ? part.trim().replace(CODE_BEFORE_CITY, '').replace(CODE_ENDING_PART, '') : part.trim();
      if (ONLY_POSTAL_CODE.test(words) || (abroad && ONLY_DIGITS_CODE.test(words))) return '';
      const code = POSTAL_CODE_IN_PART.exec(words);
      if (!code) return words;
      const before = words.slice(0, code.index);
      const after = words.slice(code.index + code[0].length);
      if (!after) return before;
      return isCountry(after) ? `${before}, ${after}` : words;
    })
    .filter(Boolean)
    .join(', ');
}

/** A state's or a province's name as compared: accents, case and punctuation aside ("Québec" is "quebec"). */
const foldName = (text: string) =>
  text.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^\p{L}]+/gu, ' ').trim();

type StateOrProvince = { code: string; country: 'US' | 'CA' };
const byName = (country: StateOrProvince['country'], names: Readonly<Record<string, string>>) =>
  Object.entries(names).map(([code, name]): [string, StateOrProvince] => [foldName(name), { code, country }]);
const BY_NAME = new Map([...byName('US', US_STATES), ...byName('CA', CA_PROVINCES)]);

/** A US state or a Canadian province by its code in capitals ("TX", "N.Y."; "in" is a word, not Indiana) or name. */
function stateOrProvince(text: string): StateOrProvince | null {
  const code = text.trim().replace(/\./g, '');
  if (/^[A-Z]{2}$/.test(code)) {
    if (Object.hasOwn(US_STATES, code)) return { code, country: 'US' };
    return Object.hasOwn(CA_PROVINCES, code) ? { code, country: 'CA' } : null;
  }
  return BY_NAME.get(foldName(text)) ?? null;
}

/** A region's words before a digit or a sign: "Texas" of "Texas: ...", "Karnataka" of "Karnataka 560001". */
const LEADING_WORDS = /^[\p{L}\p{M}.'’]+(?:(?:\s+|-)[\p{L}\p{M}.'’]+)*/u;

/**
 * A place's region as the profile keeps it. In the US and Canada, or where the country is not known, that is a state
 * or province code: the reader's, else the one its text starts with ("TX: Authorized to work in the US" is TX), so
 * nothing written after it is kept; with none, '' and `unread`, so a statement where the region would be ("Round Rock,
 * US Citizen") is never kept. In another country, its words before a digit or a sign ("Bavaria" of "Bavaria: EU
 * citizen"), and never the country again ("London, UK: ...").
 */
function regionOf(place: ParsedLocation | undefined): { region: string; country: string | null; unread: boolean } {
  const region = place?.region ?? '';
  const country = place?.countryCode ?? null;
  if (!region) return { region, country, unread: false };
  const leading = LEADING_WORDS.exec(region)?.[0] ?? '';
  if (country !== null && country !== 'US' && country !== 'CA') {
    return { region: isCountry(leading) ? '' : leading, country, unread: false };
  }
  // The whole text, its words before a digit or sign, its first word ("ON" of "ON M5V").
  const found = [region, leading, /^\S*/.exec(region)![0]]
    .map(stateOrProvince)
    .find((read) => read !== null && (country === null || read.country === country));
  if (found) return { region: found.code, country: found.country, unread: false };
  return { region: '', country, unread: true };
}

/**
 * Where a place is: the shared location reader's first place, read once the postal codes are gone and with a dash
 * between spaces read as a comma ("Austin - Authorized to work in the US", "Austin - TX"), its region as regionOf
 * keeps it. A region it cannot read adds a note when `notes` is given (the contact address).
 */
function placeOf(text: string, notes?: string[]): AutofillPlace {
  const place = parseLocations(withoutPostalCodes(text.replace(/\s+[-–—]\s+/g, ', ')))[0];
  const { region, country, unread } = regionOf(place);
  if (unread) notes?.push(REGION_NOTE);
  return {
    city: fit(place?.city, 100),
    region: fit(region, 100),
    country: country !== null && CountryCodeSchema.safeParse(country).success ? country : null,
  };
}

/** "2021" or "2021-09". */
function yearMonth(part: { y: number; m?: number } | undefined): string | null {
  if (!part) return null;
  return part.m === undefined ? String(part.y) : `${part.y}-${String(part.m).padStart(2, '0')}`;
}

/** An entry's dates: its picked period, else its text read as one; "Present" (ongoing) leaves no end date. */
function datesOf(entry: { startDate: string; endDate: string; period?: Period }) {
  const period = entry.period ?? parsePeriod(entry.startDate, entry.endDate);
  const current = period.ongoing === true;
  return { startDate: yearMonth(period.from), endDate: current ? null : yearMonth(period.to), current };
}

/** The resume entry's own id when the profile can keep it and it is not taken, else "<list>-<n>". */
function entryId(wanted: string | undefined, list: string, used: Set<string>): string {
  let id = wanted && EntryIdSchema.safeParse(wanted).success && !used.has(wanted) ? wanted : '';
  for (let n = used.size + 1; !id || used.has(id); n += 1) id = `${list}-${n}`;
  used.add(id);
  return id;
}

const entries = (count: number, one: string, many: string) => `${count === 1 ? 'One' : count} ${count === 1 ? one : many}`;

function educationOf(document: ResumeDocument, notes: string[]): AutofillEducation[] {
  const used = new Set<string>();
  const education: AutofillEducation[] = [];
  let unnamed = 0;
  for (const entry of document.education) {
    const institution = fit(entry.institution, 200);
    if (!institution) {
      if (entry.degree.trim()) unnamed += 1;
      continue;
    }
    if (education.length === EDUCATION_MAX) break;
    const degree = parseDegreeText(entry.degree);
    if (degree.level === 'other' && degree.field) {
      notes.push(`Check the degree at ${institution}: its level could not be read.`);
    }
    const gpa = parseGpa(entry.gpa ?? '');
    if (gpa?.assumedScale) notes.push(`Check the GPA at ${institution}: it was read on a scale of 4.`);
    education.push({
      id: entryId(entry.id, 'education', used),
      institution: { canonicalName: institution, aliases: [] },
      degree: { level: degree.level, type: fit(degree.type, 40), field: fit(degree.field, 150) },
      minor: '',
      ...datesOf(entry),
      gpa: gpa ? { value: gpa.value, scale: gpa.scale } : null,
      location: placeOf(entry.location),
    });
  }
  if (unnamed > 0) {
    notes.push(`${entries(unnamed, 'degree', 'degrees')} without a school name ${unnamed === 1 ? 'was' : 'were'} left out.`);
  }
  return education;
}

/** A role's description, then its bullets one per line ("- ..."), at most 4000 characters, cut between lines. */
function descriptionOf(entry: { description: string; achievements: string[] }): string {
  const bullets = entry.achievements.map((bullet) => bullet.trim()).filter(Boolean);
  const lines = [entry.description.replace(/\r\n?/g, '\n').trim(), ...bullets.map((bullet) => `- ${bullet}`)];
  let text = '';
  for (const line of lines.filter(Boolean)) {
    const next = text ? `${text}\n${line}` : line;
    if (next.length > DESCRIPTION_MAX) {
      if (text) return text;
      const cut = capUtf16(line, DESCRIPTION_MAX);
      const space = cut.lastIndexOf(' ');
      return (space > 0 ? cut.slice(0, space) : cut).trim();
    }
    text = next;
  }
  return text;
}

function experienceOf(document: ResumeDocument, notes: string[]): AutofillExperience[] {
  const used = new Set<string>();
  const experience: AutofillExperience[] = [];
  let incomplete = 0;
  for (const entry of document.experience) {
    const company = fit(entry.company, 200);
    const title = fit(entry.title, 200);
    if (!company || !title) {
      if (company || title) incomplete += 1;
      continue;
    }
    if (experience.length === EXPERIENCE_MAX) break;
    experience.push({
      id: entryId(entry.id, 'experience', used),
      company,
      title,
      location: placeOf(entry.location),
      ...datesOf(entry),
      description: descriptionOf(entry),
    });
  }
  if (incomplete > 0) {
    const roles = entries(incomplete, 'role', 'roles');
    notes.push(`${roles} without both a company and a job title ${incomplete === 1 ? 'was' : 'were'} left out.`);
  }
  return experience;
}

/** The proficiency of a language: its dots (1 to 5), else the words of its label ("Fluent", "C1"). */
function languagesOf(document: ResumeDocument): AutofillProfile['languages'] {
  const languages: AutofillProfile['languages'] = [];
  for (const entry of document.languages ?? []) {
    const language = fit(entry.language, 60);
    if (!language) continue;
    const dots = entry.level !== undefined && entry.level >= 1 && entry.level <= 5 ? entry.level : null;
    const level = dots ?? languageLevelOf(entry.proficiency);
    languages.push({ language, proficiency: level === null ? null : LANGUAGE_PROFICIENCIES[level - 1]! });
    if (languages.length === LANGUAGES_MAX) break;
  }
  return languages;
}

function skillsOf(document: ResumeDocument): string[] {
  const seen = new Set<string>();
  const skills: string[] = [];
  for (const skill of document.skills) {
    const text = fit(skill, 80);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    skills.push(text);
    if (skills.length === SKILLS_MAX) break;
  }
  return skills;
}

/**
 * The paths of every value the seed filled ("name.first", "education.0.degree.level"): nothing empty ('', null, an
 * empty list, false), no entry ids, and a list of words as a whole ("skills").
 */
function filledPaths(value: unknown, path: string): string[] {
  if (value === null || value === undefined || value === '' || value === false) return [];
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    if (value.every((item) => typeof item !== 'object' || item === null)) return [path];
    return value.flatMap((item, index) => filledPaths(item, `${path}.${index}`));
  }
  if (typeof value === 'object') {
    return Object.entries(value).flatMap(([key, inner]) =>
      key === 'id' ? [] : filledPaths(inner, path ? `${path}.${key}` : key),
    );
  }
  return [path];
}

/**
 * The seed from `resumeId` (404 when it is not one of the account's), else from the default resume, else from the
 * latest; with no resume at all, from the account and the preferences only (`source` null). Writes nothing.
 */
export async function seedAutofillProfile(deps: AppDeps, user: SessionUser, resumeId?: string): Promise<AutofillSeed> {
  const evidence = await getResumeEvidence(deps, user.id, resumeId ?? null);
  if (resumeId && !evidence) throw notFound(RESUME_NOT_FOUND);
  const preferences = await getPreferences(deps, user.id);
  const document = evidence?.document ? documentPlainText(printedDocument(evidence.document)) : null;
  const notes: string[] = [];
  const profile = structuredClone(EMPTY_AUTOFILL_PROFILE);

  // What is written beside the name (pronouns, "| US Citizen") is left out before the name is split.
  const written = nameOf(evidence?.profile.name ?? user.name);
  const name = splitPersonName(written.name);
  profile.name = {
    first: fit(name.first, 100),
    middle: fit(name.middle, 100),
    last: fit(name.last, 100),
    suffix: fit(name.suffix, 20),
    preferred: '',
  };
  if (profile.name.first || profile.name.last) notes.push(NAME_NOTE);
  if (written.cut) notes.push(NAME_CUT_NOTE);

  // The resume's detail first (one it hides is empty), then the account's sign-in address and the job preferences.
  const contact = document?.contact;
  profile.contact.email = firstRead([contact?.email, user.email], readEmail);
  const place = placeOf(firstRead([contact?.location, preferences.location], (text) => text), notes);
  profile.contact.address = { ...profile.contact.address, ...place };
  const phoneTexts = [contact?.phone, preferences.phone].map((text) => (text ?? '').trim()).filter(Boolean);
  const phone = phoneTexts.map(readPhone).find((read) => read !== null);
  if (phone) profile.contact.phone = { ...profile.contact.phone, number: phone.number, country: place.country, extension: phone.extension };
  else if (phoneTexts.length > 0) notes.push(PHONE_NOTE);
  profile.links.linkedin = firstRead([contact?.linkedin, preferences.linkedinUrl], readLink);
  profile.links.github = firstRead([contact?.github], readLink);
  profile.links.portfolio = firstRead([contact?.portfolio, preferences.portfolioUrl], readLink);

  if (document) {
    profile.education = educationOf(document, notes);
    profile.experience = experienceOf(document, notes);
    profile.languages = languagesOf(document);
    profile.skills = skillsOf(document);
  } else if (evidence) {
    notes.push(IMPORT_NOTE);
  }
  profile.preferences.workArrangements = WORK_ARRANGEMENTS.filter((arrangement) =>
    preferences.workArrangements.includes(arrangement),
  );

  return {
    source: evidence ? { resumeId: evidence.resumeId, label: evidence.label, kind: evidence.kind } : null,
    profile,
    // v2.0: Prepare & Queue's cover-letter mode (API 8's documents.coverLetters) is a setting, never a value the
    // seed filled: the page keeps the person's own (COVER_LETTER_MODE_DEFAULT before they choose one).
    filled: filledPaths(profile, '').filter((path) => path !== 'documents.coverLetters'),
    notes,
  };
}
