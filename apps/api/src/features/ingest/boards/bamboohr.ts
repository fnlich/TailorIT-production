import { BAMBOOHR_BOARD, bamboohrCompany, boardUrlOf } from '@tailorit/shared/sourcing';
import { bamboohrAdapter, bamboohrDetailUrl, readBamboohrCompanyName, readBamboohrPosting } from '../adapters/bamboohr';
import { nameFromSlug, str } from '../adapters/common';
import { configString } from './read-json';
import type { ApiBoardDescriptor } from './types';

// v38 FRAME: BambooHR's API part (its shared part: @tailorit/shared/sourcing BAMBOOHR_BOARD). A run reads the company's
// list and each opening's detail (adapters/bamboohr.ts); a link to an opening (https://<company>.bamboohr.com/careers/<id>)
// is read as its run reads it: the opening's detail JSON (v37 BOARDS B1, B4; jobs/add/board-link.ts), a new kind of
// read. An opening names no employer: its company's name is read once from the careers page (v37 FIX-37A E6).

/**
 * v37 BOARDS (SP v37 PLAN B2): a BambooHR source's recorded terms note (job_sources.terms_note, at most 1,000 characters),
 * word for word as migration 0063 writes it.
 */
export const BAMBOOHR_TERMS_NOTE =
  '2026-11-24: the owner decided TailorIT reads BambooHR careers lists. Checked that day: the list (/careers/list) and ' +
  "each opening's detail (/careers/<id>/detail) are the public careers JSON the company's own careers page loads " +
  "(BambooHR documents no such API; its own API needs a customer's key); robots.txt allows everything. Conditions: one " +
  'request at a time per host, with the bot user agent (BOT_USER_AGENT); the apply form is never read or stored.';

/** An opening's id as BambooHR writes it. */
const OPENING_ID = /^\d{1,20}$/;

export const BAMBOOHR: ApiBoardDescriptor<'bamboohr'> = {
  board: BAMBOOHR_BOARD,
  adapter: bamboohrAdapter,
  readKind: 'feed_read',
  // v37 BOARDS (SP v37 PLAN B2): the owner decided on 2026-11-24 that TailorIT reads BambooHR careers lists.
  terms: { status: 'allowed_with_conditions', url: null, note: BAMBOOHR_TERMS_NOTE },
  transferKeys: ['company'],
  importable: true,
  posting: {
    refOf: ({ source, sourceJobId }) => {
      const company = bamboohrCompany(configString(source.config, 'company'));
      return company && OPENING_ID.test(sourceJobId) ? { kind: 'bamboohr', board: company, externalId: sourceJobId, region: 'global' } : null;
    },
    refOfLink: (read) => {
      const url = boardUrlOf(read.url);
      const company = url ? bamboohrCompany(url.hostname.toLowerCase()) : '';
      return company && OPENING_ID.test(read.externalId) ? { kind: 'bamboohr', board: company, externalId: read.externalId, region: 'global' } : null;
    },
    apiUrl: (ref) => bamboohrDetailUrl(BAMBOOHR_BOARD.hostOf({ company: ref.board }) ?? `${ref.board}.bamboohr.com`, ref.externalId),
    // Named by the source's companyName, else as its run names it.
    read: async (http, ref, options) => {
      const companyName = str(options.config?.companyName) ?? nameFromSlug(ref.board);
      const raw = await readBamboohrPosting(http, ref.board, ref.externalId, companyName, options.signal);
      return raw ? { found: true, raw } : { found: false };
    },
    companyName: (http, board, signal) => readBamboohrCompanyName(http, board, signal),
  },
};
