import type { WorkArrangement } from '@tailorit/shared';
import { assertNewReadAllowed, type NewReadKind } from '../../../core/http/identity';
import { feedHostOf } from '../sources';
import { tenantOf } from '../sitemap';
import { IngestError, SourceNotFoundError, type FetchFailure, type ListingValidators, type RawPosting } from '../types';
import { isRecord, nameFromSlug, num, records, str, type Json } from './common';
import { conditionalOf, defineAdapter, notModifiedResult } from './define';

// v30 S3: BambooHR's careers list (docs/design/part2/12-job-sourcing.md §3.3): GET
// https://{company}.bamboohr.com/careers/list, `{ meta: { totalCount }, result: [{ id, jobOpeningName, departmentLabel,
// employmentStatusLabel, location { city, state }, atsLocation { city, state, province, country }, isRemote,
// locationType }] }`, the list the company's careers page reads; each opening's page is /careers/{id}. BambooHR
// documents no such endpoint, so its terms are NOT recorded: a BambooHR source starts `unchecked` (sources.ts
// KIND_TERMS has no entry) and is never run until an admin records them after a dated check (PLAN §10, S3). The list
// has no posting text; reading each opening's detail is left for that day (handoff open item). Its tests use answers
// written by hand.
//
// A source: config `{ company, companyName? }`. A new kind of read: the identity guard first ('feed_read').

const NEW_READ: NewReadKind = 'feed_read';

/** The company's name on BambooHR as typed: a name or an address on bamboohr.com. */
export const bamboohrCompany = (input: string) => tenantOf(input, ['bamboohr.com']);

/** A BambooHR source's listing: its host and address. */
export function bamboohrFeedOf(config: Record<string, unknown>): { company: string; host: string; url: string } {
  const company = bamboohrCompany(str(config.company) ?? '');
  const host = company ? feedHostOf('bamboohr', { company }) : null;
  if (!host) throw new IngestError('This source has no BambooHR company name ({company}.bamboohr.com). Edit the source and add it.');
  return { company, host, url: `https://${host}/careers/list` };
}

/** locationType ("0" on site, "1" remote, "2" hybrid) or isRemote. */
function arrangementOf(opening: Json): WorkArrangement | null {
  const type = str(opening.locationType);
  if (type === '1' || opening.isRemote === true) return 'remote';
  if (type === '2') return 'hybrid';
  if (type === '0') return 'onsite';
  return null;
}

/** An opening's place as the places reader reads it. */
function placeOf(opening: Json): string | null {
  const ats = isRecord(opening.atsLocation) ? opening.atsLocation : null;
  const plain = isRecord(opening.location) ? opening.location : null;
  const parts = ats
    ? [str(ats.city), str(ats.state) ?? str(ats.province), str(ats.country)]
    : [str(plain?.city), str(plain?.state)];
  return parts.filter(Boolean).join(', ') || null;
}

/** One opening as a RawPosting; null when it lacks an id or a name. */
export function bamboohrPosting(opening: Json, host: string, companyName: string): RawPosting | null {
  const id = str(opening.id);
  const title = str(opening.jobOpeningName);
  if (!id || !/^[0-9]{1,20}$/.test(id) || !title) return null;
  const place = placeOf(opening);
  const arrangement = arrangementOf(opening);
  return {
    sourceJobId: id,
    title,
    company: { name: companyName },
    url: `https://${host}/careers/${id}`,
    locations: place ? [place] : arrangement === 'remote' ? ['Remote'] : [],
    workArrangement: arrangement,
    employmentText: str(opening.employmentStatusLabel),
    department: str(opening.departmentLabel),
  };
}

export const bamboohrAdapter = defineAdapter({
  kind: 'bamboohr',
  label: 'BambooHR careers list',
  access: 'api',
  hosts: ['*.bamboohr.com'],
  robotsPaths(source) {
    try {
      bamboohrFeedOf(source.config);
      return ['/careers/list', '/careers/'];
    } catch {
      return [];
    }
  },
  async fetch(source, ctx) {
    assertNewReadAllowed(ctx.deps, NEW_READ);
    const feed = bamboohrFeedOf(source.config);
    let validators: ListingValidators | null = null;
    const answer = await ctx.http.getJson(feed.url, {
      signal: ctx.signal,
      allow: [404],
      allowRedirectHost: (host) => host === feed.host,
      ...conditionalOf(ctx),
      meta: (meta) => (validators = { etag: meta.etag, lastModified: meta.lastModified }),
    });
    if (answer.status === 304) return notModifiedResult();
    if (answer.status === 404) throw new SourceNotFoundError(`BambooHR has no company "${feed.company}" (${feed.host}). Check the company name.`);
    if (!isRecord(answer.data) || !Array.isArray(answer.data.result)) {
      throw new IngestError(`BambooHR answered without the openings of "${feed.company}".`);
    }
    const companyName = str(source.config.companyName) ?? nameFromSlug(feed.company);
    const postings: RawPosting[] = [];
    const failures: FetchFailure[] = [];
    const openings = records(answer.data.result);
    for (const opening of openings) {
      const posting = bamboohrPosting(opening, feed.host, companyName);
      if (posting) postings.push(posting);
      else failures.push({ sourceJobId: str(opening.id) ?? undefined, message: 'An opening has no id or name.' });
    }
    // The list says how many openings there are: a shorter list is not the whole one (nothing closes by its absence).
    const total = isRecord(answer.data.meta) ? num(answer.data.meta.totalCount) : null;
    const complete = total === null || total <= openings.length;
    ctx.log(`BambooHR ${feed.company}: ${postings.length} openings${complete ? '' : ` of ${total} (the list is incomplete)`}.`);
    return { postings, complete, failures, validators: complete ? validators : null };
  },
});
