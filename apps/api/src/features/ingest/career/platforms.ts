import { boardDescriptorOfHost, LATER_BOARD_SOURCE_KINDS } from '@tailorit/shared/sourcing'; // v38 INT

// v30 FIX-A (REV-REQ REQ-5; docs/design/part2/12-job-sourcing.md §3.4): the employers on ATS platforms with no public
// API (iCIMS, Oracle, SuccessFactors, Taleo, UKG, Teamtailor) are what career pages are for, so a host such a platform
// gives ONE employer is a career site, even though its registrable domain is the platform's. Only the per-employer
// host forms are listed (each is the employer's alone, so robots.txt and the per-host pace apply to that employer):
//   iCIMS          careers-acme.icims.com, jobs-acme.icims.com, acme.icims.com
//   Taleo          acme.taleo.net
//   Oracle         eeho.fa.us2.oraclecloud.com (Fusion HCM's candidate experience: <pod>.fa.<data centre>)
//   SuccessFactors acme.jobs.hr.cloud.sap (the career site builder's hosts)
//   UKG            acme.rec.pro.ukg.net (UKG Pro Recruiting)
//   Teamtailor     acme.teamtailor.com
// Platforms that serve every employer from one shared host (ADP's workforcenow.adp.com and myjobs.adp.com, Paycom's
// www.paycomonline.net, UKG's older recruiting.ultipro.com, SuccessFactors' career<N>.successfactors.com, all keyed by
// a path or a query) are no career site: one host there is every employer at once. Their employers' own domains (a
// jobs.acme.com in front of the platform) are career sites already. Still behind SITE_READER_CAREER_PAGES.
//
// v37 BOARDS (SP v37 PLAN I1, I5): an iCIMS host is no career site any more: it is an `icims` source's board (its host's
// first label, careers-acme for careers-acme.icims.com: ICIMS_BOARD_HOST below), read by its sitemap through the ingest
// client (adapters/icims.ts), never behind SITE_READER_CAREER_PAGES. Discovery offers it as an `icims` candidate
// (discovery/boards.ts). An employer's own domain in front of iCIMS (jobs.acme.com) stays a career site.

/** Per-employer hosts of the platforms above (lower case, no trailing dot). */
const EMPLOYER_PLATFORM_HOSTS: readonly RegExp[] = [
  /^(?!(?:www|api|login|status|support|cdn|static)\.)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.taleo\.net$/,
  /^[a-z0-9]{2,30}\.fa\.[a-z0-9]{2,10}\.oraclecloud\.com$/,
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.jobs\.hr\.cloud\.sap$/,
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.rec\.pro\.ukg\.net$/,
  /^(?!(?:www|app|api|career|careers|support|status|cdn|static|help|blog)\.)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.teamtailor\.com$/,
];

/**
 * The shared hosts of those platforms that the companies' list of shared domains does not name (Paycom's): never a
 * career site.
 */
const SHARED_PLATFORM_DOMAINS: readonly string[] = ['paycomonline.net', 'paycomonline.com'];

/** Whether a host (lower case) is one of the shared hosts above, or under one. */
export function isSharedPlatformHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.+$/, '');
  return SHARED_PLATFORM_DOMAINS.some((domain) => name === domain || name.endsWith(`.${domain}`));
}

/** Whether a host (lower case) is one employer's on an ATS platform with no public API (see the top). */
export function isEmployerPlatformHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.+$/, '');
  return EMPLOYER_PLATFORM_HOSTS.some((pattern) => pattern.test(name));
}

// v38 INT (SP v38 PLAN A9, FRAME open item 7) ------------------------------------------ board-kind hosts

/**
 * THE rule, kept here alone: a host a board kind claims (@tailorit/shared/sourcing boardDescriptorOfHost: a Teamtailor
 * company's, Taleo's, Oracle's, UKG's, Avature's, Paylocity's...) is that kind's board, never a career site, even where
 * the list above still names its host form (those employers' links read as their platform's postings now). Its readers:
 * discovery/boards.ts careerSiteOfUrl and career/discover.ts careerSiteHostOf (so offerCareerSites) never offer one, and
 * terms.ts keptCareerSiteOf still lets a career site a server kept on one from before answer for its links' terms.
 */
export function isBoardKindHost(host: string): boolean {
  return boardDescriptorOfHost(host) !== null;
}

/**
 * Whether a host is a board kind's since v3.8 (a kind of LATER_BOARD_SOURCE_KINDS: Teamtailor, Taleo, Oracle, UKG,
 * Avature...): a career site may have been kept on it from before its kind existed (terms.ts keptCareerSiteOf). v3.7's
 * kinds' hosts (Greenhouse's, iCIMS's...) were boards already: no career site was made there since.
 */
export function isNewBoardKindHost(host: string): boolean {
  const owner = boardDescriptorOfHost(host);
  return owner !== null && (LATER_BOARD_SOURCE_KINDS as readonly string[]).includes(owner.kind);
}

// v38 FIX-C (SP v38 FIXES-38 D3; REVIEW38-beh H2, M13) ------------------------------------------ hosts never read

/**
 * The board kinds whose hosts TailorIT never sends a request to, by any path (a link, a page read, a career site, its
 * robots.txt), and the can't-read reason each answers: SAP SuccessFactors (robots.txt disallows every page), Phenom (an
 * AWS WAF bot check on every request, robots.txt too) and JobDiva (a portal gated by Turnstile and reCAPTCHA). Their API
 * descriptors' `posting.unreadable` is this map's (boards/successfactors.ts, phenom.ts and jobdiva.ts read it). Kept here
 * (shared imports only) so the ingest client, the site reader's two callers, Add source and the sources file ask one
 * rule with no import cycle.
 */
export const NEVER_READ_BOARD_KINDS = {
  successfactors: 'robots',
  phenom: 'bot_check',
  jobdiva: 'bot_check',
} as const satisfies Readonly<Record<string, 'robots' | 'bot_check' | 'needs_login'>>;

/** A platform TailorIT never reads: its kind, its name and the can't-read reason its links answer. */
export interface NeverReadPlatform {
  kind: keyof typeof NEVER_READ_BOARD_KINDS;
  label: string;
  reason: (typeof NEVER_READ_BOARD_KINDS)[keyof typeof NEVER_READ_BOARD_KINDS];
}

/** The never-read platform a host (any case, a port or a trailing dot allowed) is one of, or null (see above). */
export function neverReadPlatformOfHost(host: string): NeverReadPlatform | null {
  const owner = boardDescriptorOfHost(host);
  if (!owner || !Object.hasOwn(NEVER_READ_BOARD_KINDS, owner.kind)) return null;
  const kind = owner.kind as NeverReadPlatform['kind'];
  return { kind, label: owner.label, reason: NEVER_READ_BOARD_KINDS[kind] };
}

/** Why a platform is never read, in a few words (the refusal below). */
const NEVER_READ_WHY: Record<NeverReadPlatform['reason'], string> = {
  robots: 'its robots.txt asks every robot not to read any page',
  bot_check: 'it checks every visitor for robots',
};

/**
 * The refusal of a career site on a host TailorIT never reads (Add source, a sources file, a run of one kept from before,
 * turning one on), in an admin's words; null for any other host.
 */
export function careerSiteRefusalOfHost(host: string): string | null {
  const platform = neverReadPlatformOfHost(host);
  if (!platform) return null;
  const name = host.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.+$/, '');
  return `${name} is a ${platform.label} site, and TailorIT doesn't read ${platform.label}: ${NEVER_READ_WHY[platform.reason]}. It can't be a career site.`;
}

/**
 * The dated note migration 0070 records on a career site it turned off on such a host (job_sources.terms_note, before the
 * admin's own note): 0070_never_read_hosts.sql writes these words.
 */
export const NEVER_READ_CAREER_SITE_NOTE =
  "2026-11-26: TailorIT doesn't read this platform (robots.txt or a bot check guards every page), so this career site was turned off and can't be turned on.";
// end v38 FIX-C

// v37 BOARDS ---------------------------------------------------------------------------------------------- iCIMS

// v38 FRAME: iCIMS's host rules and board normaliser moved, unchanged, to the shared board registry (ICIMS_BOARD,
// @tailorit/shared/sourcing): one employer's iCIMS host (ICIMS_BOARD_HOST: never iCIMS's www, api or login hosts nor an
// employees' internal-<co> portal; exactly the shared lookup's rule, v37 FIX-37A F11), iCIMS's own service hosts, and the
// board a name, host or address gives.
export { ICIMS_BOARD_HOST, ICIMS_SERVICE_HOST, icimsBoardOf, icimsHostOf, isIcimsBoardHost } from '@tailorit/shared/sourcing';
// end v37 BOARDS
