import {
  PROFILE_AS_PARAM,
  PROFILE_HEADER,
  PROFILE_QUERY,
  PROFILE_SELF,
  PROFILE_STATE_ENDED,
  PROFILE_STORAGE_KEY,
  SHARING_PROFILES_PATH,
  SHARING_SETTINGS_PATH,
  isProfileKey,
  type ProfileChoice,
  type ProfileKey,
} from '@tailorit/shared/sharing';

// v33 SHARE-4 (PLAN F9; SP v33 PLAN-sharing.md §4 "Naming the profile", §9 "Web UX"): the profile this tab works on.
//
// A person (B) may work on a profile someone shared with them (A's). The choice lives per tab, never on the server:
// sessionStorage[PROFILE_STORAGE_KEY] = {accountId, key} ("me" for B's own). It is read ONCE per document, when this
// module loads (before React Query sends anything), into the document's profile: every API request of the page carries
// exactly that profile (apiFetch's header, profileHeaders() on the raw fetches, profileUrl() on browser-loaded API
// addresses), its keepalive saves at unload included. A switch never changes it in place: it waits for the editors'
// saves (registerFlush), writes the new choice, and loads the section's list page (a new document, an empty cache).
// - A page link may carry ?as=<key|me> (PROFILE_AS_PARAM). Read here at load; from this site (a same-origin referrer:
//   the bell, a combined view's card, a new tab opened from an acting tab) the tab takes it at once; from anywhere else
//   the shell asks first (pendingAs). The shell strips it from the address once the page has hydrated.
// - The binding: the choice remembers whose it is. When GET /api/auth/me names another account, a shared key is dropped
//   and the page loads again on that person's own profile (bindAccount).
// - Sign-out and the sign-in page forget the choice (forgetProfile).
// - The API refuses a key that is not live (profile_ended, or the X-TailorIT-Profile-State: ended answer of a `self`
//   route): profileAnswer() tells the shell, which goes back to the person's own profile with a notice.
// Nothing here is React; the shell's hooks are in components/shell/profile.

/** The choice as it is stored for the tab. `key` null: the person's own profile. */
export interface StoredProfile {
  /** The account the choice was made for; null while it is not known yet (a ?as= taken before sign-in answered). */
  accountId: string | null;
  key: ProfileKey | null;
}

/** A word the shell says once after a reload it caused: the shared profile ended, or the tab went back to its own. */
export type ProfileNotice = { kind: 'ended'; name: string | null } | { kind: 'back' };

/** sessionStorage's one-shot notice (read and removed when the next document starts). */
export const PROFILE_NOTICE_KEY = 'tailorit.profile.notice';

/** What a document starts with: its profile, and what the address's ?as= asked for. */
export interface ProfileBoot {
  /** The profile this document works on: null is the person's own. */
  key: ProfileKey | null;
  /** The account the stored choice belongs to (null: not known). */
  accountId: string | null;
  /** The address carried ?as= (valid or not): the shell takes it out of the address after hydration. */
  sawAs: boolean;
  /** An outside ?as= that names another profile than the tab's: the shell asks first. */
  pendingAs: ProfileChoice | null;
  /** The choice to store now (a same-origin ?as= adopted), else null. */
  write: StoredProfile | null;
}

/** The server's start (no window): the person's own profile, nothing asked. */
const SERVER_BOOT: ProfileBoot = { key: null, accountId: null, sawAs: false, pendingAs: null, write: null };

/** The stored choice from its JSON, or null when there is none or it is not one. */
export function parseStoredProfile(text: string | null | undefined): StoredProfile | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const accountId = typeof record.accountId === 'string' && record.accountId ? record.accountId : null;
    if (record.key === PROFILE_SELF || record.key === null) return { accountId, key: null };
    if (isProfileKey(record.key)) return { accountId, key: record.key };
    return null;
  } catch {
    return null;
  }
}

/** The JSON the tab stores: {"accountId": "...", "key": "<key>" | "me"}. */
export function storedProfileText(stored: StoredProfile): string {
  return JSON.stringify({ accountId: stored.accountId, key: stored.key ?? PROFILE_SELF });
}

/** A profile choice from a link's text: "me", a key, or null when it is neither. */
export function parseChoice(value: string | null | undefined): ProfileChoice | null {
  if (value === PROFILE_SELF) return PROFILE_SELF;
  return isProfileKey(value) ? value : null;
}

/** The key a choice names (null for "me"). */
export const keyOfChoice = (choice: ProfileChoice): ProfileKey | null => (choice === PROFILE_SELF ? null : choice);
/** The choice a key names ("me" for null). */
export const choiceOfKey = (key: ProfileKey | null): ProfileChoice => key ?? PROFILE_SELF;

function sameOrigin(referrer: string, origin: string): boolean {
  if (!referrer) return false;
  try {
    return new URL(referrer).origin === origin;
  } catch {
    return false;
  }
}

/**
 * The document's profile from what the tab stored, the address's query and the referrer (pure: the tests and the
 * module's own start call it). A ?as= naming another profile is taken at once from a same-origin referrer and left
 * for the shell to ask about from anywhere else; one naming the tab's own profile changes nothing.
 */
export function bootProfile(input: { stored: string | null; search: string; referrer: string; origin: string }): ProfileBoot {
  const stored = parseStoredProfile(input.stored);
  const params = new URLSearchParams(input.search);
  const sawAs = params.has(PROFILE_AS_PARAM);
  const asked = sawAs ? parseChoice(params.get(PROFILE_AS_PARAM)) : null;
  const base: ProfileBoot = { key: stored?.key ?? null, accountId: stored?.accountId ?? null, sawAs, pendingAs: null, write: null };
  if (!asked) return base;
  const askedKey = keyOfChoice(asked);
  if (askedKey === base.key) return base;
  if (!sameOrigin(input.referrer, input.origin)) return { ...base, pendingAs: asked };
  return { ...base, key: askedKey, write: { accountId: base.accountId, key: askedKey } };
}

// The tab's storage -------------------------------------------------------------------------------------------------

function session(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function readSession(key: string): string | null {
  try {
    return session()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeSession(key: string, value: string | null): void {
  try {
    const store = session();
    if (value === null) store?.removeItem(key);
    else store?.setItem(key, value);
  } catch {
    // A tab that cannot store keeps working on its own profile after the next load.
  }
}

/** The tab's stored choice now (it may differ from the document's after a switch is written). */
export function readStoredProfile(): StoredProfile | null {
  return parseStoredProfile(readSession(PROFILE_STORAGE_KEY));
}

/** Stores the tab's choice for the next document (a switch, an adopted ?as=, the binding). */
export function rememberProfile(stored: StoredProfile): void {
  writeSession(PROFILE_STORAGE_KEY, storedProfileText(stored));
}

// The document's profile (read once) ---------------------------------------------------------------------------------

let boot: ProfileBoot | null = null;
let notice: ProfileNotice | null = null;

function start(): ProfileBoot {
  if (boot) return boot;
  if (typeof window === 'undefined') return SERVER_BOOT;
  boot = bootProfile({
    stored: readSession(PROFILE_STORAGE_KEY),
    search: window.location.search,
    referrer: typeof document === 'undefined' ? '' : document.referrer,
    origin: window.location.origin,
  });
  if (boot.write) rememberProfile(boot.write);
  notice = parseNotice(readSession(PROFILE_NOTICE_KEY));
  writeSession(PROFILE_NOTICE_KEY, null);
  return boot;
}

// Read when the module loads: before any component renders or any request is sent.
start();

/** The profile this document works on: a key, or null for the person's own. Fixed for the document's life. */
export function documentProfile(): ProfileKey | null {
  return start().key;
}

/** The document's profile as a choice ("me" or a key). */
export function documentChoice(): ProfileChoice {
  return choiceOfKey(documentProfile());
}

/** Whether this document works on a profile shared with the person (not their own). */
export function isActing(): boolean {
  return documentProfile() !== null;
}

function parseNotice(text: string | null): ProfileNotice | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as { kind?: unknown; name?: unknown };
    if (value.kind === 'back') return { kind: 'back' };
    if (value.kind === 'ended') return { kind: 'ended', name: typeof value.name === 'string' && value.name ? value.name : null };
  } catch {
    // none
  }
  return null;
}

/** The notice the last document left for this one (once: a second call answers null). */
export function takeProfileNotice(): ProfileNotice | null {
  start();
  const taken = notice;
  notice = null;
  return taken;
}

/** Leaves `next` for the next document of this tab (shown once). */
export function leaveProfileNotice(next: ProfileNotice): void {
  writeSession(PROFILE_NOTICE_KEY, JSON.stringify(next));
}

/**
 * The account check, when GET /api/auth/me answers: the tab's choice was made for `accountId`, or (made before the
 * account was known) is now bound to it. `reload`: the choice was another account's and this document works on a
 * shared profile; the key is dropped and the caller loads the page again on the person's own profile.
 */
export function bindAccount(accountId: string): 'ok' | 'reload' {
  const current = start();
  if (current.accountId !== null && current.accountId !== accountId) {
    // The choice was another account's: never carried over to this one.
    rememberProfile({ accountId, key: null });
    if (current.key !== null) return 'reload';
    boot = { ...current, accountId };
    return 'ok';
  }
  if (current.accountId === null) {
    boot = { ...current, accountId };
    // Bound to this account; a newer choice a switch has written on its way out is kept as it is.
    const stored = readStoredProfile();
    if (!stored || stored.key === current.key) rememberProfile({ accountId, key: current.key });
  }
  return 'ok';
}

/**
 * Sign-out and the sign-in page: the tab forgets its profile. `document` also puts this document back on the
 * person's own profile (the sign-in page, whose next page is reached without a load); requests to /api/auth/* never
 * carried a profile anyway.
 */
export function forgetProfile(options: { document?: boolean } = {}): void {
  writeSession(PROFILE_STORAGE_KEY, null);
  writeSession(PROFILE_NOTICE_KEY, null);
  if (options.document) {
    boot = { ...SERVER_BOOT };
    notice = null;
  }
}

// What a request carries --------------------------------------------------------------------------------------------

/** The paths that never name a profile: sign-in, sign-out and the session's own account. */
export function isAuthPath(path: string): boolean {
  return path === '/api/auth' || path.startsWith('/api/auth/') || path.startsWith('/api/auth?');
}

function isApiPath(path: string): boolean {
  return path.startsWith('/api/');
}

/**
 * The profile key a request to `path` names: the per-call choice (`profile`: "me" names none) or the document's, never
 * for /api/auth/* or a path outside the API.
 */
export function profileKeyFor(path: string, profile?: ProfileChoice): ProfileKey | null {
  if (!isApiPath(path) || isAuthPath(path)) return null;
  return profile === undefined ? documentProfile() : keyOfChoice(profile);
}

/**
 * The header a raw fetch() of `path` adds (the three bypass sites: downloads and the CSV export): the profile header
 * while the document (or `profile`) names a shared profile, else nothing.
 */
export function profileHeaders(path: string, profile?: ProfileChoice): Record<string, string> {
  const key = profileKeyFor(path, profile);
  return key ? { [PROFILE_HEADER]: key } : {};
}

/**
 * An API address the browser loads itself (an <img>, a download link, window.open, a server-made download URL) with
 * ?profile=<key> added while the document (or `profile`) names a shared profile; unchanged otherwise. The API takes the
 * query form on GET and HEAD only, on the routes that say so.
 */
export function profileUrl(url: string, profile?: ProfileChoice): string {
  // A server-made address may be absolute: this site's is handled as its path, another site's is left alone.
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    if (typeof window === 'undefined') return url;
    try {
      const parsed = new URL(url);
      if (parsed.origin !== window.location.origin) return url;
      const relative = profileUrl(`${parsed.pathname}${parsed.search}${parsed.hash}`, profile);
      return relative === `${parsed.pathname}${parsed.search}${parsed.hash}` ? url : `${parsed.origin}${relative}`;
    } catch {
      return url;
    }
  }
  const hashAt = url.indexOf('#');
  const hash = hashAt >= 0 ? url.slice(hashAt) : '';
  const base = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const path = base.split('?')[0] ?? base;
  const key = profileKeyFor(path, profile);
  if (!key) return url;
  const kept = (base.includes('?') ? base.slice(base.indexOf('?') + 1) : '')
    .split('&')
    .filter((pair) => pair !== '' && pair.split('=')[0] !== PROFILE_QUERY);
  return `${path}?${[...kept, `${PROFILE_QUERY}=${encodeURIComponent(key)}`].join('&')}${hash}`;
}

// What an answer says ------------------------------------------------------------------------------------------------

/** The refusals the shell explains (a GET's is the page's to show inline; a write's is one alert). */
export type ProfileRefusalCode = 'profile_not_shared' | 'own_profile_only';

export type ProfileEvent =
  /** The document's own shared profile is not live any more (refused, or a `self` route said so). */
  | { kind: 'ended'; key: ProfileKey }
  /** A per-call profile (a combined view's card) is not live any more: the view reads its list again. */
  | { kind: 'gone'; key: ProfileKey }
  /** A request on a shared profile was refused for its permission or its kind. */
  | { kind: 'refused'; code: ProfileRefusalCode; method: string; path: string; message: string; key: ProfileKey }
  /** A switch stayed put: an editor's change could not be saved first (the shell says so once). */
  | { kind: 'unsaved' };

type Listener = (event: ProfileEvent) => void;
const listeners = new Set<Listener>();

/** Hears what answers say about profiles (the shell's runtime, a combined view). Returns the way to stop. */
export function onProfileEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(event: ProfileEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      // One listener's failure never stops another's.
    }
  }
}

/**
 * apiFetch's word on each answer to a request that named `sentKey`: an ended profile (the refusal, or a `self` route's
 * state header) and the refusals of a shared profile become events. Answers of requests that named none say nothing.
 */
export function profileAnswer(answer: {
  sentKey: ProfileKey | null;
  path: string;
  method: string;
  stateHeader: string | null;
  code?: string;
  message?: string;
}): void {
  const { sentKey } = answer;
  if (!sentKey) return;
  const ended = answer.code === 'profile_ended' || answer.stateHeader === PROFILE_STATE_ENDED;
  if (ended) {
    emit({ kind: sentKey === documentProfile() ? 'ended' : 'gone', key: sentKey });
    return;
  }
  if (answer.code === 'profile_not_shared' || answer.code === 'own_profile_only') {
    emit({ kind: 'refused', code: answer.code, method: answer.method, path: answer.path, message: answer.message ?? '', key: sentKey });
  }
}

// Switching ----------------------------------------------------------------------------------------------------------

type Flush = () => Promise<unknown>;
const flushes = new Set<Flush>();

/**
 * An editor's "save what is left now" (the resume editor's queue, the letter and template autosave): a switch waits
 * for every one before it leaves the document. Returns the way to stop.
 */
export function registerFlush(flush: Flush): () => void {
  flushes.add(flush);
  return () => flushes.delete(flush);
}

/** How long a switch waits for the editors' saves. */
export const SWITCH_FLUSH_TIMEOUT_MS = 10_000;

/** Runs every registered flush: true when all of them saved (within `timeoutMs`). */
export async function flushEditors(timeoutMs = SWITCH_FLUSH_TIMEOUT_MS): Promise<boolean> {
  if (flushes.size === 0) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const all = Promise.allSettled([...flushes].map((flush) => flush())).then((results) => results.every((result) => result.status === 'fulfilled'));
  try {
    return await Promise.race([all, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The list page of the section `pathname` is in, with no object ids (a switch lands there: what the address named
 * belonged to the other profile). `toShared`: pages that are never done on a shared profile go to Jobs.
 */
export function sectionListPath(pathname: string, toShared: boolean): string {
  const inside = (prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);
  if (toShared && OWN_ONLY_PATHS.some(inside)) return '/jobs';
  if (inside('/settings/integrations') || inside('/settings/admin') || inside(SHARING_SETTINGS_PATH)) return pathname.split('/').slice(0, 3).join('/');
  if (inside('/settings/autofill')) return '/settings/autofill';
  if (inside('/settings')) return '/settings';
  if (inside('/tracker')) return '/tracker';
  if (inside('/auto-apply')) return '/auto-apply';
  if (inside('/notifications')) return '/notifications';
  if (inside(SHARING_PROFILES_PATH)) return SHARING_PROFILES_PATH;
  if (inside('/help')) return '/help'; // v34 HELP: the guide is the same on every profile
  if (inside('/resumes')) return '/documents?tab=resumes';
  if (inside('/cover-letter-template')) return '/documents?tab=templates';
  if (inside('/cover-letter')) return '/documents?tab=letters';
  if (inside('/documents')) return '/documents';
  return '/jobs';
}

/** Pages that are only ever the person's own (opening one while on a shared profile switches the tab back first). */
export const OWN_ONLY_PATHS: readonly string[] = ['/settings/integrations', '/settings/admin', SHARING_SETTINGS_PATH, '/oauth/consent'];

/** Whether `pathname` is a page only ever done on the person's own profile. */
export function isOwnOnlyPath(pathname: string | null): boolean {
  if (!pathname) return false;
  return OWN_ONLY_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export interface SwitchOptions {
  /** Where the new document opens (default: the section's list page). A path inside TailorIT. */
  to?: string;
  /** The account the choice is for (default: the one the tab is bound to). */
  accountId?: string | null;
  /** A word for the next document (the shell's toast or alert). */
  notice?: ProfileNotice;
  /** Leave without waiting for the editors (the profile ended: their saves are refused anyway). */
  force?: boolean;
}

export type SwitchResult = { ok: true } | { ok: false; reason: 'unsaved' };

/** How a switch leaves the document (window.location.assign; the tests replace it). */
export interface SwitchHost {
  assign(url: string): void;
  pathname(): string;
}

const browserHost: SwitchHost = {
  assign: (url) => window.location.assign(url),
  pathname: () => window.location.pathname,
};

/**
 * Switches the tab to `choice`: waits for the editors' saves (refusing when one did not save: nothing unsaved is
 * carried over), stores the choice, and loads `to` (the section's list page) as a new document. The same profile as
 * the document's goes to `to` only when one is given.
 */
export async function switchProfile(choice: ProfileChoice, options: SwitchOptions = {}, host: SwitchHost = browserHost): Promise<SwitchResult> {
  const key = keyOfChoice(choice);
  if (!options.force && !(await flushEditors())) {
    emit({ kind: 'unsaved' });
    return { ok: false, reason: 'unsaved' };
  }
  const accountId = options.accountId === undefined ? start().accountId : options.accountId;
  rememberProfile({ accountId, key });
  if (options.notice) leaveProfileNotice(options.notice);
  const to = options.to !== undefined && options.to.startsWith('/') && !options.to.startsWith('//') ? options.to : sectionListPath(host.pathname(), key !== null);
  host.assign(to);
  return { ok: true };
}

// Links ---------------------------------------------------------------------------------------------------------------

/** The ?as= a page link names, or null when it names none (it belongs to the person's own profile then). */
export function linkProfileOf(href: string): ProfileChoice | null {
  const queryAt = href.indexOf('?');
  if (queryAt < 0) return null;
  const hashAt = href.indexOf('#', queryAt);
  return parseChoice(new URLSearchParams(href.slice(queryAt + 1, hashAt >= 0 ? hashAt : undefined)).get(PROFILE_AS_PARAM));
}

/** `href` without its ?as= (the address a page shows: the tab, not the address, holds the profile). */
export function withoutAs(href: string): string {
  const hashAt = href.indexOf('#');
  const hash = hashAt >= 0 ? href.slice(hashAt) : '';
  const base = hashAt >= 0 ? href.slice(0, hashAt) : href;
  const queryAt = base.indexOf('?');
  if (queryAt < 0) return href;
  const kept = base
    .slice(queryAt + 1)
    .split('&')
    .filter((pair) => pair !== '' && pair.split('=')[0] !== PROFILE_AS_PARAM);
  return `${base.slice(0, queryAt)}${kept.length ? `?${kept.join('&')}` : ''}${hash}`;
}

/**
 * The address a new tab opened from an acting tab should load: `href` with ?as=<key> when it is a page of this site
 * (not an API address, not one that names a profile already); null when it should be left alone.
 */
export function newTabHref(href: string, key: ProfileKey, origin: string): string | null {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || !/^https?:$/.test(url.protocol)) return null;
  if (url.pathname.startsWith('/api/') || url.pathname === '/login' || url.pathname.startsWith('/login/')) return null;
  if (url.searchParams.has(PROFILE_AS_PARAM)) return null;
  url.searchParams.set(PROFILE_AS_PARAM, key);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The scope of the editors' local copies: one per account and profile ("<accountId>.<key|me>"). */
export function localCopyScope(accountId: string, key: ProfileKey | null = documentProfile()): string {
  return `${accountId}.${key ?? PROFILE_SELF}`;
}
