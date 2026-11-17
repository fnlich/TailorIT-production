import { z } from 'zod';
import { messageError } from '../constants/public/defaults';
import { PUBLIC_CONSTANT_SPECS } from '../constants/public/specs';

// v20 P10 (DECISIONS A28): Documents › Resumes' batch download, Paid only. With two or more resumes selected, Download
// (left of Delete) asks the server for a ZIP of them; a Free account gets 403 `paid_feature` with
// MSG_BATCH_DOWNLOAD_PAID and the Subscribe button (feature `batch_download`), from the server, never only the UI.
//   POST (P10's "documents" source of the resume ZIP)  DocumentsZipBody → 202 ResumeZipAccepted {buildId}
//   then the Tracker resume ZIP's own poll and download: GET /api/applications/resume-zip/:buildId → ResumeZipBuild,
//   and …/:buildId/file until `expiresAt` (apps/api/src/features/resume-zip; ResumeZipAccepted and ResumeZipBuild in
//   @tailorit/shared/tracker), with the account's own resumes as the source.
//
// The path of each file inside the ZIP: `<shown name>/<First>_<Last>_resume.pdf`.
// - <shown name>: the resume's name as Documents shows it now (its title), made path-safe by zipNames'
//   safePathSegment; a repeated name gets " (2)", " (3)", compared case-insensitively, as zipNames does.
// - <First>_<Last>: personFileStem of the name on that resume, else the account's name.
// - Built, edited and tailored resumes are rendered to PDF. Uploaded resumes are never modified: an uploaded PDF goes
//   in byte for byte, and an uploaded DOCX goes in as its original file with its own extension (`…_resume.docx`),
//   which SKIPPED.txt notes.
// - At most BATCH_DOWNLOAD_MAX_RESUMES resumes per ZIP (the route checks the resolved constant; the schema holds the
//   constant's own ceiling). No AI is involved, so nothing is charged.

/** The most resumes a batch download request may name: BATCH_DOWNLOAD_MAX_RESUMES' own ceiling. */
export const BATCH_DOWNLOAD_RESUMES_CEILING = PUBLIC_CONSTANT_SPECS.BATCH_DOWNLOAD_MAX_RESUMES.max;

/**
 * The batch download's request: the selected resumes, each the requester's own (another account's id is refused), each once.
 * `tzOffsetMinutes` is the browser's offset east of UTC, as the Tracker ZIP takes it, so the files' times read local.
 */
export const DocumentsZipBodySchema = z.object({
  resumeIds: z
    .array(z.string().min(1).max(64))
    .min(1, 'Choose at least one resume.')
    .max(BATCH_DOWNLOAD_RESUMES_CEILING, messageError('MSG_BATCH_DOWNLOAD_MAX', { max: BATCH_DOWNLOAD_RESUMES_CEILING }))
    .refine((ids) => new Set(ids).size === ids.length, 'Choose each resume once.'),
  tzOffsetMinutes: z.number().int().min(-720).max(840).optional(),
});
export type DocumentsZipBody = z.infer<typeof DocumentsZipBodySchema>;
