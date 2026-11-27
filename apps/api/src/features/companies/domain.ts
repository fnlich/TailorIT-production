// v30 E0-API: a company's domain (docs/design/part2/13-company-enrichment.md §5.2). The registrable domain of a host
// ("careers.acme.com" -> "acme.com"), and whether it can be a company's at all: the hosts of the ATS platforms, the job
// boards, link shorteners, social sites and LinkedIn are never a company's domain.
//
// The registrable domain is read with a short built-in list of public suffixes (the common two-label country
// suffixes and the hosting suffixes whose subdomains are separate owners: github.io, webflow.io, ...), not the whole
// Public Suffix List: the app has no PSL package, and adding one is the coordinator's call (handoff, open items). A
// host under a suffix the list lacks reads as its last two labels, the common case; nothing outside reads it yet
// (domains come from hiringOrganization and admins in wave 3; E2's reader, wave 4, is the first to follow links).

/**
 * Shared hosting suffixes: each name under one is a different site's owner (github.io, a site builder's, a cloud's app
 * hosts). v381 FIX (SP v381 FIXES-381 G5, REVIEW381-beh owner 3): the list grew (hs-sites.com, azurestaticapps.net,
 * pantheonsite.io, wpengine.com, surge.sh, amplifyapp.com and the like: hosts only, never a company's own main domain);
 * a job link's site on one of them is its whole host (siteOfAddress), never a suffix every tenant shares.
 */
const SHARED_HOSTING_SUFFIXES: ReadonlySet<string> = new Set([
  'github.io', 'gitlab.io', 'webflow.io', 'herokuapp.com', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev',
  'web.app', 'firebaseapp.com', 'azurewebsites.net', 'cloudfront.net', 'appspot.com', 'blogspot.com', 'wordpress.com',
  'wixsite.com', 'squarespace.com', 'carrd.co', 'notion.site', 'framer.website', 'framer.app', 'myshopify.com',
  'substack.com', 'medium.com', 'readthedocs.io', 'fly.dev', 'onrender.com', 'replit.app', 'glitch.me',
  // v381 FIX (G5)
  'hs-sites.com', 'hs-sites-eu1.com', 'hubspotpagebuilder.com', 'azurestaticapps.net', 'azureedge.net', 'azurefd.net',
  'cloudapp.net', 'pantheonsite.io', 'wpengine.com', 'wpenginepowered.com', 'kinsta.cloud', 'flywheelsites.com',
  'wpcomstaging.com', 'surge.sh', 'amplifyapp.com', 'elasticbeanstalk.com', 's3.amazonaws.com', 'a.run.app',
  'cloudfunctions.net', 'r2.dev', 'now.sh', 'deno.dev', 'up.railway.app', 'repl.co', 'replit.dev', 'csb.app',
  'stackblitz.io', 'bitbucket.io', 'gitbook.io', 'ghost.io', 'bubbleapps.io', 'jimdosite.com', 'godaddysites.com',
  'square.site', 'wixstudio.io', 'editorx.io', 'myportfolio.com', 'shopifypreview.com', 'lovable.app', 'ngrok.io',
  'ngrok.app', 'ngrok-free.app', 'trycloudflare.com', 'loca.lt',
]);

/** Suffixes of two or more labels under which each next label is one owner's (a short list; see above). */
const MULTI_LABEL_SUFFIXES = new Set([
  // Country second levels.
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'ltd.uk', 'plc.uk', 'me.uk', 'net.uk', 'sch.uk', 'nhs.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'co.nz', 'org.nz', 'govt.nz', 'ac.nz',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'co.kr', 'or.kr', 'ac.kr', 'go.kr',
  'com.br', 'net.br', 'org.br', 'gov.br', 'com.mx', 'org.mx', 'gob.mx', 'com.ar', 'com.co', 'com.pe', 'com.cl',
  'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in', 'co.za', 'org.za', 'gov.za', 'ac.za',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'com.hk', 'org.hk', 'com.tw', 'org.tw', 'com.sg', 'org.sg', 'gov.sg',
  'com.my', 'com.ph', 'co.id', 'co.th', 'com.vn', 'com.tr', 'org.tr', 'gov.tr', 'co.il', 'org.il', 'ac.il',
  'com.eg', 'com.sa', 'com.ng', 'co.ke', 'com.pk', 'com.bd', 'com.ua', 'com.pl', 'com.es', 'com.pt', 'co.at', 'or.at',
  // Hosting suffixes: each subdomain is a different site's owner.
  ...SHARED_HOSTING_SUFFIXES,
]);

/**
 * Registrable domains that are never one company's: the ATS platforms (jobs.apply_platform's suffixes,
 * tailorit_url_platform), job boards and aggregators, link shorteners, social sites, LinkedIn, and site builders' own
 * domains.
 */
const NOT_A_COMPANY_DOMAIN = new Set([
  // ATS and recruiting platforms.
  'greenhouse.io', 'lever.co', 'ashbyhq.com', 'myworkdayjobs.com', 'myworkdaysite.com', 'workday.com', 'workable.com',
  'icims.com', 'taleo.net', 'successfactors.com', 'successfactors.eu', 'oraclecloud.com', 'oraclegovcloud.com',
  'jobvite.com', 'applytojob.com', 'bamboohr.com', 'rippling.com', 'breezy.hr', 'careerplug.com', 'pinpointhq.com',
  'recruitingbypaycor.com', 'hibob.com', 'ultipro.com', 'dayforcehcm.com', 'paylocity.com', 'clearcompany.com',
  'adp.com', 'smartrecruiters.com', 'personio.de', 'personio.com', 'recruitee.com', 'teamtailor.com', 'jazzhr.com',
  'paycom.com', 'ukg.com', 'jobdiva.com', 'eightfold.ai', 'gem.com', 'dover.com', 'wellfound.com',
  // Job boards and aggregators.
  'linkedin.com', 'lnkd.in', 'indeed.com', 'glassdoor.com', 'ziprecruiter.com', 'monster.com', 'dice.com',
  'simplyhired.com', 'careerbuilder.com', 'usajobs.gov', 'himalayas.app', 'jobicy.com', 'remoteok.com',
  'weworkremotely.com', 'angel.co', 'builtin.com', 'otta.com', 'welcometothejungle.com', 'stepstone.de', 'xing.com',
  'jobright.ai', 'simplify.jobs', 'handshake.com', 'joinhandshake.com', 'crunchbase.com',
  // Shorteners, social and site builders.
  'bit.ly', 'tinyurl.com', 'goo.gl', 't.co', 'ow.ly', 'buff.ly', 'rebrand.ly', 'linktr.ee',
  'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'youtube.com', 'tiktok.com', 'github.com', 'gitlab.com',
  'medium.com', 'google.com', 'goo.gle', 'apple.com', 'wix.com', 'squarespace.com', 'wordpress.com',
]);

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The host of an address or a bare host, in lower case without a trailing dot or "www."; null when unreadable. */
export function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = value.trim().toLowerCase();
  if (!text) return null;
  let host: string;
  try {
    host = /^[a-z][a-z0-9+.-]*:\/\//.test(text) ? new URL(text).hostname : new URL(`https://${text}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/\.+$/, '');
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((label) => HOST_LABEL.test(label))) return null;
  // An address, not a name.
  if (/^\d+$/.test(labels[labels.length - 1]!)) return null;
  return host;
}

/** The registrable domain of a host or an address ("https://careers.acme.co.uk/x" -> "acme.co.uk"); null for none. */
export function registrableDomain(value: string | null | undefined): string | null {
  const host = hostOf(value);
  if (!host) return null;
  const labels = host.split('.');
  for (let take = Math.min(4, labels.length - 1); take >= 2; take -= 1) {
    const suffix = labels.slice(-take).join('.');
    if (MULTI_LABEL_SUFFIXES.has(suffix)) {
      return labels.length > take ? labels.slice(-(take + 1)).join('.') : null;
    }
  }
  return labels.slice(-2).join('.');
}

/** Whether a registrable domain may be one company's (never an ATS, a job board, a shortener, a social site). */
export function isCompanyDomain(domain: string | null | undefined): domain is string {
  if (!domain) return false;
  if (NOT_A_COMPANY_DOMAIN.has(domain)) return false;
  // Example and test names (RFC 2606, 6761) never name a real company's site.
  return !/(?:^|\.)(?:example|test|invalid|localhost|local)$/.test(domain) && !/^example\.(?:com|net|org)$/.test(domain);
}

/** v381 FIX (G5): whether a host is under a shared hosting suffix (each name there is another owner's site). */
export function isSharedHostingHost(host: string): boolean {
  const labels = host.toLowerCase().replace(/\.+$/, '').split('.');
  for (let take = Math.min(4, labels.length - 1); take >= 2; take -= 1) {
    if (SHARED_HOSTING_SUFFIXES.has(labels.slice(-take).join('.'))) return true;
  }
  return false;
}

/**
 * v381 FIX (SP v381 FIXES-381 G5): the site an address is on: its whole host under a shared hosting suffix
 * ("careers.acme.github.io", "acme-1234.hs-sites.com"), else its registrable domain ("careers.acme.com" -> "acme.com");
 * null for none.
 */
export function siteOfAddress(value: string | null | undefined): string | null {
  const host = hostOf(value);
  if (!host) return null;
  if (isSharedHostingHost(host)) return registrableDomain(host) === null ? null : host;
  return registrableDomain(host);
}

/** The company domains of the given hints (addresses or hosts), strongest first, without repeats. */
export function companyDomainsOf(hints: readonly (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const hint of hints) {
    const domain = registrableDomain(hint);
    if (isCompanyDomain(domain) && !out.includes(domain)) out.push(domain);
  }
  return out;
}
