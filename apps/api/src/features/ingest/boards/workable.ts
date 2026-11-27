import { WORKABLE_BOARD, workableAccount } from '@tailorit/shared/sourcing';
import { nameFromSlug, str } from '../adapters/common';
import { readWorkableAccountName, readWorkablePosting, workableAdapter, workablePostingUrl } from '../adapters/workable';
import type { IngestHttp } from '../http';
import { configString } from './read-json';
import type { ApiBoardDescriptor, PostingAnswer, PostingReadOptions, PostingRef } from './types';

// v38 FRAME: Workable's API part (its shared part: @tailorit/shared/sourcing WORKABLE_BOARD). One posting:
// /api/v2/accounts/{account}/jobs/{shortcode}, the request a run makes for each posting, at most
// WORKABLE_ANSWER_MAX_BYTES (one no longer published is gone, as a 404 is); and the account's list once for its name when
// the source names no company (v37's postings.ts read, moved here unchanged). A link is read through the autofill
// contract's addable posting (autofill/jobs.ts).

/**
 * A Workable posting, named by the source's companyName, else by the account's list (read once, shared through
 * `names`), else by the account's slug.
 */
async function workablePostingOf(http: IngestHttp, ref: PostingRef, options: PostingReadOptions): Promise<PostingAnswer> {
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

export const WORKABLE: ApiBoardDescriptor<'workable'> = {
  board: WORKABLE_BOARD,
  adapter: workableAdapter,
  terms: { status: 'allowed', url: 'https://workable.readme.io/reference/jobs' },
  transferKeys: ['account'],
  importable: true,
  posting: {
    refOf: ({ source, sourceJobId }) => {
      const account = workableAccount(configString(source.config, 'account'));
      return account ? { kind: 'workable', board: account, externalId: sourceJobId, region: 'global' } : null;
    },
    apiUrl: (ref) => workablePostingUrl(ref.board, ref.externalId),
    read: workablePostingOf,
  },
};
