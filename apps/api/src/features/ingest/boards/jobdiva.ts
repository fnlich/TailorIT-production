import { JOBDIVA_BOARD } from '@tailorit/shared/sourcing';
import { jobDivaAdapter } from '../adapters/not-read';
import { NEVER_READ_BOARD_KINDS } from '../career/platforms'; // v38 FIX-C
import { notReadPostings } from './not-read';
import type { ApiBoardDescriptor } from './types';

// v38 ATS-D: JobDiva's API part (its shared part: @tailorit/shared/sourcing JOBDIVA_BOARD). Never read: an agency's
// portal is a script-drawn page that gates itself with Cloudflare Turnstile and reCAPTCHA, and its jobs' data needs the
// agency's own API user (SP v38 EVIDENCE.md §25). A link's verdict is can't read (`bot_check`: "This site checks for
// robots…"), with no request; the adder keeps the job as their own.

/** v38 ATS-D (SP v38 PLAN A5): the dated note a JobDiva source records (none is made: it is never read). */
export const JOBDIVA_TERMS_NOTE =
  '2026-11-25: the owner asked TailorIT to verify JobDiva job links (the request of 2026-11-25). Checked that day: an ' +
  "agency's candidate portal (/portal/?a=<key>) is a script-drawn page that loads Cloudflare Turnstile and Google " +
  "reCAPTCHA, its job sits in the address's fragment, and JobDiva's job API needs the agency's own API user. Conditions: " +
  "TailorIT sends these portals no request and never tries to pass a check; a link is recognised and cleaned (its key " +
  "and fragment kept), and its job stays its adder's own (can't read).";

export const JOBDIVA: ApiBoardDescriptor<'jobdiva'> = {
  board: JOBDIVA_BOARD,
  adapter: jobDivaAdapter,
  terms: { status: 'allowed_with_conditions', url: null, note: JOBDIVA_TERMS_NOTE },
  posting: notReadPostings('jobdiva', NEVER_READ_BOARD_KINDS.jobdiva), // v38 FIX-C (D3): the one never-read rule
};
