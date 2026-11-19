import { CA_PROVINCES, parseLocations, resumeHeadingOf, US_STATES, type ResumeDocument } from '@tailorit/shared';

// v3.2 FILL: how "Fill from my resume" reads an uploaded file, whose structure TailorIT does not keep: only its stored
// text. Pure and small, like resume-text.ts.
// - contactInText: the contact details a resume's text shows without any AI (an email and LinkedIn anywhere; a phone
//   number, GitHub, a personal site and a place in its top lines, before its first section): what an upload fills
//   until the AI has read it, or when the AI cannot.
// - groundedReading: the AI's reading of the file (resumes/ai/uploadReading.ts, the editable copy's prompt: copy, never
//   infer) kept only where the text says it, so a name, an employer, a school, a date, a skill or a contact detail
//   the file does not hold never reaches the profile.
// v32 FIX-API (REV-SECBEH SF-1): each field is checked as the file writes it: a degree by its words (or its usual
// abbreviation), a phone number and a GPA against each number the text writes (never digits of two numbers run
// together), an email only when it is one of the text's addresses, a language's level only when its line says it, and
// a role's description and bullets line by line (most of a line's words, and all its numbers, in the text).

export interface TextContact {
  email: string;
  phone: string;
  linkedin: string;
  github: string;
  portfolio: string;
  /** "Seattle, WA": a place written in the top lines ('' for none). */
  location: string;
}

/** The most lines a resume's top (its name, headline and contact details) is read in. */
const TOP_LINES = 8;

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,24}/i;
const EMAILS = new RegExp(EMAIL.source, 'gi');
const LINKEDIN = /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[\p{L}\p{N}_%-]+/iu;
const GITHUB = /(?:https?:\/\/)?(?:www\.)?github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/i;
/** A web address written in a resume's header: a scheme, or "www.", or a host whose last label is letters. */
const SITE = /(?:https?:\/\/)?(?:www\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,24}(?:\/[^\s|,;·•]*)?/gi;
/** A technology's name written like a host ("Node.js", "Vue.js", "Next.ts"): no site. */
const TECH_NAME = /\.(?:js|ts)$/i;
/** What separates the details of a resume's contact line: bars, dots, bullets, symbols (icons), tabs, wide gaps. */
const DETAIL_SEPARATOR = /\s*[|•·;\t\p{So}\p{Co}]+\s*|\s{3,}/u;
/** A phone number as written: digits with spaces, dots, dashes and brackets, maybe a +, maybe an extension. */
const PHONE = /\+?\(?\d[\d\s().-]{6,}\d(?:\s*(?:ext\.?|x|#)\s*\d{1,8})?/gi;
/** Two years with a dash ("2019 - 2021"): a period, not a phone number. */
const YEAR_RANGE = /^\(?(?:19|20)\d{2}\)?\s*[-–.]\s*\(?(?:19|20)\d{2}\)?$/;

/** The text's top: its first non-empty lines, up to its first section heading ("Summary", "Experience"). */
function topOf(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, TOP_LINES);
  const heading = lines.findIndex((line) => resumeHeadingOf(line) !== null);
  return (heading < 0 ? lines : lines.slice(0, heading)).join('\n');
}

/** A phone number in the header: 8 to 15 digits, and not two years of a period. */
function phoneIn(header: string): string {
  for (const match of header.matchAll(PHONE)) {
    const written = match[0].trim();
    const digits = written.replace(/\D/g, '').length;
    if (digits >= 8 && digits <= 19 && !YEAR_RANGE.test(written)) return written;
  }
  return '';
}

/** A personal site in the header: a web address that is not an email's, LinkedIn's or GitHub's. */
function siteIn(text: string, email: string): string {
  const emailHost = email.split('@')[1]?.toLowerCase() ?? '';
  // An address's words ("jane.doe@example.com") are no site.
  const header = text.replace(EMAILS, ' ');
  for (const match of header.matchAll(SITE)) {
    const before = header[match.index - 1] ?? '';
    if (before === '@' || before === '.' || /[\p{L}\p{N}]/u.test(before)) continue;
    const host = match[0].replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0]!.toLowerCase();
    if (host === emailHost || /(?:^|\.)(?:linkedin|github)\.com$/.test(host) || TECH_NAME.test(host)) continue;
    return match[0].replace(/[.)]+$/, '');
  }
  return '';
}

/** US state and Canadian province names, in lower case. */
const REGION_NAMES = new Set([...Object.values(US_STATES), ...Object.values(CA_PROVINCES)].map((name) => name.toLowerCase()));

/** What ends a place: a state or province code ("WA", "ON") or name, or a country alone ("UK", "Germany"). */
function endsPlace(text: string): boolean {
  if (/^[A-Z]{2}$/.test(text) || REGION_NAMES.has(text.toLowerCase())) return true;
  const place = parseLocations(text)[0];
  return place !== undefined && !place.city && !place.region && place.countryCode !== null;
}

/**
 * A place in the top lines: a detail of its own ("Seattle, WA" between bars or icons) that ends with a state, a
 * province or a country, that the location reader reads as a city there, and that holds no digit, address or link.
 */
function placeIn(top: string): string {
  for (const line of top.split('\n')) {
    for (const part of line.split(DETAIL_SEPARATOR)) {
      const detail = part.trim();
      if (!detail.includes(',') || detail.length > 60 || /[\d@/]/.test(detail)) continue;
      if (!endsPlace(detail.slice(detail.lastIndexOf(',') + 1).trim())) continue;
      const place = parseLocations(detail)[0];
      if (place?.city && (place.region || place.countryCode)) return detail;
    }
  }
  return '';
}

/** The contact details an upload's text shows: the first email and LinkedIn link, and the rest from its top. */
export function contactInText(text: string): TextContact {
  const top = topOf(text);
  const email = EMAIL.exec(text)?.[0] ?? '';
  return {
    email,
    phone: phoneIn(top),
    linkedin: LINKEDIN.exec(text)?.[0] ?? '',
    github: GITHUB.exec(top)?.[0] ?? '',
    portfolio: siteIn(top, email),
    location: placeIn(top),
  };
}

// ------------------------------------------------------------------------------------------------ the AI's reading

/**
 * Text as compared: compatibility forms folded (a ligature is its letters), accents dropped ("José" is "jose": a file's
 * text and the AI may spell one with them and one without), lower case, letters and digits only.
 */
const fold = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Phrases this long may also be found with their spaces gone (a PDF's text runs words together or breaks them). */
const COMPACT_MIN = 8;

/**
 * v32 FIX-API (SF-1): a number as a line writes it: digits with single spaces, dots, dashes and brackets, maybe a + and
 * an extension (a wider gap, a bar or a dot between two numbers ends it).
 */
const WRITTEN_NUMBER = /\+?\(?\d(?:[\d().-]| (?! ))*\d(?: ?(?:ext\.?|x|#) ?\d{1,8})?|\d/gi;
/** v32 FIX-API (SF-1): a decimal number ("3.9", "4", "2,000" read as "2000"). */
const DECIMAL = /\d+(?:[.,]\d+)?/g;
/** A phone number's extension, at its end. */
const EXTENSION = /[ \t,;]*(?:ext\.?|extension|x|#)[ \t]*\d{1,8}$/i;

/** The digits of a phone number as written, its extension apart. */
function phoneDigits(written: string): { main: string; extension: string } {
  const extension = EXTENSION.exec(written);
  return {
    main: (extension ? written.slice(0, extension.index) : written).replace(/\D/g, ''),
    extension: extension ? extension[0].replace(/\D/g, '') : '',
  };
}

/** Words of a line that carry its meaning (folded, two letters or more, no filler). */
const FILLER = new Set(['a', 'an', 'and', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'by', 'with', 'as', 'or', 'from', 'my', 'our']);
const meaningful = (line: string) => fold(line).split(' ').filter((word) => word.length >= 2 && !FILLER.has(word));

/**
 * Whether the text says things: `says(phrase)` as whole words; v32 FIX-API (SF-1): `saysPhone` a phone number as one
 * number the text writes, `saysNumbers` each number of a value as the text writes it, `saysLine` a line most of whose
 * words (and all of whose numbers) are the text's, `saysNear` a phrase on a line that names another.
 */
function evidenceOf(text: string) {
  const words = ` ${fold(text)} `;
  const compact = words.replace(/ /g, '');
  const wordSet = new Set(words.trim().split(' '));
  const lines = text.split(/\r?\n/).map((line) => ` ${fold(line)} `);
  const phones = [...text.matchAll(WRITTEN_NUMBER)].map((match) => phoneDigits(match[0])).filter((phone) => phone.main.length >= 7);
  const decimals = new Set([...text.matchAll(DECIMAL)].map((match) => match[0].replace(',', '.')));
  const says = (phrase: string | null | undefined): boolean => {
    const wanted = fold(phrase ?? '');
    if (!wanted) return false;
    if (words.includes(` ${wanted} `)) return true;
    const tight = wanted.replace(/ /g, '');
    return tight.length >= COMPACT_MIN && compact.includes(tight);
  };
  const saysNumbers = (value: string): boolean => {
    const numbers = (value.match(DECIMAL) ?? []).map((number) => number.replace(',', '.'));
    return numbers.every((number) => decimals.has(number));
  };
  return {
    says,
    /** One number the text writes, by its digits; the AI may add the country's code (its last ten digits will do). */
    saysPhone(value: string): boolean {
      const wanted = phoneDigits(value.trim());
      if (wanted.main.length < 7) return false;
      return phones.some((phone) => {
        const same =
          phone.main === wanted.main ||
          (wanted.main.length > 10 && phone.main === wanted.main.slice(-10)) ||
          (phone.main.length > 10 && phone.main.slice(-10) === wanted.main);
        return same && (wanted.extension === '' || wanted.extension === phone.extension);
      });
    },
    saysNumbers(value: string): boolean {
      return (value.match(DECIMAL) ?? []).length > 0 && saysNumbers(value);
    },
    /** Most (four in five) of a line's words are the text's, and every number in it. */
    saysLine(line: string): boolean {
      const own = meaningful(line);
      if (own.length === 0) return false;
      const found = own.filter((word) => wordSet.has(word)).length;
      return found / own.length >= 0.8 && saysNumbers(line);
    },
    /** `phrase` on a line of the text that also names `anchor`. */
    saysNear(anchor: string, phrase: string): boolean {
      const near = fold(anchor);
      const wanted = fold(phrase);
      if (!near || !wanted) return false;
      return lines.some((line) => line.includes(` ${near} `) && line.includes(` ${wanted} `));
    },
  };
}

/**
 * v32 FIX-API (SF-1): a degree's level as written in full ("bachelor of science") and its usual abbreviations
 * ("b s", "bs", "bsc": folded), any of which the text may write.
 */
const DEGREE_FORMS: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/\bbachelor(?: s)? (?:of )?science\b/, ['bachelor of science', 'b s', 'bs', 'bsc', 'b sc']],
  [/\bbachelor(?: s)? (?:of )?arts\b/, ['bachelor of arts', 'b a', 'ba']],
  [/\bbachelor(?: s)? (?:of )?engineering\b/, ['bachelor of engineering', 'b eng', 'beng', 'b e', 'be']],
  [/\bmaster(?: s)? (?:of )?business administration\b/, ['master of business administration', 'm b a', 'mba']],
  [/\bmaster(?: s)? (?:of )?science\b/, ['master of science', 'm s', 'ms', 'msc', 'm sc']],
  [/\bmaster(?: s)? (?:of )?arts\b/, ['master of arts', 'm a', 'ma']],
  [/\bmaster(?: s)? (?:of )?engineering\b/, ['master of engineering', 'm eng', 'meng']],
  [/\bdoctor (?:of )?philosophy\b/, ['doctor of philosophy', 'ph d', 'phd', 'd phil', 'dphil']],
  [/\bassociate(?: s)? (?:of )?science\b/, ['associate of science', 'a s']],
  [/\bassociate(?: s)? (?:of )?arts\b/, ['associate of arts', 'a a']],
];

/** Each form's abbreviations as a whole, for a degree the AI wrote short ("Ph.D. Physics"): the long form's group. */
const DEGREE_ABBREVIATIONS = DEGREE_FORMS.map(([, forms]) => forms);

/**
 * v32 FIX-API (SF-1): whether the text says the degree: as written, or its level in any of its usual forms and the rest
 * of it (its field) word for word.
 */
function degreeSaid(evidence: Evidence, degree: string): boolean {
  if (!degree.trim() || evidence.says(degree)) return true;
  let rest = ` ${fold(degree)} `;
  let level: readonly string[] | null = null;
  for (const [pattern, forms] of DEGREE_FORMS) {
    if (pattern.test(rest)) {
      level = forms;
      rest = rest.replace(pattern, ' ');
      break;
    }
  }
  if (!level) {
    for (const forms of DEGREE_ABBREVIATIONS) {
      const short = forms.find((form) => form !== forms[0] && rest.startsWith(` ${form} `));
      if (short) {
        level = forms;
        rest = rest.replace(` ${short} `, ' ');
        break;
      }
    }
  }
  if (level && !level.some((form) => evidence.says(form))) return false;
  const field = meaningful(rest);
  return field.every((word) => evidence.says(word));
}

type Evidence = ReturnType<typeof evidenceOf>;

/** Each 4-digit year a date names is in the text (a date with none is kept as it is). */
function yearsSaid(evidence: Evidence, date: string): boolean {
  const years = date.match(/(?<!\d)\d{4}(?!\d)/g) ?? [];
  return years.every((year) => evidence.says(year));
}

/** A web address, as compared: no scheme, no "www.", no slash at its end. */
const bareLink = (link: string) => link.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');

export interface GroundedReading {
  document: ResumeDocument;
  /** How many things the AI gave that the text does not say (each left out). */
  dropped: number;
}

/**
 * The AI's reading of an upload, kept where `text` says it:
 * - the name, a location, a school, an employer, a job title, a skill, a language, a certification: as words of the
 *   text; a role stays when both its employer and its title are there (the profile needs both), a degree when its
 *   school is;
 * - an email as written, a phone number by its digits, a link by its address;
 * - a date when each year it names is in the text; a GPA when its number is;
 * - a role's description and bullets as the prompt allows (tidied wording), with the role.
 * v32 FIX-API (SF-1): a degree by its words or its usual abbreviation; a phone number and a GPA as numbers the text
 * writes; an email only as one of the text's addresses; a language's level as its line says it; a description and each
 * bullet line by line (four in five of its words, and all its numbers, the text's).
 * Sections the profile does not keep are dropped as they are.
 */
export function groundedReading(reading: ResumeDocument, text: string): GroundedReading {
  const evidence = evidenceOf(text);
  let dropped = 0;
  /** `value` when `kept`, else '' (counted when there was something). */
  const keep = (value: string, kept: boolean) => {
    if (kept || !value.trim()) return value;
    dropped += 1;
    return '';
  };
  const said = (value: string) => keep(value, evidence.says(value));
  // v32 FIX-API (SF-1): a role's description and bullets, line by line (a sentence of a description apart).
  const linesSaid = (value: string) =>
    value
      .split(/\r?\n/)
      .map((line) =>
        line
          .split(/(?<=[.!?])\s+(?=\p{Lu})/u)
          .map((sentence) => sentence.trim())
          .filter((sentence) => sentence !== '' && keep(sentence, evidence.saysLine(sentence)) !== '')
          .join(' '),
      )
      .filter((line) => line !== '')
      .join('\n');
  const linkSaid = (link: string | undefined) => keep(link ?? '', evidence.says(bareLink(link ?? '')));
  const dates = <T extends { startDate: string; endDate: string; period?: unknown }>(entry: T): T => {
    const startDate = keep(entry.startDate, yearsSaid(evidence, entry.startDate));
    const endDate = keep(entry.endDate, yearsSaid(evidence, entry.endDate));
    const { period: _period, ...rest } = entry;
    return { ...rest, startDate, endDate } as T;
  };
  const kept = <T>(list: readonly T[], keepIt: (item: T) => boolean): T[] =>
    list.filter((item) => {
      if (keepIt(item)) return true;
      dropped += 1;
      return false;
    });

  const contact = reading.contact;
  // v32 FIX-API (SF-1): an email only when it is one of the text's own addresses (never a part of one).
  const addresses = new Set([...text.matchAll(EMAILS)].map((match) => match[0].toLowerCase()));
  const document: ResumeDocument = {
    ...reading,
    name: said(reading.name),
    contact: {
      ...contact,
      email: keep(contact.email, addresses.has(contact.email.trim().toLowerCase())),
      phone: keep(contact.phone, evidence.saysPhone(contact.phone)),
      location: said(contact.location),
      linkedin: linkSaid(contact.linkedin),
      github: linkSaid(contact.github),
      portfolio: linkSaid(contact.portfolio),
    },
    experience: kept(reading.experience, (role) => evidence.says(role.company) && evidence.says(role.title)).map((role) =>
      dates({
        ...role,
        company: said(role.company),
        title: said(role.title),
        location: said(role.location),
        description: linesSaid(role.description),
        achievements: kept(role.achievements, (bullet) => evidence.saysLine(bullet)),
      }),
    ),
    education: kept(reading.education, (school) => evidence.says(school.institution)).map((school) =>
      dates({
        ...school,
        location: said(school.location),
        // v32 FIX-API (SF-1): the degree by its words, the GPA by its own numbers.
        degree: keep(school.degree, degreeSaid(evidence, school.degree)),
        gpa: keep(school.gpa ?? '', evidence.saysNumbers(school.gpa ?? '')),
      }),
    ),
    skills: kept(reading.skills, (skill) => evidence.says(skill)),
    // v32 FIX-API (SF-1): a language's level only as its own line says it (never dots: a file's text has none).
    languages: kept(reading.languages ?? [], (entry) => evidence.says(entry.language)).map(({ level: _level, ...entry }) => ({
      ...entry,
      proficiency: keep(entry.proficiency, evidence.saysNear(entry.language, entry.proficiency)),
    })),
    certifications: kept(reading.certifications ?? [], (entry) => evidence.says(entry.name)).map((entry) => ({
      ...entry,
      issuer: said(entry.issuer),
      date: keep(entry.date, yearsSaid(evidence, entry.date)),
    })),
  };
  return { document, dropped };
}
