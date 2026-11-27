import type { JobVerifyReason } from '@tailorit/shared';
import { SMARTRECRUITERS_BOARD, smartRecruitersCompany } from '@tailorit/shared/sourcing';
import { str } from '../adapters/common';
import { readSmartRecruitersPosting, smartRecruitersAdapter, smartRecruitersCompanyUrl, smartRecruitersPageOf } from '../adapters/smartrecruiters';
import { configString } from './read-json';
import type { ApiBoardDescriptor } from './types';

// v38 ATS-C: SmartRecruiters' API part (its shared part: @tailorit/shared/sourcing SMARTRECRUITERS_BOARD), links only.
// A numeric link's posting is read from its own page (its schema.org microdata: adapters/smartrecruiters.ts), a new kind
// of read; api.smartrecruiters.com is never asked (its robots.txt disallows it). A one-click link
// (/oneclick-ui/company/<Company>/publication/<uuid>) is recognised and cleaned, but its page answers a bot check
// (DataDome): its read answers can't read at once, nothing sent (the adder keeps the job as their own).

/** v38 ATS-C (A5): a SmartRecruiters source's recorded terms note (job_sources.terms_note, at most 1,000 characters). */
export const SMARTRECRUITERS_TERMS_NOTE =
  "2026-11-25: the owner asked TailorIT to verify SmartRecruiters job links. Checked that day: a posting's own page " +
  '(jobs.smartrecruiters.com/<Company>/<id>-<slug>) is public, server-rendered and carries schema.org JobPosting ' +
  "microdata; jobs.smartrecruiters.com has no robots.txt. api.smartrecruiters.com's robots.txt disallows every path " +
  'for other bots, so it is never read; one-click application pages answer a bot check (DataDome) and are never read. ' +
  'Conditions: one request at a time to SmartRecruiters, with the bot user agent (BOT_USER_AGENT); links only, no ' +
  'company list.';

/**
 * v38 ATS-C (SP v38 WAVE2 item 5): the can't-read reason of a one-click link (a bot check guards its page). ATS-D adds
 * the bot-check reason and its words; INT sets it here (one line). v38 INT: ATS-D's `bot_check` (can't read: "This site
 * checks for robots"), never `blocked` (try later): the page is never asked.
 */
export const SMARTRECRUITERS_ONE_CLICK_REASON: JobVerifyReason = 'bot_check';

/** A posting's number as SmartRecruiters writes it (a one-click link's id is its publication's uuid instead). */
const POSTING_ID = /^\d{6,20}$/;

export const SMARTRECRUITERS: ApiBoardDescriptor<'smartrecruiters'> = {
  board: SMARTRECRUITERS_BOARD,
  adapter: smartRecruitersAdapter,
  readKind: 'feed_read',
  terms: { status: 'allowed_with_conditions', url: null, note: SMARTRECRUITERS_TERMS_NOTE },
  posting: {
    // A stored link: its company's, its number, its job's own page.
    refOf: ({ source, sourceJobId, jobUrl }) => {
      const company = smartRecruitersCompany(configString(source.config, 'company'));
      return company && POSTING_ID.test(sourceJobId) ? { kind: 'smartrecruiters', board: company, externalId: sourceJobId, region: 'global', page: jobUrl } : null;
    },
    // Either form (the extension's reading: a posting's number, or a one-click publication's uuid).
    refOfLink: (read) => (read.board ? { kind: 'smartrecruiters', board: read.board, externalId: read.externalId, region: 'global', page: read.url } : null),
    // v38 FIX-C (beh-L11): a job whose link is not the posting's own page is read nowhere (can't read); its company's
    // address names the host it would go to (the re-check's hold check).
    apiUrl: (ref) => smartRecruitersPageOf({ company: ref.board, id: ref.externalId, page: ref.page }) ?? smartRecruitersCompanyUrl(ref.board),
    read: async (http, ref, options) => {
      // A one-click link's page is a bot check: never asked.
      if (!POSTING_ID.test(ref.externalId)) return { found: false, unreadable: SMARTRECRUITERS_ONE_CLICK_REASON };
      const read = await readSmartRecruitersPosting(
        http,
        { company: ref.board, id: ref.externalId, page: ref.page },
        { companyName: str(options.config?.companyName), signal: options.signal, now: options.now?.() },
      );
      return read.found ? { found: true, raw: read.raw, company: read.company } : { found: false };
    },
  },
};
