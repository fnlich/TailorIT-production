import { AVATURE_BOARD, avatureSite } from '@tailorit/shared/sourcing';
import { str } from '../adapters/common';
import { avatureAdapter, avaturePageOf, avatureSearchUrl, readAvaturePosting } from '../adapters/avature';
import { configString } from './read-json';
import type { ApiBoardDescriptor } from './types';

// v38 ATS-C: Avature's API part (its shared part: @tailorit/shared/sourcing AVATURE_BOARD). A run reads the site's job
// search pages and each job's page (adapters/avature.ts); a link to a posting (<tenant>.avature.net/<locale>/<portal>/
// JobDetail/<slug>/<id>) is read as its run reads it: the posting's page, a new kind of read. Gone: a redirect to the
// site's error page (never followed), a 404 or 410.

/** v38 ATS-C (A5): an Avature source's recorded terms note (job_sources.terms_note, at most 1,000 characters). */
export const AVATURE_TERMS_NOTE =
  "2026-11-25: the owner asked TailorIT to read Avature careers sites. Checked that day: robots.txt allows each portal's " +
  'pages (Allow /*/careers) and disallows addresses with qtvc=, which TailorIT never sends; the job search (SearchJobs, ' +
  "6 jobs a page, followed by its next links) and each posting's page are public, server-rendered pages; a gone posting " +
  "redirects to the site's error page, which is never followed. Conditions: one request at a time to Avature, with the " +
  'bot user agent (BOT_USER_AGENT), at most AVATURE_LIST_PAGES_PER_RUN list pages a run; the apply and sign-in pages are ' +
  'never read.';

/** A posting's id as Avature writes it. */
const JOB_ID = /^\d{1,12}$/;

export const AVATURE: ApiBoardDescriptor<'avature'> = {
  board: AVATURE_BOARD,
  adapter: avatureAdapter,
  readKind: 'feed_read',
  terms: { status: 'allowed_with_conditions', url: null, note: AVATURE_TERMS_NOTE },
  transferKeys: ['site'],
  importable: true,
  posting: {
    refOf: ({ source, sourceJobId, jobUrl }) => {
      const site = avatureSite(configString(source.config, 'site'));
      return site && JOB_ID.test(sourceJobId) ? { kind: 'avature', board: site, externalId: sourceJobId, region: 'global', page: jobUrl } : null;
    },
    refOfLink: (read) => {
      const site = avatureSite(read.board ?? '');
      return site && JOB_ID.test(read.externalId) ? { kind: 'avature', board: site, externalId: read.externalId, region: 'global', page: read.url } : null;
    },
    // v38 FIX-C (beh-L11): a job whose link is not the posting's own page is read nowhere (can't read): its site's search page
    // names the host it would go to (the re-check's hold check).
    apiUrl: (ref) => avaturePageOf(ref.board, ref.externalId, ref.page) ?? avatureSearchUrl(ref.board),
    // Named by the source's companyName, else by the posting's Company field.
    read: async (http, ref, options) => {
      const read = await readAvaturePosting(http, ref.board, ref.externalId, { page: ref.page, companyName: str(options.config?.companyName), signal: options.signal });
      return read.found ? { found: true, raw: read.raw, company: read.company } : { found: false };
    },
  },
};
