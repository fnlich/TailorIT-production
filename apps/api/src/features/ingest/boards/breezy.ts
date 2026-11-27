import { BREEZY_BOARD, breezyCompany, boardUrlOf } from '@tailorit/shared/sourcing';
import { breezyAdapter, breezyCompanyFacts, breezyFeedOf, breezyPosting, readBreezyFeed } from '../adapters/breezy';
import { nameFromSlug, records, str } from '../adapters/common';
import type { HttpAnswer } from '../http';
import { IngestError } from '../types';
import { readSharedFeed } from './feed-cache';
import { configString } from './read-json';
import type { ApiBoardDescriptor, PostingRef } from './types';

// v38 FRAME: Breezy HR's API part (its shared part: @tailorit/shared/sourcing BREEZY_BOARD): its public list
// (<company>.breezy.hr/json).
// v38 ATS-A (SP v38 PLAN A5, "Final coverage" row 1; EVIDENCE.md 1): the owner decided on 2026-11-25 that TailorIT reads
// Breezy HR: its terms are recorded (a new source starts "allowed with conditions" with the dated note below; migration
// 0065 writes it on the older ones that have none). A position has no read of its own and no status: its link is read
// from the company's list with each position's text (/json?verbose=true, through the feed cache: read once and reused
// briefly), and a position missing from it is closed.
// v38 FIX-A (SP v38 FIXES-38 item 1, REVIEW38-beh M3): a 404 of the list itself is the board's problem (a wrong or
// retired address), never its positions' answer: a link's read answers try later, and only a list read whole that no
// longer names the position closes it (a run's 404 is "source not found", adapters/breezy.ts). L18: the list a link's
// read shares is sent with no caller's signal (feed-cache readSharedFeed).

/** v38 ATS-A: a Breezy source's recorded terms note, word for word as migration 0065 writes it. */
export const BREEZY_TERMS_NOTE =
  '2026-11-25: the owner decided TailorIT reads Breezy HR careers lists. Checked that day: the list (/json, with each ' +
  "position's text: /json?verbose=true) is the public JSON the company's own careers page loads (Breezy documents no " +
  'such API); robots.txt allows it (it disallows only /css, /fonts, /stylesheets and /javascripts). A position missing ' +
  'from the list is closed. Conditions: one request at a time to all of Breezy HR (its lane), with the bot user agent ' +
  '(BOT_USER_AGENT); the list is read once a run; the apply form is never read or stored.';

/** A position's id as Breezy writes it: 12 hexadecimal digits. */
const POSITION_ID = /^[0-9a-f]{12}$/i;

/** The position a ref names on its company's list (see the top). */
function postingRefOf(company: string, id: string): PostingRef | null {
  return company && POSITION_ID.test(id) ? { kind: 'breezy', board: company, externalId: id.toLowerCase(), region: 'global' } : null;
}

export const BREEZY: ApiBoardDescriptor<'breezy'> = {
  board: BREEZY_BOARD,
  adapter: breezyAdapter,
  readKind: 'feed_read',
  // v38 ATS-A (SP v38 PLAN A5): the owner decided on 2026-11-25 that TailorIT reads Breezy HR.
  terms: { status: 'allowed_with_conditions', url: null, note: BREEZY_TERMS_NOTE },
  transferKeys: ['company'],
  importable: true, // v38 ATS-A (A9)
  posting: {
    refOf: ({ source, sourceJobId }) => postingRefOf(breezyCompany(configString(source.config, 'company')), sourceJobId),
    refOfLink: (read) => {
      const url = boardUrlOf(read.url);
      return postingRefOf(url ? breezyCompany(url.hostname.toLowerCase()) : '', read.externalId);
    },
    apiUrl: (ref) => breezyFeedOf({ company: ref.board }).url,
    // From the company's list (read once and reused briefly): missing is closed; named by the source's companyName,
    // else as the list names the company, else by its address made readable.
    read: async (http, ref, options) => {
      const feed = breezyFeedOf({ company: ref.board });
      const answer = await readSharedFeed<HttpAnswer>(options, `breezy:${feed.company}`, (signal) => readBreezyFeed(http, feed, { signal }));
      if (answer.status === 404) return { found: false, unreadable: 'unavailable' }; // v38 FIX-A (M3): the list's, not the position's
      if (!Array.isArray(answer.data)) throw new IngestError(`Breezy answered without the positions of "${feed.company}".`);
      const position = records(answer.data).find((each) => str(each.id)?.toLowerCase() === ref.externalId.toLowerCase());
      if (!position) return { found: false };
      const company = breezyCompanyFacts(position);
      const raw = breezyPosting(position, feed.host, str(options.config?.companyName) ?? company.name ?? nameFromSlug(feed.company));
      if (!raw) throw new IngestError("Breezy's position has no id or name.");
      return { found: true, raw, company };
    },
  },
};
