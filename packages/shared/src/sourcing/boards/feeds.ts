import { DNS_LABEL } from './url';

// v38 FRAME: the feed ATSs' common host rule (v30 S3, the API's sources.ts feedHostOf): a company's name on a feed host is
// one DNS label ("acme-robotics"), as its adapter normalised it.

/** The company a feed source's config names (config `company`, trimmed, lower case), or null when it names none. */
export function feedCompanyOf(config: Record<string, unknown>): string | null {
  const company = typeof config.company === 'string' ? config.company.trim().toLowerCase() : '';
  return DNS_LABEL.test(company) ? company : null;
}
