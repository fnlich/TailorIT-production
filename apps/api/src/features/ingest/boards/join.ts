import { boardUrlOf, JOIN_BOARD, JOIN_HOST, joinCompanyOf, joinJobOf, joinJobUrl } from '@tailorit/shared/sourcing';
import { str } from '../adapters/common';
import { joinAdapter, readJoinPosting } from '../adapters/join';
import { configString } from './read-json';
import type { ApiBoardDescriptor, PostingRef } from './types';

// v38 ATS-B: Join.com's API part (its shared part: @tailorit/shared/sourcing JOIN_BOARD). A run reads the company's page
// and each job's page (adapters/join.ts); a link to a job (https://join.com/companies/<company>/<id>-<slug>) is read from
// its page's Next.js data (else its JSON-LD), a new kind of read: 404, or a status no longer ONLINE, is closed.
// v38 FIX-A (SP v38 FIXES-38 item 11; REVIEW38-ux M3, REVIEW38-beh M13): the short form, https://join.com/jobs/<id>
// (REQUEST.md 13: it loads the job, and its canonical tag gives the long form), is read as Join's too: one read of the
// short page (Join's own page: robots.txt allows /jobs/, the client asks it first), whose Next.js data (company.domain)
// or canonical link names the company; the posting is then the long form's, kept under that company's source (the read
// answers its `board`, as a Paylocity page does: jobs/add/board-link.ts), so a short and a long link of one posting are
// one job, read and published alike, and no career site is made for join.com. A short page that names no company is
// can't read.

/** v38 ATS-B (SP v38 PLAN A5): a Join.com source's recorded terms note (job_sources.terms_note, at most 1,000 characters). */
export const JOIN_TERMS_NOTE =
  '2026-11-25: the owner asked TailorIT to verify job links and read Join.com companies. Checked that day: robots.txt ' +
  "disallows only /*/lp/ (never read) and lists the job sitemaps; a company's page and each job's page carry their data " +
  'as Next.js page data (and a schema.org JobPosting). Conditions: one request at a time to join.com, with the bot user ' +
  "agent (BOT_USER_AGENT); a run lists a company page's first jobs only (its next pages are not read) and reads at most " +
  "JOIN_READS_PER_RUN jobs' pages; a job's contact person is never read or stored.";

/** The job's page: the ref's clean link when it names this job of this company, else built from the company and id. */
function pageOfRef(ref: PostingRef): string {
  const page = ref.page ? boardUrlOf(ref.page) : null;
  const own = page ? joinJobOf(page) : null;
  // v38 FIX-A: a ref that names no company (a short link's) reads the short page (its own, when it is this job's).
  if (!ref.board) return own && !own.company && own.id === ref.externalId ? joinJobUrl(null, own.segment) : `https://${JOIN_HOST}/jobs/${ref.externalId}`;
  return own && own.id === ref.externalId && own.company === ref.board ? joinJobUrl(own.company, own.segment) : joinJobUrl(ref.board, ref.externalId);
}

export const JOIN: ApiBoardDescriptor<'join'> = {
  board: JOIN_BOARD,
  adapter: joinAdapter,
  readKind: 'feed_read',
  terms: { status: 'allowed_with_conditions', url: null, note: JOIN_TERMS_NOTE },
  transferKeys: ['company'],
  importable: true,
  posting: {
    refOf: ({ source, sourceJobId, jobUrl }) => {
      const company = joinCompanyOf(configString(source.config, 'company'));
      return company && /^\d{1,15}$/.test(sourceJobId) ? { kind: 'join', board: company, externalId: sourceJobId, region: 'global', page: jobUrl } : null;
    },
    // v38 FIX-A (M3): a link that names its company, or the short /jobs/<id> (board '': its page names it).
    refOfLink: (read) =>
      /^\d{1,15}$/.test(read.externalId)
        ? { kind: 'join', board: read.board ?? '', externalId: read.externalId, region: 'global', page: read.canonical[0] ?? read.url }
        : null,
    apiUrl: (ref) => pageOfRef(ref),
    // Named by the source's companyName, else the job's company.
    read: async (http, ref, options) => {
      const read = await readJoinPosting(http, pageOfRef(ref), ref.externalId, { companyName: str(options.config?.companyName), signal: options.signal });
      if (!read.found) return { found: false };
      // v38 FIX-A (M3): a short link's posting is kept under the company its page names.
      return { found: true, raw: read.raw, ...(read.company ? { company: read.company } : {}), ...(!ref.board && read.board ? { board: read.board } : {}) };
    },
  },
};
