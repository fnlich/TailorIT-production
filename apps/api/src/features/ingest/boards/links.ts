import { parseAtsUrl } from '@tailorit/shared/autofill';
import { BOARD_DESCRIPTORS, boardDescriptorOfHost, boardHostOf, boardUrlOf, type BoardDescriptor, type BoardSourceKind } from '@tailorit/shared/sourcing';
import type { BoardLinkRead } from './types';

// v38 FRAME (SP v38 PLAN A2): the API's link reader. A link names a posting of a board kind when
//   parseAtsUrl(url) (the extension's contract, hash-pinned: its board and posting id are the extension's, one identity)
//   reads it as a platform a board descriptor names as its `atsKind`, or else
//   the descriptor of the link's host reads it with its own `parseLink` (a platform parseAtsUrl does not know, or a link
//   form it does not read: Paylocity's /Details/<id>).
// parseAtsUrl stays as it is; a platform it reads that no board kind names yet (Taleo before v3.8's) reads as no board's.

/** The board kind that reads parseAtsUrl's kind as its own (the first in the registry's order: Workday's one-posting kind). */
function boardOfAtsKind(atsKind: string): BoardDescriptor | null {
  return (BOARD_DESCRIPTORS as readonly BoardDescriptor[]).find((board) => board.atsKind === atsKind) ?? null;
}

/** The posting a link names on a board kind's platform (see the top), or null. */
export function readBoardLink(address: string): BoardLinkRead | null {
  const ats = parseAtsUrl(address);
  if (ats) {
    const board = boardOfAtsKind(ats.kind);
    return board
      ? { kind: board.kind as BoardSourceKind, board: ats.board, externalId: ats.externalId, canonical: ats.canonical, url: address, ats }
      : null;
  }
  const url = boardUrlOf(address);
  if (!url) return null;
  const board = boardDescriptorOfHost(boardHostOf(url));
  const own = board?.parseLink?.(url);
  return board && own ? { kind: board.kind as BoardSourceKind, ...own, url: address, ats: null } : null;
}
