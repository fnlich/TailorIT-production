import { PAYCOM_BOARD, paycomClientKey, paycomJobUrl } from '@tailorit/shared/sourcing';
import { str } from '../adapters/common';
import { paycomAdapter, readPaycomPosting } from '../adapters/paycom';
import { configString } from './read-json';
import type { ApiBoardDescriptor } from './types';

// v38 ATS-C: Paycom's API part (its shared part: @tailorit/shared/sourcing PAYCOM_BOARD), links only. A link to a posting
// (www.paycomonline.net/v4/ats/web.php/portal/<clientKey>/jobs/<id>) is read from its page's schema.org JobPosting
// (adapters/paycom.ts), a new kind of read. Gone: a 404 or 410, a past validThrough; v38 FIX-C (D2): the portal's own empty
// page (adapters/paycom.ts isPaycomEmptyPortal: a new link closes at once, a stored job once two reads a day apart see it:
// boards/sightings.ts). A page with no JobPosting and none of those signs is can't read, never gone.

/** v38 ATS-C (A5): a Paycom source's recorded terms note (job_sources.terms_note, at most 1,000 characters). */
export const PAYCOM_TERMS_NOTE =
  "2026-11-25: the owner asked TailorIT to verify Paycom job links. Checked that day: robots.txt allows the portals' " +
  "pages (/v4/ats/web.php/portal/); a posting's page carries one schema.org JobPosting in its HTML (it names no place); a " +
  "gone posting's page is the portal's empty shell (no job in it). The careers list needs a browser, which TailorIT does not run: links only, no portal " +
  'list. Conditions: one request at a time to Paycom, with the bot user agent (BOT_USER_AGENT); the application pages ' +
  'are never read.';

/** A posting's id as Paycom writes it. */
const JOB_ID = /^\d{1,15}$/;

export const PAYCOM: ApiBoardDescriptor<'paycom'> = {
  board: PAYCOM_BOARD,
  adapter: paycomAdapter,
  readKind: 'feed_read',
  terms: { status: 'allowed_with_conditions', url: null, note: PAYCOM_TERMS_NOTE },
  posting: {
    refOf: ({ source, sourceJobId }) => {
      const key = paycomClientKey(configString(source.config, 'board'));
      return key && JOB_ID.test(sourceJobId) ? { kind: 'paycom', board: key, externalId: sourceJobId, region: 'global' } : null;
    },
    refOfLink: (read) => {
      const key = paycomClientKey(read.board ?? '');
      return key && JOB_ID.test(read.externalId) ? { kind: 'paycom', board: key, externalId: read.externalId, region: 'global' } : null;
    },
    apiUrl: (ref) => paycomJobUrl(ref.board, ref.externalId),
    // Named by the source's companyName, else by the posting's hiring organisation.
    read: async (http, ref, options) => {
      const read = await readPaycomPosting(http, ref.board, ref.externalId, {
        companyName: str(options.config?.companyName),
        signal: options.signal,
        now: options.now?.(),
      });
      if (read.found) return { found: true, raw: read.raw, company: read.company };
      // v38 FIX-C (D2): the empty portal closes a stored job only when seen twice a day apart (boards/sightings.ts).
      return read.emptyPortal ? { found: false, confirmTwice: true } : { found: false };
    },
  },
};
