import { Router, type Request } from 'express';
import {
  AUTOFILL_SAVED_ANSWER_LIMITS,
  AutofillSavedAnswerIdSchema,
  PutAutofillSavedAnswerBodySchema,
  type AutofillSavedAnswerList,
} from '@tailorit/shared/autofill';
import { userOf } from '../../../core/auth/guards';
import type { AppDeps } from '../../../core/context';
import { notFound, validationFailed } from '../../../core/http/errors';
import { parseInput } from '../../../core/http/validate';
import { allow, perAccountLimit } from '../auth';
import { deleteSavedAnswer, listSavedAnswers, saveSavedAnswer } from './repository';
import { refusalOf } from './screen';
import { MINUTE_MS } from '@tailorit/shared';

// Saved answers (work package AF, Phase 6), mounted at /api/autofill:
//   GET    /answers      Settings or a token (profile:read) → AutofillSavedAnswerList; the extension reads it with
//                        GET /profile, once per run
//   PUT    /answers      Settings or a token (answers:write) PutAutofillSavedAnswerBody → 200 AutofillSavedAnswer;
//                        400 for a file, a sensitive, consent or attention-check question; 409 past the account's limit
//   DELETE /answers/:id  Settings or a token (answers:write) → 204; 404 for another account's or none
// The log names the account, the token, the answer's id and counts; never a question, a label or an answer.

/** "account <id>", and the token when the extension called. */
function caller(req: Request): string {
  const token = req.extensionToken ? ` (token ${req.extensionToken.id})` : '';
  return `account ${userOf(req).id}${token}`;
}

export function createAutofillAnswersRouter(deps: AppDeps): Router {
  const router = Router();
  const readLimit = perAccountLimit('autofill-answers-read', 60, MINUTE_MS);
  const writeLimit = perAccountLimit('autofill-answers-write', 60, MINUTE_MS);

  router.get('/answers', allow('either', 'profile:read'), readLimit, async (req, res) => {
    const { items, unreadable } = await listSavedAnswers(deps, userOf(req).id);
    if (unreadable) deps.log.warn(`[autofill] ${caller(req)}: ${unreadable} saved answer(s) could not be read`);
    const limit = AUTOFILL_SAVED_ANSWER_LIMITS.perAccount;
    const list: AutofillSavedAnswerList = { items, total: items.length, limit };
    res.json(list);
  });

  router.put('/answers', allow('either', 'answers:write'), writeLimit, async (req, res) => {
    const body = parseInput(PutAutofillSavedAnswerBodySchema, req.body ?? {}, 'saved answer');
    const refusal = refusalOf(body);
    if (refusal) {
      deps.log.debug(`[autofill] ${caller(req)}: a saved answer was refused (sensitive, consent or attention check)`);
      throw validationFailed(refusal, { questionLabel: refusal });
    }
    const { answer, created, total } = await saveSavedAnswer(deps, userOf(req).id, body);
    deps.log.debug(
      `[autofill] ${caller(req)} ${created ? 'saved' : 'replaced'} saved answer ${answer.id} ` +
        `(${total} of ${AUTOFILL_SAVED_ANSWER_LIMITS.perAccount})`,
    );
    res.json(answer);
  });

  router.delete('/answers/:id', allow('either', 'answers:write'), writeLimit, async (req, res) => {
    const id = AutofillSavedAnswerIdSchema.safeParse(req.params.id);
    if (!id.success) throw notFound('That saved answer');
    await deleteSavedAnswer(deps, userOf(req).id, id.data);
    deps.log.debug(`[autofill] ${caller(req)} deleted saved answer ${id.data}`);
    res.status(204).end();
  });

  return router;
}
