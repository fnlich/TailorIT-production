import { boardUrlOf, TEAMTAILOR_BOARD, teamtailorCompany } from '@tailorit/shared/sourcing';
import { nameFromSlug, str } from '../adapters/common';
import {
  readTeamtailorFeed,
  readTeamtailorPage,
  teamtailorAdapter,
  teamtailorFeedUrl,
  teamtailorPosting,
  teamtailorSiteOf,
  type TeamtailorFeed,
} from '../adapters/teamtailor';
import { HostHeldError, IngestHttpError } from '../http';
import { readSharedFeed } from './feed-cache';
import { configString } from './read-json';
import type { ApiBoardDescriptor, PostingRef } from './types';

// v38 ATS-A (SP v38 PLAN "Final coverage" row 24; REQUEST.md 24, EVIDENCE.md 24; SP v38 FRAME open item 6): a Teamtailor
// careers site's API part (its shared part: @tailorit/shared/sourcing TEAMTAILOR_BOARD). A job's link
// (https://<company>.teamtailor.com/jobs/<number>[-<slug>]) is read from the company's feed (its first page, through
// the feed cache: read once and reused briefly); a job the feed does not list may be unlisted, not closed (REQUEST.md
// 24), so its own page's JSON-LD decides: its JobPosting (open), a 404 or a past validThrough (closed), or a page with no
// JobPosting (try later). A held lane or a 429 on the feed is the read's answer (nothing more is sent).
// v38 FIX-A (SP v38 FIXES-38 items 8 and 12; REVIEW38-beh M11, L8, L18): the feed's jobs.rss gives a listed job's remote
// or hybrid; a 401 or 403 on the feed stops the read too (the host is held: a bot check or a refusal is never retried);
// the feed a link's read shares is sent with no caller's signal (readSharedFeed).

/** v38 ATS-A: a Teamtailor source's recorded terms note (a new source's; migration 0065 writes it on converted ones). */
export const TEAMTAILOR_TERMS_NOTE =
  '2026-11-25: the owner decided TailorIT reads Teamtailor careers sites. Checked that day: /jobs.json (a JSON Feed of ' +
  "the listed jobs, each with its schema.org JobPosting) and each job's page (/jobs/<number>-<slug>, its JobPosting as " +
  'JSON-LD) are public, with no key; robots.txt allows them (it disallows /app/, /messages/, /messenger/, /facebook/tab/ ' +
  'and /jobs/internal/; its Content-Signal says search=yes, ai-input=yes, ai-train=no). An unlisted job is still open: ' +
  "only its page's 404 closes it. Conditions: one request at a time to all of Teamtailor (its lane), with the bot user " +
  'agent (BOT_USER_AGENT); the feed is read once a run.';

/** A job's number. */
const JOB_NUMBER = /^\d{1,12}$/;

const jobRef = (company: string, id: string, page: string | null): PostingRef | null =>
  company && JOB_NUMBER.test(id) ? { kind: 'teamtailor', board: company, externalId: id, region: 'global', ...(page ? { page } : {}) } : null;

/** Whether a feed read's failure stops the read (a held lane, a 429; v38 FIX-A, L8: a 401 or 403): nothing more is sent. */
const stopsTheRead = (error: unknown) => error instanceof HostHeldError || (error instanceof IngestHttpError && [401, 403, 429].includes(error.status));

export const TEAMTAILOR: ApiBoardDescriptor<'teamtailor'> = {
  board: TEAMTAILOR_BOARD,
  adapter: teamtailorAdapter,
  readKind: 'feed_read',
  terms: { status: 'allowed_with_conditions', url: null, note: TEAMTAILOR_TERMS_NOTE },
  transferKeys: ['company'],
  importable: true,
  posting: {
    // By its number and its job's own page (read when the feed does not list it).
    refOf: ({ source, sourceJobId, jobUrl }) => jobRef(teamtailorCompany(configString(source.config, 'company')), sourceJobId, jobUrl),
    refOfLink: (read) => {
      const url = boardUrlOf(read.url);
      return jobRef(url ? teamtailorCompany(url.hostname.toLowerCase()) : '', read.externalId, read.canonical[0] ?? null);
    },
    apiUrl: (ref) => teamtailorFeedUrl(teamtailorSiteOf({ company: ref.board }).host),
    read: async (http, ref, options) => {
      const site = teamtailorSiteOf({ company: ref.board });
      const named = str(options.config?.companyName);
      let feed: TeamtailorFeed | null = null;
      try {
        feed = await readSharedFeed<TeamtailorFeed>(options, `teamtailor:${site.company}`, (signal) => readTeamtailorFeed(http, site, { signal, pages: 1 }));
      } catch (error) {
        if (options.signal?.aborted || stopsTheRead(error)) throw error;
        // No feed (the site's feed is gone, or it failed): the job's own page decides.
      }
      const job = feed?.jobs.get(ref.externalId);
      const listed = job && feed ? teamtailorPosting(job, site.host, named ?? feed.company.name ?? nameFromSlug(site.company), feed.arrangements.get(job.id) ?? null) : null;
      if (listed && feed) return { found: true, raw: listed, company: feed.company };
      // Not in the feed: an unlisted job is still open, so its page decides.
      const page = await readTeamtailorPage(http, site, ref.externalId, {
        page: ref.page ?? null,
        named,
        signal: options.signal,
        now: (options.now ?? (() => new Date()))(),
      });
      if (page.found) return { found: true, raw: page.raw, company: page.company };
      return 'noPosting' in page ? { found: false, unreadable: 'unavailable' } : { found: false };
    },
  },
};
