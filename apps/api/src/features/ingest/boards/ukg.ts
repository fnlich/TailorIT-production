import { boardUrlOf, UKG_BOARD, ukgPostingOf, ukgTenant } from '@tailorit/shared/sourcing';
import { str } from '../adapters/common';
import { readUkgPosting, ukgAdapter } from '../adapters/ukg';
import { configString } from './read-json';
import type { ApiBoardDescriptor, PostingRef } from './types';

// v38 ATS-D: UKG Recruiting's API part (its shared part: @tailorit/shared/sourcing UKG_BOARD). A link to a posting
// (…/<tenant>/JobBoard/<board>/OpportunityDetail?opportunityId=<uuid>, or its application's page) is read from the
// posting's own page, whose record is inline (adapters/ukg.ts): a new kind of read, on UKG's lane. Gone: 404, 410, the
// not-found page, OpportunityIsClosed. A board never runs (its list is robots-disallowed): no Add source, no discovery.

/**
 * v38 ATS-D (SP v38 PLAN A5): a UKG Recruiting source's recorded terms note (job_sources.terms_note, at most 1,000
 * characters).
 */
export const UKG_TERMS_NOTE =
  '2026-11-25: the owner asked TailorIT to verify UKG Recruiting job links (the request of 2026-11-25). Checked that day: ' +
  "robots.txt disallows every path but */JobBoard/ (and disallows */JobBoardView, where a board's list is a POST: never " +
  "sent); each posting's OpportunityDetail page carries its record inline, the data the company's own careers page " +
  'shows. Conditions: one posting at a time on the UKG lane, with the bot user agent (BOT_USER_AGENT); no board list; ' +
  'a supervisor name, the apply criteria and the EEO statement are never stored.';

/** The posting a page names: its tenant (lower case) as the board, its opportunity as the id, its page kept. */
function refOfPage(page: string, id: string): PostingRef | null {
  const url = boardUrlOf(page);
  const posting = url ? ukgPostingOf(url) : null;
  if (!posting || posting.id.toLowerCase() !== id.toLowerCase()) return null;
  return { kind: 'ukg', board: posting.tenant.toLowerCase(), externalId: posting.id.toLowerCase(), region: 'global', page };
}

export const UKG: ApiBoardDescriptor<'ukg'> = {
  board: UKG_BOARD,
  adapter: ukgAdapter,
  readKind: 'feed_read',
  terms: { status: 'allowed_with_conditions', url: null, note: UKG_TERMS_NOTE },
  // v38 INT: no transferKeys: a links-only kind (runs false) is never a sources file's entry (boardRegistryProblems).
  posting: {
    // A stored link: its job's own page, when it is this source's tenant's and names this opportunity.
    refOf: ({ source, sourceJobId, jobUrl }) => {
      const ref = refOfPage(jobUrl, sourceJobId);
      return ref && ref.board === ukgTenant(configString(source.config, 'tenant')) ? ref : null;
    },
    // The link as given (its tenant's case kept), else its posting's page parseAtsUrl names (an application's account step).
    refOfLink: (read) => refOfPage(read.url, read.externalId) ?? refOfPage(read.canonical.at(-1) ?? '', read.externalId),
    // Named by the source's companyName (the page names no company); v38 FIX-APP (D1): else by none, never the host label.
    read: async (http, ref, options) => {
      if (!ref.page) return { found: false, unreadable: 'no_posting' };
      return readUkgPosting(http, { page: ref.page, id: ref.externalId }, str(options.config?.companyName), options.signal);
    },
    // The page names no company and no other page of the board does without script: the source's name (an import's row's
    // first, board-link.ts); v38 FIX-APP (D1): else the person's typed company, or Add job asks for it.
    companyName: async () => null,
  },
};
