import type { AppDeps } from '../context';
import { OutboundRefusedError } from './outbound';

// v30 SCH: the identity guard of every NEW kind of outside read (DECISIONS P1, owner question 7; docs/design/part2/
// 00-overview.md §4, 12 §1, 13 §4). TailorIT's new reads say who they are with one User-Agent, BOT_USER_AGENT
// (config/outside.ts): "TailorIT/1.0 (+https://<public site>/bot; <role mailbox>)". Until the owner has the public site
// (its /bot page) and a role mailbox, the setting holds a placeholder, and every new kind of read refuses before it
// sends anything:
//
//   assertNewReadAllowed(deps, 'discovery_validation');   // throws NewReadRefusedError while the placeholder is set
//   const headers = { 'User-Agent': deps.config.outside.botUserAgent };
//
// Today's reads keep today's identity (INGEST_USER_AGENT) and never call it: the v2.0 sources' runs, Add job's read,
// the liveness reads and the closed reports' re-checks (14 §5.1: the same read today's liveness check makes). Each new
// kind is one of NEW_READ_KINDS; its package's test shows it refuses with the placeholder (PLAN §5). The refusal is an
// OutboundRefusedError, so a client that already treats a refused request as "not sent" treats this one the same.

/** Every new kind of outside read (PLAN §5's first row), named in the refusal and the logs. */
export const NEW_READ_KINDS = [
  /** S2: a candidate board's validation read and its name probes (12 §4). */
  'discovery_validation',
  /** S2: Common Crawl's columnar index (12 §3.9). */
  'common_crawl',
  /** S1-API: a keyless board read beyond v2.0's kinds, and robots.txt for it (12 §9.4). */
  'board_read',
  /** S3: Workday sitemaps; Personio, Recruitee, Breezy and BambooHR feeds (12 §3.2-3.3). */
  'feed_read',
  /** S4: USAJOBS (12 §3.6). */
  'usajobs',
  /** S4: Himalayas and Jobicy (12 §3.7). */
  'remote_api',
  /** E2 and S5: the shared site reader (company homepages, career pages; 13 §4, 12 §3.4). */
  'site_reader',
  /** E1: Wikidata, SEC EDGAR and GLEIF live lookups (13 §3.2). */
  'refdata_lookup',
  /** E2: logo.dev (13 §3.3). */
  'logo_dev',
  /** v31 LINK (D3): an added job's own page, read for its schema.org JobPosting through the shared reader. */
  'add_page',
] as const;
export type NewReadKind = (typeof NEW_READ_KINDS)[number];

/** A new kind of outside read refused because BOT_USER_AGENT is still a placeholder (nothing was sent). */
export class NewReadRefusedError extends OutboundRefusedError {
  readonly kind: NewReadKind;
  constructor(kind: NewReadKind) {
    super(
      `TailorIT sends no ${kind} request while BOT_USER_AGENT is a placeholder: set it in .env to ` +
        '"TailorIT/1.0 (+https://<public site>/bot; <role mailbox>)" with the real site and mailbox, then restart.',
    );
    this.name = 'NewReadRefusedError';
    this.kind = kind;
  }
}

/** Whether a new kind of outside read may run now: BOT_USER_AGENT names the public site and a role mailbox. */
export function newReadsAllowed(deps: Pick<AppDeps, 'config'>): boolean {
  return !deps.config.outside.botUserAgentIsPlaceholder;
}

/**
 * Throws NewReadRefusedError while BOT_USER_AGENT is unset or a placeholder. Call it before every new kind of outside
 * read, then send `deps.config.outside.botUserAgent` as the request's User-Agent.
 */
export function assertNewReadAllowed(deps: Pick<AppDeps, 'config'>, kind: NewReadKind): void {
  if (!newReadsAllowed(deps)) throw new NewReadRefusedError(kind);
}
