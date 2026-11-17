import { Router, type ErrorRequestHandler, type RequestHandler } from 'express';
import { IdParam, MINUTE_MS, HOUR_MS } from '@tailorit/shared';
import { AutofillCoverLetterRequestSchema, type AutofillCoverLetterStatus } from '@tailorit/shared/autofill';
import { userOf } from '../../core/auth/guards';
import { constantsOf } from '../../core/constants/service';
import type { AppDeps } from '../../core/context';
import { AppError, asyncHandler, notFound, sendError } from '../../core/http/errors';
import { parseInput } from '../../core/http/validate';
import { allow, perAccountLimit } from './auth';
import { coverLetterFileOf, coverLetterFor, coverLetterStateOf, coverLetterTextOf, type LetterOutcome } from './cover-letters';
import { sendAttachedFile } from './resumes-router';

// The cover letter the extension uploads into a form (work package AF, API version 2), mounted at /api/autofill:
//   POST /cover-letters           Settings or a token (letters:write) AutofillCoverLetterRequest → {letterId, state, aiWritten}
//   GET  /cover-letters/:id       Settings or a token (letters:write) → {state}, polled while it is written
//   GET  /cover-letters/:id/file  Settings or a token (letters:write) → the PDF the editor's Download prints:
//                                 Content-Disposition attachment, X-TailorIT-File-Kind pdf, X-TailorIT-Sha256 (of the
//                                 exact bytes sent), Server-Timing, Cache-Control no-store; 409 until it is ready
//   GET  /cover-letters/:id/text  Settings or a token (letters:write, version 3) → {text}: its words for a text box,
//                                 Cache-Control no-store; 409 until it is ready
// The POST may start a Claude call, hence its limits: 10 a minute and 60 an hour per account; the state is polled
// (120 a minute), the file is a Chrome print (20 a minute, as a resume's). The debug lines name the account, whether
// TailorIT has the job, how the letter came about, its state, its size and the time; never a letter, a job, an
// application or a resume (an id leads back to the posting), nor a word of the letter or the job. Refusals are
// answered here, so the shared error handler never logs these paths, which hold the letter's id: a client error a
// library raised (a path that does not decode) as the shared handler answers it, unlogged.

/** Letters asked for that may be written (generate: true) per account: a minute, an hour (v30 ST3: the constant
 *  AUTOFILL_COVER_LETTERS_PER_HOUR, read on each request since v30 INT-0). */
export const COVER_LETTERS_PER_MINUTE = 10;
/**
 * Checks for a letter the person has (generate: false) per account per minute: the extension's job card asks on every
 * posting it shows, so they have a count of their own and never use up the writes above.
 */
export const COVER_LETTER_CHECKS_PER_MINUTE = 60;
/** State reads per account per minute (the extension polls every 1.5 s while a letter is written). */
export const COVER_LETTER_STATES_PER_MINUTE = 120;
/** Files per account per minute. */
export const COVER_LETTER_FILES_PER_MINUTE = 20;
/** Texts per account per minute (version 3). */
export const COVER_LETTER_TEXTS_PER_MINUTE = 20;

const OUTCOMES: Record<LetterOutcome, string> = {
  existing: "the person's letter",
  written_into_empty: 'writing their empty letter',
  new: 'writing a new letter',
  template_unfilled: "their empty letter's template needs a detail they have not given",
};

/** The status a library's error carries (Express's, body-parser's), else 500. */
function statusOf(error: unknown): number {
  const { status, statusCode } = (error ?? {}) as { status?: unknown; statusCode?: unknown };
  if (typeof status === 'number') return status;
  return typeof statusCode === 'number' ? statusCode : 500;
}

/**
 * A refusal as the shared error handler (core/http/errors.ts) answers it: an AppError as it is; a client error a
 * library raised (a path parameter that does not decode) 404 `not_found` or `validation_failed` with its status, its
 * own message never shown (it can quote the request); anything else 500 `internal`.
 */
function refusalOf(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const status = statusOf(error);
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return status === 404 ? notFound() : new AppError('validation_failed', 'The request is not valid.', { status });
  }
  return new AppError('internal', 'Something went wrong on our side. Please try again.', { cause: error });
}

/** What a failure's cause is, for the log: its class's name alone, never its message (it can quote the path). */
function causeName(cause: unknown): string {
  if (cause === undefined) return '';
  return ` (${cause instanceof Error ? cause.name : typeof cause})`;
}

export function createAutofillCoverLettersRouter(deps: AppDeps): Router {
  const router = Router();
  const minuteLimit = perAccountLimit('autofill-cover-letter', COVER_LETTERS_PER_MINUTE, MINUTE_MS);
  const perHour = () => constantsOf(deps).get('AUTOFILL_COVER_LETTERS_PER_HOUR');
  const hourLimit = perAccountLimit('autofill-cover-letter-hour', perHour, HOUR_MS);
  const checkLimit = perAccountLimit('autofill-cover-letter-check', COVER_LETTER_CHECKS_PER_MINUTE, MINUTE_MS);
  const stateLimit = perAccountLimit('autofill-cover-letter-state', COVER_LETTER_STATES_PER_MINUTE, MINUTE_MS);
  const fileLimit = perAccountLimit('autofill-cover-letter-file', COVER_LETTER_FILES_PER_MINUTE, MINUTE_MS);
  const textLimit = perAccountLimit('autofill-cover-letter-text', COVER_LETTER_TEXTS_PER_MINUTE, MINUTE_MS);
  // A body that may write counts against the writes; anything else (a check, or a body the parse refuses) against the
  // checks.
  const askLimit: RequestHandler = (req, res, next) => {
    if ((req.body as { generate?: unknown } | undefined)?.generate !== true) return checkLimit(req, res, next);
    return minuteLimit(req, res, (error?: unknown) => (error ? next(error) : hourLimit(req, res, next)));
  };

  router.post('/cover-letters', allow('either', 'letters:write'), askLimit, async (req, res) => {
    const userId = userOf(req).id;
    const request = parseInput(AutofillCoverLetterRequestSchema, req.body ?? {}, 'request');
    const started = performance.now();
    const { answer, outcome } = await coverLetterFor(deps, userId, request);
    const job = request.jobId === undefined ? 'a posting TailorIT does not have' : 'a TailorIT job';
    deps.log.debug(
      `[autofill] cover letter for account ${userId}: ${job}, ${OUTCOMES[outcome]}, ${answer.state}, ` +
        `${Math.round(performance.now() - started)} ms`,
    );
    res.json(answer);
  });

  router.get('/cover-letters/:id', allow('either', 'letters:write'), stateLimit, async (req, res) => {
    const id = parseInput(IdParam, req.params.id, 'cover letter id');
    const body: AutofillCoverLetterStatus = { state: await coverLetterStateOf(deps, userOf(req).id, id) };
    res.json(body);
  });

  router.get(
    '/cover-letters/:id/file',
    allow('either', 'letters:write'),
    fileLimit,
    asyncHandler(async (req, res) => {
      const userId = userOf(req).id;
      const id = parseInput(IdParam, req.params.id, 'cover letter id');
      const file = await coverLetterFileOf(deps, userId, id);
      deps.log.debug(
        `[autofill] cover letter sent to account ${userId}: pdf, ${file.buffer.length} bytes, printed in ` +
          `${file.printMs} ms`,
      );
      res.setHeader('Cache-Control', 'no-store');
      sendAttachedFile(res, file);
    }),
  );

  router.get('/cover-letters/:id/text', allow('either', 'letters:write'), textLimit, async (req, res) => {
    const userId = userOf(req).id;
    const id = parseInput(IdParam, req.params.id, 'cover letter id');
    const body = await coverLetterTextOf(deps, userId, id);
    deps.log.debug(`[autofill] cover letter text sent to account ${userId}: ${body.text.length} characters`);
    res.setHeader('Cache-Control', 'no-store');
    res.json(body);
  });

  // These routes' refusals, answered as the shared handler answers them, but logged (a failure on our side only) with
  // the request's id, the sentence and its cause's kind alone: never the path, nor a raw error's message.
  const answerRefusal: ErrorRequestHandler = (error, req, res, next) => {
    if (res.headersSent) return next(error);
    const refusal = refusalOf(error);
    if (refusal.status >= 500) {
      deps.log.error(`[${req.requestId}] [autofill] cover letter: ${refusal.message}${causeName(refusal.cause)}`);
    }
    sendError(res, refusal, req.requestId);
  };
  router.use(answerRefusal);

  return router;
}
