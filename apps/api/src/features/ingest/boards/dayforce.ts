import { boardUrlOf, DAYFORCE_BOARD, DAYFORCE_POSTING_ID, dayforcePostingOf, dayforcePostingUrl } from '@tailorit/shared/sourcing';
import { str } from '../adapters/common';
import { dayforceAdapter, readDayforcePosting } from '../adapters/dayforce';
import { IngestError } from '../types';
import { configString } from './read-json';
import type { ApiBoardDescriptor, PostingRef } from './types';

// v38 ATS-B: Dayforce's API part (its shared part: @tailorit/shared/sourcing DAYFORCE_BOARD). Links only (a portal's
// list needs a browser: the kind never runs): a link to a posting (jobs.dayforcehcm.com/[<locale>/]<namespace>/<portal>/
// jobs/<id>) is read from its page's Next.js data, a new kind of read, and kept under its client's source (made off, by
// Add job, as Workday's one-posting kind's). 404, Dayforce's own "not found" page or a past expiry: closed.

/** v38 ATS-B (SP v38 PLAN A5): a Dayforce source's recorded terms note (job_sources.terms_note, at most 1,000 characters). */
export const DAYFORCE_TERMS_NOTE =
  '2026-11-25: the owner asked TailorIT to verify Dayforce job links. Checked that day: robots.txt has no rules (only ' +
  "content-signal notes); a posting's page carries its data as Next.js page data (jobData); a portal's job list needs a " +
  'browser and is not read. Conditions: one request at a time to jobs.dayforcehcm.com, with the bot user agent ' +
  "(BOT_USER_AGENT); only the links people and imports add (and their re-checks) are read; the client's mailbox is never " +
  'read or stored.';

/** The posting's page: the ref's clean link, when it names this posting. */
function pageOfRef(ref: PostingRef): string {
  const page = ref.page ? boardUrlOf(ref.page) : null;
  const own = page ? dayforcePostingOf(page) : null;
  if (!own || own.id !== ref.externalId || own.namespace.toLowerCase() !== ref.board.toLowerCase()) {
    throw new IngestError("TailorIT does not know this Dayforce posting's page.");
  }
  return dayforcePostingUrl(own);
}

export const DAYFORCE: ApiBoardDescriptor<'dayforce'> = {
  board: DAYFORCE_BOARD,
  adapter: dayforceAdapter,
  readKind: 'feed_read',
  terms: { status: 'allowed_with_conditions', url: null, note: DAYFORCE_TERMS_NOTE },
  // Read one posting at a time, each read asking robots.txt itself (the ingest client): no source-level verdict.
  noRobots: true,
  posting: {
    // By its client, its id and its job's own link (the posting's page: its portal is the customer's own).
    refOf: ({ source, sourceJobId, jobUrl }) => {
      const namespace = configString(source.config, 'tenant').trim();
      return namespace && DAYFORCE_POSTING_ID.test(sourceJobId) ? { kind: 'dayforce', board: namespace, externalId: sourceJobId, region: 'global', page: jobUrl } : null;
    },
    refOfLink: (read) => {
      const url = boardUrlOf(read.url);
      const posting = url ? dayforcePostingOf(url) : null;
      return read.board && posting && posting.id === read.externalId
        ? { kind: 'dayforce', board: read.board, externalId: read.externalId, region: 'global', page: dayforcePostingUrl(posting) }
        : null;
    },
    apiUrl: (ref) => pageOfRef(ref),
    // Named by the source's companyName, else the name its site gives its correspondence.
    read: async (http, ref, options) => {
      const read = await readDayforcePosting(http, pageOfRef(ref), ref.externalId, {
        namespace: ref.board,
        companyName: str(options.config?.companyName),
        signal: options.signal,
        now: (options.now ?? (() => new Date()))(),
      });
      return read.found ? { found: true, raw: read.raw, ...(read.company ? { company: read.company } : {}) } : { found: false };
    },
  },
};
