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

// v37 BOARDS ---------------------------------------------------------------------------------------------- iCIMS

/**
 * One employer's iCIMS host (lower case): careers-acme.icims.com, jobs-acme.icims.com, acme.icims.com; never iCIMS's www,
 * api or login hosts nor an employees' internal-<co> portal. Its first label is the `icims` source's board.
 * v37 FIX-37A (REVIEW37-beh F11): exactly the shared lookup's rule (@tailorit/shared/autofill lookup.ts ICIMS_HOST, a
 * DNS label), so a link the lookup reads as an iCIMS posting is always a board here: careers.icims.com (iCIMS's own
 * careers portal) and every other label it accepts. Discovery offers no candidate from iCIMS's own service hosts
 * (ICIMS_SERVICE_HOST) unless the page is a posting.
 */
export const ICIMS_BOARD_HOST = /^(?!(?:www|api|login)\.)(?!internal-)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.icims\.com$/;

/** v37 FIX-37A (F11): hosts iCIMS runs for itself, never a portal of job pages (discovery/boards.ts). */
export const ICIMS_SERVICE_HOST = /^(?:developer|developers|community|status|support|cdn|static)\.icims\.com$/;

/** Whether a host (any case, a trailing dot allowed) is one employer's iCIMS host (ICIMS_BOARD_HOST). */
export function isIcimsBoardHost(host: string): boolean {
  return ICIMS_BOARD_HOST.test(host.toLowerCase().replace(/\.+$/, ''));
}

/**
 * The iCIMS board a name, host or address gives ("careers-acme", "careers-acme.icims.com",
 * "https://careers-acme.icims.com/jobs/1234/x/job"): its host's first label in lower case; '' when it names none (another
 * host, iCIMS's own, a label that is no DNS label).
 */
export function icimsBoardOf(input: string): string {
  const text = input.trim().toLowerCase();
  if (!text) return '';
  let host = text;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(text) || text.includes('/')) {
    try {
      host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(text) ? text : `https://${text}`).hostname;
    } catch {
      return '';
    }
  } else if (!text.includes('.')) {
    host = `${text}.icims.com`;
  }
  host = host.replace(/\.+$/, '');
  return isIcimsBoardHost(host) ? host.slice(0, -'.icims.com'.length) : '';
}

/** An iCIMS board's host. */
export const icimsHostOf = (board: string) => `${board}.icims.com`;
// end v37 BOARDS
