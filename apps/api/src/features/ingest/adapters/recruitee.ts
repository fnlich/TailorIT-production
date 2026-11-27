import type { EmploymentType, WorkArrangement } from '@tailorit/shared';
import { assertNewReadAllowed, type NewReadKind } from '../../../core/http/identity';
import { RECRUITEE_BOARD, recruiteeCompany } from '@tailorit/shared/sourcing'; // v38 FRAME: the board registry's rules
import type { IngestHttp } from '../http'; // v38 ATS-A
import { IngestError, SourceNotFoundError, type FetchFailure, type ListingValidators, type RawPosting, type RawSalary } from '../types';
import { isRecord, nameFromSlug, num, periodOf, records, str, type Json } from './common';
import { conditionalOf, defineAdapter, notModifiedResult } from './define';

// v30 S3: Recruitee (docs/design/part2/12-job-sourcing.md §3.3). The design chose Recruitee's XML offer feed; Recruitee's
// documentation (read 2026-11-16, SP\p2\build\S3.md) shows that feed is generated per job board for Recruitee's
// job-board partners, with no address of a company's own. So this reads the documented Careers Site API instead,
// GET https://{company}.recruitee.com/api/offers/ (docs.recruitee.com/reference/offers: the company's published offers,
// no credentials today): { offers: [{ id, slug, title, careers_url, locations[], remote, hybrid, on_site, description,
// requirements, employment_type_code, department, published_at, updated_at, company_name, salary }] }. Only published
// offers are listed, so the answer is the company's whole list: a complete listing (two misses close, 12 §8.2).
//
// From RECRUITEE_TOKEN_REQUIRED_FROM the API wants each employer's own token (X-Careers-Sites-Token; 401 without it).
// TailorIT has none, so from that day the adapter sends nothing and the run fails with that reason (a 401 would hold the
// host as a refusal). The owner decides what follows (a partner feed, or the employers' tokens): handoff open item.
//
// A source: config `{ company, companyName? }`. A new kind of read: the identity guard first ('feed_read').
//
// v38 ATS-A (SP v38 PLAN "Final coverage" row 9; REQUEST.md 9; EVIDENCE.md 9, read 2026-11-25): the list runs to about
// 5 MB on a large company (5,135,145 bytes), so it is read at most RECRUITEE_LIST_MAX_BYTES; one offer is read on its own
// (GET /api/offers/{slug}: { offer: {...} }, the list's fields; 404 for an unknown slug; status "published" while it is
// live): an offer's link, Add job, imports and the re-checks (readRecruiteeOffer). The apply form's questions
// (open_questions) and the company's mailbox (mailbox_email) are never read or kept.

const NEW_READ: NewReadKind = 'feed_read';

/** The day Recruitee's careers API starts to need each employer's token (docs.recruitee.com, authentication). */
export const RECRUITEE_TOKEN_REQUIRED_FROM = '2027-02-10T00:00:00.000Z';
/** v38 ATS-A: the most of a company's list read (about 5 MB on a large one, with every offer's text): 24 MB. */
export const RECRUITEE_LIST_MAX_BYTES = 24 * 1024 * 1024;
/** v38 ATS-A: the most of one offer's answer read: 2 MB. */
export const RECRUITEE_OFFER_MAX_BYTES = 2 * 1024 * 1024;

/** v38 ATS-A: whether Recruitee's careers API wants each employer's token by `now` (TailorIT has none). */
export const recruiteeNeedsToken = (now: Date) => now.getTime() >= Date.parse(RECRUITEE_TOKEN_REQUIRED_FROM);

/** The company's name on Recruitee as typed: a name or an address on recruitee.com (v38 FRAME: the registry's). */
export { recruiteeCompany };

/** A Recruitee source's listing: its host and address. */
export function recruiteeFeedOf(config: Record<string, unknown>): { company: string; host: string; url: string } {
  const company = recruiteeCompany(str(config.company) ?? '');
  const host = company ? RECRUITEE_BOARD.hostOf({ company }) : null;
  if (!host) throw new IngestError('This source has no Recruitee company name ({company}.recruitee.com). Edit the source and add it.');
  return { company, host, url: `https://${host}/api/offers/` };
}

/** "2026-11-02 10:00:00 UTC" (Recruitee's way) or ISO as an ISO time; null for anything else. */
function timeOf(value: unknown): string | null {
  const text = str(value);
  if (!text) return null;
  const iso = text.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/, '$1T$2Z');
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

/** employment_type_code ("fulltime", "fulltime_permanent", "parttime", "internship", "freelance", ...). */
function employmentOf(value: unknown): EmploymentType | null {
  const code = str(value)?.toLowerCase().replace(/[^a-z]/g, '') ?? '';
  if (code.startsWith('intern') || code.startsWith('trainee') || code.startsWith('apprentice')) return 'internship';
  if (code.startsWith('parttime')) return 'part_time';
  if (code.startsWith('fulltime')) return 'full_time';
  if (code.startsWith('freelance') || code.startsWith('contract') || code.startsWith('temporary')) return 'contract';
  return null;
}

function arrangementOf(offer: Json): WorkArrangement | null {
  if (offer.remote === true) return 'remote';
  if (offer.hybrid === true) return 'hybrid';
  if (offer.on_site === true) return 'onsite';
  return null;
}

function salaryOf(value: unknown): RawSalary | null {
  if (!isRecord(value)) return null;
  const min = num(value.min);
  const max = num(value.max);
  if ((min === null || min <= 0) && (max === null || max <= 0)) return null;
  return { min: min && min > 0 ? min : null, max: max && max > 0 ? max : null, currency: str(value.currency), period: periodOf(value.period) };
}

/** An offer's places, as the places reader reads them ("Berlin, BE, Germany"). */
function placesOf(offer: Json): string[] {
  const places = records(offer.locations).map((place) =>
    [str(place.city), str(place.state), str(place.country)].filter(Boolean).join(', '),
  );
  const listed = places.filter(Boolean);
  if (listed.length === 0 && str(offer.location)) listed.push(str(offer.location)!);
  return [...new Set(listed)];
}

/** The offer's page: its careers_url on the company's Recruitee host, else /o/{slug}; null without either. */
function pageOf(offer: Json, host: string): string | null {
  const given = str(offer.careers_url);
  try {
    const url = given ? new URL(given) : null;
    if (url && url.protocol === 'https:' && (url.hostname === host || url.hostname.endsWith('.recruitee.com'))) return url.href;
  } catch {
    /* not an address: built below */
  }
  const slug = str(offer.slug);
  return slug && /^[A-Za-z0-9_-]{1,200}$/.test(slug) ? `https://${host}/o/${slug}` : null;
}

/** One offer as a RawPosting; null when it lacks an id, a title or a page. */
export function recruiteePosting(offer: Json, host: string, companyName: string): RawPosting | null {
  const id = str(offer.id);
  const title = str(offer.title);
  const url = pageOf(offer, host);
  if (!id || !title || !url) return null;
  const description = str(offer.description);
  const requirements = str(offer.requirements);
  const salary = salaryOf(offer.salary);
  const country = records(offer.locations).map((place) => str(place.country_code)).find(Boolean) ?? null;
  return {
    sourceJobId: id,
    title,
    company: { name: companyName },
    descriptionHtml: [description, requirements].filter(Boolean).join('\n') || null,
    url,
    locations: placesOf(offer),
    countryHint: country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : null,
    workArrangement: arrangementOf(offer),
    employmentType: employmentOf(offer.employment_type_code),
    employmentText: str(offer.employment_type_code),
    department: str(offer.department),
    salary,
    postedAt: timeOf(offer.published_at) ?? timeOf(offer.created_at),
    updatedAt: timeOf(offer.updated_at),
  };
}

/**
 * v38 ATS-A: one offer read on its own (at most RECRUITEE_OFFER_MAX_BYTES, on the company's host only): the offer as a
 * RawPosting and its company's name on Recruitee, or null when it is gone (404, or a status other than published).
 * Named by `named`, else the offer's company_name, else the company's name in its address made readable. Throws
 * IngestHttpError when Recruitee fails, IngestError for an answer that is no offer. v38 FIX-A (SP v38 FIXES-38 item 12,
 * REVIEW38-beh L9): with `expectedId` (a stored offer's id), an offer of another id at that slug (the slug reused) is
 * IngestError: can't read, never the stored offer still live.
 */
export async function readRecruiteeOffer(
  http: IngestHttp,
  company: string,
  slug: string,
  named: string | null,
  signal?: AbortSignal,
  expectedId: string | null = null,
): Promise<{ raw: RawPosting; companyName: string | null } | null> {
  const feed = recruiteeFeedOf({ company });
  const answer = await http.getJson(`https://${feed.host}/api/offers/${encodeURIComponent(slug)}`, {
    signal,
    allow: [404],
    maxBytes: RECRUITEE_OFFER_MAX_BYTES,
    allowRedirectHost: (host) => host === feed.host,
  });
  if (answer.status === 404) return null;
  const offer = isRecord(answer.data) && isRecord(answer.data.offer) ? answer.data.offer : null;
  if (!offer) throw new IngestError('Recruitee answered without an offer.');
  if (expectedId !== null && str(offer.id) !== expectedId) throw new IngestError("Recruitee's link now names another offer.");
  const status = str(offer.status);
  if (status && status !== 'published') return null;
  const listedName = str(offer.company_name);
  const raw = recruiteePosting(offer, feed.host, named ?? listedName ?? nameFromSlug(feed.company));
  if (!raw) throw new IngestError("Recruitee's offer has no id, title or page.");
  return { raw, companyName: listedName };
}

export const recruiteeAdapter = defineAdapter({
  kind: 'recruitee',
  label: 'Recruitee careers site',
  access: 'api',
  hosts: ['*.recruitee.com'],
  robotsPaths(source) {
    try {
      recruiteeFeedOf(source.config);
      return ['/api/offers/', '/o/'];
    } catch {
      return [];
    }
  },
  async fetch(source, ctx) {
    assertNewReadAllowed(ctx.deps, NEW_READ);
    const feed = recruiteeFeedOf(source.config);
    if (recruiteeNeedsToken(ctx.deps.now())) {
      throw new IngestError(
        "From 10 February 2027 Recruitee's careers API needs each employer's own token, and TailorIT has none: nothing was read.",
      );
    }
    let validators: ListingValidators | null = null;
    const answer = await ctx.http.getJson(feed.url, {
      signal: ctx.signal,
      allow: [404],
      maxBytes: RECRUITEE_LIST_MAX_BYTES, // v38 ATS-A: a safe cap over the 5 MB seen
      allowRedirectHost: (host) => host === feed.host,
      ...conditionalOf(ctx),
      meta: (meta) => (validators = { etag: meta.etag, lastModified: meta.lastModified }),
    });
    if (answer.status === 304) return notModifiedResult();
    if (answer.status === 404) throw new SourceNotFoundError(`Recruitee has no careers site "${feed.company}" (${feed.host}). Check the company name.`);
    if (!isRecord(answer.data) || !Array.isArray(answer.data.offers)) {
      throw new IngestError(`Recruitee answered without the offers of "${feed.company}".`);
    }
    const named = str(source.config.companyName);
    const postings: RawPosting[] = [];
    const failures: FetchFailure[] = [];
    let unpublished = 0;
    for (const offer of records(answer.data.offers)) {
      // Only published offers are listed; one the answer marks otherwise is not open (not stored, not seen).
      const status = str(offer.status);
      if (status && status !== 'published') {
        unpublished += 1;
        continue;
      }
      const posting = recruiteePosting(offer, feed.host, named ?? str(offer.company_name) ?? nameFromSlug(feed.company));
      if (posting) postings.push(posting);
      else failures.push({ sourceJobId: str(offer.id) ?? undefined, message: 'An offer has no id, title or page.' });
    }
    ctx.log(`Recruitee ${feed.company}: ${postings.length} published offers${unpublished ? ` (${unpublished} not published skipped)` : ''}.`);
    return { postings, complete: true, failures, validators };
  },
});
