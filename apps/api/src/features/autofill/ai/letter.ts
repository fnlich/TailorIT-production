import type { LetterProfile } from '@tailorit/shared';
import { namesForeignContact, type OwnContacts } from './contacts';
import { holdsCanary, speaksAsAnAi, stringsOf } from './tasks';
import { holdsPromptMarkup } from './untrusted';

// A cover letter the extension asked for (POST /api/autofill/cover-letters), checked before it is stored (the Phase G
// review). The cover-letter feature writes it (cover-letters/generate.ts) from the job the form's page shows, which is
// page text like a draft's job text (draft.ts), so Claude's answer is not trusted until it passes the drafts' checks:
// a canary of the page's anywhere in the answer or in the reply texts it came from, or Claude speaking as an AI there;
// the prompt's wrapper, the JSON sentinels or the fake CLI's scenario tag in the answer; a link, an email address or a
// phone number in it that is not the person's own. A letter that fails one is not kept: its writing fails, the letter
// stays as it was, and the extension reads it `failed`.

/** Why a letter's answer was not kept. */
export type LetterProblem = 'canary' | 'ai_reference' | 'wrapper' | 'contact';

/** What the task's failure says (stored on the task; it names no word of the letter or the page). */
export const LETTER_NOT_KEPT =
  'This cover letter was not kept: what Claude wrote did not pass the checks for a letter written from a job page.';

/** The person's own links, email address and phone number, from the letter's profile: a letter may name these. */
export function letterContacts(profile: Pick<LetterProfile, 'email' | 'phone' | 'linkedin' | 'portfolio'>): OwnContacts {
  const present = (values: string[]) => values.map((value) => value.trim()).filter(Boolean);
  return {
    urls: present([profile.linkedin, profile.portfolio]),
    emails: present([profile.email]),
    phones: present([profile.phone]),
  };
}

/**
 * The first problem of a letter's answer (`answer`: Claude's parsed JSON; `replies`: each reply's whole text, prose
 * outside the sentinels included, which hold the sentinels themselves), or null when it may be stored.
 */
export function letterProblem(
  answer: unknown,
  replies: readonly string[],
  check: { canaries: readonly string[]; contacts: OwnContacts },
): LetterProblem | null {
  const texts = stringsOf(answer);
  const heard = [...texts, ...replies];
  if (holdsCanary(heard, check.canaries)) return 'canary';
  if (heard.some(speaksAsAnAi)) return 'ai_reference';
  if (texts.some(holdsPromptMarkup)) return 'wrapper';
  if (texts.some((text) => namesForeignContact(text, check.contacts))) return 'contact';
  return null;
}
