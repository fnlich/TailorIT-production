import type {
  AtsKind,
  AutofillFormsKnownRequest,
  AutofillFormsKnownResponse,
  AutofillSubmissionRequest,
  AutofillSubmissionResponse,
} from '@tailorit/shared/autofill';
import { nowIso, type AppDeps } from '../../../core/context';
import { notFound } from '../../../core/http/errors';
import { aliasValueHash } from '../alias-key';
import type { InFlight } from '../jobs';
import { currentJobId, findPageJob, readPage, type PageReading } from '../lookup';
import { markApplied, type AppliedOptions, type AppliedVia } from '../tracker';
import { greenhousePostingOf, startGreenhouseRead, type GreenhouseQuestionReads } from './greenhouse';
// v1.5 P
import { draftAnswersFor } from '../../prepare/known';
// end v1.5 P
import {
  findForm,
  formKnown,
  formPlace,
  formQuestions,
  keepQuestions,
  knownAnswers,
  openForm,
  questionCount,
  replaceAnswers,
  type AnswerReach,
  type FormPlace,
} from './store';

// A confirmed submission's questions and answers, and a job's known form (TailorIT v1.3, decisions 1 to 5; the
// contract is packages/shared/src/autofill/forms.ts). Routes: POST /api/autofill/submissions (jobs-router.ts, beside
// /applied, whose limits and posting reads it shares) and POST /api/autofill/forms/known (forms/router.ts).

export interface Submitted {
  body: AutofillSubmissionResponse;
  via: AppliedVia;
  moved: boolean;
  kind: AtsKind | null;
}

/**
 * POST /submissions: Applied's steps (markApplied), with the posting's text to add the job from and the person's own
 * page job shared; then, in the transaction that moves the entry to Applied, the form's questions kept for the job (or
 * the posting, with no job) and, when the body has `answers`, this account's answers for the entry replaced.
 */
export async function submitApplication(
  deps: AppDeps,
  userId: string,
  request: AutofillSubmissionRequest,
  inFlight: InFlight,
  options: AppliedOptions,
): Promise<Submitted> {
  let questionsAdded = 0;
  let questionsKnown = 0;
  let answersKept: number | null = request.answers ? 0 : null;
  const applied = await markApplied(
    deps,
    userId,
    {
      ...(request.url !== undefined ? { url: request.url } : {}),
      ...(request.jobId !== undefined ? { jobId: request.jobId } : {}),
      ...(request.resumeId !== undefined ? { resumeId: request.resumeId } : {}),
    },
    inFlight,
    options,
    {
      ...(request.employerUrl !== undefined ? { employerUrl: request.employerUrl } : {}),
      ...(request.posting !== undefined ? { posting: request.posting } : {}),
      share: true,
      within: async (t, entryId, jobId, page) => {
        const place = await formPlace(t, jobId, page);
        if (!place) return;
        const now = nowIso(deps);
        const form = await openForm(t, place, 'submission', now);
        const { ids, added } = await keepQuestions(t, form.id, request.questions, now);
        questionsAdded = added;
        questionsKnown = await questionCount(t, form.id);
        if (request.answers) {
          answersKept = await replaceAnswers(t, userId, entryId, request.questions, ids, request.answers, now);
        }
      },
    },
  );
  const lookup = { ...applied.answer, formKnown: questionsKnown > 0 };
  return {
    body: { lookup, job: applied.job, questionsAdded, questionsKnown, answersKept },
    via: applied.via,
    moved: applied.moved,
    kind: applied.kind,
  };
}

/**
 * The form a page or a job names for `viewer`: the job is `jobId` (404 when the viewer may not see it), else the one
 * the lookup finds; the page is passed over when the job was named by its id.
 */
export async function placeFor(
  deps: Pick<AppDeps, 'db' | 'config'>,
  viewer: string,
  request: Pick<AutofillFormsKnownRequest, 'url' | 'jobId' | 'employerUrl'>,
): Promise<{ jobId: number | null; page: PageReading | null; place: FormPlace | null }> {
  if (request.jobId !== undefined) {
    const jobId = await currentJobId(deps, viewer, request.jobId);
    if (jobId === null) throw notFound('That job');
    return { jobId, page: null, place: await formPlace(deps.db, jobId, null) };
  }
  const page = readPage(request.url ?? '', request.employerUrl, aliasValueHash(deps));
  const jobId = (await findPageJob(deps, viewer, page))?.id ?? null;
  return { jobId, page, place: await formPlace(deps.db, jobId, page) };
}

/**
 * Starts the Greenhouse questions' read for a lookup's job when it is a shared Greenhouse job whose form keeps no
 * questions (forms/greenhouse.ts); never waits for it (it is under way when this answers). Answers whether TailorIT
 * keeps the form's questions now.
 */
export async function formKnownAndRead(
  deps: AppDeps,
  reads: GreenhouseQuestionReads,
  jobId: number | null,
  page: PageReading | null,
): Promise<boolean> {
  const place = await formPlace(deps.db, jobId, page);
  if (!place) return false;
  if (await formKnown(deps.db, place)) return true;
  // Only a job TailorIT shares already: a posting no one added is never read for a lookup (nothing records it).
  if (place.jobId !== null) {
    const posting = await greenhousePostingOf(deps, page, place.jobId);
    if (posting) void startGreenhouseRead(deps, reads, place, posting, deps.services.ingest?.http ?? null);
  }
  return false;
}

/**
 * POST /forms/known: the form's questions and this account's earlier answers (store.ts knownAnswers), as far as
 * `reach` lets the caller read them.
 */
export async function knownForm(
  deps: AppDeps,
  viewer: string,
  request: AutofillFormsKnownRequest,
  reach: AnswerReach,
  reads: GreenhouseQuestionReads,
): Promise<AutofillFormsKnownResponse> {
  const { jobId, page, place } = await placeFor(deps, viewer, request);
  const form = place ? await findForm(deps.db, place) : null;
  const questions = form ? await formQuestions(deps.db, form.id) : [];
  if (questions.length === 0) await formKnownAndRead(deps, reads, jobId, page);
  const answers = await knownAnswers(deps.db, viewer, form?.id ?? null, questions, request.fields ?? [], reach);
  // v1.5 P: the viewer's own prepared draft answers to the job's questions (with profile:read, as every answer); left
  // out when there are none, so the answer is as before for a job the person never prepared.
  const drafts = reach.answers ? await draftAnswersFor(deps, viewer, jobId, questions) : [];
  return { jobId, questions, answers, ...(drafts.length > 0 ? { drafts } : {}) };
  // end v1.5 P
}
