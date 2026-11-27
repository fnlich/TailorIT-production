import { RECRUITERFLOW_BOARD, RECRUITERFLOW_JOB_ID, recruiterflowCompanyOf, recruiterflowJobUrl } from '@tailorit/shared/sourcing';
import { str } from '../adapters/common';
import { readRecruiterflowPosting, recruiterflowAdapter } from '../adapters/recruiterflow';
import { configString } from './read-json';
import type { ApiBoardDescriptor } from './types';

// v38 ATS-B: Recruiterflow's API part (its shared part: @tailorit/shared/sourcing RECRUITERFLOW_BOARD). A run reads the
// board's page and each job's page (adapters/recruiterflow.ts); a link to a job (https://recruiterflow.com/<company>/
// jobs/<id>) is read from its page's raw HTML (its JSON-LD and page data; no browser), a new kind of read: 404, or the
// closed visibility, is closed.
// v38 FIX-A (SP v38 FIXES-38 D5, REVIEW38-beh M8): the company's path is read as written: a link's as the link wrote it,
// a stored link's as its job's own link wrote it when that names the source's company in another case (sources are
// looked up in any case), else the source's.

/** v38 ATS-B (SP v38 PLAN A5): a Recruiterflow source's recorded terms note (job_sources.terms_note, at most 1,000 characters). */
export const RECRUITERFLOW_TERMS_NOTE =
  '2026-11-25: the owner asked TailorIT to verify job links and read Recruiterflow job boards. Checked that day: ' +
  "robots.txt allows everything; a board's page and each job's page carry their data in the raw HTML (window.jobsList, " +
  "a schema.org JobPosting and the page's job data), so no browser is used. Conditions: one request at a time to " +
  "recruiterflow.com, with the bot user agent (BOT_USER_AGENT); a run reads at most RECRUITERFLOW_READS_PER_RUN jobs' " +
  "pages; a job's apply form is never read or stored.";

export const RECRUITERFLOW: ApiBoardDescriptor<'recruiterflow'> = {
  board: RECRUITERFLOW_BOARD,
  adapter: recruiterflowAdapter,
  readKind: 'feed_read',
  terms: { status: 'allowed_with_conditions', url: null, note: RECRUITERFLOW_TERMS_NOTE },
  transferKeys: ['company'],
  importable: true,
  posting: {
    refOf: ({ source, sourceJobId, jobUrl }) => {
      const kept = recruiterflowCompanyOf(configString(source.config, 'company'));
      // v38 FIX-A (D5): the company as the job's own link writes it, when it is the source's in another case.
      const own = recruiterflowCompanyOf(jobUrl ?? '');
      const company = own && own.toLowerCase() === kept.toLowerCase() ? own : kept;
      return company && RECRUITERFLOW_JOB_ID.test(sourceJobId) ? { kind: 'recruiterflow', board: company, externalId: sourceJobId, region: 'global' } : null;
    },
    refOfLink: (read) =>
      read.board && RECRUITERFLOW_JOB_ID.test(read.externalId) ? { kind: 'recruiterflow', board: read.board, externalId: read.externalId, region: 'global' } : null,
    apiUrl: (ref) => recruiterflowJobUrl(ref.board, ref.externalId),
    // Named by the source's companyName, else the job's hiring organisation (most often the recruiting agency).
    read: async (http, ref, options) => {
      const read = await readRecruiterflowPosting(http, ref.board, ref.externalId, { companyName: str(options.config?.companyName), signal: options.signal });
      return read.found ? { found: true, raw: read.raw, company: read.company } : { found: false };
    },
  },
};
