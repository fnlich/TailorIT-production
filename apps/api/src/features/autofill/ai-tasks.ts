import { autofillAnswerPrompt } from '../../ai/prompts/autofill/answer';
import { autofillClassifyPrompt } from '../../ai/prompts/autofill/classify';
import { autofillDraftPrompt } from '../../ai/prompts/autofill/draft';
import { factsAndJobPrompt } from '../../ai/prompts/autofill/facts-and-job';
import { autofillPickPrompt } from '../../ai/prompts/autofill/pick';
import { untrustedRulePrompt } from '../../ai/prompts/autofill/untrusted';
import { defineAiTask } from '../../ai/task';
import { readAnswerTaskInput, runAutofillAnswer } from './ai/answer';
import { readClassifyTaskInput, runAutofillClassify } from './ai/classify';
import { readDraftTaskInput, runAutofillDraft } from './ai/draft';
import { readPickTaskInput, runAutofillPick } from './ai/pick';
import { readDraftFacts } from './draft-facts';

// v30 ST3: the extension's four AI task kinds (ai/task.ts defineAiTask), listed on autofillFeature.aiTasks, which
// registers each on the AI queue (they were registerHandler calls in index.ts). Each is queued by its route
// (ai/router.ts, ai/tasks.ts answerTask) with the account that asked, which pays (charge 'person'). A stored input
// that does not read fails the task as ai_failed (ai/tasks.ts readTaskInput). A draft's and an answer's facts are read
// here, outside ai/, whose modules never read the profile (draft-facts.ts).
// v33 SHARE-3 (PLAN F9 "Who pays"): 'person' is the person who pays, not always the profile's owner: the route names it
// (ai/payer.ts autofillPayerOf: the grantee who prepared the job A's extension is running, else the owner), and the
// task still reads the owner's facts (ctx.userId).

export const autofillPickTask = defineAiTask({
  kind: 'autofill_pick',
  prompts: [autofillPickPrompt, untrustedRulePrompt],
  parse: readPickTaskInput,
  charge: 'person',
  defaultModel: 'haiku',
  run: (deps, input, ctx) => runAutofillPick(deps, input, ctx),
});

export const autofillClassifyTask = defineAiTask({
  kind: 'autofill_classify',
  prompts: [autofillClassifyPrompt, untrustedRulePrompt],
  parse: readClassifyTaskInput,
  charge: 'person',
  defaultModel: 'haiku',
  run: (deps, input, ctx) => runAutofillClassify(deps, input, ctx),
});

export const autofillDraftTask = defineAiTask({
  kind: 'autofill_draft',
  prompts: [autofillDraftPrompt, factsAndJobPrompt, untrustedRulePrompt],
  parse: readDraftTaskInput,
  charge: 'person',
  defaultModel: 'cli',
  run: (deps, input, ctx) =>
    runAutofillDraft(deps, input, ctx, (userId, resumeId) => readDraftFacts(deps, userId, resumeId)),
});

export const autofillAnswerTask = defineAiTask({
  kind: 'autofill_answer',
  prompts: [autofillAnswerPrompt, factsAndJobPrompt, untrustedRulePrompt],
  parse: readAnswerTaskInput,
  charge: 'person',
  defaultModel: 'cli',
  run: (deps, input, ctx) =>
    runAutofillAnswer(deps, input, ctx, (userId, resumeId) => readDraftFacts(deps, userId, resumeId)),
});

/** The autofill feature's AI task kinds (Feature.aiTasks). */
export const AUTOFILL_AI_TASKS = [autofillPickTask, autofillClassifyTask, autofillDraftTask, autofillAnswerTask] as const;
