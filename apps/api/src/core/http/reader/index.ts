import type { SiteReader } from '../../seams';
import { createSiteReader } from './read';

// v30 E2: the shared polite reader of company homepages (E2) and career pages (S5): core/seams.ts SiteReader, built
// (docs/design/part2/13-company-enrichment.md §4, 12 §3.4, 11 §5.3a). read.ts holds the rules in order; transport.ts
// the connect-time address check (undici); robots.ts robots.txt; detect.ts the walls a read never crosses. Callers
// import siteReader from core/seams. Both purposes are off by default (SITE_READER_COMPANY_SITES,
// SITE_READER_CAREER_PAGES), and nothing is sent while BOT_USER_AGENT is a placeholder.

/** The shared reader of company homepages and career pages (core/seams.ts SiteReader). */
export const siteReader: SiteReader = createSiteReader();

export { createSiteReader, isOptedOut, type SiteReaderOptions } from './read';
export { createUndiciTransport, defaultSiteTransport, type SiteAnswer, type SiteTransport } from './transport';
export { AddressRefusedError, isAddressRefused, isPublicAddress, publicLookup, type ResolveHost } from './address';
export { wallOf } from './detect';
