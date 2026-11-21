import type { PublicMessageKey } from '@/lib/constants';
import { isApiError } from '@/lib/api';
import { isActing } from '@/lib/profile';

/*
 * v33 SHARE-3 (PLAN-sharing §9 "Editors"; SHARE-4's edit 5): a letter or template save names the version it changes
 * (`baseUpdatedAt`); when the server saved another one since (someone else on a shared profile, or another tab), it
 * answers 409 `revision_conflict` and nothing is saved. The editor then says so, drops what it was about to send and
 * loads the latest version, as the resume editor does ("Someone else changed this resume.").
 */

/** Whether a save was refused because the document was saved elsewhere since this editor loaded or saved it. */
export const isSaveConflict = (error: unknown): boolean => isApiError(error) && error.code === 'revision_conflict';

/** The toast's words for that refusal: on a shared profile someone else changed it; on one's own, another tab did. */
export function conflictToast(
  t: (key: PublicMessageKey) => string,
  kind: 'letter' | 'template',
): { title: string; description: string } {
  if (!isActing()) return { title: 'Edited in another tab', description: 'Loading the latest version.' };
  return {
    title: t(kind === 'letter' ? 'MSG_LETTER_CHANGED_SHARED' : 'MSG_LETTER_TEMPLATE_CHANGED_SHARED'),
    description: 'Loading the latest version.',
  };
}
