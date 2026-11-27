import { ASHBY_BOARD, ashbyBoard } from '@tailorit/shared/sourcing';
import { ASHBY_API, ashbyAdapter, ashbyPosting } from '../adapters/ashby';
import { isRecord, nameFromSlug, records, str } from '../adapters/common';
import type { HttpAnswer, IngestHttp } from '../http'; // v381 INT-2: HttpAnswer
import { IngestError } from '../types';
import { configString } from './read-json';
import type { ApiBoardDescriptor, PostingAnswer, PostingReadOptions, PostingRef } from './types';

// v38 FRAME: Ashby's API part (its shared part: @tailorit/shared/sourcing ASHBY_BOARD). Ashby has no one-posting
// endpoint, so its board's listing (/posting-api/job-board/{board}?includeCompensation=true, the run's own request) is
// read once and the posting picked from it by its id (v37's postings.ts read, moved here unchanged). A link is read
// through the autofill contract's addable posting (autofill/jobs.ts).

/** The most of an Ashby board's listing read (its every posting, with descriptions and pay): 25 MB. */
export const ASHBY_BOARD_MAX_BYTES = 25 * 1024 * 1024;

const apiUrl = (ref: PostingRef) => `${ASHBY_API}/${encodeURIComponent(ref.board)}?includeCompensation=true`;

/**
 * v381 INT-2: a board's whole listing for a link's read through the process's feed cache (autofill/jobs.ts ashbyListOf,
 * jobs/add/embedded-board.ts primeAshbyList, both keyed `ashby:<board>`), sent with no caller's signal (v38 FIX-A). An
 * answer that is neither a board nor Ashby's 404 fails the read (as ashbyFromBoard would fail it), so the cache never
 * keeps it for the next link.
 */
export async function ashbyBoardListing(http: IngestHttp, ref: PostingRef): Promise<HttpAnswer> {
  const answer = await http.getJson(apiUrl(ref), { allow: [404], maxBytes: ASHBY_BOARD_MAX_BYTES });
  if (answer.status !== 404 && !(isRecord(answer.data) && Array.isArray(answer.data.jobs))) throw new IngestError('Ashby answered without a job board.');
  return answer;
}

/**
 * An Ashby posting from its board's listing: gone when the board is (404) or no longer lists it (an unlisted posting
 * is skipped, as a run skips it). `options.boards` shares one read of a board between calls.
 */
async function ashbyFromBoard(http: IngestHttp, ref: PostingRef, options: PostingReadOptions): Promise<PostingAnswer> {
  const url = apiUrl(ref);
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

export const ASHBY: ApiBoardDescriptor<'ashby'> = {
  board: ASHBY_BOARD,
  adapter: ashbyAdapter,
  terms: { status: 'allowed', url: 'https://developers.ashbyhq.com/docs/public-job-posting-api' },
  transferKeys: ['board'],
  importable: true,
  posting: {
    refOf: ({ source, sourceJobId }) => {
      const board = ashbyBoard(configString(source.config, 'board'));
      return board ? { kind: 'ashby', board, externalId: sourceJobId, region: 'global' } : null;
    },
    apiUrl,
    read: ashbyFromBoard,
  },
};
