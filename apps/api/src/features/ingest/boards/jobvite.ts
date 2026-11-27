import { JOBVITE_BOARD, jobviteCompany } from '@tailorit/shared/sourcing';
import { str } from '../adapters/common';
import { jobviteAdapter, jobviteJobUrl, readJobvitePosting } from '../adapters/jobvite';
import { configString } from './read-json';
import type { ApiBoardDescriptor } from './types';

// v38 ATS-C: Jobvite's API part (its shared part: @tailorit/shared/sourcing JOBVITE_BOARD). A run reads the company's
// list and each job's page (adapters/jobvite.ts); a link to a posting (jobs.jobvite.com/<company>/job/<id>[/apply]) is
// read as its run reads it: the posting's page and its JobPosting, a new kind of read. Gone: a 303 to the error page
// (never followed), a 404 or 410.

/** v38 ATS-C (A5): a Jobvite source's recorded terms note (job_sources.terms_note, at most 1,000 characters). */
export const JOBVITE_TERMS_NOTE =
  "2026-11-25: the owner asked TailorIT to read Jobvite boards. Checked that day: a company's list " +
  "(jobs.jobvite.com/<company>/jobs) and each posting's page (/<company>/job/<id>, one schema.org JobPosting) are the " +
  'public pages of its careers site; jobs.jobvite.com has no robots.txt; a gone posting answers a redirect to an error ' +
  'page, which is never followed. Conditions: one request at a time to Jobvite, with the bot user agent ' +
  '(BOT_USER_AGENT); the apply form is never read.';

/** A posting's id as Jobvite writes it (letters and digits, case-sensitive). */
const JOB_ID = /^[A-Za-z0-9]{1,40}$/;

export const JOBVITE: ApiBoardDescriptor<'jobvite'> = {
  board: JOBVITE_BOARD,
  adapter: jobviteAdapter,
  readKind: 'feed_read',
  terms: { status: 'allowed_with_conditions', url: null, note: JOBVITE_TERMS_NOTE },
  transferKeys: ['company'],
  importable: true,
  posting: {
    refOf: ({ source, sourceJobId }) => {
      const company = jobviteCompany(configString(source.config, 'company'));
      return company && JOB_ID.test(sourceJobId) ? { kind: 'jobvite', board: company, externalId: sourceJobId, region: 'global' } : null;
    },
    refOfLink: (read) => {
      const company = jobviteCompany(read.board ?? '');
      return company && JOB_ID.test(read.externalId) ? { kind: 'jobvite', board: company, externalId: read.externalId, region: 'global' } : null;
    },
    apiUrl: (ref) => jobviteJobUrl(ref.board, ref.externalId),
    // Named by the source's companyName, else by the posting's employer.
    read: async (http, ref, options) => {
      const read = await readJobvitePosting(http, ref.board, ref.externalId, { companyName: str(options.config?.companyName), signal: options.signal });
      return read.found ? { found: true, raw: read.raw, company: read.company } : { found: false };
    },
  },
};
