import { JOB_VERIFY_REASON_MESSAGE, type AddJobResult, type JobVerifyReason } from '@tailorit/shared';
import type { FanoutAddJobResult } from '@tailorit/shared/sharing';
import type { MessageRenderer } from '@/lib/messages';
import { FANOUT_COPY, namesList } from '../../sharing/fanout/copy'; // v34 FANWEB
import { refusalText } from '../../sharing/fanout/results';
import type { FanoutProfile, LabelOf } from '../../sharing/fanout/targets';
import type { PublicMessageKey } from '@/lib/constants';

// v31 JOBSWEB: what the Add job dialog says after TailorIT tried to read a link (docs/design/v3.1/21-jobs-from-links.md
// §3): the four states of POST /api/jobs/add, each with its next step. The server renders the state's words (an
// admin's change included) in `message`; the reason's words ("This site's robots.txt...") come from the constants.

/** The link field's words, kept beside the dialog's other copy. */
export const ADD_JOB_COPY = {
  title: 'Add a job by its link',
  // v32 JOBS2 (E5): one short sentence each.
  description: "Paste the posting's link; TailorIT reads the job from it.",
  linkLabel: 'Job posting link',
  linkPlaceholder: 'https://',
  linkHint: "The posting's own page, not a search results page.",
  linkRequired: 'Paste a link to the job posting.',
  add: 'Add job',
  adding: 'Reading the posting...',
  openJob: 'Open the job',
  addAnother: 'Add another',
  tryAnother: 'Try another link',
  close: 'Close',
  back: 'Back',
  saveForMe: 'Save for me only',
  detailsLead: 'Only you will see what you type here.',
  failed: "We couldn't add the job. Please try again.",
} as const;

export type AddOutcomeTone = 'success' | 'info' | 'warning' | 'error';

/** One outcome as the dialog draws it. */
export interface AddOutcomeView {
  tone: AddOutcomeTone;
  title: string;
  /** The server's words for the state. */
  body: string;
  /** Why TailorIT could not read the link, when that adds to `body` (a private job, details asked); else null. */
  why: string | null;
  /** The job to open ("Open the job"): published, waiting for an admin, or the person's own. */
  jobId: number | null;
  /** The next step: open the job, type the details (title and company) for a job of one's own, or try another link. */
  next: 'open' | 'details' | 'retry';
}

/** A reason's words (each reason's message is a public constant). */
export function reasonText(reason: JobVerifyReason | null, t: MessageRenderer): string | null {
  return reason ? t(JOB_VERIFY_REASON_MESSAGE[reason] as PublicMessageKey) : null;
}

/** The dialog's view of an add's answer. */
export function addOutcomeView(result: AddJobResult, t: MessageRenderer): AddOutcomeView {
  switch (result.state) {
    case 'published':
      return { tone: 'success', title: 'Added to Jobs', body: result.message, why: null, jobId: result.jobId, next: 'open' };
    case 'waiting_admin':
      return {
        tone: 'info',
        title: t('MSG_JOB_HELD_TITLE'),
        body: result.message,
        why: null,
        jobId: result.jobId,
        next: 'open',
      };
    case 'private_unverified': {
      const why = reasonText(result.reason, t);
      // The reason's words already said when they are the whole message (a server that answered with them).
      const extra = why && why !== result.message ? why : null;
      if (result.needsDetails || result.jobId === null) {
        return { tone: 'warning', title: "TailorIT couldn't read this link", body: result.message, why: extra, jobId: null, next: 'details' };
      }
      return { tone: 'warning', title: t('LABEL_JOB_FROM_BROWSER'), body: result.message, why: extra, jobId: result.jobId, next: 'open' };
    }
    case 'refused':
      return {
        tone: 'error',
        title: result.reason === 'closed' ? 'This posting has closed' : "This link can't be added",
        body: result.message,
        why: null,
        jobId: null,
        next: 'retry',
      };
  }
}

/**
 * What the person pasted, as a link the server reads: trimmed, and `https://` before an address typed without its
 * scheme ("boards.greenhouse.io/acme/jobs/1"). Anything else is sent as it is (the server says what it cannot add).
 */
export function linkInput(text: string): string {
  const value = text.trim();
  if (!value) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  return /^[\w-]+(\.[\w-]+)+(?:[/:?#]|$)/.test(value) ? `https://${value}` : value;
}

/**
 * v34 FANWEB fix (sharing L7): the outcome when the tab's own profile refused the add (the other profiles' line follows
 * under it): its reason, and try again from another profile or later.
 */
export function refusedHereView(why: string): AddOutcomeView {
  return { tone: 'error', title: FANOUT_COPY.addRefusedTitle, body: why, why: null, jobId: null, next: 'retry' };
}

/**
 * v34 FANWEB: what "Also save to" did on the other profiles, one line under the outcome ("Also on Ana. Not on Ben:
 * Needs Job Tracker › Change."); null without other profiles. A profile where the link added nothing (closed, or a
 * link TailorIT cannot read before its details are typed) says the server's words for it.
 */
export function alsoSavedLine(others: readonly FanoutAddJobResult[], profiles: readonly FanoutProfile[], label: LabelOf): string | null {
  if (others.length === 0) return null;
  const nameOf = (choice: string, answered: string) => profiles.find((profile) => profile.choice === choice)?.label ?? answered;
  const added = others.filter((entry) => entry.ok && entry.jobId !== null).map((entry) => nameOf(entry.profile, entry.name));
  const not = others
    .filter((entry) => !entry.ok || entry.jobId === null)
    .map((entry) => `${nameOf(entry.profile, entry.name)}: ${(entry.ok ? entry.message : refusalText(profiles, entry, label)).replace(/\.$/, '')}`);
  return [added.length > 0 ? FANOUT_COPY.alsoSaved(namesList(added)) : null, not.length > 0 ? FANOUT_COPY.alsoNot(not.join('; ')) : null]
    .filter(Boolean)
    .join(' ');
}
