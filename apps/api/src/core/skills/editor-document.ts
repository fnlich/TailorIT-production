import { isEditorDocument, type ResumeDocument, type ResumeTemplateId } from '@tailorit/shared';
import type { AppDeps } from '../context';
import { upgradeLegacyDocument } from '../resume-upgrade';
import { skillsFor } from './service';

/**
 * A resume document as the on-page editor opens it (core/resume-upgrade.ts). One the editor already owns comes back as
 * it is, with nothing read; an older one (saved before the editor) or one the AI wrote is upgraded with the person's
 * skill library. `into` makes it a new resume of the editor on that template (an upload's editable copy, a tailored
 * resume's source); without it an older resume keeps what its retired template printed, on A4.
 */
export async function editorDocumentOf(
  deps: Pick<AppDeps, 'db'>,
  userId: string,
  document: ResumeDocument,
  into?: ResumeTemplateId,
): Promise<ResumeDocument> {
  if (isEditorDocument(document)) return document;
  return upgradeLegacyDocument(document, { skills: await skillsFor(deps, userId), ...(into ? { into } : {}) });
}
