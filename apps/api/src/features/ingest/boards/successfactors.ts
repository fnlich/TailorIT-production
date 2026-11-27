import { SUCCESSFACTORS_BOARD } from '@tailorit/shared/sourcing';
import { successFactorsAdapter } from '../adapters/not-read';
import { NEVER_READ_BOARD_KINDS } from '../career/platforms'; // v38 FIX-C
import { notReadPostings } from './not-read';
import type { ApiBoardDescriptor } from './types';

// v38 ATS-D: SAP SuccessFactors' API part (its shared part: @tailorit/shared/sourcing SUCCESSFACTORS_BOARD). Never read:
// its classic career sites' robots.txt disallows every path for every robot (SP v38 EVIDENCE.md §18). A link's verdict is
// can't read (`robots`: "This site doesn't allow automated reading…"), with no request; the adder keeps the job as their own.

/** v38 ATS-D (SP v38 PLAN A5): the dated note a SuccessFactors source records (none is made: it is never read). */
export const SUCCESSFACTORS_TERMS_NOTE =
  '2026-11-25: the owner asked TailorIT to verify SAP SuccessFactors job links (the request of 2026-11-25). Checked that ' +
  'day: robots.txt on career<n>.successfactors.com disallows every path for every robot (User-agent: *, Disallow: /), ' +
  "the job pages and the XML job list alike. Conditions: TailorIT sends these sites no request; a link is recognised and " +
  "cleaned, and its job stays its adder's own (can't read).";

export const SUCCESSFACTORS: ApiBoardDescriptor<'successfactors'> = {
  board: SUCCESSFACTORS_BOARD,
  adapter: successFactorsAdapter,
  terms: { status: 'allowed_with_conditions', url: null, note: SUCCESSFACTORS_TERMS_NOTE },
  posting: notReadPostings('successfactors', NEVER_READ_BOARD_KINDS.successfactors), // v38 FIX-C (D3): the one never-read rule
};
