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

/** Per-employer hosts of the platforms above (lower case, no trailing dot). */
const EMPLOYER_PLATFORM_HOSTS: readonly RegExp[] = [
  /^(?!(?:www|api|developer|developers|community|login|status|support|cdn|static|careers)\.)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.icims\.com$/,
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
