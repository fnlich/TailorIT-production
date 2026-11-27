import type { BoardSourceKind } from '@tailorit/shared/sourcing';
import type { BoardLinkRead, BoardPostingReads, PostingRef } from './types';

// v38 ATS-D (SP v38 PLAN "Final coverage"): the posting reads of a platform TailorIT recognises but never reads (SAP
// SuccessFactors, Phenom, JobDiva): every link names its posting (so it is never read as a page, which would reach the
// disallowed or bot-checked host), and its verdict is can't read with the platform's reason, with no request.

/** The reads of a platform never read: its links' postings, and the one answer `why` (see BoardPostingReads.unreadable). */
export function notReadPostings(kind: BoardSourceKind, why: NonNullable<BoardPostingReads['unreadable']>): BoardPostingReads {
  return {
    unreadable: why,
    refOfLink: (read: BoardLinkRead): PostingRef | null =>
      read.board ? { kind, board: read.board, externalId: read.externalId, region: 'global', page: read.canonical[0] ?? read.url } : null,
    read: async () => ({ found: false, unreadable: why }),
  };
}
