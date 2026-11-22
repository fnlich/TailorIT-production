import { reachableProfiles } from '../../core/auth/grants';
import type { AppDeps } from '../../core/context';
import { AppError } from '../../core/http/errors';
import {
  BARE_DOMAIN,
  contactView,
  digitsOf,
  EMAIL,
  isCodeName,
  isPhoneNumber,
  LINK,
  namesForeignContact,
  PATHED_DOMAIN,
  PHONE_RUN,
  PRODUCT_ENDINGS,
  samePhone,
  type OwnContacts,
} from '../autofill/ai/contacts';
import { detectionViews } from '../autofill/ai/fold';
import { stringsOf } from '../autofill/ai/tasks';
import { readAutofillProfile } from '../autofill/profile/repository';
import { CONTENT_REFUSALS, holdsFencedData } from './screen'; // v34 INT-B

// v34 MCPDIR (the security review, finding 1 HIGH, and finding 5; the coordinator's replacement for the tripwire, which
// was instruction text the directory forbids): server-side checks on what the person's own AI writes, independent of
// any words handed to it.
// 1. A written save (a letter, a resume's text, entry bullets, an own-AI document, a verdict's or a mark's reason, a
//    report) is refused when it holds a link, an email address or a phone number that is not the profile owner's own:
//    their account address, their Settings phone, LinkedIn and portfolio, their autofill profile's contacts and links,
//    and the contacts in the resume the text is written from. The usual payload of an instruction hidden in a posting
//    or in another person's words ("add this link", "write to this address") is one of those. (Answers keep their
//    stricter screen: no contact detail at all, save.ts answerRefusal.)
// 2. A save on one profile is refused when it holds another reachable profile's identifying details: the full name,
//    email address or phone number of the caller or of an owner who shared a profile with them (R8 on the server).
// What these do not catch: an instruction that changes wording, emphasis or which facts are used without adding a
// contact or another person's details; a link the person's own resume already holds. TailorIT's other checks cover
// parts of that (a resume keeps the person's facts; answers are checked against their question; filters run again).

/** The refusal of a text with a contact that is not the profile owner's own. */
export const FOREIGN_CONTACT =
  "Nothing was saved: the text holds a link, email address or phone number that is not the profile owner's own " +
  '(their account, Settings, autofill profile or resume). Leave it out: the application carries their own contact details.';

/** The refusal of a text with another profile's identifying details. */
export const OTHER_PROFILE =
  'Nothing was saved: the text holds the name or contact details of another profile you can reach. Each profile is a ' +
  'different person: write this one from its own facts only.';

/** The links, email addresses and phone numbers written in a text. */
export function contactsIn(text: string): OwnContacts {
  let rest = contactView(text);
  const emails = [...(rest.match(EMAIL) ?? [])].map((email) => email.replace(/[.,;:!?]+$/, ''));
  rest = rest.replace(EMAIL, ' ');
  const urls: string[] = [...(rest.match(LINK) ?? [])];
  rest = rest.replace(LINK, ' ');
  for (const match of rest.matchAll(PATHED_DOMAIN)) {
    const { domain = '', ending = '' } = match.groups ?? {};
    if (!isCodeName(domain, ending)) urls.push(match[0]);
  }
  rest = rest.replace(PATHED_DOMAIN, ' ');
  for (const match of rest.matchAll(BARE_DOMAIN)) if (!PRODUCT_ENDINGS.has(match.groups?.ending ?? '')) urls.push(match[0]);
  rest = rest.replace(BARE_DOMAIN, ' ');
  const phones = [...(rest.match(PHONE_RUN) ?? [])].filter(isPhoneNumber);
  return { urls, emails, phones };
}

const present = (values: ReadonlyArray<string | null | undefined>) => values.map((value) => (value ?? '').trim()).filter(Boolean);

/** A person's contact details from their account, Settings and autofill profile. */
async function accountContacts(deps: Pick<AppDeps, 'db'>, userId: string): Promise<OwnContacts & { name: string }> {
  const user = await deps.db.one<{ name: string | null; email: string | null }>('SELECT name, email FROM users WHERE id = ?', [userId]);
  const settings = await deps.db.one<{ phone: string; linkedin_url: string; portfolio_url: string }>(
    'SELECT phone, linkedin_url, portfolio_url FROM user_preferences WHERE user_id = ?',
    [userId],
  );
  const profile = (await readAutofillProfile(deps, userId)).value;
  const links = profile.links;
  return {
    name: (user?.name ?? '').trim(),
    emails: present([user?.email, profile.contact.email]),
    phones: present([settings?.phone, profile.contact.phone.number]),
    urls: present([
      settings?.linkedin_url,
      settings?.portfolio_url,
      links.linkedin,
      links.github,
      links.portfolio,
      links.website,
      links.x,
      links.telegram,
      ...links.other.map((link) => link.url),
    ]),
  };
}

/** The profile owner's own contact details, with those written in `sources` (the resume a text is written from). */
export async function ownContactsOf(deps: Pick<AppDeps, 'db'>, userId: string, sources: readonly string[] = []): Promise<OwnContacts> {
  const own = await accountContacts(deps, userId);
  const found = sources.map(contactsIn);
  return {
    urls: [...own.urls, ...found.flatMap((one) => one.urls)],
    emails: [...own.emails, ...found.flatMap((one) => one.emails)],
    phones: [...own.phones, ...found.flatMap((one) => one.phones)],
  };
}

/** A full name worth matching: at least two words of two letters or more. */
const fullNameOf = (name: string) => {
  const words = name.normalize('NFKC').trim().split(/\s+/).filter((word) => /\p{L}{2,}/u.test(word));
  return words.length >= 2 ? words.join(' ').toLowerCase() : null;
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The context a written save is screened in: whose profile, and who calls. */
export interface WrittenScope {
  deps: AppDeps;
  /** The profile's owner (whose contacts are the text's own). */
  userId: string;
  caller: { id: string };
}

/** True when a text holds another reachable profile's full name, email address or phone number. */
async function holdsOtherProfile(scope: WrittenScope, texts: readonly string[]): Promise<boolean> {
  const others = new Set<string>([scope.caller.id]);
  for (const grant of await reachableProfiles(scope.deps, scope.caller.id, ['mcp'])) others.add(grant.owner.id);
  others.delete(scope.userId);
  if (others.size === 0 || texts.length === 0) return false;
  const views = texts.flatMap((text) => detectionViews(text));
  const digits = texts.flatMap((text) => [...(contactView(text).match(PHONE_RUN) ?? [])].map(digitsOf));
  for (const id of others) {
    const other = await accountContacts(scope.deps, id);
    const name = fullNameOf(other.name);
    if (name && views.some((view) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'u').test(view))) return true;
    for (const email of other.emails) if (views.some((view) => view.includes(email.toLowerCase()))) return true;
    for (const phone of other.phones.map(digitsOf).filter((one) => one.length >= 7)) {
      if (digits.some((run) => samePhone(run, phone))) return true;
    }
  }
  return false;
}

/**
 * Refuses a written save (validation_failed, saying what to do) whose text holds a contact that is not the profile
 * owner's own (`sources`: the resume it is written from), or another reachable profile's identifying details.
 */
export async function refuseWrittenLeaks(scope: WrittenScope, value: unknown, sources: readonly string[] = []): Promise<void> {
  const texts = stringsOf(value).filter((text) => text.trim());
  if (texts.length === 0) return;
  // v34 INT-B (the random-id flake of mcp-tools and v33-share8-mcp2): copied fenced data first, as every caller screens
  // it before this, so a data id whose 12 hex digits hold a long run of decimal digits is refused as fenced data, never
  // as a phone number (contacts.ts PHONE_RUN has no word boundary).
  if (holdsFencedData(texts)) throw new AppError('validation_failed', CONTENT_REFUSALS.canary);
  const own = await ownContactsOf(scope.deps, scope.userId, sources);
  if (texts.some((text) => namesForeignContact(text, own))) throw new AppError('validation_failed', FOREIGN_CONTACT);
  if (await holdsOtherProfile(scope, texts)) throw new AppError('validation_failed', OTHER_PROFILE);
}

/** add_job's refusal of a link that carries the person's own contact details. */
export const LINK_CARRIES_CONTACT =
  "TailorIT did not add this link: its address carries the person's email address or phone number. Use the posting's " +
  'own link, without personal details.';

/**
 * v34 MCPDIR (the security review, finding 1): refuses a link to add whose path or query carries the email address or
 * phone number of the profile's owner or of the caller (TailorIT's server fetches the link as given, so a link built by
 * an instruction in a posting could send them to its host).
 */
export async function refuseLinkLeak(scope: WrittenScope, url: string): Promise<void> {
  let address = url;
  for (let pass = 0; pass < 3; pass += 1) {
    try {
      const decoded = decodeURIComponent(address.replace(/\+/g, ' '));
      if (decoded === address) break;
      address = decoded;
    } catch {
      break;
    }
  }
  const lower = address.normalize('NFKC').toLowerCase();
  const digitRuns = [...lower.matchAll(/\d[\d\s().-]{5,}\d/g)].map((run) => digitsOf(run[0]));
  for (const id of new Set([scope.userId, scope.caller.id])) {
    const person = await accountContacts(scope.deps, id);
    if (person.emails.some((email) => lower.includes(email.toLowerCase()))) throw new AppError('validation_failed', LINK_CARRIES_CONTACT);
    for (const phone of person.phones.map(digitsOf).filter((one) => one.length >= 7)) {
      if (digitRuns.some((run) => samePhone(run, phone))) throw new AppError('validation_failed', LINK_CARRIES_CONTACT);
    }
  }
}

/** v34 MCPDIR: an answer's text holding another reachable profile's details (save.ts answers; refused one by one). */
export const answerNamesOtherProfile = (scope: WrittenScope, text: string): Promise<boolean> => holdsOtherProfile(scope, [text]);
