import type { PromptModule } from '../../runPrompt';
import { defineTextPrompt } from '../types';
import { serverPromptText } from './render';

// v30 ST2: the MCP step prompt `write_cover_letter` for a job whose chosen resume is an upload (no built resume),
// moved from features/mcp/step-prompts.ts and own-prompts.ts. v2.0 P5 (DECISIONS A29): the letter is written from the
// upload's text with the editor's own letter prompt (the cover-letters area's, which the caller passes with its
// input), as text for the person's AI (serverPromptText), then the call that saves its paragraphs.

/** The editor's letter prompt and its input for the job. */
export interface UploadLetterInput<I = unknown> {
  jobId: number;
  module: PromptModule<I, unknown>;
  input: I;
  /**
   * v34 MCPDIR: the posting's data label (features/mcp/screen.ts), written as the job description's last line once the
   * prompt cleaned it (the cleaning defuses a TailorIT mark written in the page).
   */
  label?: string;
}

/** Where the editor's letter prompt quotes the job description. */
const JOB_DESCRIPTION = 'Job description:\n<untrusted>\n';

/** The editor's letter prompt for the job, as text for the person's AI, ending with the call that saves it. */
export function uploadLetterText<I>({ jobId, module, input, label }: UploadLetterInput<I>): string {
  const text = serverPromptText(
    module,
    input,
    `This prompt is for job ${jobId}. Call prepare_save_cover_letter with {"jobId": ${jobId}, "paragraphs": ` +
      '[...]}, the paragraphs of your answer. TailorIT places them on the cover letter template of the person\'s profile.',
  );
  const start = text.indexOf(JOB_DESCRIPTION);
  const end = start < 0 ? -1 : text.indexOf('\n</untrusted>', start + JOB_DESCRIPTION.length);
  return label && end >= 0 ? `${text.slice(0, end)}\n${label}${text.slice(end)}` : text;
}

export const uploadLetterPrompt = defineTextPrompt<UploadLetterInput>({
  area: 'mcp',
  name: 'upload-cover-letter',
  version: 1,
  description:
    "The step `write_cover_letter` for the person's AI on an upload's text: the editor's letter prompt, saved with prepare_save_cover_letter.",
  text: (input) => uploadLetterText(input),
});
