import type { Request } from 'express';
import type { ResumeDocument } from '@tailorit/shared';
import { userOf } from '../../core/auth/guards';
import { getUserById } from '../../core/auth/users';
import type { AppDeps } from '../../core/context';
import { refuse } from '../../core/http/refuse';
import { readAutofillProfile } from '../autofill/profile/repository';
import { contactInText } from '../autofill/profile/upload-text';
import { documentOf, type ResumeRow } from './repository'; // v33 INT-C

// v33 SHARE-3 (PLAN F9; SP v33 PLAN-sharing.md §4 "Where applications go"): on a profile shared with them, B may edit
// A's resumes, but where employers write back stays A's: a resume B saves keeps the contact email and phone it had, and
// a resume B makes (a new one, an import, an editable copy B pays for) takes A's, from A's autofill profile (else A's
// sign-in address). B never sees the save refused for it; the two fields simply stay A's. The person's own saves are
// unchanged.
// The review: an upload is never changed (only its text is read), so an upload B makes on A's profile whose text shows an
// email or a phone that is not A's (the rule-based reading, contactInText) is refused before it is stored: it would
// carry B's (or anyone's) details to A's employers. An upload whose text shows neither is kept.
// v33 INT-C (the coordinator's decision): the email is always compared; the phone only when A has one on record (A's
// autofill profile, or A's own resumes: a built resume's contact, an upload's text), so an upload with a phone is not
// refused on a profile whose owner never gave one.

/** The two fields that stay the owner's. */
type LockedContact = { email: string; phone: string };

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

function withContact(document: ResumeDocument, contact: LockedContact): ResumeDocument {
  return { ...document, contact: { ...document.contact, email: contact.email, phone: contact.phone } };
}

/** Whether the request acts on a profile shared with the signed-in person (B's work on A's resumes). */
export const actsOnSharedProfile = (req: Request): boolean => Boolean(req.acting);

/** A save of an existing resume: while acting, the contact email and phone stay as stored. */
export function keepStoredContact(req: Request, document: ResumeDocument, stored: ResumeDocument | null): ResumeDocument {
  if (!actsOnSharedProfile(req) || !stored) return document;
  return withContact(document, { email: stored.contact.email, phone: stored.contact.phone });
}

/** The owner's contact as their autofill profile keeps it, with their sign-in address and name. */
async function ownerContactOf(deps: Deps, ownerId: string): Promise<{ email: string; phone: string; signInEmail: string; name: string }> {
  const owner = await getUserById(deps, ownerId);
  const { value: profile } = await readAutofillProfile(deps, ownerId);
  const signInEmail = owner?.email ?? '';
  return { email: profile.contact.email || signInEmail, phone: profile.contact.phone.number, signInEmail, name: owner?.name ?? '' };
}

/**
 * A new resume made on `ownerId`'s profile by someone else (an editable copy B pays for: resume_import's handler): its
 * contact email and phone are the owner's (their autofill profile's, else their sign-in address and no phone).
 */
export async function withOwnerContact(deps: Deps, ownerId: string, document: ResumeDocument): Promise<ResumeDocument> {
  const owner = await ownerContactOf(deps, ownerId);
  return withContact(document, { email: owner.email, phone: owner.phone });
}

/**
 * A new resume made while acting: its contact email and phone are the owner's (their autofill profile's, else their
 * sign-in address and no phone). Unchanged on the person's own profile.
 */
export async function ownerContactFor(deps: Deps, req: Request, document: ResumeDocument): Promise<ResumeDocument> {
  if (!actsOnSharedProfile(req)) return document;
  return withOwnerContact(deps, userOf(req).id, document);
}

/** A phone number's digits, its extension ("ext. 12", "x12", "#12") left out. */
const digitsOf = (phone: string) => phone.replace(/\s*(?:ext\.?|extension|x|#)\s*\d{1,8}\s*$/i, '').replace(/\D/g, '');

/**
 * Whether two phone numbers are one: the same digits, or one is the other with a country code before it (both of at
 * least 7 digits). A number the owner has not given is never theirs.
 */
export function samePhone(read: string, owners: string): boolean {
  const a = digitsOf(read);
  const b = digitsOf(owners);
  if (a.length < 7 || b.length < 7) return false;
  return a === b || a.endsWith(b) || b.endsWith(a);
}

/** How many of the owner's newest resumes are read for the phones they show (a bound on one upload's check). */
const PHONE_RESUMES_READ = 50;

/**
 * v33 INT-C: the phones the owner has on record: their autofill profile's, and those on their newest resumes (a built
 * resume's contact phone; the phone an upload's text shows). Only numbers samePhone can compare (7 digits or more).
 */
export async function ownerPhonesOf(deps: Pick<AppDeps, 'db'>, ownerId: string, profilePhone: string): Promise<string[]> {
  const rows = await deps.db.all<Pick<ResumeRow, 'kind' | 'data' | 'extracted_text'>>(
    'SELECT kind, data, extracted_text FROM resumes WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
    [ownerId, PHONE_RESUMES_READ],
  );
  const phones = [profilePhone];
  for (const row of rows) {
    if (row.kind === 'built') phones.push(documentOf(row)?.contact.phone ?? '');
    else if (row.extracted_text) phones.push(contactInText(row.extracted_text).phone);
  }
  return [...new Set(phones.filter((phone) => digitsOf(phone).length >= 7))];
}

/**
 * The review (uploads are never modified): an upload made while acting on someone else's profile whose text shows an
 * email that is not the owner's (their autofill profile's email or sign-in address), or a phone that is none of the
 * owner's on record (ownerPhonesOf; not compared when they have none), is refused (400 validation_failed,
 * MSG_SHARING_UPLOAD_CONTACT); one that shows neither is kept. A no-op on the person's own profile.
 */
export async function assertUploadContactIsOwners(deps: Deps, req: Request, text: string): Promise<void> {
  if (!actsOnSharedProfile(req)) return;
  const read = contactInText(text);
  if (!read.email && !read.phone) return;
  const owner = await ownerContactOf(deps, userOf(req).id);
  const emails = new Set([owner.email, owner.signInEmail].filter(Boolean).map((email) => email.toLowerCase()));
  const emailIsTheirs = !read.email || emails.has(read.email.toLowerCase());
  const phones = read.phone ? await ownerPhonesOf(deps, userOf(req).id, owner.phone) : [];
  const phoneIsTheirs = !read.phone || phones.length === 0 || phones.some((phone) => samePhone(read.phone, phone));
  if (emailIsTheirs && phoneIsTheirs) return;
  throw refuse(deps, 'validation_failed', 'MSG_SHARING_UPLOAD_CONTACT', { name: owner.name || userOf(req).name });
}
