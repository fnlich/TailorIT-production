import type { WorkdayPostingRef } from '@tailorit/shared/autofill';
import { ASHBY_API, ashbyPosting } from './adapters/ashby';
import { isRecord, nameFromSlug, records, str } from './adapters/common';
import { GREENHOUSE_API, greenhousePosting, payRangeOf } from './adapters/greenhouse';
import { leverHost, leverPosting } from './adapters/lever';
import { readWorkableAccountName, readWorkablePosting, workablePostingUrl } from './adapters/workable';
import { readWorkdayPosting, workdayPostingUrl, workdayTenant, type WorkdayRef } from './adapters/workday';
import type { HttpAnswer, IngestHttp } from './http';
import { IngestError, type RawPosting } from './types';

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

/** A posting on a board TailorIT can ask about one posting at a time. */
export interface PostingRef {
  kind: 'greenhouse' | 'lever' | 'ashby' | 'workable' | 'workday';
  /**
   * The Greenhouse board token, the Lever site, the Ashby job board's name, the Workable account or the Workday tenant
   * (in lower case).
   */
  board: string;
  externalId: string;
  /**
   * Lever's EU sites live on their own host; TailorIT reads Greenhouse's global boards only; Ashby, Workable and Workday
   * have no regions.
   */
  region: 'global' | 'eu';
  /** A Workday posting's host, site, location and name (its read needs them; its board is the tenant). */
  workday?: WorkdayPostingRef;
}

/** A Workday posting's reference for its reader, or an IngestError when the ref lacks its address parts. */
function workdayRefOf(ref: PostingRef): WorkdayRef {
  const tenant = workdayTenant(ref.board);
  if (!ref.workday || !tenant) throw new IngestError("TailorIT does not know this Workday posting's address.");
  return { ...ref.workday, tenant, reqId: ref.externalId };
}

/**
 * A posting read: found, or not (`unlisted`: the board's listing names it but hides it from its public list, as an
 * Ashby posting reached by its own link can be; a run skips those). `listedCompany`: the company name the board's
 * own list gave, read because the source names none (Workable's account name): Add job keeps it on a source it makes.
 */
export type PostingAnswer =
  | { found: true; raw: RawPosting; listedCompany?: string }
  | { found: false; unlisted?: true };

/** The most of an Ashby board's listing read (its every posting, with descriptions and pay): 25 MB. */
export const ASHBY_BOARD_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Ashby boards' listings read, by board name in lower case, for callers that ask about several postings of one board:
 * the daily check keeps each for the whole check (each board read once); Add job shares a read while it is under way
 * (`shareWhileReading`), so two adds from one board at once read it once, and a later add reads it afresh.
 */
export type AshbyBoardReads = Map<string, Promise<HttpAnswer>>;

/** Workable accounts' names (readWorkableAccountName), by account, read once for every posting of a daily check. */
export type WorkableNames = Map<string, Promise<string | null>>;

/** The posting's API address (an Ashby board's listing, for an Ashby posting). */
export function postingApiUrl(ref: PostingRef): string {
  const board = encodeURIComponent(ref.board);
  const id = encodeURIComponent(ref.externalId);
  if (ref.kind === 'ashby') return `${ASHBY_API}/${board}?includeCompensation=true`;
  if (ref.kind === 'workable') return workablePostingUrl(ref.board, ref.externalId);
  if (ref.kind === 'workday') return workdayPostingUrl(workdayRefOf(ref));
  return ref.kind === 'greenhouse'
    ? `${GREENHOUSE_API}/${board}/jobs/${id}?pay_transparency=true`
    : `${leverHost(ref.region)}/v0/postings/${board}/${id}?mode=json`;
}

const LABELS: Record<PostingRef['kind'], string> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  workable: 'Workable',
  workday: 'Workday',
};

interface FetchOptions {
  /** The config of the source the posting is stored under (its companyName). */
  config?: Record<string, unknown>;
  signal?: AbortSignal;
  /** Ashby listings shared between calls (see AshbyBoardReads). */
  boards?: AshbyBoardReads;
  /** Share a listing only while it is being read (Add job), not for good (the daily check). */
  shareWhileReading?: boolean;
  /** Workable accounts' names shared between calls (the daily check: each account's list read once). */
  names?: WorkableNames;
}

/**
 * A Workable posting, named by the source's companyName, else by the account's list (read once, shared through
 * `names`), else by the account's slug.
 */
async function workablePostingOf(http: IngestHttp, ref: PostingRef, options: FetchOptions): Promise<PostingAnswer> {
  const named = str(options.config?.companyName);
  const companyName = named ?? nameFromSlug(ref.board);
  const raw = await readWorkablePosting(http, ref.board, ref.externalId, companyName, options.signal);
  if (!raw) return { found: false };
  if (named) return { found: true, raw };
  let reading = options.names?.get(ref.board);
  if (!reading) {
    reading = readWorkableAccountName(http, ref.board, options.signal);
    options.names?.set(ref.board, reading);
  }
  const listed = await reading;
  if (!listed) return { found: true, raw };
  raw.company.name = listed;
  return { found: true, raw, listedCompany: listed };
}

/**
 * An Ashby posting from its board's listing: gone when the board is (404) or no longer lists it (an unlisted posting
 * is skipped, as a run skips it).
 */
async function ashbyFromBoard(http: IngestHttp, ref: PostingRef, options: FetchOptions): Promise<PostingAnswer> {
  const url = postingApiUrl(ref);
  const key = ref.board.toLowerCase();
  const boards = options.boards;
  let reading = boards?.get(key);
  if (!reading) {
    reading = http.getJson(url, { signal: options.signal, allow: [404], maxBytes: ASHBY_BOARD_MAX_BYTES });
    if (boards) {
      boards.set(key, reading);
      if (options.shareWhileReading) {
        const read = reading;
        void read.finally(() => boards.get(key) === read && boards.delete(key)).catch(() => undefined);
      }
    }
  }
  const answer = await reading;
  if (answer.status === 404) return { found: false };
  if (!isRecord(answer.data) || !Array.isArray(answer.data.jobs)) throw new IngestError('Ashby answered without a job board.');
  const wanted = ref.externalId.toLowerCase();
  const job = records(answer.data.jobs).find((entry) => str(entry.id)?.toLowerCase() === wanted);
  if (!job) return { found: false };
  if (job.isListed === false) return { found: false, unlisted: true };
  const companyName = str(options.config?.companyName) ?? nameFromSlug(ref.board);
  const raw = ashbyPosting(job, companyName);
  if (!raw) throw new IngestError("Ashby's posting has no id, title or link.");
  return { found: true, raw };
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
 * it (RobotsRefusal otherwise); without a companyName the hiring organisation Workday names is the company.
 */
export async function fetchPosting(http: IngestHttp, ref: PostingRef, options: FetchOptions = {}): Promise<PostingAnswer> {
  if (ref.kind === 'ashby') return ashbyFromBoard(http, ref, options);
  if (ref.kind === 'workable') return workablePostingOf(http, ref, options);
  if (ref.kind === 'workday') {
    return readWorkdayPosting(http, workdayRefOf(ref), str(options.config?.companyName), options.signal);
  }
  const answer = await http.getJson(postingApiUrl(ref), { signal: options.signal, allow: [404] });
  if (answer.status === 404) return { found: false };
  const label = LABELS[ref.kind];
  if (!isRecord(answer.data)) throw new IngestError(`${label} answered without a posting.`);
  const named = str(options.config?.companyName);
  const companyName = named ?? nameFromSlug(ref.board);
  const raw =
    ref.kind === 'greenhouse' ? greenhousePosting(answer.data, companyName) : leverPosting(answer.data, companyName);
  if (!raw) throw new IngestError(`${label}'s posting has no id, title or link.`);
  if (raw.sourceJobId.toLowerCase() !== ref.externalId.toLowerCase()) {
    throw new IngestError(`${label} answered with another posting.`);
  }
  if (named) raw.company.name = named;
  if (ref.kind === 'greenhouse') raw.supplement = { salary: payRangeOf(answer.data) };
  return { found: true, raw };
}
