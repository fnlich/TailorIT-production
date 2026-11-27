import { boardUrlOf, PINPOINT_BOARD, pinpointCompany } from '@tailorit/shared/sourcing';
import {
  pinpointAdapter,
  pinpointCompanyFacts,
  pinpointCompanyNameOf,
  pinpointPosting,
  pinpointSiteOf,
  readPinpointFeed,
  type PinpointFeed,
} from '../adapters/pinpoint';
import { str } from '../adapters/common';
import { IngestError, SourceNotFoundError } from '../types';
import { readSharedFeed } from './feed-cache';
import { configString } from './read-json';
import type { ApiBoardDescriptor, PostingRef } from './types';

// v38 ATS-A (SP v38 PLAN "Final coverage" row 5; REQUEST.md 5, EVIDENCE.md 5): a Pinpoint careers site's API part (its
// shared part: @tailorit/shared/sourcing PINPOINT_BOARD). Pinpoint has no single-posting JSON: a posting's link (its
// UUID: https://<company>.pinpointhq.com[/<locale>]/postings/<uuid>) is read from the site's feeds (postings.json with
// jobs.rss for its date and the company's name, through the feed cache: read once and reused briefly), matched by the
// UUID in each posting's url/path (never its numeric `id`); missing is closed.
// v38 FIX-A (SP v38 FIXES-38 item 1, REVIEW38-beh M3): a 404 of postings.json is the site's problem (a wrong or retired
// address), never its postings' answer: a link's read answers try later (a run's is "source not found",
// adapters/pinpoint.ts). L18: the feeds a link's read shares are sent with no caller's signal (readSharedFeed).

/** v38 ATS-A: a Pinpoint source's recorded terms note (a new source's: job_sources.terms_note). */
export const PINPOINT_TERMS_NOTE =
  '2026-11-25: the owner decided TailorIT reads Pinpoint careers sites. Checked that day: /postings.json (every open ' +
  "posting with its text) and /jobs.rss (the company's name, each job's posted date) are public feeds of the " +
  "company's careers site, with no key; robots.txt allows both (it disallows /mydata, /admin and /companies). " +
  'Conditions: one request at a time to all of Pinpoint (its lane), with the bot user agent (BOT_USER_AGENT); each feed ' +
  "is read once a run; the hiring manager's name (reporting_to) and the apply form are never stored.";

/** A posting's UUID (lower case). */
const POSTING_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const postingRef = (company: string, id: string): PostingRef | null =>
  company && POSTING_UUID.test(id) ? { kind: 'pinpoint', board: company, externalId: id.toLowerCase(), region: 'global' } : null;

export const PINPOINT: ApiBoardDescriptor<'pinpoint'> = {
  board: PINPOINT_BOARD,
  adapter: pinpointAdapter,
  readKind: 'feed_read',
  terms: { status: 'allowed_with_conditions', url: null, note: PINPOINT_TERMS_NOTE },
  transferKeys: ['company'],
  importable: true,
  posting: {
    refOf: ({ source, sourceJobId }) => postingRef(pinpointCompany(configString(source.config, 'company')), sourceJobId),
    refOfLink: (read) => {
      const url = boardUrlOf(read.url);
      return postingRef(url ? pinpointCompany(url.hostname.toLowerCase()) : '', read.externalId);
    },
    apiUrl: (ref) => `https://${pinpointSiteOf({ company: ref.board }).host}/postings.json`,
    // Named by the source's companyName, else the RSS channel's company, else its address made readable.
    read: async (http, ref, options) => {
      const site = pinpointSiteOf({ company: ref.board });
      let feed: PinpointFeed;
      try {
        feed = await readSharedFeed<PinpointFeed>(options, `pinpoint:${site.company}`, (signal) => readPinpointFeed(http, site, signal));
      } catch (error) {
        // v38 FIX-A (M3): postings.json answered 404: the site's address, not this posting, says so: try later.
        if (error instanceof SourceNotFoundError) return { found: false, unreadable: 'unavailable' };
        throw error;
      }
      const posting = feed.postings.get(ref.externalId.toLowerCase());
      if (!posting) return { found: false };
      const raw = pinpointPosting(posting, site.host, pinpointCompanyNameOf(feed, site.company, str(options.config?.companyName)), feed.postedAt);
      if (!raw) throw new IngestError("Pinpoint's posting has no title.");
      return { found: true, raw, company: pinpointCompanyFacts(feed) };
    },
  },
};
