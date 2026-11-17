import { createHash } from 'node:crypto';
import { Router, type Response } from 'express';
import { IdParam, MINUTE_MS } from '@tailorit/shared';
import {
  AUTOFILL_FILE_KIND_HEADER,
  AUTOFILL_FILE_MIME_TYPES,
  AUTOFILL_FILE_SHA256_HEADER,
} from '@tailorit/shared/autofill';
import { userOf } from '../../core/auth/guards';
import type { AppDeps } from '../../core/context';
import { contentDisposition } from '../../core/files/index';
import { asyncHandler } from '../../core/http/errors';
import { parseInput } from '../../core/http/validate';
import { allow, perAccountLimit } from './auth';
import { listAttachableResumes, resumeFileOf, type AttachedFile } from './resumes';

// The resumes the extension attaches (work package AF), mounted at /api/autofill:
//   GET /resumes           Settings or a token (resumes:read) → AutofillResumeList
//   GET /resumes/:id/file  Settings or a token (resumes:read) → the file itself: Content-Disposition attachment,
//                          X-TailorIT-File-Kind (pdf, docx or doc) and X-TailorIT-Sha256 (of the exact bytes sent)
// A built resume costs a Chrome print (PDF_MAX_CONCURRENCY at a time), hence the tighter limit on the file. The log
// names the resume, the account, the kind, the size and the print's time; never a byte or a word of the resume.

/** Files per account per minute. */
export const RESUME_FILES_PER_MINUTE = 20;

/**
 * The file as the extension checks it: its kind and the SHA-256 of these exact bytes (it checks the digest when it
 * fetches them and again after handing them to the page), and how long a built resume (or a cover letter) took to
 * print.
 */
export function sendAttachedFile(res: Response, file: AttachedFile): void {
  res.setHeader('Content-Type', AUTOFILL_FILE_MIME_TYPES[file.kind]);
  res.setHeader('Content-Disposition', contentDisposition(file.fileName));
  res.setHeader('Content-Length', String(file.buffer.length));
  res.setHeader(AUTOFILL_FILE_KIND_HEADER, file.kind);
  res.setHeader(AUTOFILL_FILE_SHA256_HEADER, createHash('sha256').update(file.buffer).digest('hex'));
  if (file.printMs !== null) res.setHeader('Server-Timing', `print;dur=${file.printMs}`);
  res.send(file.buffer);
}

export function createAutofillResumesRouter(deps: AppDeps): Router {
  const router = Router();
  const listLimit = perAccountLimit('autofill-resumes', 60, MINUTE_MS);
  const fileLimit = perAccountLimit('autofill-resume-file', RESUME_FILES_PER_MINUTE, MINUTE_MS);

  router.get('/resumes', allow('either', 'resumes:read'), listLimit, async (req, res) => {
    res.json(await listAttachableResumes(deps, userOf(req).id));
  });

  router.get(
    '/resumes/:id/file',
    allow('either', 'resumes:read'),
    fileLimit,
    asyncHandler(async (req, res) => {
      const userId = userOf(req).id;
      const id = parseInput(IdParam, req.params.id, 'resume id');
      const file = await resumeFileOf(deps, userId, id);
      const printed = file.printMs === null ? '' : `, printed in ${file.printMs} ms`;
      deps.log.debug(
        `[autofill] resume ${id} sent to account ${userId}: ${file.kind}, ${file.buffer.length} bytes${printed}`,
      );
      sendAttachedFile(res, file);
    }),
  );

  return router;
}
