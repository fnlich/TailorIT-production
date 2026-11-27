import { PHENOM_BOARD } from '@tailorit/shared/sourcing';
import { phenomAdapter } from '../adapters/not-read';
import { NEVER_READ_BOARD_KINDS } from '../career/platforms'; // v38 FIX-C
import { notReadPostings } from './not-read';
import type { ApiBoardDescriptor } from './types';

// v38 ATS-D: Phenom's API part (its shared part: @tailorit/shared/sourcing PHENOM_BOARD). Never read: every request to a
// <company>.phenompro.com site, its robots.txt included, meets an AWS WAF bot challenge (SP v38 EVIDENCE.md §23). A link's
// verdict is can't read (`bot_check`: "This site checks for robots…"), with no request; the adder keeps the job as their own.

/** v38 ATS-D (SP v38 PLAN A5): the dated note a Phenom source records (none is made: it is never read). */
export const PHENOM_TERMS_NOTE =
  '2026-11-25: the owner asked TailorIT to verify Phenom job links (the request of 2026-11-25). Checked that day: every ' +
  'request to a <company>.phenompro.com site, robots.txt included, met an AWS WAF bot challenge (202, x-amzn-waf-action: ' +
  "challenge); Phenom's own job API needs a token Phenom issues. Conditions: TailorIT sends these sites no request and " +
  "never tries to pass a check; a link is recognised and cleaned, and its job stays its adder's own (can't read).";

export const PHENOM: ApiBoardDescriptor<'phenom'> = {
  board: PHENOM_BOARD,
  adapter: phenomAdapter,
  terms: { status: 'allowed_with_conditions', url: null, note: PHENOM_TERMS_NOTE },
  posting: notReadPostings('phenom', NEVER_READ_BOARD_KINDS.phenom), // v38 FIX-C (D3): the one never-read rule
};
