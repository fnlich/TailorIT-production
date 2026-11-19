import { z } from 'zod';
import {
  isResumeTemplateId,
  newCustomSectionKey,
  normalizeResumeDocument,
  TECHNICAL_SKILLS_LAYOUTS,
  type ResumeDocument,
  type ResumeImportTaskResult,
} from '@tailorit/shared';
import type { AiTaskContext } from '../../../ai/index';
import { resumeImportPrompt, type ImportedResume } from '../../../ai/prompts/resumes/resume-import';
import type { AppDeps } from '../../../core/context';
import { AppError } from '../../../core/http/errors';
import { upgradeLegacyDocument } from '../../../core/resume-upgrade';
import { getResumeEngine } from '../engine';
import { assertRoomForResumes, insertResume } from '../repository';
import { MAX_EXTRACTED_TEXT, readableForImport, UNREADABLE_TEXT } from '../upload';

// "Make an editable copy": an uploaded resume's text read by the AI into a new resume document. The rule is
// free_tailor's, in TailorIT's words: copy, never infer. The new resume is a separate, built resume whose
// `source_resume_id` is the upload; the upload itself is left as it was. Two rules hold for every copy (asked for
// alone, or from the copy line): no AI call is spent on a copy the account has no room to keep (the insert checks
// again), and a template this server does not offer is dropped, so the copy starts on the standard one. v30 ST1: the
// prompt and its answer's schema are apps/api/src/ai/prompts/resumes/resume-import.ts.

/** The model's answer as a normalised resume document; its extra sections become custom sections. */
export function importedDocument(answer: ImportedResume): ResumeDocument {
  const taken: string[] = [];
  const customSections = (answer.otherSections ?? []).slice(0, 10).map((section) => {
    const key = newCustomSectionKey(undefined, taken);
    taken.push(key);
    return { key, title: section.title ?? '', entries: section.entries ?? [] };
  });
  return normalizeResumeDocument({ ...answer, contact: answer.contact ?? {}, customSections });
}

/** Whether a document holds anything worth opening in the editor (v32 FILL: and worth filling a profile from). */
export function hasImportedContent(document: ResumeDocument): boolean {
  return Boolean(
    document.name ||
      document.summary ||
      document.experience.length ||
      document.education.length ||
      document.skills.length,
  );
}

/** The AI read the file but found nothing of a resume in it. */
export const NO_RESUME_CONTENT =
  'The AI found no resume content in that file. Check that it is a resume with selectable text, then try again.';

export const ImportTaskInputSchema = z.object({
  sourceResumeId: z.string().min(1).max(64),
  templateId: z.string().max(100).optional(),
  layout: z.enum(TECHNICAL_SKILLS_LAYOUTS).optional(),
  /** A copy the copy line started (copies/backlog.ts counts its copies in flight by it); the copy is made the same. */
  copyLine: z.literal(true).optional(),
  /**
   * v32 FILL: a reading only ("Fill from my resume" on an upload, ./uploadReading.ts): the document is kept for the
   * account and no resume is made, so neither the template nor the room for a copy matters.
   */
  readOnly: z.literal(true).optional(),
});
export type ImportTaskInput = z.infer<typeof ImportTaskInputSchema>;

/**
 * A request's text quoted for one log line, in printable ASCII only: JSON escapes quotes, backslashes and C0 controls,
 * and every other character outside printable ASCII is escaped too. Terminals and log tools read DEL, the C1 controls
 * (NEL, the 8-bit CSI) and the line and paragraph separators as new lines or commands, and a reader that takes the
 * log for Latin-1, or an 8-bit terminal, reads the same controls in the UTF-8 bytes of a letter (U+00C5 is C3 85).
 */
function quotedForLog(text: string): string {
  return JSON.stringify(text).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * The `resume_import` task (resumes/tasks.ts reads its input with ImportTaskInputSchema): reads the upload's stored
 * text, asks the AI, saves a new built resume.
 */
export async function runResumeImport(deps: AppDeps, input: ImportTaskInput, ctx: AiTaskContext): Promise<ResumeImportTaskResult> {
  const userId = ctx.userId;
  if (!userId) throw new AppError('forbidden', 'A resume import needs an account.');
  const upload = await deps.db.one<{ id: string; extracted_text: string | null }>(
    "SELECT id, extracted_text FROM resumes WHERE id = ? AND user_id = ? AND kind = 'uploaded'",
    [input.sourceResumeId, userId],
  );
  if (!upload) throw new AppError('not_found', 'The uploaded resume was deleted before it could be read.');
  const text = (upload.extracted_text ?? '').slice(0, MAX_EXTRACTED_TEXT);
  if (!readableForImport(text)) throw new AppError('validation_failed', UNREADABLE_TEXT);
  await assertRoomForResumes(deps, userId, 1);
  const engine = getResumeEngine(deps);
  // The on-page editor's new resume names one of its own templates: the copy is a resume of that editor, on it.
  const editorTemplate = isResumeTemplateId(input.templateId) ? input.templateId : undefined;
  const templateId = input.templateId && !editorTemplate ? engine.templates.get(input.templateId)?.id : undefined;
  if (input.templateId && !editorTemplate && !templateId) {
    // Quoted and escaped: the id is as the request sent it, and must never start a line of its own in the log.
    deps.log.info(
      `[resumes] an editable copy asked for template ${quotedForLog(input.templateId)}, which this server does not ` +
        'offer; it starts on the standard template',
    );
  }

  const answer = await ctx.runPrompt(resumeImportPrompt, { text });
  let document = importedDocument(answer);
  if (templateId || input.layout) {
    document = normalizeResumeDocument(
      {
        ...(templateId ? { preferredTemplate: templateId } : {}),
        ...(input.layout ? { resumeSettings: { technicalSkillsLayout: input.layout } } : {}),
      },
      document,
    );
  }
  if (editorTemplate) {
    document = upgradeLegacyDocument(document, { templates: engine.templates, skills: await engine.skillsFor(userId), into: editorTemplate });
  }
  if (!hasImportedContent(document)) throw new AppError('ai_failed', NO_RESUME_CONTENT);
  // The upload may have been deleted while the AI read it; the copy is kept either way.
  const sourceStillThere = await deps.db.one('SELECT 1 FROM resumes WHERE id = ? AND user_id = ?', [upload.id, userId]);
  const resumeId = await insertResume(deps, userId, {
    kind: 'built',
    document,
    sourceResumeId: sourceStillThere ? upload.id : null,
    madeBy: 'copy', // v1.5 W
  });
  return { resumeId };
}
