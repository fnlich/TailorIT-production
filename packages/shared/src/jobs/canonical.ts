// v31 LINK: one canonical form of a job's link (docs/design/v3.1/21-jobs-from-links.md §2). Every write of a job's
// address (a job's Apply link, its `link` keys, a page job's link and aliases, a review's key, a tracker entry's
// posting link, an import's links, the add routes) goes through it, so no "?utm_source=..." or "?source=..." mark of
// how someone arrived at a posting is ever stored. ONE list of such marks (NOISE_*), read by `linkKey` (identity.ts)
// and the API's lookups alike: there is no second copy (v3.0's LINK_NOISE / LINK_KEEP_ONLY moved here).
//
// The form: https, the host in lower case (no trailing dot), no default port, no user name or password, no session
// matrix parameter (;jsessionid=...), one trailing slash dropped (the root keeps its "/"), the query without its noise
// and sorted by name then value, and no fragment, except one that names what a hash-routed careers page shows
// (#/jobs/101, #!/jobs/101, BrassRing's #jobDetails=111_5), itself without its noise (v31 FIX-LINK, REQ-2). The path
// keeps its case (boards put case-sensitive ids there). Pure string work, in every browser and in Node.
//
// v31 FIX-LINK (SEC-2): shareableJobUrl, the form a link takes when TailorIT stores or shares it from an add: the
// canonical form without a person's secret parameters (?email=, ?token=, ?session_id=, ...: the one list below).

interface UrlLike {
  protocol: string;
  hostname: string;
  port: string;
  pathname: string;
  hash: string;
  searchParams: Iterable<[string, string]>;
}

interface SearchParamsLike {
  toString(): string;
}

// URL and URLSearchParams exist in every browser and in Node; this package's lib types (ES only) do not declare them.
const runtime = globalThis as unknown as {
  URL?: new (input: string) => UrlLike;
  URLSearchParams?: new (init: Array<[string, string]>) => SearchParamsLike;
};

/**
 * Parameters that say how someone arrived at a posting, never which posting it is, on any host (compared in lower
 * case): ad and mail click ids (Google's gclid, dclid, gbraid, wbraid; Meta's fbclid; Microsoft's msclkid; Yandex's
 * yclid; Instagram's igshid; Mailchimp's mc_cid and mc_eid; Google Analytics' _ga and _gl; HubSpot's _hsenc, _hsmi,
 * __hstc, __hssc and __hsfp; Marketo's mkt_tok; Klaviyo's _kx; LinkedIn's li_fat_id and trk, trackingid; ConvertKit's
 * ck_subscriber_id; Omeda's oly_enc_id and oly_anon_id; Vero's vero_id and vero_conv; a cache buster's cb or _;
 * Impact's irclickid; TikTok's ttclid; Twitter's twclid; Pinterest's epik; Adobe's s_kwcid and ef_id; Branch's
 * _branch_match_id); the boards' own marks (Greenhouse's gh_src, Lever's lever-source and lever-origin, Jobright's
 * jr_id); and, by the owner's rule (2026-11-17), `source` and `src` of any value ("?source=Simplify", "&src=LinkedIn").
 */
const NOISE_NAMES: ReadonlySet<string> = new Set([
  'source',
  'src',
  'gclid',
  'dclid',
  'gbraid',
  'wbraid',
  'fbclid',
  'msclkid',
  'yclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  '_ga',
  '_gl',
  '_hsenc',
  '_hsmi',
  '__hstc',
  '__hssc',
  '__hsfp',
  'trk',
  'trackingid',
  'gh_src',
  'lever-source',
  'lever-origin',
  'jr_id',
  'mkt_tok',
  '_kx',
  'li_fat_id',
  'ck_subscriber_id',
  'oly_enc_id',
  'oly_anon_id',
  'vero_id',
  'vero_conv',
  'cb',
  '_',
  'irclickid',
  'ttclid',
  'twclid',
  'epik',
  's_kwcid',
  'ef_id',
  '_branch_match_id',
]);

/**
 * Name patterns of the same kind: every utm_* (utm_source=Simplify), every Simplify mark (simplify_ref, ...), and the
 * referral marks (ref, ref_src, ref_source, refid, ref_id, ref_type, ref_url, ref_page, referrer, referer, referral and
 * referral_source, referral_code, referral_id). A requisition's reference number (refno, reference, requisition) is no
 * referral mark and is kept.
 */
const NOISE_NAME_PATTERNS: readonly RegExp[] = [
  /^utm_/,
  /^simplify/,
  /^(?:ref|ref[_-]?(?:src|source|id|type|url|page)|referr?er|referral(?:[_-]?(?:source|code|id))?)$/,
];

/** Parameters that are noise on some hosts only: Ashby's `embed` on its board, iCIMS's inbound source and its name. */
const HOST_NOISE: ReadonlyArray<{ name: string; host: RegExp }> = [
  { name: 'embed', host: /^jobs\.ashbyhq\.com$/ },
  { name: 'iis', host: /\.icims\.com$/ },
  { name: 'iisn', host: /\.icims\.com$/ },
];

/**
 * Job boards whose posting pages name the posting in one or two parameters and carry a visit's own in every other
 * (Indeed's tk, from, vjs, advn, ...; Glassdoor's pos, ao, cs, ...): there every parameter but those is noise, so two
 * visits of one posting are one address. Indeed keeps jk and vjk; Glassdoor jl and jobListingId.
 */
const KEEP_ONLY: ReadonlyArray<{ host: RegExp; keep: ReadonlySet<string> }> = [
  { host: /(?:^|\.)indeed\.(?:com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/, keep: new Set(['jk', 'vjk']) },
  { host: /(?:^|\.)glassdoor\.(?:com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/, keep: new Set(['jl', 'joblistingid']) },
];

/**
 * Parameters that name a posting on the ATSs and careers platforms (Greenhouse's gh_jid, Ashby's ashby_jid, a jobId,
 * an id, a requisition's id, a posting's id, UltiPro's opportunityId, BrassRing's jobid, ...): always kept, whatever
 * their value looks like (an id that happens to read "indeed" is still the id).
 */
const POSTING_NAMES: ReadonlySet<string> = new Set([
  'gh_jid',
  'ashby_jid',
  'jobid',
  'job_id',
  'id',
  'jid',
  'job',
  'reqid',
  'req_id',
  'requisitionid',
  'requisition_id',
  'jobreqid',
  'postingid',
  'posting_id',
  'jobpostingid',
  'opportunityid',
  'jobcode',
  'jk',
  'vjk',
  'jl',
  'joblistingid',
]);

/**
 * A value that names a job board or an aggregator someone came from (Simplify, LinkedIn, Indeed, Glassdoor,
 * ZipRecruiter, Jobright, ...): such a parameter (?via=SimplifyJobs, ?channel=indeed) says how someone arrived, never
 * which posting it is, whatever its name. Compared lower case, trimmed; Taleo's job-board codes (JB-10120) too.
 */
const BOARD_VALUE =
  /^(?:simplify(?:[ ._-]?(?:jobs?|copilot))?|simplify\.jobs|linkedin(?:[ ._-]?(?:jobs?|feed|easy[ ._-]?apply))?|jobboard[ _-]linkedin|li|lnkd|indeed(?:[ ._-]?(?:jobs?|apply))?|glassdoor|ziprecruiter|zip[ _-]recruiter|jobright(?:\.ai)?|monster|dice|handshake|wellfound|angellist|angel\.co|builtin|built[ _-]in|otta|welcome[ ._-]?to[ ._-]?the[ ._-]?jungle|hired|google[ ._-]?jobs?|google[ ._-]for[ ._-]jobs|careerbuilder|snagajob|talent\.com|adzuna|jooble|lensa|teal(?:hq)?|huntr|jobscan|levels\.fyi|jb-\d{1,10})$/;

/** Whether `value` (as written in the address, decoded) names a job board or an aggregator (BOARD_VALUE). */
export function namesJobBoard(value: string): boolean {
  return BOARD_VALUE.test(value.trim().toLowerCase());
}

/**
 * Whether a query parameter is noise on `host` (lower case): never part of a canonical link or a link key. A
 * posting's own parameter (POSTING_NAMES) never is; on a keep-only board every parameter but its few is; elsewhere a
 * NOISE_NAMES name or pattern, a host's own noise, or any parameter whose value names a job board.
 */
export function isLinkNoise(name: string, value: string, host: string): boolean {
  const lower = name.toLowerCase();
  const board = KEEP_ONLY.find((rule) => rule.host.test(host));
  if (board) return !board.keep.has(lower);
  if (POSTING_NAMES.has(lower)) return false;
  if (NOISE_NAMES.has(lower) || NOISE_NAME_PATTERNS.some((pattern) => pattern.test(lower))) return true;
  if (HOST_NOISE.some((noise) => noise.name === lower && noise.host.test(host))) return true;
  return namesJobBoard(value);
}

/** Query parameters kept from a parsed address: noise dropped, then sorted by name, then value (linkKey's order). */
export function keptLinkParameters(params: Iterable<[string, string]>, host: string): Array<[string, string]> {
  return [...params]
    .filter(([name, value]) => !isLinkNoise(name, value, host))
    .sort(([a, aValue], [b, bValue]) => (a === b ? aValue.localeCompare(bValue) : a.localeCompare(b)));
}

/** A query string ("?a=1&b=2", or '') of these parameters, as WHATWG URLSearchParams writes it. */
export function linkQueryOf(params: Array<[string, string]>): string {
  if (params.length === 0) return '';
  const encoded = runtime.URLSearchParams
    ? new runtime.URLSearchParams(params).toString()
    : params.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&');
  return `?${encoded}`;
}

/** A path without its session matrix parameters (;jsessionid=..., ;sessionid=..., ;sid=...) and one trailing '/'. */
export function canonicalPath(pathname: string): string {
  let path = (pathname || '/').replace(/;(?:jsessionid|sessionid|phpsessid|sid)=[^/]*/gi, '');
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path || '/';
}

/** A fragment that names what a hash-routed page shows by its parameters (BrassRing's "#jobDetails=111_5"). */
const PARAMETER_FRAGMENT = /^#[A-Za-z_][\w.-]*=/;

/**
 * How a parameter fares in a stored link: kept with this value (a value cut at its ';', or as written), or null when it
 * goes. `name` as written (not lower-cased), `value` decoded.
 */
type ParameterRule = (name: string, value: string) => string | null;

/**
 * v31 FIX-LINK (REQ-2): a fragment's "a=1&b=2" part with each pair `rule` drops gone, the rest as written (a value the
 * rule cuts written again, encoded); '' when none is left.
 */
function fragmentPairs(query: string, rule: ParameterRule): string {
  const kept: string[] = [];
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const equals = pair.indexOf('=');
    const written = equals < 0 ? pair : pair.slice(0, equals);
    const value = equals < 0 ? '' : decodeSafe(pair.slice(equals + 1).replace(/\+/g, ' '));
    const decided = rule(decodeSafe(written), value);
    if (decided === null) continue;
    kept.push(decided === value ? pair : `${written}=${encodeURIComponent(decided)}`);
  }
  return kept.join('&');
}

/** The rule of the canonical form: a parameter that is noise on `host` (isLinkNoise) goes, any other stays as it is. */
const noiseRule =
  (host: string): ParameterRule =>
  (name, value) =>
    isLinkNoise(name, value, host) ? null : value;

/**
 * The fragment kept: one that names what a hash-routed page shows (a route "#/jobs/101" or "#!/jobs/101", with a query
 * or not; a parameter "#jobDetails=111_5"), holding no quote, angle bracket, backslash, space or control character;
 * '' for any other ("#apply", "#top"). v31 FIX-LINK (REQ-2): a route's query and a parameter fragment lose their noise
 * as the address's own query does (isLinkNoise on `host`: "#/jobs/101?utm_source=Simplify&lang=en" keeps "lang=en",
 * "#utm_source=Simplify" is no fragment); `rule` (the shared form's) may drop more.
 */
export function postingFragmentOf(hash: string, host = '', rule: ParameterRule = noiseRule(host)): string {
  if (!hash || hash === '#') return '';
  if (/["'<>`\\\s\p{Cc}]/u.test(hash)) return '';
  if (/^#!?\//.test(hash)) {
    const at = hash.indexOf('?');
    if (at < 0) return hash;
    const query = fragmentPairs(hash.slice(at + 1), rule);
    return query ? `${hash.slice(0, at)}?${query}` : hash.slice(0, at);
  }
  if (!PARAMETER_FRAGMENT.test(hash)) return '';
  const kept = fragmentPairs(hash.slice(1), rule);
  // What is left must still read as a parameter fragment, or the next canonical form would drop it (idempotence).
  return kept && PARAMETER_FRAGMENT.test(`#${kept}`) ? `#${kept}` : '';
}

/** The parsed address, or null for anything that is not an http(s) URL with a host. */
function parse(link: unknown): UrlLike | null {
  if (typeof link !== 'string' || !runtime.URL) return null;
  const trimmed = link.trim();
  if (!trimmed) return null;
  let url: UrlLike;
  try {
    url = new runtime.URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  return url;
}

/** The host as kept: lower case (URL already lowers it), a trailing dot dropped. */
function hostOf(url: UrlLike): string {
  return url.hostname.toLowerCase().replace(/\.+$/, '');
}

/** The port as kept: none for 80, 443 or none. */
function portOf(url: UrlLike): string {
  return url.port && url.port !== '80' && url.port !== '443' ? `:${url.port}` : '';
}

/**
 * A job's link in its one canonical form (see the top), or null for anything that is not an http(s) address with a
 * host. Idempotent: canonicalJobUrl(canonicalJobUrl(x)) === canonicalJobUrl(x), and linkKey(canonicalJobUrl(x)) ===
 * linkKey(x).
 */
export function canonicalJobUrl(link: unknown): string | null {
  const url = parse(link);
  if (!url) return null;
  const host = hostOf(url);
  if (!host) return null;
  const search = linkQueryOf(keptLinkParameters(url.searchParams, host));
  return `https://${host}${portOf(url)}${canonicalPath(url.pathname)}${search}${postingFragmentOf(url.hash, host)}`;
}

// v31 FIX-LINK (SEC-2): the parameters a link TailorIT stores for everyone never carries. v3.0 kept these rules in the
// API's page lookup (autofill/lookup.ts keptOnPage, for a page job's link and aliases); they are the one list here now,
// read by that lookup and by the shared form below, which every address the add pipeline stores or shares goes through
// (a job's Apply link and keys, a "Couldn't verify" row, a queued link, an answer's link). A person may paste their own
// personalised link (a recruiter's mail with ?email=...&token=...): it is read as given, and stored without them.

/**
 * Query parameters that carry a person's secret or lead elsewhere, never kept in a stored address in any form; compared
 * in lower case. These names, exactly: one-time passwords and codes, a session or signature id, a password, an email
 * address or user name, a magic link, OAuth's nonce, a JWT, auth, an HMAC, iCIMS's hashed id, a refresh, a cookie, a
 * bearer, an Authorization, CSRF and XSRF tokens, a signed URL's key pair (CloudFront) and access id (Google Cloud
 * Storage), SuccessFactors' session crumb and request parameters; the person's own details (a phone number, a name, a
 * birth date, an SSN, a candidate's or an applicant's id); and the addresses a page sends the person on to
 * (redirect_uri, returnUrl, next, continue, RelayState, callback, goto, dest, ...), which may carry a secret of their own.
 */
export const SECRET_LINK_PARAMETERS: ReadonlySet<string> = new Set([
  'otp',
  'totp',
  'mfa',
  'ott',
  'sid',
  'ssid',
  'sig',
  'pass',
  'pwd',
  'email',
  'mail',
  'username',
  'login_hint',
  'magic',
  'nonce',
  'jwt',
  'auth',
  'hmac',
  'hashed',
  'refresh',
  'cookie',
  'bearer',
  'csrf',
  'xsrf',
  'key-pair-id',
  '_s.crb',
  'requestparams',
  'redirect_uri',
  'redirect',
  'redirect_url',
  'returnurl',
  'return_url',
  'return_to',
  'returnto',
  'next',
  'continue',
  'relaystate',
  'callback',
  'goto',
  'dest',
  'destination',
  'authorization',
  'googleaccessid',
  'phone',
  'tel',
  'mobile',
  'firstname',
  'first_name',
  'lastname',
  'last_name',
  'fullname',
  'full_name',
  'dob',
  'birthdate',
  'birthday',
  'ssn',
  'candidateid',
  'candidate_id',
  'applicantid',
  'applicant_id',
]);

/**
 * ...and these patterns: a token of any kind (access_token, auth_token, authToken, __RequestVerificationToken, ...), a
 * secret (client_secret), a password, a session (jsessionid, PHPSESSID, session_id), a signature (X-Amz-Signature), a
 * credential (X-Amz-Credential), SAML's request and response, a magic link, a nonce, a one-time password, CSRF and XSRF
 * tokens, a bearer, a cookie, Amazon's and Google's signed-URL parameters, an API, access, private, app, client,
 * subscription or activation key, an auth code or key, a pass, PIN, access, security, MFA, SMS, one-time, activation,
 * verification or login code, an email address, and the links of a verification, a confirmation, an invitation, a
 * reset or a sign-in.
 */
export const SECRET_LINK_PARAMETER =
  /token|secret|passw|session|sessid|signature|credential|saml|magic|nonce|otp|csrf|xsrf|bearer|cookie|^x-amz-|^x-goog-|^aws|api[_-]?key|access[_-]?key|private[_-]?key|(?:app|client|subscription|activation)[_-]?key$|(?:^|[_.-])auth(?:$|[_.-]|code|key|z)|^oauth|(?:^|[_.-])(?:pass|pin|access|security|mfa|sms|otp|one[_-]?time|activation|verification|login)[_-]?code$|e-?mail|verif|confirm|invit|reset|login|logon|signin|sign-in/;

/**
 * Names that may carry a secret or may name the posting (a sign-in code or a job's code, an API key or a posting's key,
 * OAuth's state or a US state, a user or a hiring manager, a hash, a PIN, a ticket or a requisition's, a signed URL's
 * policy and expiry or a site's): never stored as written. A page alias keeps such a value only as its keyed hash (the
 * API's aliasValueHash), so two postings stay apart and the value cannot be read back; a shared link keeps none of them.
 */
export const AMBIGUOUS_LINK_PARAMETERS: ReadonlySet<string> = new Set([
  'code',
  'key',
  'state',
  'user',
  'uid',
  'userid',
  'user_id',
  'hash',
  'pin',
  'ticket',
  'policy',
  'expires',
]);

/** A value that is itself a signed token (a JWT: base64url header starting "eyJ", a payload, a signature). */
const TOKEN_VALUE = /^(?:bearer\s+)?eyJ[\w-]{4,}\.[\w-]{4,}\./i;

/** A one-letter parameter's value that looks like a token: over 32 characters of base64, base64url or hex. */
const TOKEN_LIKE = /^[A-Za-z0-9+/_=-]{33,}$/;

/** The longest value a parameter keeps as written: a longer one (a return address, an encoded blob) is hashed or dropped. */
export const LINK_PARAMETER_MAX = 200;

/** How a stored address keeps a parameter: as written, dropped, or (a page alias's) only as its keyed hash. */
export type LinkParameterKept = 'keep' | 'drop' | 'hash';

/** How a stored address keeps a parameter (its name in lower case, its value decoded): see the lists above. */
export function linkParameterKept(name: string, value: string): LinkParameterKept {
  if (SECRET_LINK_PARAMETERS.has(name) || SECRET_LINK_PARAMETER.test(name) || TOKEN_VALUE.test(value)) return 'drop';
  if (name.length === 1 && TOKEN_LIKE.test(value)) return 'drop';
  if (AMBIGUOUS_LINK_PARAMETERS.has(name) || value.length > LINK_PARAMETER_MAX) return 'hash';
  return 'keep';
}

/** Whether a parameter's name (in lower case) is one TailorIT never keeps as written: a secret's or an ambiguous. */
export function secretOrAmbiguousName(name: string): boolean {
  return SECRET_LINK_PARAMETERS.has(name) || SECRET_LINK_PARAMETER.test(name) || AMBIGUOUS_LINK_PARAMETERS.has(name);
}

/** A value as a stored address keeps it: up to its first ';' (a server may read what follows as parameters). */
const cutAtSemicolon = (value: string): string => (value.includes(';') ? value.slice(0, value.indexOf(';')) : value);

/**
 * v31 FIX-LINK (SEC-2): a job's link as TailorIT stores and shares it: its canonical form (canonicalJobUrl) without a
 * secret's, an ambiguous or an over-long parameter (linkParameterKept: only `keep` stays), in its query and in a kept
 * fragment's, each value up to its first ';'. `named` ("<name in lower case>=<value>"): parameters the posting's own
 * address names, kept whatever they look like (the API's postingParameters: JobDiva's agency key `a`). Null for what is
 * no link. Idempotent, and canonicalJobUrl(shareableJobUrl(x)) === shareableJobUrl(x).
 */
export function shareableJobUrl(link: unknown, named: ReadonlySet<string> = new Set()): string | null {
  const url = parse(canonicalJobUrl(link));
  if (!url) return null;
  const host = hostOf(url);
  const rule: ParameterRule = (name, value) => {
    const lower = name.toLowerCase();
    const cut = cutAtSemicolon(value);
    if (named.has(`${lower}=${cut}`)) return cut;
    if (isLinkNoise(name, cut, host)) return null;
    return linkParameterKept(lower, cut) === 'keep' ? cut : null;
  };
  const params: Array<[string, string]> = [];
  for (const [name, value] of url.searchParams) {
    const kept = rule(name, value);
    if (kept !== null) params.push([name, kept]);
  }
  const fragment = postingFragmentOf(url.hash, host, rule);
  return canonicalJobUrl(`https://${host}${portOf(url)}${canonicalPath(url.pathname)}${linkQueryOf(params)}${fragment}`);
}

/**
 * The address with only its noise parameters removed (the rest kept as written, in their order), its scheme, host and
 * path untouched: for an address stored in a form of its own (a page alias whose values may be hashed), so a noise
 * mark stored before v3.1 can be dropped without rewriting anything else. The address as it is when it has none, or is
 * no address.
 */
export function withoutLinkNoise(address: string): string {
  const at = address.indexOf('?');
  if (at < 0) return address;
  const hash = address.indexOf('#', at);
  const query = hash < 0 ? address.slice(at + 1) : address.slice(at + 1, hash);
  const rest = hash < 0 ? '' : address.slice(hash);
  const host = /^https?:\/\/(?:[^@/?#]*@)?([^/:?#]+)/i.exec(address)?.[1]?.toLowerCase() ?? '';
  const kept: string[] = [];
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const equals = pair.indexOf('=');
    const name = decodeSafe(equals < 0 ? pair : pair.slice(0, equals));
    const value = equals < 0 ? '' : decodeSafe(pair.slice(equals + 1).replace(/\+/g, ' '));
    if (!isLinkNoise(name, value, host)) kept.push(pair);
  }
  return `${address.slice(0, at)}${kept.length > 0 ? `?${kept.join('&')}` : ''}${rest}`;
}

function decodeSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
