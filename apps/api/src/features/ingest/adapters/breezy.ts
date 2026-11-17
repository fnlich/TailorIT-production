import { assertNewReadAllowed, type NewReadKind } from '../../../core/http/identity';
import { feedHostOf } from '../sources';
import { tenantOf } from '../sitemap';
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

const NEW_READ: NewReadKind = 'feed_read';

/** The company's name on Breezy as typed: a name or an address on breezy.hr. */
export const breezyCompany = (input: string) => tenantOf(input, ['breezy.hr']);

/** A Breezy source's listing: its host and address. */
export function breezyFeedOf(config: Record<string, unknown>): { company: string; host: string; url: string } {
  const company = breezyCompany(str(config.company) ?? '');
  const host = company ? feedHostOf('breezy', { company }) : null;
  if (!host) throw new IngestError('This source has no Breezy company name ({company}.breezy.hr). Edit the source and add it.');
  return { company, host, url: `https://${host}/json` };
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
      return ['/json', '/p/'];
    } catch {
      return [];
    }
  },
  async fetch(source, ctx) {
    assertNewReadAllowed(ctx.deps, NEW_READ);
    const feed = breezyFeedOf(source.config);
    let validators: ListingValidators | null = null;
    const answer = await ctx.http.getJson(feed.url, {
      signal: ctx.signal,
      allow: [404],
      allowRedirectHost: (host) => host === feed.host,
      ...conditionalOf(ctx),
      meta: (meta) => (validators = { etag: meta.etag, lastModified: meta.lastModified }),
    });
    if (answer.status === 304) return notModifiedResult();
    if (answer.status === 404) throw new SourceNotFoundError(`Breezy has no company "${feed.company}" (${feed.host}). Check the company name.`);
    if (!Array.isArray(answer.data)) throw new IngestError(`Breezy answered without the positions of "${feed.company}".`);
    const named = str(source.config.companyName);
    const postings: RawPosting[] = [];
    const failures: FetchFailure[] = [];
    for (const position of records(answer.data)) {
      const listedCompany = isRecord(position.company) ? str(position.company.name) : null;
      const posting = breezyPosting(position, feed.host, named ?? listedCompany ?? nameFromSlug(feed.company));
      if (posting) postings.push(posting);
      else failures.push({ sourceJobId: str(position.id) ?? undefined, message: 'A position has no id or name.' });
    }
    ctx.log(`Breezy ${feed.company}: ${postings.length} positions.`);
    return { postings, complete: true, failures, validators };
  },
});
