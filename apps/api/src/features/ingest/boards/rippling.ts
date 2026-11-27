import { RIPPLING_BOARD, ripplingBoard } from '@tailorit/shared/sourcing';
import { readRipplingPosting, ripplingAdapter, ripplingPostingUrl } from '../adapters/rippling';
import { str } from '../adapters/common';
import { configString } from './read-json';
import type { ApiBoardDescriptor, PostingRef } from './types';

// v38 ATS-A (SP v38 PLAN "Final coverage" row 7; REQUEST.md 7, EVIDENCE.md 7): a Rippling job board's API part (its
// shared part: @tailorit/shared/sourcing RIPPLING_BOARD). A run reads the board's list on ats.rippling.com and each
// planned posting's record on api.rippling.com (adapters/rippling.ts); a posting's link
// (https://ats.rippling.com/<board>/jobs/<uuid>), Add job, imports and the re-checks read its record the same way (404 is
// closed). Its company: the record's companyName, its blurb (description.company) and its board's logo.
// v38 FIX-A (SP v38 FIXES-38 D5, REVIEW38-beh M8): a board's name is case-sensitive (REQUEST.md 7) and its sources are
// looked up in any case, so a link written DGRSystems may be kept under a source typed dgrsystems: a stored link is read
// with the board as its job's own link writes it when that names the source's board in another case, else the source's.
// A posting's UUID is matched in lower case, as Rippling's own list and links write it.

/** v38 ATS-A: a Rippling source's recorded terms note (a new source's: job_sources.terms_note). */
export const RIPPLING_TERMS_NOTE =
  '2026-11-25: the owner decided TailorIT reads Rippling job boards. Checked that day: ats.rippling.com/api/v2/board/' +
  '<board>/jobs (the list, no text) and api.rippling.com/platform/api/ats/v1/board/<board>/jobs/<id> (one posting with ' +
  "its text) are the public JSON a board's own pages load, with no key; robots.txt disallows only /internal/ on " +
  'ats.rippling.com, and api.rippling.com has none. Conditions: one request at a time to both hosts (the Rippling ' +
  'lane), with the bot user agent (BOT_USER_AGENT), at most RIPPLING_READS_PER_RUN postings read a run; the apply form ' +
  '(activeJobApplication) is never read or stored.';

/** A posting's id: a UUID (lower case). */
const POSTING_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const postingRef = (board: string, id: string): PostingRef | null =>
  board && POSTING_UUID.test(id) ? { kind: 'rippling', board, externalId: id.toLowerCase(), region: 'global' } : null;

export const RIPPLING: ApiBoardDescriptor<'rippling'> = {
  board: RIPPLING_BOARD,
  adapter: ripplingAdapter,
  readKind: 'feed_read',
  terms: { status: 'allowed_with_conditions', url: null, note: RIPPLING_TERMS_NOTE },
  transferKeys: ['board'],
  importable: true,
  posting: {
    refOf: ({ source, sourceJobId, jobUrl }) => {
      const kept = ripplingBoard(configString(source.config, 'board'));
      const own = jobUrl ? ripplingBoard(jobUrl) : ''; // v38 FIX-A (D5): as the job's own link writes it
      return postingRef(own && own.toLowerCase() === kept.toLowerCase() ? own : kept, sourceJobId);
    },
    refOfLink: (read) => (read.board ? postingRef(ripplingBoard(read.board), read.externalId) : null),
    apiUrl: (ref) => ripplingPostingUrl(ref.board, ref.externalId),
    // Named by the source's companyName, else the record's companyName, else the board's name made readable.
    read: async (http, ref, options) => {
      const read = await readRipplingPosting(http, ref.board, ref.externalId, str(options.config?.companyName), options.signal);
      return read ? { found: true, raw: read.raw, company: read.company } : { found: false };
    },
  },
};
