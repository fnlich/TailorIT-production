import { GREENHOUSE_BOARD, greenhouseToken } from '@tailorit/shared/sourcing';
import { GREENHOUSE_API, greenhouseAdapter, greenhousePosting, payRangeOf } from '../adapters/greenhouse';
import { configString, readPostingJson } from './read-json';
import type { ApiBoardDescriptor, PostingRef } from './types';

// v38 FRAME: Greenhouse's API part (its shared part: @tailorit/shared/sourcing GREENHOUSE_BOARD). One posting:
// /v1/boards/{token}/jobs/{id}?pay_transparency=true, the endpoint a run asks for pay ranges (its pay range rides along,
// so it counts as checked). A link is read through the autofill contract's addable posting (autofill/jobs.ts).

const apiUrl = (ref: PostingRef) =>
  `${GREENHOUSE_API}/${encodeURIComponent(ref.board)}/jobs/${encodeURIComponent(ref.externalId)}?pay_transparency=true`;

export const GREENHOUSE: ApiBoardDescriptor<'greenhouse'> = {
  board: GREENHOUSE_BOARD,
  adapter: greenhouseAdapter,
  // 12 §3.1 (read 2026-11-14: "use"): the documented Job Board API.
  terms: { status: 'allowed', url: 'https://developers.greenhouse.io/job-board.html' },
  transferKeys: ['token'],
  importable: true,
  posting: {
    refOf: ({ source, sourceJobId }) => {
      const board = greenhouseToken(configString(source.config, 'token'));
      return board ? { kind: 'greenhouse', board, externalId: sourceJobId, region: 'global' } : null;
    },
    apiUrl,
    read: (http, ref, options) =>
      readPostingJson(http, apiUrl(ref), GREENHOUSE_BOARD.label, ref, options, greenhousePosting, (raw, data) => {
        raw.supplement = { salary: payRangeOf(data) };
      }),
  },
};
