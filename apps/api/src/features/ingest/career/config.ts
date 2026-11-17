import { isRefusedPageHost, isSiteHost, normalHost } from '../../job-reviews/hosts';
import { registrableDomain } from '../../companies/domain';
import { str } from '../adapters/common';
import { IngestError } from '../types';

// v30 S5: a career_site source's config (job_sources.config): one host's career site (the source's name is the host).
//   { "host": "careers.acme.com",          required: the host whose sitemaps and posting pages are read
//     "sitemaps": ["/jobs-sitemap.xml"],    optional: its sitemaps (paths, or https addresses on the same domain);
//                                           without them: the ones its robots.txt announces, else /sitemap.xml
//     "postingPaths": ["/jobs/"],           optional: the path prefixes of its posting pages (default: the patterns of
//                                           sitemap.ts isPostingAddress)
//     "companyName": "Acme" }               optional: the employer's name for postings whose JobPosting names none

/** The sitemaps and posting prefixes one config may name. */
export const CAREER_CONFIG_LIST_MAX = 20;

export interface CareerSiteConfig {
  host: string;
  /** Absolute https addresses, on the host's registrable domain. Empty: robots.txt's, else /sitemap.xml. */
  sitemaps: string[];
  postingPaths: string[];
  companyName: string | null;
}

/** The career site's host a config names (lower case), or null when it names none TailorIT may read. */
export function careerHostOfConfig(config: Record<string, unknown> | null | undefined): string | null {
  const value = str(config?.host);
  if (!value) return null;
  const host = normalHost(value.replace(/^https?:\/\//i, '').replace(/[/?#].*$/, ''));
  return isSiteHost(host) && !isRefusedPageHost(host) ? host : null;
}

/** A sitemap named in a config: an https address on the host's domain, or a path on the host. */
function sitemapAddress(value: unknown, host: string): string | null {
  const text = str(value);
  if (!text) return null;
  try {
    const url = new URL(text, `https://${host}/`);
    if (url.protocol !== 'https:') return null;
    if (registrableDomain(url.hostname) !== registrableDomain(host)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** The config read and checked; throws IngestError when it names no readable host. */
export function careerSiteConfigOf(config: Record<string, unknown>): CareerSiteConfig {
  const host = careerHostOfConfig(config);
  if (!host) throw new IngestError('This career site names no host TailorIT may read. Edit the source and give its host (careers.example.org).');
  const list = (value: unknown) => (Array.isArray(value) ? value : []).slice(0, CAREER_CONFIG_LIST_MAX);
  return {
    host,
    sitemaps: list(config.sitemaps)
      .map((value) => sitemapAddress(value, host))
      .filter((value): value is string => value !== null),
    postingPaths: list(config.postingPaths)
      .map((value) => str(value))
      .filter((value): value is string => value !== null && value.startsWith('/')),
    companyName: str(config.companyName)?.slice(0, 200) ?? null,
  };
}

/** The new source of a career site (S2's validation makes it from a `career_site` candidate: the host is its name). */
export function careerSiteSourceOf(host: string): { kind: 'career_site'; name: string; config: { host: string } } | null {
  const checked = careerHostOfConfig({ host });
  return checked ? { kind: 'career_site', name: checked, config: { host: checked } } : null;
}

/** The paths a run of the site reads first, for its robots.txt verdict (defineAdapter's robotsPaths). */
export function careerRobotsPaths(config: Record<string, unknown>): string[] {
  const host = careerHostOfConfig(config);
  if (!host) return ['/'];
  const sitemaps = careerSiteConfigOf(config).sitemaps.filter((address) => new URL(address).hostname === host);
  return sitemaps.length > 0 ? sitemaps.map((address) => {
    const url = new URL(address);
    return `${url.pathname}${url.search}`;
  }) : ['/sitemap.xml'];
}
