import { assertNewReadAllowed, type NewReadKind } from '../../../core/http/identity';
import { BREEZY_BOARD, breezyCompany } from '@tailorit/shared/sourcing'; // v38 FRAME: the board registry's rules
import type { CompanyFacts } from '../boards/types'; // v38 ATS-A
import type { HttpAnswer, IngestHttp } from '../http'; // v38 ATS-A
import { IngestError, SourceNotFoundError, type FetchFailure, type ListingValidators, type RawPosting } from '../types';
import { isRecord, nameFromSlug, records, str, type Json } from './common';
import { conditionalOf, defineAdapter, notModifiedResult } from './define';

// v30 S3: Breezy HR's public positions list (docs/design/part2/12-job-sourcing.md §3.3): GET
// https://{company}.breezy.hr/json, an array of the company's published positions (id, name, url, published_date,
// type, location { name, city, state, country, is_remote }, department, salary, description when given). Breezy
// documents no such endpoint (a third party lists it, 12 [G24]), so its terms are NOT recorded: a Breezy source starts
// `unchecked` (sources.ts KIND_TERMS has no entry) and is never run until an admin records them after a dated check
// (PLAN §10, S3). The adapter exists so that check is all that is missing; its tests use answers written by hand.
//
// A source: config `{ company, companyName? }`. A new kind of read: the identity guard first ('feed_read').
//
// v38 ATS-A (SP v38 PLAN A5, "Final coverage" row 1; EVIDENCE.md 1, read 2026-11-25): the owner decided on 2026-11-25
// that TailorIT reads Breezy HR (its terms recorded: boards/breezy.ts BREEZY_TERMS_NOTE). The list is read with each
// position's text, GET https://{company}.breezy.hr/json?verbose=true (an array, no paging; 327 kB for 27 positions,
// read once a run): each entry's `description` (HTML), `company { name, logo_url }`. robots.txt allows /json. A position
// has no status: one missing from the list is closed, and a position's link is read from the list (boards/breezy.ts).

const NEW_READ: NewReadKind = 'feed_read';

/** v38 ATS-A: the most of the list read (327 kB for 27 positions with their text): 16 MB. Past it the run fails (413). */
export const BREEZY_FEED_MAX_BYTES = 16 * 1024 * 1024;

/** The company's name on Breezy as typed: a name or an address on breezy.hr (v38 FRAME: the registry's). */
export { breezyCompany };

/** A Breezy source's listing: its host and address. */
export function breezyFeedOf(config: Record<string, unknown>): { company: string; host: string; url: string } {
  const company = breezyCompany(str(config.company) ?? '');
  const host = company ? BREEZY_BOARD.hostOf({ company }) : null;
  if (!host) throw new IngestError('This source has no Breezy company name ({company}.breezy.hr). Edit the source and add it.');
  return { company, host, url: `https://${host}/json?verbose=true` }; // v38 ATS-A: with each position's text
}

/** v38 ATS-A (A6): what a position says about its company: its name and its logo on Breezy. */
export function breezyCompanyFacts(position: Record<string, unknown>): CompanyFacts {
  const company = isRecord(position.company) ? position.company : {};
  return { name: str(company.name), logoUrl: str(company.logo_url) };
}

/**
 * v38 ATS-A: a company's list as read (at most BREEZY_FEED_MAX_BYTES, on its own host only): its answer, conditional when
 * `validators` are given. A run and a link's read (boards/breezy.ts, through the feed cache) read it alike.
 */
export function readBreezyFeed(
  http: IngestHttp,
  feed: { host: string; url: string },
  options: { signal?: AbortSignal; validators?: { etag?: string; lastModified?: string }; meta?: (meta: { etag: string | null; lastModified: string | null }) => void } = {},
): Promise<HttpAnswer> {
  return http.getJson(feed.url, {
    signal: options.signal,
    allow: [404],
    maxBytes: BREEZY_FEED_MAX_BYTES,
    allowRedirectHost: (host) => host === feed.host,
    ...(options.validators ?? {}),
    ...(options.meta ? { meta: options.meta } : {}),
  });
}

/** A position's place as the places reader reads it, and its country code. */
function placeOf(position: Json): { text: string | null; country: string | null; remote: boolean } {
  const location = isRecord(position.location) ? position.location : {};
  const state = isRecord(location.state) ? (str(location.state.id) ?? str(location.state.name)) : str(location.state);
  const countryCode = isRecord(location.country) ? str(location.country.id) : null;
  const countryName = isRecord(location.country) ? str(location.country.name) : str(location.country);
  const text = str(location.name) ?? ([str(location.city), state, countryName].filter(Boolean).join(', ') || null);
  return {
    text,
    country: countryCode && /^[A-Za-z]{2}$/.test(countryCode) ? countryCode.toUpperCase() : null,
    remote: location.is_remote === true,
  };
}

/** One position as a RawPosting; null when it lacks an id or a name. */
export function breezyPosting(position: Json, host: string, companyName: string): RawPosting | null {
  const id = str(position.id) ?? str(position.friendly_id);
  const title = str(position.name);
  if (!id || !/^[A-Za-z0-9_-]{1,200}$/.test(id) || !title) return null;
  let url = `https://${host}/p/${id}`;
  try {
    const given = str(position.url) ? new URL(str(position.url)!) : null;
    if (given && given.protocol === 'https:' && given.hostname === host) url = given.href;
  } catch {
    /* the built address */
  }
  const place = placeOf(position);
  const type = isRecord(position.type) ? (str(position.type.name) ?? str(position.type.id)) : str(position.type);
  return {
    sourceJobId: id,
    title,
    company: { name: companyName },
    descriptionHtml: str(position.description),
    url,
    locations: place.text ? [place.text] : place.remote ? ['Remote'] : [],
    countryHint: place.country,
    workArrangement: place.remote ? 'remote' : null,
    employmentText: type,
    department: str(position.department),
    salaryText: str(position.salary),
    postedAt: str(position.published_date),
  };
}

export const breezyAdapter = defineAdapter({
  kind: 'breezy',
  label: 'Breezy HR positions',
  access: 'api',
  hosts: ['*.breezy.hr'],
  robotsPaths(source) {
    try {
      breezyFeedOf(source.config);
      return ['/json?verbose=true', '/p/']; // v38 ATS-A
    } catch {
      return [];
    }
  },
  async fetch(source, ctx) {
    assertNewReadAllowed(ctx.deps, NEW_READ);
    const feed = breezyFeedOf(source.config);
    let validators: ListingValidators | null = null;
    // v38 ATS-A: the list with each position's text, read once a run (at most BREEZY_FEED_MAX_BYTES).
    const answer = await readBreezyFeed(ctx.http, feed, {
      signal: ctx.signal,
      validators: conditionalOf(ctx),
      meta: (meta) => (validators = { etag: meta.etag, lastModified: meta.lastModified }),
    });
    if (answer.status === 304) return notModifiedResult();
    if (answer.status === 404) throw new SourceNotFoundError(`Breezy has no company "${feed.company}" (${feed.host}). Check the company name.`);
    if (!Array.isArray(answer.data)) throw new IngestError(`Breezy answered without the positions of "${feed.company}".`);
    const named = str(source.config.companyName);
    const postings: RawPosting[] = [];
    const failures: FetchFailure[] = [];
    for (const position of records(answer.data)) {
      const facts = breezyCompanyFacts(position); // v38 ATS-A (A6)
      const posting = breezyPosting(position, feed.host, named ?? facts.name ?? nameFromSlug(feed.company));
      // v38 ATS-A (A6): its logo on Breezy for the company's record (copied by the logo step, never hot-linked).
      if (posting && facts.logoUrl && /^https:\/\//i.test(facts.logoUrl)) posting.company.logoSourceUrl = facts.logoUrl;
      if (posting) postings.push(posting);
      else failures.push({ sourceJobId: str(position.id) ?? undefined, message: 'A position has no id or name.' });
    }
    ctx.log(`Breezy ${feed.company}: ${postings.length} positions.`);
    return { postings, complete: true, failures, validators };
  },
});
