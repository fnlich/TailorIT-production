import { z } from 'zod';
import { InstantSchema } from './common';

// The resumes the extension may attach (GET /api/autofill/resumes) and the file it uploads into a form
// (GET /api/autofill/resumes/:id/file, which answers the bytes themselves, not JSON).

export const AUTOFILL_RESUME_KINDS = ['built', 'uploaded'] as const;
export type AutofillResumeKind = (typeof AUTOFILL_RESUME_KINDS)[number];

// v1.5 W
/**
 * v1.5 (additive within API 6): how a resume came to be, as TailorIT's Documents files it in its three folders.
 * `upload`: an uploaded file (Uploaded resumes). `editor`: made in the on-page editor, imported or duplicated from one
 * (Edited resumes). `copy`: an upload's editable copy, the AI's reading of the file (Edited resumes). `tailor`: made by
 * tailoring a resume for a job (Tailored resumes, grouped by the day it was made, `createdAt`).
 */
export const AUTOFILL_RESUME_MADE_BY = ['upload', 'editor', 'copy', 'tailor'] as const;
export type AutofillResumeMadeBy = (typeof AUTOFILL_RESUME_MADE_BY)[number];
// end v1.5 W

/**
 * What GET …/file answers: a built resume always prints as a PDF, exactly as Download does; an upload is sent as it
 * was uploaded, never converted. The extension refuses a legacy .doc before fetching it.
 */
export const AUTOFILL_FILE_KINDS = ['pdf', 'docx', 'doc'] as const;
export type AutofillFileKind = (typeof AUTOFILL_FILE_KINDS)[number];

/** The file's Content-Type, by kind: a form's `accept` may name either the extension or the type. */
export const AUTOFILL_FILE_MIME_TYPES: Record<AutofillFileKind, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
};

/** GET …/file names the kind of the bytes it sends (`pdf`, `docx` or `doc`). */
export const AUTOFILL_FILE_KIND_HEADER = 'X-TailorIT-File-Kind';
/** GET …/file sends the SHA-256 of the exact bytes, as 64 lower-case hex digits; the extension checks it twice. */
export const AUTOFILL_FILE_SHA256_HEADER = 'X-TailorIT-Sha256';
/** The largest file GET …/file answers (413 `file_too_large` above it), so the extension's handover stays small. */
export const AUTOFILL_RESUME_MAX_BYTES = 10 * 1024 * 1024;

export const AutofillResumeItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(AUTOFILL_RESUME_KINDS),
  /** What GET …/file answers: always 'pdf' for a built resume. */
  fileKind: z.enum(AUTOFILL_FILE_KINDS),
  /** The name the file is uploaded under ("Elena Ruiz Resume.pdf"). */
  fileName: z.string(),
  isDefault: z.boolean(),
  updatedAt: InstantSchema,
  // v1.5 W
  /** v1.5 (additive within API 6): how the resume came to be (AUTOFILL_RESUME_MADE_BY). Absent from an older server. */
  madeBy: z.enum(AUTOFILL_RESUME_MADE_BY).optional(),
  /** v1.5 (additive within API 6): when it was stored (a tailored resume's day). Absent from an older server. */
  createdAt: InstantSchema.optional(),
  // end v1.5 W
});
export type AutofillResumeItem = z.infer<typeof AutofillResumeItemSchema>;

/** GET /api/autofill/resumes: the account's resumes, and which one is the default. */
export const AutofillResumeListSchema = z.object({
  items: z.array(AutofillResumeItemSchema),
  defaultResumeId: z.string().nullable(),
});
export type AutofillResumeList = z.infer<typeof AutofillResumeListSchema>;
