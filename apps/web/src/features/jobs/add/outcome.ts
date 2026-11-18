import { JOB_VERIFY_REASON_MESSAGE, type AddJobResult, type JobVerifyReason } from '@tailorit/shared';
import type { MessageRenderer } from '@/lib/messages';
import type { PublicMessageKey } from '@/lib/constants';

// v31 JOBSWEB: what the Add job dialog says after TailorIT tried to read a link (docs/design/v3.1/21-jobs-from-links.md
// §3): the four states of POST /api/jobs/add, each with its next step. The server renders the state's words (an
// admin's change included) in `message`; the reason's words ("This site's robots.txt...") come from the constants.

/** The link field's words, kept beside the dialog's other copy. */
export const ADD_JOB_COPY = {
  title: 'Add a job by its link',
  description: "Paste the job posting's link. TailorIT reads the job from the posting itself, so its title, company and details are the employer's.",
  linkLabel: 'Job posting link',
  linkPlaceholder: 'https://',
  linkHint: "The posting's own page or its application page, not a search results page.",
  linkRequired: 'Paste a link to the job posting.',
  add: 'Add job',
  adding: 'Reading the posting...',
  openJob: 'Open the job',
  addAnother: 'Add another',
  tryAnother: 'Try another link',
  close: 'Close',
  back: 'Back',
  saveForMe: 'Save for me only',
  detailsLead: 'Only you will see what you type here. TailorIT keeps trying to read the link, and shares the job once it can.',
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
