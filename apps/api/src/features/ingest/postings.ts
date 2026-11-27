import { apiBoardOf } from './boards/index';
import { withCompanyFacts } from './boards/company';
import type { IngestHttp } from './http';
import { IngestError, PostingUnreadableError } from './types';
import type { PostingAnswer, PostingReadOptions, PostingRef } from './boards/types';

// One posting by its board and id: Greenhouse (/v1/boards/{token}/jobs/{id}?pay_transparency=true, the endpoint a run
// asks for pay ranges), Lever (/v0/postings/{site}/{id}?mode=json, on its EU host for an EU site) and Workable
// (/api/v2/accounts/{account}/jobs/{shortcode}, the request a run makes for each posting, at most
// WORKABLE_ANSWER_MAX_BYTES; and the account's list once for its name when the source names no company) answer a
// single posting; Ashby has no such endpoint, so its board's listing
// (/posting-api/job-board/{board}?includeCompensation=true, the run's own request) is read once and the posting picked
// from it by its id. Workday (autofill API version 5): /wday/cxs/<tenant>/<site>/job/<location>/<slug>_<reqId> on the
// posting's own host, the read its page makes, once the host's robots.txt allows it (adapters/workday.ts). Read with
// the adapters' own readers, so a posting read here is stored exactly as a run stores it.
// For the extension's Add job (features/autofill/jobs.ts) and the daily check of jobs that no enabled source lists
// (liveness.ts). Through the shared HTTP client: one request a second per host, taking turns with the runs.
//
// v38 FRAME (SP v38 PLAN A3): each board kind's read of one posting is its board descriptor's (ingest/boards/<kind>.ts
// `posting.read`, readPosting): fetchPosting picks it by the ref's kind. A descriptor answers the posting, gone (closed),
// or the platform's own word that it can't be read now or at all, which fetchPosting throws as a PostingUnreadableError
// (every link read's verdict reads it: jobs/add/verdict.ts, jobs/add/board-link.ts). What the platform says about the
// posting's company (A6, `company`) is applied to the posting here (boards/company.ts).

export type { AshbyBoardReads, PostingAnswer, PostingRef, WorkableNames } from './boards/types';
export { ASHBY_BOARD_MAX_BYTES } from './boards/ashby';

/** The board kind's reads of one posting, or an IngestError for a kind that has none. */
function readsOf(ref: PostingRef) {
  const reads = apiBoardOf(ref.kind)?.posting;
  if (!reads?.read) throw new IngestError(`TailorIT does not read ${ref.kind} postings one at a time.`);
  return reads;
}

/** The posting's API address (an Ashby board's listing, for an Ashby posting). */
export function postingApiUrl(ref: PostingRef): string {
  const reads = readsOf(ref);
  if (!reads.apiUrl) throw new IngestError(`TailorIT does not know a ${ref.kind} posting's address.`);
  return reads.apiUrl(ref);
}

/**
 * Reads one posting: found, or gone (404: the board no longer has it). A Greenhouse posting carries its pay range as
 * a run's pay check does, so it counts as checked. Throws IngestHttpError when the board fails (the client's retries
 * spent) and IngestError when the answer is not that posting (no id, title or link, or another id). `config` is the
 * config of the source it is stored under: its companyName names the company, as the adapters name it; without one,
 * the posting's own company name does (Greenhouse, Lever), else the board's slug ("acme-robotics" reads "Acme
 * Robotics"). An Ashby posting is picked from its board's listing (`boards` shares one read of a board between calls).
 * A Workable posting names no company: without a companyName the account's list names it (one more read, best effort,
 * `names` sharing it), else its slug; one no longer published is gone, as a 404 is, and an answer over
 * WORKABLE_ANSWER_MAX_BYTES fails (IngestHttpError 413). A Workday posting is read once its host's robots.txt allows
 * it (RobotsRefusal otherwise); without a companyName the hiring organisation Workday names is the company. v37 BOARDS:
 * a BambooHR opening's detail; an iCIMS posting's content page (gone: 404, 410, or a past validThrough). v38 FRAME:
 * every board kind's readPosting; PostingUnreadableError for the platform's own "can't read" or "try later".
 */
export async function fetchPosting(http: IngestHttp, ref: PostingRef, options: PostingReadOptions = {}): Promise<PostingAnswer> {
  const answer = await readsOf(ref).read!(http, ref, options);
  if ('unreadable' in answer) throw new PostingUnreadableError(answer.unreadable);
  if (answer.found && answer.company) return { ...answer, raw: withCompanyFacts(answer.raw, answer.company, options.config) };
  return answer;
}
