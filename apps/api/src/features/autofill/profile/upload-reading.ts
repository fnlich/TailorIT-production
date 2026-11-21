import { requireAi } from '../../../ai/index';
import type { PersonPayer } from '../../../core/accounts/payer'; // v33 SHARE-3 (INT-1: a person's)
import type { AppDeps, SessionUser } from '../../../core/context';
import { AppError, notFound } from '../../../core/http/errors';
import { uploadReadingDedupeKey, uploadReadingOf } from '../../resumes/ai/uploadReading';
import { getResumeEvidence } from '../../resumes/evidence';
import { RESUME_NOT_FOUND } from '../../resumes/repository';
import { readableForImport } from '../../resumes/upload';

// v3.2 FILL: POST /api/autofill/profile/seed's first step. An uploaded file that has text to read and no reading yet is
// read by the AI (the `resume_import` task, `readOnly`: resumes/ai/uploadReading.ts), charged to the person, one task
// per file at a time; anything else (a built resume, an upload already read, one whose text cannot be read, no resume)
// is seeded at once. Without AI (off, paused, or the person's AI use for the day spent) the upload is seeded at once
// from what its text shows, and the refusal's own words go into the seed's notes.

export type UploadReadingStart =
  | { kind: 'none' }
  | { kind: 'started'; resumeId: string; taskId: string }
  | { kind: 'refused'; code: string; message: string };

/**
 * The refusals that leave an upload to its text alone: AI off or unavailable, and the day's AI use spent. v32 FIX-API:
 * and `ai_busy`, the account's two `resume_import` places taken (two editable copies being made): the contact details
 * fill now, and the note says why (MSG_AI_BUSY), rather than the whole Fill failing.
 */
const SEED_WITHOUT_AI: ReadonlySet<string> = new Set(['ai_unavailable', 'ai_usage_exhausted', 'ai_busy']);

/**
 * Starts the AI's reading of the resume "Fill from my resume" reads, when it is an upload that needs one. v33 SHARE-3
 * (PLAN F9 "Who pays"): `payer` pays (B filling A's profile: payerOf(req); v33 INT-1: required). B's reading never
 * joins one A pays for (the queue scopes the dedupe key by payer).
 */
export async function startUploadReading(deps: AppDeps, user: SessionUser, resumeId: string | undefined, payer: PersonPayer): Promise<UploadReadingStart> {
  const evidence = await getResumeEvidence(deps, user.id, resumeId ?? null);
  if (resumeId && !evidence) throw notFound(RESUME_NOT_FOUND);
  if (!evidence || evidence.kind !== 'uploaded' || !readableForImport(evidence.text)) return { kind: 'none' };
  // v32 FIX-API (SF-2): a reading kept, with or without a resume in it, is never asked again.
  if (await uploadReadingOf(deps, user.id, evidence.text)) return { kind: 'none' };
  try {
    const accepted = await requireAi(deps).enqueue({
      kind: 'resume_import',
      userId: user.id,
      input: { sourceResumeId: evidence.resumeId, readOnly: true },
      dedupeKey: uploadReadingDedupeKey(evidence.resumeId),
      chargeTo: payer, // v33 SHARE-3; INT-1: always named
    });
    return { kind: 'started', resumeId: evidence.resumeId, taskId: accepted.taskId };
  } catch (error) {
    if (error instanceof AppError && SEED_WITHOUT_AI.has(error.code)) {
      return { kind: 'refused', code: error.code, message: error.message };
    }
    throw error;
  }
}
