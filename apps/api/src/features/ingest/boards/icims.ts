import { boardUrlOf, ICIMS_BOARD, icimsBoardOf, icimsHostOf } from '@tailorit/shared/sourcing';
import { icimsAdapter, icimsContentUrl, icimsPostingRef, icimsSiteOf, readIcimsPosting } from '../adapters/icims';
import { configString } from './read-json';
import type { ApiBoardDescriptor, PostingRef } from './types';

// v38 FRAME: iCIMS's API part (its shared part: @tailorit/shared/sourcing ICIMS_BOARD). A run reads the site's sitemap
// and each posting's page (adapters/icims.ts); a link to a posting (https://<board>.icims.com/jobs/<id>/[<slug>/]job, or
// any of its pages) is read as its run reads it: the posting's content page (…/job?in_iframe=1: the page itself is a
// frame with no JobPosting), a new kind of read (v37 BOARDS I2, I4; jobs/add/board-link.ts). Gone: 404, 410, or a past
// validThrough.

/**
 * v37 BOARDS (SP v37 PLAN I3): an iCIMS source's recorded terms note, word for word as migration 0063 writes it.
 */
export const ICIMS_TERMS_NOTE =
  '2026-11-24: the owner decided TailorIT reads iCIMS career sites. Checked that day: robots.txt names the sitemap ' +
  '(/sitemap.xml) and allows the job pages (/jobs/<id>/<slug>/job; it disallows the referral, login and candidate ' +
  "pages, never read); each job page's content (?in_iframe=1) carries one schema.org JobPosting and says index,follow. " +
  'Conditions: one request at a time per host, with the bot user agent (BOT_USER_AGENT).';

/** A posting's id as iCIMS's addresses write it. */
const POSTING_ID = /^\d{1,12}$/;

/** v37 BOARDS: an iCIMS posting's page, the ref's own (on its board's host, naming its id), else its plain page. */
function icimsPageOf(ref: PostingRef): string {
  const site = icimsSiteOf({ board: ref.board });
  const own = ref.page ? icimsPostingRef(ref.page, site.host) : null;
  return own && own.id === ref.externalId ? own.page : `https://${site.host}/jobs/${encodeURIComponent(ref.externalId)}/job`;
}

export const ICIMS: ApiBoardDescriptor<'icims'> = {
  board: ICIMS_BOARD,
  adapter: icimsAdapter,
  readKind: 'feed_read',
  // v37 BOARDS (SP v37 PLAN I3): the owner decided on 2026-11-24 that TailorIT reads iCIMS career sites.
  terms: { status: 'allowed_with_conditions', url: null, note: ICIMS_TERMS_NOTE },
  // The site's board; its company name travels at the entry level, as every kind's (v37 INT-B).
  transferKeys: ['board'],
  importable: true,
  posting: {
    // By its board, its id and its job's own page (read when it is the posting's, else its plain page).
    refOf: ({ source, sourceJobId, jobUrl }) => {
      const board = icimsBoardOf(configString(source.config, 'board'));
      return board && POSTING_ID.test(sourceJobId) ? { kind: 'icims', board, externalId: sourceJobId, region: 'global', page: jobUrl } : null;
    },
    refOfLink: (read) => {
      const url = boardUrlOf(read.url);
      const board = url ? icimsBoardOf(url.hostname.toLowerCase()) : '';
      if (!board || !POSTING_ID.test(read.externalId)) return null;
      const own = icimsPostingRef(read.url, icimsHostOf(board));
      return { kind: 'icims', board, externalId: read.externalId, region: 'global', ...(own && own.id === read.externalId ? { page: own.page } : {}) };
    },
    apiUrl: (ref) => icimsContentUrl(icimsPageOf(ref)),
    // Named by the source's companyName, else as its run names it.
    read: async (http, ref, options) => {
      const site = icimsSiteOf({ board: ref.board, companyName: options.config?.companyName });
      const read = await readIcimsPosting(http, site, { id: ref.externalId, page: icimsPageOf(ref) }, {
        signal: options.signal,
        now: (options.now ?? (() => new Date()))(),
      });
      return read.found ? { found: true, raw: read.raw } : { found: false };
    },
  },
};
