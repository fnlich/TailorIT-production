import {
  analyzeResumeText,
  CA_PROVINCES,
  documentPlainText,
  languageLevelOf,
  parseLocations,
  parsePeriod,
  parseSingleDate,
  printedDocument,
  US_STATES,
  type DatePart,
  type ParsedLocation,
  type Period,
  type ProfileSeedView,
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
  type AutofillCertification,
  type AutofillProfile,
} from '@tailorit/shared/autofill';
import { constantsOf } from '../../../core/constants/service';
import type { AppDeps, SessionUser } from '../../../core/context';
import { capUtf16 } from '../../../core/files/index';
import { notFound } from '../../../core/http/errors';
import { getPreferences } from '../../me/preferences';
import { uploadReadingOf } from '../../resumes/ai/uploadReading';
import { skillLists } from '../../resumes/analysis/store';
import { getResumeEvidence } from '../../resumes/evidence';
import { RESUME_NOT_FOUND } from '../../resumes/repository';
import { readableForImport } from '../../resumes/upload';
import { nameOf, parseDegreeText, parseGpa, splitPersonName } from './resume-text';
import { contactInText, groundedReading } from './upload-text';

// "Fill from my resume" (GET /api/autofill/profile/seed): a whole autofill profile made from one resume, the account
// and the job preferences, which the Settings page merges into its empty fields only. It writes nothing, and nothing
// sensitive is ever seeded (min_salary is a job filter, not an expectation). A built resume is read as it prints
// (printedDocument, then its words: documentPlainText), so a hidden field, a switched-off section or a contact detail
// hidden on the resume seeds nothing from it.
// v3.2 FILL: an upload (TailorIT keeps its text, not its structure) is read from the AI's reading of its text
// (resumes/ai/uploadReading.ts, which POST /profile/seed starts), kept only where the text says it (groundedReading);
// until there is one, or without AI, from the contact details its text shows (contactInText). Either way the file's
// own details come before the account's and the preferences'. Certifications are seeded too, and a degree still in
// progress ("Expected May 2027") is a current one with its expected graduation as its end date.
// v32 FIX-API (REV-SECBEH SF-1): a seed from the AI's reading always says to check it (MSG_AUTOFILL_SEED_AI_CHECK), and
// names the paths the reading filled (`fromAi`: the page marks each "AI read, check it").

const NAME_NOTE = 'Check how your name was split.';
const NAME_CUT_NOTE = 'Check your name: what was written beside it was left out.';
const PHONE_NOTE = 'Check your phone number: it could not be read, so it was left empty.';
const REGION_NOTE = 'Check your state or province: it could not be read, so it was left empty.';
// v32 FILL: an upload's notes.
const UNREADABLE_NOTE = "This file's text could not be read (it may be a scan), so only your contact details were filled.";
const TEXT_ONLY_NOTE = 'Only the contact details in this file were filled.';
const DROPPED_NOTE = 'Some details the AI read are not in your file, so they were left out.';

const EDUCATION_MAX = 10;
const EXPERIENCE_MAX = 30;
const LANGUAGES_MAX = 20;
const SKILLS_MAX = 200;
const DESCRIPTION_MAX = 4000;
const CERTIFICATIONS_MAX = 20;

const EmailSchema = AutofillProfileSchema.shape.contact.shape.email;
const EntryIdSchema = AutofillEducationSchema.shape.id;

/** Text on one line, trimmed and cut to `max` characters (never between the halves of a surrogate pair). */
function fit(text: string | null | undefined, max: number): string {
  return capUtf16((text ?? '').replace(/\s+/g, ' ').trim(), max).trim();
}

/** A candidate value: its text, and whether it is the account's or the preferences' rather than the resume's. */
interface Candidate {
  text: string | null | undefined;
  settings?: boolean;
}

/**
 * The first candidate `read` makes something of ('' when none does), whether it was the settings', and (v32 FIX-API)
 * which candidate it was (-1 for none).
 */
function firstRead(candidates: readonly Candidate[], read: (text: string) => string): { value: string; settings: boolean; index: number } {
  for (const [index, candidate] of candidates.entries()) {
    const value = read((candidate.text ?? '').trim());
    if (value) return { value, settings: candidate.settings === true, index };
  }
  return { value: '', settings: false, index: -1 };
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

/** v32 FILL: the year in a date the period could not read ("Summer 2010", "Fall 2018"). */
function yearIn(text: string | undefined): DatePart | undefined {
  const year = /(?<!\d)(?:19|20)\d{2}(?!\d)/.exec(text ?? '')?.[0];
  return year ? { y: Number(year) } : undefined;
}

/** v32 FILL: words that make a school's end date an expected one ("Expected May 2027", "May 2027 (expected)"). */
const EXPECTED = /\(?\b(?:expected(?:\s+graduation)?|anticipated|graduating)\b\)?:?/gi;

/**
 * An entry's dates: its picked period, else its text read as one; "Present" (ongoing) leaves no end date. v32 FILL: a
 * date written with a season keeps its year, and at a school (`school`) an expected graduation is the end date of a
 * degree still in progress (`current`).
 */
function datesOf(
  entry: { startDate: string; endDate: string; period?: Period },
  school = false,
): { startDate: string | null; endDate: string | null; current: boolean } {
  const period = entry.period ?? parsePeriod(entry.startDate, entry.endDate);
  const startDate = yearMonth(period.from ?? yearIn(period.raw?.start));
  if (period.ongoing === true) return { startDate, endDate: null, current: true };
  const rawEnd = period.raw?.end;
  if (school && rawEnd && rawEnd.search(EXPECTED) >= 0) {
    const date = rawEnd.replace(EXPECTED, ' ').replace(/\s+/g, ' ').trim();
    return { startDate, endDate: yearMonth(parsePeriod(date, '').from ?? yearIn(date)), current: true };
  }
  return { startDate, endDate: yearMonth(period.to ?? yearIn(rawEnd)), current: false };
}

/** The resume entry's own id when the profile can keep it and it is not taken, else "<list>-<n>". */
function entryId(wanted: string | undefined, list: string, used: Set<string>): string {
  let id = wanted && EntryIdSchema.safeParse(wanted).success && !used.has(wanted) ? wanted : '';
  for (let n = used.size + 1; !id || used.has(id); n += 1) id = `${list}-${n}`;
  used.add(id);
  return id;
}

const entries = (count: number, one: string, many: string) => `${count === 1 ? 'One' : count} ${count === 1 ? one : many}`;

/** v32 FILL: whether a "2027" or "2027-05" end is after `now`'s month: a school's expected graduation. */
function isAfter(end: string | null, now: Date): boolean {
  if (!end) return false;
  const [year, month] = end.split('-').map(Number);
  const nowYear = now.getUTCFullYear();
  return year! > nowYear || (year === nowYear && month !== undefined && month > now.getUTCMonth() + 1);
}

function educationOf(document: ResumeDocument, notes: string[], now: Date): AutofillEducation[] {
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
    // v32 FILL: an end still to come is an expected graduation, however it is written ("05/2027").
    const dates = datesOf(entry, true);
    if (isAfter(dates.endDate, now)) dates.current = true;
    if (gpa?.assumedScale) notes.push(`Check the GPA at ${institution}: it was read on a scale of 4.`);
    education.push({
      id: entryId(entry.id, 'education', used),
      institution: { canonicalName: institution, aliases: [] },
      degree: { level: degree.level, type: fit(degree.type, 40), field: fit(degree.field, 150) },
      minor: '',
      ...dates,
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

/** v32 FILL: the resume's certifications: the name, who issued it and its year (all the profile keeps of one). */
function certificationsOf(document: ResumeDocument): AutofillCertification[] {
  const seen = new Set<string>();
  const certifications: AutofillCertification[] = [];
  for (const entry of document.certifications ?? []) {
    const name = fit(entry.name, 150);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const year = parseSingleDate(entry.date ?? '').y ?? yearIn(entry.date)?.y ?? null;
    certifications.push({
      name,
      issuer: fit(entry.issuer, 150),
      year: year !== null && year >= 1950 && year <= 2100 ? year : null,
    });
    if (certifications.length === CERTIFICATIONS_MAX) break;
  }
  return certifications;
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

/** v32 FILL: what a seed is asked with. */
export interface SeedOptions {
  /** Why the AI cannot read the upload now (POST /profile/seed's refusal): a note, after what was filled. */
  unread?: { code: string; message: string };
}

/** The paths under `prefix` in `paths` ("contact.phone" names "contact.phone.number"...). */
const under = (paths: readonly string[], prefix: string) => paths.filter((path) => path === prefix || path.startsWith(`${prefix}.`));

/**
 * The seed from `resumeId` (404 when it is not one of the account's), else from the default resume, else from the
 * latest; with no resume at all, from the account and the preferences only (`source` null). Writes nothing.
 */
export async function seedAutofillProfile(
  deps: AppDeps,
  user: SessionUser,
  resumeId?: string,
  options: SeedOptions = {},
): Promise<ProfileSeedView> {
  const evidence = await getResumeEvidence(deps, user.id, resumeId ?? null);
  if (resumeId && !evidence) throw notFound(RESUME_NOT_FOUND);
  const preferences = await getPreferences(deps, user.id);
  const notes: string[] = [];
  const profile = structuredClone(EMPTY_AUTOFILL_PROFILE);
  // The prefixes of what came from the account or the preferences, not the resume.
  const settings: string[] = [];

  // v32 FILL: an upload's words: what its text shows, and the AI's reading of it (when there is one), kept where the
  // text says it.
  const upload = evidence?.kind === 'uploaded' ? evidence.text : null;
  const readable = upload !== null && readableForImport(upload);
  const shown = readable ? contactInText(upload) : null;
  let document: ResumeDocument | null = evidence?.document ? documentPlainText(printedDocument(evidence.document)) : null;
  let dropped = 0;
  // v32 FIX-API (SF-1): the prefixes of what the AI's reading of an upload filled.
  const ai: string[] = [];
  const reading = readable ? await uploadReadingOf(deps, user.id, upload) : null;
  const aiRead = reading?.kind === 'read';
  if (reading?.kind === 'read') ({ document, dropped } = groundedReading(documentPlainText(reading.document), upload!));

  // What is written beside the name (pronouns, "| US Citizen") is left out before the name is split. An upload's name
  // is the reading's, else the one its first line shows, else the account's.
  const uploadName = upload === null ? '' : document?.name || (readable ? (analyzeResumeText(upload, skillLists()).personName ?? '') : '');
  const ownName = upload === null ? (evidence?.document?.name ?? '').trim() : uploadName;
  const written = nameOf(ownName || user.name);
  if (!ownName) settings.push('name');
  else if (aiRead && document?.name) ai.push('name');
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

  // The resume's detail first (one it hides is empty), then what an upload's text shows, then the account's sign-in
  // address and the job preferences.
  const contact = document?.contact;
  const email = firstRead([{ text: contact?.email }, { text: shown?.email }, { text: user.email, settings: true }], readEmail);
  profile.contact.email = email.value;
  if (email.settings) settings.push('contact.email');
  if (aiRead && email.index === 0) ai.push('contact.email');
  const location = firstRead(
    [{ text: contact?.location }, { text: shown?.location }, { text: preferences.location, settings: true }],
    (text) => text,
  );
  const place = placeOf(location.value, notes);
  profile.contact.address = { ...profile.contact.address, ...place };
  if (location.settings) settings.push('contact.address');
  if (aiRead && location.index === 0) ai.push('contact.address');
  const phoneTexts = [
    { text: contact?.phone, settings: false },
    { text: shown?.phone, settings: false },
    { text: preferences.phone, settings: true },
  ].filter((candidate) => (candidate.text ?? '').trim());
  const phone = phoneTexts
    .map((candidate) => ({ read: readPhone((candidate.text ?? '').trim()), settings: candidate.settings, ai: candidate.text === contact?.phone }))
    .find((found) => found.read !== null);
  if (phone?.read) {
    profile.contact.phone = { ...profile.contact.phone, number: phone.read.number, country: place.country, extension: phone.read.extension };
    if (phone.settings) settings.push('contact.phone');
    if (aiRead && phone.ai) ai.push('contact.phone');
  } else if (phoneTexts.length > 0) notes.push(PHONE_NOTE);
  const linkedin = firstRead([{ text: contact?.linkedin }, { text: shown?.linkedin }, { text: preferences.linkedinUrl, settings: true }], readLink);
  profile.links.linkedin = linkedin.value;
  if (linkedin.settings) settings.push('links.linkedin');
  if (aiRead && linkedin.index === 0) ai.push('links.linkedin');
  const github = firstRead([{ text: contact?.github }, { text: shown?.github }], readLink);
  profile.links.github = github.value;
  if (aiRead && github.index === 0) ai.push('links.github');
  const portfolio = firstRead([{ text: contact?.portfolio }, { text: shown?.portfolio }, { text: preferences.portfolioUrl, settings: true }], readLink);
  profile.links.portfolio = portfolio.value;
  if (portfolio.settings) settings.push('links.portfolio');
  if (aiRead && portfolio.index === 0) ai.push('links.portfolio');

  if (document) {
    profile.education = educationOf(document, notes, deps.now());
    profile.experience = experienceOf(document, notes);
    profile.languages = languagesOf(document);
    profile.skills = skillsOf(document);
    profile.certifications = certificationsOf(document);
    if (aiRead) ai.push('education', 'experience', 'languages', 'skills', 'certifications');
  } else if (upload !== null) {
    // v32 FIX-API (SF-2): a file the AI found no resume in says so (it is not read again).
    const why = reading?.kind === 'empty' ? constantsOf(deps).message('MSG_AUTOFILL_SEED_NO_RESUME_IN_FILE') : options.unread?.message;
    notes.push(readable ? (why ? `${TEXT_ONLY_NOTE} ${why}` : TEXT_ONLY_NOTE) : UNREADABLE_NOTE);
  }
  if (dropped > 0) notes.push(DROPPED_NOTE);
  // v32 FIX-API (SF-1): what the AI read is checked by the person, always (the filter keeps only what the file says, not
  // what it means).
  if (aiRead && document) notes.push(constantsOf(deps).message('MSG_AUTOFILL_SEED_AI_CHECK'));
  profile.preferences.workArrangements = WORK_ARRANGEMENTS.filter((arrangement) =>
    preferences.workArrangements.includes(arrangement),
  );
  settings.push('preferences');

  // v2.0: Prepare & Queue's cover-letter mode (API 8's documents.coverLetters) is a setting, never a value the seed
  // filled: the page keeps the person's own (COVER_LETTER_MODE_DEFAULT before they choose one).
  const filled = filledPaths(profile, '').filter((path) => path !== 'documents.coverLetters');
  return {
    source: evidence ? { resumeId: evidence.resumeId, label: evidence.label, kind: evidence.kind } : null,
    profile,
    filled,
    notes,
    fromSettings: settings.flatMap((prefix) => under(filled, prefix)),
    fromAi: ai.flatMap((prefix) => under(filled, prefix)),
    unread: upload !== null && readable && !document ? (options.unread ?? null) : null,
  };
}
