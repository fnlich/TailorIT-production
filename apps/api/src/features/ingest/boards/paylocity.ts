import { PAYLOCITY_BOARD, paylocityBoard, paylocityDetailsUrl } from '@tailorit/shared/sourcing';
import { str } from '../adapters/common';
import { paylocityAdapter, readPaylocityPosting } from '../adapters/paylocity';
import { configString } from './read-json';
import type { ApiBoardDescriptor } from './types';

// v38 ATS-C: Paylocity's API part (its shared part: @tailorit/shared/sourcing PAYLOCITY_BOARD). A run reads the board's
// page (its list as JSON) and each job's Details page (adapters/paylocity.ts); a link to a posting
// (recruiting.paylocity.com/Recruiting/Jobs/Details/<id>, or /Apply/<id>/) is read as its run reads it: its Details page,
// a new kind of read. A link names no board: the read answers the board its page links to (PostingAnswer.board), and the
// posting is kept under that board's source (jobs/add/board-link.ts). Gone: a redirect to Job Not Found (never followed),
// a 404 or 410.

/** v38 ATS-C (A5): a Paylocity source's recorded terms note (job_sources.terms_note, at most 1,000 characters). */
export const PAYLOCITY_TERMS_NOTE =
  "2026-11-25: the owner asked TailorIT to read Paylocity job boards. Checked that day: a board's page " +
  '(recruiting.paylocity.com/Recruiting/Jobs/All/<guid>) carries its list as JSON (window.pageData.Jobs) and each ' +
  "posting's Details page its text; recruiting.paylocity.com has no robots.txt; a gone posting redirects to Job Not " +
  'Found, which is never followed. Conditions: one request at a time to Paylocity, with the bot user agent ' +
  '(BOT_USER_AGENT); internal jobs and the apply form are never read.';

/** A posting's id as Paylocity writes it. */
const JOB_ID = /^\d{1,15}$/;

export const PAYLOCITY: ApiBoardDescriptor<'paylocity'> = {
  board: PAYLOCITY_BOARD,
  adapter: paylocityAdapter,
  readKind: 'feed_read',
  terms: { status: 'allowed_with_conditions', url: null, note: PAYLOCITY_TERMS_NOTE },
  transferKeys: ['board'],
  importable: true,
  posting: {
    refOf: ({ source, sourceJobId }) => {
      const board = paylocityBoard(configString(source.config, 'board'));
      return board && JOB_ID.test(sourceJobId) ? { kind: 'paylocity', board, externalId: sourceJobId, region: 'global' } : null;
    },
    // A link names no board (''): its Details page names it.
    refOfLink: (read) => (JOB_ID.test(read.externalId) ? { kind: 'paylocity', board: paylocityBoard(read.board ?? ''), externalId: read.externalId, region: 'global' } : null),
    apiUrl: (ref) => paylocityDetailsUrl(ref.externalId),
    // Named by the source's companyName, else by the board's own name (its page's).
    read: async (http, ref, options) => {
      const read = await readPaylocityPosting(http, ref.externalId, { companyName: str(options.config?.companyName), signal: options.signal });
      if (!read.found) return { found: false };
      return { found: true, raw: read.raw, company: read.company, ...(read.board ? { board: read.board } : {}) };
    },
  },
};
