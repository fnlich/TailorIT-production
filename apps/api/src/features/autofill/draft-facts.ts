import { documentPlainText, printedDocument, type ResumeDocument } from '@tailorit/shared';
import type { AutofillProfile, LanguageProficiency, WorkArrangement } from '@tailorit/shared/autofill';
import type { AppDeps } from '../../core/context';
import { getResumeEvidence } from '../resumes/evidence';
import {
  BARE_DOMAIN,
  digitsOf,
  EMAIL,
  holdsPostalAddress,
  isCodeName,
  isPhoneNumber,
  LINK,
  linkKey,
  namesForeignContact,
  NO_CONTACTS,
  PATHED_DOMAIN,
  PHONE_RUN,
  PRODUCT_ENDINGS,
  samePhone,
  type OwnContacts,
} from './ai/contacts';
import type { DraftFacts } from './ai/draft';
import { hasSensitiveLabel, statesSensitiveAnswer } from './ai/statements';
import { readAutofillProfile } from './profile/repository';

// What a draft or an answer may say about the person (work package AF, Phase 6; answers since v2 Phase D): the facts
// of their resume and of their autofill profile (work history, education, languages, skills and job preferences, and
// since autofill API version 3 the person's "Anything else we should know?" note, screened line by line the same way),
// read when an autofill_draft or autofill_answer task runs and handed to its handler (ai/draft.ts, ai/answer.ts), which
// cannot read the profile itself (autofill-ai.test.ts walks the AI modules' imports). Only the profile part is read,
// through readAutofillProfile: never the sensitive part, and never the saved answers. A resume may still hold a
// personal-details block the person wrote on it, so the facts leave out (the Phase 6 review, T6-2):
// - every line that states a sensitive answer (ai/statements.ts: a nationality, a visa, sponsorship, pronouns, a
//   gender, a religion, a birth date, a salary...), and every "label: value" line whose label names a sensitive topic
//   (the question screen's terms: "Nationality: ...", "Gender: ...", "Current salary: ...");
// - every line that holds a postal address (a street address, a postcode, the profile's own address);
// - the person's name, in any case, with a title or a suffix ("ADA LOVELACE, PhD", "Dr. Ada K. Lovelace",
//   "Lovelace, Ada"), and a line left with nothing else;
// - contact details: email addresses, links, phone numbers with or without separators, and the person's own, by value.
// The person's own links, email addresses and phone numbers are kept apart, for the check that a draft names no
// others; they never reach Claude.

/** The most text taken from a resume, before the prompt's own cap. */
const RESUME_MAX = 20_000;

/** What the facts leave out of every line: the person's names, contact details and home address. */
interface Personal {
  /** The name as a line may write it (namePatterns). */
  names: readonly RegExp[];
  contacts: OwnContacts;
  /** The profile's street line and postcode as words (nameKey); a postcode of digits alone only from five digits on,
   *  so "Grew to 1000 users" is no address. */
  address: readonly string[];
}

/** A text's words: letters and digits only, in lower case, one space between (names and addresses compare so). */
const nameKey = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** True when a line holds a postal address, or the profile's own street line or postcode as whole words. */
function holdsAddress(line: string, own: readonly string[]): boolean {
  if (holdsPostalAddress(line)) return true;
  const words = ` ${nameKey(line)} `;
  return own.some((value) => words.includes(` ${value} `));
}

/** What may stand between the words of a name: spaces, stops, commas, hyphens, apostrophes and quotes. */
const NAME_GAP = String.raw`[\s.,'\p{Pd}\p{Pi}\p{Pf}_]+`;

/** A name's words as a pattern, any gap between them. Its words are letters and digits only (nameKey). */
const wordsPattern = (name: string) => nameKey(name).split(' ').join(NAME_GAP);

/**
 * The person's name as a line may write it, in any case: the profile's first or preferred name and last name, with
 * or without a middle name or initial between them, last name first ("Lovelace, Ada"), and the account's name.
 */
function namePatterns(profile: AutofillProfile, account: { name: string }): RegExp[] {
  const { first, middle, last, preferred } = profile.name;
  const sources: string[] = [];
  const family = nameKey(last);
  for (const given of [first, preferred].map(nameKey)) {
    if (given === '' || family === '') continue;
    const between = String.raw`(?:${NAME_GAP}[\p{L}]{1,20})?`;
    sources.push(`${wordsPattern(given)}${between}${NAME_GAP}${wordsPattern(family)}`);
    sources.push(`${wordsPattern(family)}${NAME_GAP}${wordsPattern(given)}`);
  }
  if (nameKey(middle) !== '' && nameKey(first) !== '' && family !== '') {
    sources.push([first, middle, last].map(wordsPattern).join(NAME_GAP));
  }
  if (nameKey(account.name).includes(' ')) sources.push(wordsPattern(account.name));
  return sources.map((source) => new RegExp(String.raw`(?<![\p{L}\p{N}])${source}(?![\p{L}\p{N}])`, 'giu'));
}

/** The titles and suffixes a name is written with: a line left with these alone is the name's line. */
const NAME_TITLES: ReadonlySet<string> = new Set([
  'dr', 'mr', 'mrs', 'ms', 'mx', 'miss', 'prof', 'professor', 'sir', 'dame', 'rev', 'jr', 'sr', 'ii', 'iii', 'iv',
  'phd', 'ph', 'd', 'md', 'mba', 'msc', 'bsc', 'ba', 'ma', 'meng', 'beng', 'cpa', 'pe', 'esq', 'cfa', 'pmp',
]);

/** Separators left at either end of a line once something is taken out of it. */
const LOOSE_ENDS = /^[^\p{L}\p{N}(]+|[^\p{L}\p{N}.)!?]+$/gu;

/** What is left of a line once something is taken out: spaces tidied, a run of separators made one, no loose ends. */
const tidied = (text: string) =>
  text
    .replace(/[^\S\n]{2,}/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/([|,;])(?:\s*[|,;])+/g, '$1')
    .replace(LOOSE_ENDS, '')
    .trim();

/**
 * A line without the person's name: the line itself when it does not name them; null when nothing but the name and
 * its titles is left; else what is left, its loose ends tidied ("Ada Lovelace | Staff Engineer" gives "Staff Engineer").
 */
function withoutName(line: string, names: readonly RegExp[]): string | null {
  let out = line;
  for (const name of names) out = out.replace(name, ' ');
  if (out === line) return line;
  const words = nameKey(out).split(' ').filter(Boolean);
  if (words.every((word) => NAME_TITLES.has(word))) return null;
  return tidied(out);
}

/** Each place `value` stands in `text`, in any case, taken out. */
function withoutValue(text: string, value: string): string {
  const needle = value.toLowerCase();
  if (needle.length < 4) return text;
  let out = text;
  for (let at = out.toLowerCase().indexOf(needle); at !== -1; at = out.toLowerCase().indexOf(needle)) {
    out = `${out.slice(0, at)} ${out.slice(at + needle.length)}`;
  }
  return out;
}

/** The profile sites, written without a scheme or a path ("github.com"). */
const PROFILE_SITES = /(?<![\p{L}\p{N}@._/-])(?:linkedin|github|gitlab|behance|dribbble)\.com\b[^\s<>"'`]*/giu;

/** The words a contact line labels its details with: a line left with these alone was the contact line. */
const CONTACT_WORDS: ReadonlySet<string> = new Set([
  'mobile', 'cell', 'tel', 'telephone', 'phone', 'fax', 'email', 'e', 'mail', 'web', 'website', 'site', 'url', 'portfolio',
  'linkedin', 'github', 'gitlab', 'contact', 'home', 'work', 'personal', 'and', 'or', 'at', 'on',
]);

/**
 * A line with its contact details taken out: email addresses, links (any domain with a path, a bare domain, the
 * profile sites), phone numbers with or without separators, and the person's own links and addresses by value. Null
 * when only the labels of those details are left, or when a contact detail is still there once look-alike letters
 * read as Latin ones ("paypal.com" in Cyrillic).
 */
function withoutContacts(line: string, own: OwnContacts): string | null {
  let out = line.replace(EMAIL, ' ').replace(LINK, ' ');
  out = out.replace(PATHED_DOMAIN, (...args: unknown[]) => {
    const { domain = '', ending = '' } = args[args.length - 1] as Record<string, string | undefined>;
    return isCodeName(domain, ending) ? String(args[0]) : ' ';
  });
  out = out.replace(BARE_DOMAIN, (...args: unknown[]) => {
    const { ending = '' } = args[args.length - 1] as Record<string, string | undefined>;
    return PRODUCT_ENDINGS.has(ending) ? String(args[0]) : ' ';
  });
  out = out.replace(PROFILE_SITES, ' ');
  for (const url of own.urls) out = withoutValue(out, linkKey(url));
  for (const email of own.emails) out = withoutValue(out, email.trim());
  // Every phone number, and the person's own by its digits however short or written ("9123 4567" for +65 9123 4567).
  const ownPhones = own.phones.map(digitsOf).filter((digits) => digits.length >= 7);
  const isOwnPhone = (run: string) => ownPhones.some((mine) => samePhone(digitsOf(run), mine));
  out = out.replace(PHONE_RUN, (run) => (isPhoneNumber(run) || isOwnPhone(run) ? ' ' : run));
  if (namesForeignContact(out, NO_CONTACTS)) return null;
  if (out === line) return line;
  if (nameKey(out).split(' ').every((word) => word === '' || CONTACT_WORDS.has(word))) return null;
  return tidied(out);
}

/**
 * The lines of a text that are facts the draft may use: no statement of a sensitive answer, no sensitive label, no
 * postal address, no name and no contact details (see above).
 */
function factLines(text: string, personal: Personal): string[] {
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || statesSensitiveAnswer(line) || hasSensitiveLabel(line) || holdsAddress(line, personal.address)) {
      continue;
    }
    const named = withoutName(line, personal.names);
    const kept = named === null ? null : withoutContacts(named, personal.contacts);
    if (kept !== null && /[\p{L}\p{N}]/u.test(kept)) lines.push(kept);
  }
  return lines;
}

const joined = (parts: ReadonlyArray<string | null | undefined>, separator = ', ') =>
  parts.map((part) => (part ?? '').trim()).filter(Boolean).join(separator);

const period = (start: string | null | undefined, end: string | null | undefined, current = false) => {
  const to = current ? 'now' : (end ?? '').trim();
  const from = (start ?? '').trim();
  return from || to ? ` (${joined([from, to], ' to ')})` : '';
};

/** `text` after `before`, or '' when there is no text. */
const after = (before: string, text: string | null | undefined) => (text?.trim() ? `${before}${text.trim()}` : '');

/** A built resume's facts, a line each: what it prints, without the name, the contact line or the references. */
function builtResumeLines(stored: ResumeDocument): string[] {
  const document = documentPlainText(printedDocument(stored));
  const lines: string[] = [];
  const add = (line: string) => void (line.trim() && lines.push(line));
  const bullets = (items: readonly string[] | undefined) => (items ?? []).forEach((item) => add(`  - ${item}`));
  add(document.title ? `Headline: ${document.title}` : '');
  add(document.summary ? `Summary: ${document.summary}` : '');
  if (document.totalYearsExperience) add(`Years of experience: ${document.totalYearsExperience}`);
  if (document.experience.length) add('Experience:');
  for (const entry of document.experience) {
    const role = joined([entry.title, entry.company], ' at ');
    add(`- ${role}${period(entry.startDate, entry.endDate)}${after(', ', entry.location)}`);
    add(entry.description ? `  ${entry.description}` : '');
    bullets(entry.achievements);
    if (entry.skills.length) add(`  Skills: ${entry.skills.join(', ')}`);
  }
  if (document.strengths.length) add('Strengths:');
  for (const entry of document.strengths) add(`- ${joined([entry.title, entry.description], ': ')}`);
  const skills = [
    ...document.skills,
    ...(document.skillCategories ?? []).flatMap((group) => group.skills),
    ...(document.softSkills ?? []),
  ];
  if (skills.length) add(`Skills: ${[...new Set(skills)].join(', ')}`);
  if (document.education.length) add('Education:');
  for (const entry of document.education) {
    add(`- ${joined([entry.degree, entry.institution])}${period(entry.startDate, entry.endDate)}`);
    bullets(entry.achievements);
  }
  if (document.projects?.length) add('Projects:');
  for (const entry of document.projects ?? []) {
    const role = entry.role.trim() ? `(${entry.role.trim()})` : '';
    add(`- ${joined([entry.name, role], ' ')}${after(': ', entry.description)}`);
    bullets(entry.achievements);
  }
  if (document.certifications?.length) add('Certifications:');
  for (const entry of document.certifications ?? []) add(`- ${joined([entry.name, entry.issuer, entry.date])}`);
  if (document.awards?.length) add('Awards:');
  for (const entry of document.awards ?? []) {
    add(`- ${joined([entry.title, entry.issuer])}${after(': ', entry.description)}`);
  }
  if (document.volunteering?.length) add('Volunteering:');
  for (const entry of document.volunteering ?? []) {
    add(`- ${joined([entry.role, entry.organization], ' at ')}${after(': ', entry.description)}`);
    bullets(entry.achievements);
  }
  if (document.publications?.length) add('Publications:');
  for (const entry of document.publications ?? []) {
    add(`- ${entry.title}${after(': ', entry.description)}`);
  }
  if (document.languages?.length) {
    const languages = document.languages.map((entry) =>
      entry.proficiency.trim() ? `${entry.language} (${entry.proficiency.trim()})` : entry.language,
    );
    add(`Languages: ${languages.join(', ')}`);
  }
  if (document.courses?.length) add('Courses:');
  for (const entry of document.courses ?? []) add(`- ${joined([entry.name, entry.institution])}`);
  return lines;
}

const PROFICIENCY_WORDS: Record<LanguageProficiency, string> = {
  elementary: 'elementary',
  'limited-working': 'limited working',
  'professional-working': 'professional working',
  'full-professional': 'full professional',
  native: 'native',
};

const ARRANGEMENT_WORDS: Record<WorkArrangement, string> = { remote: 'remote', hybrid: 'hybrid', onsite: 'on site' };

/**
 * The autofill profile's job preferences, a line each (v2 Phase D): whether the person would relocate, the work
 * arrangements they accept, how much they would travel, their notice period and earliest start, and their usual answer
 * to "How did you hear about us?". None of them is sensitive: the pay, the work authorization and the age are the
 * sensitive part's, which is never read here.
 */
function preferenceLines(preferences: AutofillProfile['preferences']): string[] {
  const { willingToRelocate, workArrangements, travelPercent, noticePeriodWeeks, earliestStartDate } = preferences;
  const lines: string[] = [];
  if (willingToRelocate) lines.push(`Willing to relocate: ${willingToRelocate}`);
  if (workArrangements.length) {
    lines.push(`Work arrangements accepted: ${workArrangements.map((value) => ARRANGEMENT_WORDS[value]).join(', ')}`);
  }
  if (travelPercent !== null) {
    lines.push(travelPercent === 0 ? 'Willing to travel: no' : `Willing to travel: up to ${travelPercent}% of the time`);
  }
  if (noticePeriodWeeks !== null) {
    const weeks = noticePeriodWeeks === 0 ? 'none' : `${noticePeriodWeeks} week${noticePeriodWeeks === 1 ? '' : 's'}`;
    lines.push(`Notice period: ${weeks}`);
  }
  if (earliestStartDate) lines.push(`Earliest start date: ${earliestStartDate}`);
  if (preferences.referralSource.trim()) {
    lines.push(`Usual answer to "How did you hear about us?": ${preferences.referralSource.trim()}`);
  }
  return lines.length ? ['Job preferences:', ...lines.map((line) => `- ${line}`)] : [];
}

/**
 * The autofill profile's facts, a line each: work history, education, languages, skills and job preferences. No name
 * or contact.
 */
function profileLines(profile: AutofillProfile): string[] {
  const lines: string[] = [];
  if (profile.experience.length) lines.push('Work history:');
  for (const entry of profile.experience) {
    const where = joined([entry.location.city, entry.location.region]);
    const dates = period(entry.startDate, entry.endDate, entry.current);
    lines.push(`- ${entry.title} at ${entry.company}${dates}${after(', ', where)}`);
    if (entry.description.trim()) lines.push(...entry.description.split(/\r?\n/).map((line) => `  ${line}`));
  }
  if (profile.education.length) lines.push('Education:');
  for (const entry of profile.education) {
    const degree = joined([entry.degree.type || entry.degree.level, entry.degree.field], ' in ');
    const dates = period(entry.startDate, entry.endDate, entry.current);
    lines.push(`- ${joined([degree, entry.institution.canonicalName])}${dates}`);
  }
  if (profile.languages.length) {
    const languages = profile.languages.map((entry) =>
      entry.proficiency ? `${entry.language} (${PROFICIENCY_WORDS[entry.proficiency]})` : entry.language,
    );
    lines.push(`Languages: ${languages.join(', ')}`);
  }
  if (profile.skills.length) lines.push(`Skills: ${profile.skills.join(', ')}`);
  lines.push(...preferenceLines(profile.preferences));
  return lines;
}


/** The account's name and sign-in address. */
export const ACCOUNT_NAME_SQL = 'SELECT name, email FROM users WHERE id = ?';

type Account = { name: string; email: string };

/** The account's name and sign-in address. */
async function accountOf(deps: Pick<AppDeps, 'db'>, userId: string): Promise<Account> {
  return (await deps.db.one<Account>(ACCOUNT_NAME_SQL, [userId])) ?? { name: '', email: '' };
}

/** The person's own contact details in the profile, and the account's sign-in address (the profile's when empty). */
function ownContacts(account: { email: string }, profile: AutofillProfile): OwnContacts {
  const { links, contact } = profile;
  return {
    urls: [links.linkedin, links.github, links.portfolio, links.website, ...links.other.map((link) => link.url)].filter(
      Boolean,
    ),
    emails: [contact.email, account.email].filter(Boolean),
    phones: [contact.phone.number].filter(Boolean),
  };
}

/** What the facts leave out for this person: their names, contact details and the profile's street line and postcode. */
function personalOf(profile: AutofillProfile, account: { name: string; email: string }): Personal {
  const { line1, postalCode } = profile.contact.address;
  return {
    names: namePatterns(profile, account),
    contacts: ownContacts(account, profile),
    address: [line1, postalCode].map(nameKey).filter((value) => value.length >= 3 && !/^\d{1,4}$/.test(value)),
  };
}

/**
 * The facts for a draft or an answer task of `userId`'s (ai/draft.ts's ReadDraftFacts): the resume named, else the
 * profile's resume to attach, else the default, else the latest (a resume deleted since gives none), and the autofill
 * profile.
 */
export async function readDraftFacts(deps: Pick<AppDeps, 'db'>, userId: string, resumeId: string | null): Promise<DraftFacts> {
  const profile = (await readAutofillProfile(deps, userId)).value;
  return draftFactsOf(deps, userId, resumeId, profile, await accountOf(deps, userId));
}

/** readDraftFacts once the profile and the account are read (readDraftFacts). */
export async function draftFactsOf(
  deps: Pick<AppDeps, 'db'>,
  userId: string,
  resumeId: string | null,
  profile: AutofillProfile,
  account: Account,
): Promise<DraftFacts> {
  const personal = personalOf(profile, account);
  const chosen = resumeId ?? profile.documents.resumeId;
  const evidence = chosen ? await getResumeEvidence(deps, userId, chosen) : await getResumeEvidence(deps, userId, null);
  // The profile's own choice, since deleted, falls back to the default; a resume the request named does not.
  const resume = evidence ?? (resumeId === null && chosen ? await getResumeEvidence(deps, userId, null) : null);
  const resumeText = resume
    ? resume.document
      ? builtResumeLines(resume.document).join('\n')
      : resume.text.slice(0, RESUME_MAX)
    : '';
  return {
    resume: factLines(resumeText, personal).join('\n'),
    profile: factLines(profileLines(profile).join('\n'), personal).join('\n'),
    note: factLines(profile.anythingElse, personal).join('\n'),
    contacts: personal.contacts,
  };
}
