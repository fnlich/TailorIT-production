import { ADP_BOARD, ADP_JOB_ID, adpBoardName, adpBoardOf, adpCenterOf, adpCenterOfConfig } from '@tailorit/shared/sourcing';
import { str } from '../adapters/common';
import { ADP_LINK_LIST_MAX, adpAdapter, readAdpList, readAdpPosting, type AdpList } from '../adapters/adp';
import { IngestError, SourceNotFoundError } from '../types';
import { readSharedFeed } from './feed-cache';
import type { ApiBoardDescriptor, PostingRef } from './types';

// v38 ATS-B: ADP Workforce Now's API part (its shared part: @tailorit/shared/sourcing ADP_BOARD). A run reads the career
// center's list and each posting's record (adapters/adp.ts); a link to a posting (recruitment.html?cid=…&jobId=…&ccId=…)
// names its ExternalJobID, so its read finds the posting's itemID in the career center's list (read once and reused a
// short time: ./feed-cache.ts), then reads its record. A jobId the whole list no longer names is closed, as is a record
// ADP answers with its empty lists. The posting names no employer: an import row's company or the source's names it.
// v38 FIX-A (SP v38 FIXES-38 items 1, 2 and 12; REVIEW38-beh M3, M4, L18): a 404 of the list (no such career center) or
// of the record's address is the board's problem, never the posting's answer: try later; the list a link's read shares
// is sent with no caller's signal (readSharedFeed).

/** v38 ATS-B (SP v38 PLAN A5): an ADP source's recorded terms note (job_sources.terms_note, at most 1,000 characters). */
export const ADP_TERMS_NOTE =
  '2026-11-25: the owner asked TailorIT to verify job links and read ADP Workforce Now career centers. Checked that day: ' +
  "the careers page loads its job list and each job's record as keyless JSON (/mascsr/default/careercenter/public/events/" +
  "staffing/v1/job-requisitions); robots.txt redirects to ADP's sign-in page (it holds no rules). Conditions: one request " +
  'at a time to workforcenow.adp.com, with the bot user agent (BOT_USER_AGENT); a run reads at most ADP_LIST_MAX listed ' +
  "jobs and ADP_READS_PER_RUN jobs' records; the list's filter lists (meta.links, which hold what look like people's " +
  'names) are never read or stored.';

/** A ref's career center (its board's name, <cid>[/<ccId>]). */
function centerOfRef(ref: PostingRef) {
  const center = adpCenterOf(ref.board);
  if (!center) throw new IngestError('TailorIT does not know this ADP career center.');
  return center;
}

export const ADP: ApiBoardDescriptor<'adp'> = {
  board: ADP_BOARD,
  adapter: adpAdapter,
  readKind: 'feed_read',
  terms: { status: 'allowed_with_conditions', url: null, note: ADP_TERMS_NOTE },
  transferKeys: ['tenant'],
  importable: true,
  posting: {
    refOf: ({ source, sourceJobId, jobUrl }) => {
      const center = adpCenterOfConfig(source.config);
      return center && ADP_JOB_ID.test(sourceJobId) ? { kind: 'adp', board: adpBoardName(center), externalId: sourceJobId, region: 'global', page: jobUrl } : null;
    },
    // parseAtsUrl's board is the cid; the career center (ccId) is the link's.
    refOfLink: (read) => {
      const board = adpBoardOf(read.url);
      return board && ADP_JOB_ID.test(read.externalId) ? { kind: 'adp', board, externalId: read.externalId, region: 'global' } : null;
    },
    // Named by the source's companyName (or an import row's); v38 FIX-APP (D1): else by none (the read names no company:
    // the person's typed company names it, or Add job asks for it: jobs/add/board-link.ts), never the client's id.
    read: async (http, ref, options) => {
      const center = centerOfRef(ref);
      let list: AdpList;
      try {
        list = await readSharedFeed<AdpList>(options, `adp:${adpBoardName(center)}`, (signal) => readAdpList(http, center, { max: ADP_LINK_LIST_MAX, signal }));
      } catch (error) {
        // v38 FIX-A (M3): the career center's list answered 404: its address, not this posting, says so: try later.
        if (error instanceof SourceNotFoundError) return { found: false, unreadable: 'unavailable' };
        throw error;
      }
      const itemId = list.items.get(ref.externalId);
      // Not listed: closed when the list was read whole, else not known now (try later).
      if (!itemId) return list.whole ? { found: false } : { found: false, unreadable: 'unavailable' };
      const raw = await readAdpPosting(http, center, ref.externalId, itemId, {
        companyName: str(options.config?.companyName) ?? '', // v38 FIX-APP (D1)
        signal: options.signal,
      });
      return raw ? { found: true, raw } : { found: false };
    },
    // ADP names no employer anywhere: nothing to read (an import row's company or the source's names the job).
    companyName: () => Promise.resolve(null),
  },
};
