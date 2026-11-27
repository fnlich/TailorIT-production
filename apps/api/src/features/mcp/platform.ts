import { ATS_KINDS } from '@tailorit/shared/autofill';

// v1.5 Q2: the job board platform of a posting, read from its apply URL's host: the ATS (Greenhouse, Lever, Workday,
// ...), `linkedin`, `site` (a company's own careers page, or any other host) or `unknown` (no URL). One table drives
// both readers: `platformOfUrl` (JavaScript, for answers) and the SQL reading (for filters and groups), which the
// jobs' generated column `jobs.apply_platform` holds, so the jobs' index can hold it and a filter over a million jobs
// never parses a URL.
//
// What it cannot know: the board a person found the job on (a Greenhouse posting reached from LinkedIn is
// `greenhouse`), and a company page that embeds an ATS's form (`site`, unless its address names Greenhouse's
// ?gh_jid=).
//
// v3.0 PG-G: on PostgreSQL the SQL reading is the baseline's two immutable functions, `tailorit_url_host(url)` and
// `tailorit_url_platform(url)` (0001_baseline.sql: `jobs.apply_host`/`apply_platform` are generated from them, and
// list_applications reads an entry's own posting URL with the second); pg-baseline.test.ts keeps them equal to
// platformOfUrl for every platform. (v2.0's SQLite spelling, hostSql and platformSql, went with SQLite in v3.0 RET.)

/** Each platform and the host suffixes that are its (a host is the suffix itself or ends with "." + it). */
export const PLATFORM_HOSTS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['greenhouse', ['greenhouse.io']],
  ['lever', ['lever.co']],
  ['ashby', ['ashbyhq.com']],
  ['workday', ['myworkdayjobs.com', 'myworkdaysite.com']],
  ['workable', ['workable.com']],
  ['icims', ['icims.com']],
  ['taleo', ['taleo.net']],
  ['successfactors', ['successfactors.com', 'successfactors.eu']],
  ['oracle', ['oraclecloud.com', 'oraclegovcloud.com']],
  ['jobvite', ['jobvite.com']],
  ['jazzhr', ['applytojob.com']],
  ['bamboohr', ['bamboohr.com']],
  ['rippling', ['rippling.com']],
  ['breezy', ['breezy.hr']],
  ['careerplug', ['careerplug.com']],
  ['pinpoint', ['pinpointhq.com']],
  ['paycor', ['recruitingbypaycor.com']],
  ['hibob', ['hibob.com']],
  ['ultipro', ['ultipro.com', 'rec.pro.ukg.net']], // v38 ATS-D: a UKG tenant's host (migration 0068)
  ['dayforce', ['dayforcehcm.com']],
  ['paylocity', ['paylocity.com']],
  ['dice', ['dice.com']],
  ['clearcompany', ['clearcompany.com']],
  ['adp', ['adp.com']],
  ['smartrecruiters', ['smartrecruiters.com']],
  // v30 S3: the feed ATSs' tenant hosts (migration 0021 adds their platforms rows and the same lines to
  // tailorit_url_platform; its existing jobs are read again there).
  ['personio', ['personio.de', 'personio.com']],
  ['recruitee', ['recruitee.com']],
  // v38 ATS-A: Gem's and Teamtailor's boards (migration 0065 adds their platforms rows and the same lines to
  // tailorit_url_platform; its existing jobs are read again there).
  ['gem', ['gem.com']],
  ['teamtailor', ['teamtailor.com']],
  // v38 ATS-B: Zoho Recruit, Join.com and Recruiterflow (migration 0066 adds their platforms rows and the same lines to
  // tailorit_url_platform; its existing jobs are read again there).
  ['zohorecruit', ['zohorecruit.com', 'zohorecruit.eu', 'zohorecruit.in', 'zohorecruit.com.au']],
  ['join', ['join.com']],
  ['recruiterflow', ['recruiterflow.com']],
  // v38 ATS-C: Paycom's and Avature's hosts (migration 0067 adds Avature's platforms row and the same lines).
  ['paycom', ['paycomonline.net']],
  ['avature', ['avature.net']],
  // v38 ATS-D: JobDiva's portals and Phenom's hosted sites (migration 0068 adds phenom's platforms row and both lines).
  ['jobdiva', ['jobdiva.com']],
  ['phenom', ['phenompro.com']],
  // v38 INT: LinkedIn last, as in 0068's tailorit_url_platform (the same order; a UKG tenant's host rec.pro.ukg.net,
  // the function's rank 42, is in ultipro's line above: one line per platform, and no suffix overlaps another).
  ['linkedin', ['linkedin.com']],
];

/** Every value a platform may take, in the table's order, then `site` and `unknown`. */
export const PLATFORMS: readonly string[] = [...PLATFORM_HOSTS.map(([name]) => name), 'site', 'unknown'];

// Every ATS the extension knows is in the table (a test checks it), so a new one is not read as `site` by mistake.
export const KNOWN_ATS: readonly string[] = ATS_KINDS;

/** The host as the SQL reading takes it: the text between "://" and the next "/", in lower case; null without "://". */
function hostOf(url: string): string | null {
  const at = url.indexOf('://');
  if (at < 0) return null;
  const rest = url.slice(at + 3);
  const end = rest.indexOf('/');
  return (end < 0 ? rest : rest.slice(0, end)).toLowerCase();
}

/** The platform of a posting's apply URL (see the module's note); the same answer as tailorit_url_platform. */
export function platformOfUrl(url: string | null | undefined): string {
  if (url === null || url === undefined || url.trim() === '') return 'unknown';
  const host = hostOf(url);
  if (host === null) return 'site';
  for (const [name, suffixes] of PLATFORM_HOSTS) {
    if (suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return name;
  }
  return url.toLowerCase().includes('gh_jid=') ? 'greenhouse' : 'site';
}
