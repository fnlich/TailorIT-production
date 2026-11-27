import { GEM_BOARD, gemBoard } from '@tailorit/shared/sourcing';
import { gemAdapter, gemPostUrl, readGemPost } from '../adapters/gem';
import { str } from '../adapters/common';
import { configString } from './read-json';
import type { ApiBoardDescriptor, PostingRef } from './types';

// v38 ATS-A (SP v38 PLAN "Final coverage" row 4; REQUEST.md 4, EVIDENCE.md 4): a Gem job board's API part (its shared
// part: @tailorit/shared/sourcing GEM_BOARD). A run reads the board's whole list once (adapters/gem.ts); a post's link
// (https://jobs.gem.com/<board>/<id>), Add job, imports and the re-checks read the post on its own
// (api.gem.com/job_board/v0/<board>/job_posts/<id>/: 404 is closed).
// v38 FIX-A (SP v38 FIXES-38 D5, REVIEW38-beh M8): the board is read as written: a link's as the link wrote it, a stored
// link's as its job's own link wrote it when that names the source's board in another case (sources are looked up in
// any case), else the source's. L17: the board's company is the source's companyName, which a run keeps once it has
// read the board's name from its posts (adapters/gem.ts), so a run and a link's read name it alike.

/** v38 ATS-A: a Gem source's recorded terms note (a new source's: job_sources.terms_note). */
export const GEM_TERMS_NOTE =
  '2026-11-25: the owner decided TailorIT reads Gem job boards. Checked that day: api.gem.com/job_board/v0/<board>/' +
  'job_posts/ (every open post with its text) and .../job_posts/<id>/ (one post) are the public job-board API a ' +
  "board's own page reads, with no key; api.gem.com has no robots.txt (403) and jobs.gem.com none (404). Conditions: " +
  "one request at a time to Gem's API host, with the bot user agent (BOT_USER_AGENT); the whole board is read once a " +
  'run; the apply form is never read or stored.';

/** A post's id as Gem writes it (opaque, case-sensitive). */
const POST_ID = /^[A-Za-z0-9_-]{6,200}$/;

const postRef = (board: string, id: string): PostingRef | null =>
  board && POST_ID.test(id) ? { kind: 'gem', board, externalId: id, region: 'global' } : null;

/** v38 FIX-A (D5): the board as the job's own link (on jobs.gem.com) writes it, when it is `kept` in another case. */
function boardAsWritten(kept: string, jobUrl: string | null | undefined): string {
  const own = jobUrl && /^https:\/\//i.test(jobUrl) ? gemBoard(jobUrl) : '';
  return own && own.toLowerCase() === kept.toLowerCase() ? own : kept;
}

export const GEM: ApiBoardDescriptor<'gem'> = {
  board: GEM_BOARD,
  adapter: gemAdapter,
  readKind: 'feed_read',
  terms: { status: 'allowed_with_conditions', url: null, note: GEM_TERMS_NOTE },
  transferKeys: ['board'],
  importable: true,
  posting: {
    refOf: ({ source, sourceJobId, jobUrl }) => postRef(boardAsWritten(gemBoard(configString(source.config, 'board')), jobUrl), sourceJobId),
    refOfLink: (read) => (read.board ? postRef(gemBoard(read.board), read.externalId) : null),
    apiUrl: (ref) => gemPostUrl(ref.board, ref.externalId),
    // Named by the source's companyName, else the post's first heading's company, else the board's name made readable.
    read: async (http, ref, options) => {
      const read = await readGemPost(http, ref.board, ref.externalId, str(options.config?.companyName), options.signal);
      return read ? { found: true, raw: read.raw, company: read.company } : { found: false };
    },
  },
};
