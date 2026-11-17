import { caseKeptText } from './fold';

// Contact details in a text (work package AF, Phase 6): a link, an email address or a phone number, and (the Phase D
// review) a postal address. A draft may name only the person's own (draft.ts), an answer no address (answer.ts), a
// current answer sent to be rewritten none at all, and the facts a draft is written from leave every one out
// (draft-facts.ts). Read over the text's compatibility form with look-alike letters read as their Latin ones, case
// kept (fold.ts, caseKeptText), so a full-width letter reads as a plain one, and "paypal.com" spelt with Cyrillic
// look-alikes as "paypal.com".

/** No contact details: with these as the person's own, any contact detail is foreign. */
export const NO_CONTACTS: OwnContacts = { urls: [], emails: [], phones: [] };

/** The person's own contact details: a draft may name these and no others. */
export interface OwnContacts {
  urls: readonly string[];
  emails: readonly string[];
  phones: readonly string[];
}

/** A text as the contact patterns read it: its compatibility form, look-alike letters read as Latin ones. */
export const contactView = (text: string) => caseKeptText(text.normalize('NFKC'));

// An email address is read first and taken out, so its domain is not read as a link.
export const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;
export const LINK = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>"'`]+/gi;

/**
 * A domain with a path ("evil.ru/apply", "EVIL.EXAMPLE.COM/APPLY", "jobs.evil.top/apply"): any labels, in any case,
 * whose last is two letters or more, then "/" (the Phase 6 review, T6-4). The ending says nothing here, so any domain
 * counts but a code name (see isCodeName).
 */
export const PATHED_DOMAIN =
  /(?<![\p{L}\p{N}@._/-])(?<domain>(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+(?<ending>\p{L}{2,63}))\/[^\s<>"'`]*/giu;

/**
 * A domain without a path ("evil.example.com"), in lower case only, so "ASP.NET" is none; its ending must be one of
 * these. The endings libraries and products are also named with ("socket.io") count only with a path after them.
 */
export const BARE_DOMAIN =
  /(?<![\p{L}\p{N}@._/-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?<ending>com|net|org|io|ai|co|dev|app|me|info|biz|xyz|link|site|online|tech|cloud|page|us|uk|ca|de|fr|eu|in|au|nz|gg|tv|ly|sh|to)(?![\p{L}\p{N}-])/gu;
export const PRODUCT_ENDINGS: ReadonlySet<string> = new Set([
  'io',
  'ai',
  'dev',
  'app',
  'me',
  'tech',
  'cloud',
  'gg',
  'tv',
  'ly',
  'sh',
  'to',
]);

/**
 * A file's or a library's name with a path after it ("Node.js/TypeScript", "ASP.NET/C#"): its ending is a code
 * file's, which no top-level domain is, or it is one of the .NET names. Never a link.
 */
const CODE_ENDINGS: ReadonlySet<string> = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'json', 'yaml', 'yml', 'toml', 'html', 'htm', 'css', 'scss', 'sass', 'cpp',
  'hpp', 'java', 'kt', 'kts', 'swift', 'txt', 'csv', 'exe', 'dll', 'lock', 'vue', 'svelte',
]);
const DOT_NET_NAMES: ReadonlySet<string> = new Set(['asp.net', 'vb.net', 'ado.net']);

/** True when a domain with a path is a code name instead (see CODE_ENDINGS). */
export function isCodeName(domain: string, ending: string): boolean {
  return CODE_ENDINGS.has(ending.toLowerCase()) || DOT_NET_NAMES.has(domain.toLowerCase());
}

/** The words a street address ends its street with ("221B Baker Street", "7 Engine Row", "12 Elm St."). */
const STREET_WORDS = String.raw`(?:street|st|road|rd|avenue|ave|boulevard|blvd|lane|ln|drive|dr|court|ct|place|pl|way|terrace|close|crescent|square|sq|parkway|pkwy|highway|hwy|row|mews|grove|gardens|walk|circle|cir|trail|alley|plaza)`;

/** The end of a postcode: the text's end, or a separator after it ("London NW1 6XE", "M5V 2T6, Canada"). */
const POSTCODE_END = String.raw`(?=\s*(?:$|[,;|)]))`;

/**
 * A postal address in a line: a street address at the start of the line or after a separator, a post office box or
 * an apartment, a UK or Canadian postcode in capitals, or a US state and ZIP code. The facts leave out a line that
 * holds one (draft-facts.ts), and an answer that holds one is discarded (answer.ts).
 */
const ADDRESS: readonly RegExp[] = [
  new RegExp(String.raw`(?:^|[,|;:]\s*)\d{1,6}[a-z]?\s+(?:[\p{L}'.-]+\s+){0,3}${STREET_WORDS}\b`, 'iu'),
  /\b(?:p\.?\s?o\.?\s+box|apt\.?\s*#?\s*\d|apartment\s+#?\d|suite\s+#?\d|flat\s+\d)/i,
  new RegExp(String.raw`\b[A-Z]{1,2}\d[A-Z\d]?\s+\d[A-Z]{2}\b${POSTCODE_END}`),
  new RegExp(String.raw`\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b${POSTCODE_END}`),
  /\b(?:AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\s+\d{5}(?:-\d{4})?\b/,
];

/** True when a text holds a postal address (ADDRESS), as written or with look-alike letters read as Latin ones. */
export function holdsPostalAddress(text: string): boolean {
  const views = [...new Set([text, contactView(text)])];
  return views.some((view) => ADDRESS.some((pattern) => pattern.test(view)));
}

/** A run of digits and the separators phone numbers are written with. */
export const PHONE_RUN = /\+?\(?\d[\d\s().\-\u2010-\u2015]{5,}\d/g;

/** A link compared without its scheme, "www.", case, a trailing slash or the punctuation a sentence puts after it. */
export function linkKey(link: string): string {
  return link
    .toLowerCase()
    .replace(/[.,;:!?)\]'"\u2019\u201D]+$/, '')
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

export const digitsOf = (text: string) => text.replace(/\D/g, '');

/** A run that is a phone number: 9 to 15 digits, and not years only ("2019 2023"). */
export function isPhoneNumber(run: string): boolean {
  const digits = digitsOf(run);
  if (digits.length < 9 || digits.length > 15) return false;
  const groups = run.split(/\D+/).filter(Boolean);
  return !groups.every((group) => /^(?:19|20)\d\d$/.test(group));
}

/** The same number: one's digits end with the other's (a country code or a trunk 0 aside), at least 7 of them. */
export function samePhone(a: string, b: string): boolean {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 7 && longer.endsWith(shorter);
}

/**
 * True when a text names a link, an email address or a phone number that is not the person's own. A link is the
 * person's when it is one of theirs, a page under one ("github.com/ada/project"), or bare the site of one
 * ("github.com"). With no contacts of the person's, any contact detail counts.
 */
export function namesForeignContact(text: string, own: OwnContacts): boolean {
  let rest = contactView(text);
  const ownEmails = new Set(own.emails.map((email) => email.trim().toLowerCase()).filter(Boolean));
  for (const email of rest.match(EMAIL) ?? []) {
    if (!ownEmails.has(email.toLowerCase().replace(/[.,;:!?]+$/, ''))) return true;
  }
  rest = rest.replace(EMAIL, ' ');
  const ownLinks = own.urls.map(linkKey).filter(Boolean);
  const isOwn = (link: string) => {
    const key = linkKey(link);
    return ownLinks.some((mine) => key === mine || key.startsWith(`${mine}/`) || mine.split('/')[0] === key);
  };
  for (const link of rest.match(LINK) ?? []) if (!isOwn(link)) return true;
  rest = rest.replace(LINK, ' ');
  for (const match of rest.matchAll(PATHED_DOMAIN)) {
    const { domain = '', ending = '' } = match.groups ?? {};
    if (!isCodeName(domain, ending) && !isOwn(match[0])) return true;
  }
  rest = rest.replace(PATHED_DOMAIN, ' ');
  for (const match of rest.matchAll(BARE_DOMAIN)) {
    if (PRODUCT_ENDINGS.has(match.groups?.ending ?? '')) continue;
    if (!isOwn(match[0])) return true;
  }
  rest = rest.replace(BARE_DOMAIN, ' ');
  const ownPhones = own.phones.map(digitsOf).filter((digits) => digits.length >= 7);
  for (const run of rest.match(PHONE_RUN) ?? []) {
    if (isPhoneNumber(run) && !ownPhones.some((mine) => samePhone(digitsOf(run), mine))) return true;
  }
  return false;
}
