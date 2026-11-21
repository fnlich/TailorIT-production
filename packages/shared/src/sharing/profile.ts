import { z } from 'zod';

// v33 SHARE-0 (PLAN F9; SP v33 PLAN-sharing.md §1, §2, §4): naming the profile a request acts on.
//
// A grant's id is its *profile key*: `p` and 11 base62 characters (about 65 bits), made at random once and never
// reused (a "Send again" makes a new grant and a new key). The web names the profile per tab, never in the server's
// session:
// - every API request sends the header PROFILE_HEADER: <key> (apiFetch; never to /api/auth/*);
// - a URL the browser loads itself (an <img>, a download link, window.open) carries ?profile=<key> (PROFILE_QUERY,
//   accepted on GET and HEAD only, and only where the route says so);
// - a page link carries ?as=<key|me> (PROFILE_AS_PARAM): the tab adopts that profile, then strips it from the address.
// A request that names a profile on a `self` route is served as the signed-in person; when the key is not live any more
// the answer says so in PROFILE_STATE_HEADER: ended.

/** A profile key: `p` and 11 characters of [0-9A-Za-z]. */
export const PROFILE_KEY_PATTERN = /^p[0-9A-Za-z]{11}$/;
/** The key's length. */
export const PROFILE_KEY_LENGTH = 12;
/** The alphabet of a key's 11 random characters. */
export const PROFILE_KEY_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export const ProfileKeySchema = z.string().regex(PROFILE_KEY_PATTERN).brand<'ProfileKey'>();
/** A profile key (a grant's id): only ProfileKeySchema, isProfileKey and the API's newProfileKey make one. */
export type ProfileKey = z.infer<typeof ProfileKeySchema>;

/** Whether `value` is a profile key in form (it says nothing about the grant). */
export const isProfileKey = (value: unknown): value is ProfileKey => typeof value === 'string' && PROFILE_KEY_PATTERN.test(value);

/** The signed-in person's own profile, where a choice of profile is made (`?as=me`, a combined view's `profile: 'me'`). */
export const PROFILE_SELF = 'me';
export type ProfileSelf = typeof PROFILE_SELF;
/** A choice of profile: the person's own (`me`) or a shared one (its key). There is no null. */
export const ProfileChoiceSchema = z.union([z.literal(PROFILE_SELF), ProfileKeySchema]);
export type ProfileChoice = z.infer<typeof ProfileChoiceSchema>;

/** The request header that names the profile a request acts on (every API request of an acting tab). */
export const PROFILE_HEADER = 'X-TailorIT-Profile';
/** The query parameter a browser-loaded API URL names the profile with (GET and HEAD only). */
export const PROFILE_QUERY = 'profile';
/** The page-link parameter: ?as=<key|me> makes the tab work on that profile. */
export const PROFILE_AS_PARAM = 'as';
/** The answer header of a `self` route asked with a key that is not live: its value is PROFILE_STATE_ENDED. */
export const PROFILE_STATE_HEADER = 'X-TailorIT-Profile-State';
export const PROFILE_STATE_ENDED = 'ended';
/** The web's sessionStorage key of the tab's profile ({accountId, key}): one per tab, read once per document. */
export const PROFILE_STORAGE_KEY = 'tailorit.profile';

/**
 * `path` (a path inside TailorIT, with or without a query and a hash) with ?as=<profile> set: a link that opens the page
 * on that profile (a notification's link, a combined view's card). An existing `as` is replaced.
 */
export function linkAs(path: string, profile: ProfileChoice): string {
  const hashAt = path.indexOf('#');
  const hash = hashAt >= 0 ? path.slice(hashAt) : '';
  const beforeHash = hashAt >= 0 ? path.slice(0, hashAt) : path;
  const queryAt = beforeHash.indexOf('?');
  const base = queryAt >= 0 ? beforeHash.slice(0, queryAt) : beforeHash;
  // The other parameters as they are (no URLSearchParams here: the shared package has no DOM library); `as` once, last.
  const kept = (queryAt >= 0 ? beforeHash.slice(queryAt + 1) : '')
    .split('&')
    .filter((pair) => pair !== '' && pair.split('=')[0] !== PROFILE_AS_PARAM);
  return `${base}?${[...kept, `${PROFILE_AS_PARAM}=${encodeURIComponent(profile)}`].join('&')}${hash}`;
}

// The canonical mailbox -------------------------------------------------------------------------------------------------

/** The domains whose mail ignores dots in the local part and that name one mailbox (googlemail.com is gmail.com). */
const GMAIL_DOMAINS: ReadonlySet<string> = new Set(['gmail.com', 'googlemail.com']);

/**
 * The mailbox an address reaches, for telling two spellings of one person's address apart (a person may not share
 * their profile with their own mailbox): trimmed and lower-cased, a `+tag` dropped from the local part, and on gmail.com
 * and googlemail.com the dots dropped and the domain read as gmail.com. Never stored, never shown.
 */
export function canonicalMailbox(email: string): string {
  const address = email.trim().toLowerCase();
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return address;
  let local = address.slice(0, at);
  let domain = address.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replace(/\./g, '');
    domain = 'gmail.com';
  }
  return `${local}@${domain}`;
}

/** Whether two addresses reach the same mailbox (canonicalMailbox). */
export const sameMailbox = (a: string, b: string): boolean => canonicalMailbox(a) === canonicalMailbox(b);
