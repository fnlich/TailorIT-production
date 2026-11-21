import type { z } from 'zod';
import { AI_TASK_KINDS, type AiTaskKind } from '@tailorit/shared';
import { AI_KIND_DEFAULT_MODELS, HAIKU_MODEL } from '../config/models';
import { isPersonPayer, type Payer } from '../core/accounts/payer'; // v33 SHARE-3
import type { AppDeps } from '../core/context';
import { AI_DETAILS, AiError } from './errors';
import type { CatalogPrompt } from './prompts/types';
import type { AiPriority } from './semaphore';
import type { AiService, AiTaskContext, AiTaskHandler, EnqueueOptions } from './queue';

// v30 ST0: the AI task base (PLAN §6, "AI task kinds"). One definition per kind says, in one place, what the kind
// runs (its catalogue prompts), how its stored input is read, whose budget pays, which model it runs on by default
// and the work itself. A feature lists its kinds on `Feature.aiTasks`; setupServices registers each on the AI queue
// right after the feature's own `services` hook (core/feature-hooks.ts), so no feature calls registerHandler by hand
// (apps/api/test/structure-bases.test.ts checks it).
//
//   export const jobSearchTask = defineAiTask({
//     kind: 'job_search',
//     prompts: [jobSearchPrompt],
//     parse: JobSearchInputSchema,          // or (raw) => ... for a hand-written reader
//     charge: 'person',
//     defaultModel: 'haiku',
//     run: (deps, input, ctx) => searchWithAi(deps, input, ctx),
//   });
//   export const jobsFeature: Feature = { name: 'jobs', aiTasks: [jobSearchTask], ... };
//   ...
//   const { taskId } = jobSearchTask.enqueue(deps, { userId, input: { text } });

/**
 * Whose daily AI budget and extra credit the task's prompt runs are charged to (docs/design/v2.0/03-ai-usage.md,
 * "Attribution"):
 * - `person`: the account that queued it (enqueue's `userId`), the queue's default;
 * - `server`: nobody, a server cost (system work such as the job analysis backlog); enqueue passes `chargeTo: null`;
 * - `caller`: the caller says whom on each enqueue (`chargeTo`): the job analysis is a server cost from the backlog
 *   and the person's when Prepare forces it.
 * v33 SHARE-3 (PLAN F9 "Who pays"): `person` is the person who started the work, not always the profile's owner: B
 * pays for what B starts on A's profile (`userId` A, `chargeTo` B's Payer: payerOf(req), payerOfRow, payerOfGrant).
 * v33 INT-1: `chargeTo` is required on every kind (the owner's own work names the owner: payerOf(req) or a listed
 * ownPayer); a `server` kind takes only a server cost (serverCost).
 */
export type AiCharge = 'person' | 'server' | 'caller';

/**
 * The model a kind runs on unless its `AI_MODEL_<KIND>` says otherwise: `haiku` (Haiku 5.5, for closed answers code
 * checks) or `cli` (AI_CLI_MODEL, Sonnet 5.5 by default). `config/models.ts`'s AI_KIND_DEFAULT_MODELS stays the one
 * source the configuration reads; defineAiTask refuses a definition that disagrees with it.
 */
export type AiDefaultModel = 'haiku' | 'cli';

export interface AiTaskSpec<I, O> {
  kind: AiTaskKind;
  /** The catalogue prompts the task runs (ai/prompts). Empty only for a kind that runs none of its own. */
  prompts: readonly CatalogPrompt[];
  /**
   * Reads the stored input (JSON, the same after a restart) into the handler's input: a zod schema or a function. A
   * failure fails the task (an AppError as it is; anything else as `ai_failed`): inputs are TailorIT's own.
   */
  parse: z.ZodType<I> | ((raw: unknown) => I);
  charge: AiCharge;
  defaultModel: AiDefaultModel;
  /** The work: returns the task's result (any JSON value). Throw AppError for failures a person can act on. */
  run(deps: AppDeps, input: I, ctx: AiTaskContext): Promise<O>;
}

/** What enqueue takes: the queue's options without the kind (the definition's), the input typed. */
export interface AiTaskEnqueue<I> {
  userId: string | null;
  input: I;
  priority?: AiPriority;
  dedupeKey?: string;
  /**
   * Whose budget pays (v33 INT-1: required): a `person` kind a Payer of a person (B on A's profile; the owner's own:
   * payerOf(req) or a listed ownPayer), a `server` kind only a server cost (serverCost), a `caller` kind either.
   */
  chargeTo: Payer;
}

export interface AiTask<I, O> {
  readonly kind: AiTaskKind;
  readonly prompts: readonly CatalogPrompt[];
  readonly charge: AiCharge;
  readonly defaultModel: AiDefaultModel;
  /** The queue's handler for these deps (parse, then run). Tests run it outside the queue. */
  handler(deps: AppDeps): AiTaskHandler;
  /**
   * Registers the handler on deps.services.ai; nothing when this server has no AI queue. setupServices calls it for
   * every `Feature.aiTasks` entry: a feature never calls it itself.
   */
  register(deps: AppDeps): void;
  /** The queue options for one task: the kind, and `chargeTo` as `charge` says. Throws for a misused `chargeTo`. */
  enqueueOptions(options: AiTaskEnqueue<I>): EnqueueOptions;
  /**
   * Queues one task (the AI service's enqueue, with its refusals: ai_unavailable, ai_usage_exhausted, ai_busy; and
   * ai_unavailable, as requireAi, on a server without the AI queue). v3.0 D2: async.
   */
  enqueue(deps: Pick<AppDeps, 'services'>, options: AiTaskEnqueue<I>): Promise<{ taskId: string; deduped: boolean }>;
  /** The result's type, for `typeof task.result` (never set). */
  readonly result?: O;
}

/** As requireAi (ai/index.ts): a server built without the AI queue answers MSG_AI_UNAVAILABLE. */
function queueOf(deps: Pick<AppDeps, 'services'>): AiService {
  const ai = deps.services.ai;
  if (!ai) throw new AiError('unavailable', { text: deps.services.constants?.message('MSG_AI_UNAVAILABLE'), message: AI_DETAILS.notSetUp });
  return ai;
}

/** The default model a kind has today (config/models.ts). */
export function defaultModelOf(kind: AiTaskKind): AiDefaultModel {
  return AI_KIND_DEFAULT_MODELS[kind] === HAIKU_MODEL ? 'haiku' : 'cli';
}

const isSchema = <I>(parse: AiTaskSpec<I, unknown>['parse']): parse is z.ZodType<I> =>
  typeof (parse as z.ZodType<I>).parse === 'function' && typeof (parse as z.ZodType<I>).safeParse === 'function';

/** Defines one AI task kind (see the comment at the top). */
export function defineAiTask<I, O>(spec: AiTaskSpec<I, O>): AiTask<I, O> {
  if (!(AI_TASK_KINDS as readonly string[]).includes(spec.kind)) throw new Error(`Unknown AI task kind "${spec.kind}".`);
  const configured = defaultModelOf(spec.kind);
  if (spec.defaultModel !== configured) {
    throw new Error(
      `The AI task "${spec.kind}" says its default model is ${spec.defaultModel}, but config/models.ts runs it on ` +
        `${configured}. Change AI_KIND_DEFAULT_MODELS and the definition together.`,
    );
  }
  for (const prompt of spec.prompts) {
    if (prompt.form === 'model' && prompt.kind !== spec.kind) {
      // A prompt may run under another kind's model (runPrompt's `kind` option), but it is listed by the kind it names.
      throw new Error(`The AI task "${spec.kind}" lists the prompt ${prompt.id}, which names the kind "${prompt.kind}".`);
    }
  }
  const read = (raw: unknown): I => (isSchema(spec.parse) ? spec.parse.parse(raw) : spec.parse(raw));
  const task: AiTask<I, O> = {
    kind: spec.kind,
    prompts: spec.prompts,
    charge: spec.charge,
    defaultModel: spec.defaultModel,
    handler: (deps) => async (raw, ctx) => spec.run(deps, read(raw), ctx),
    register(deps) {
      deps.services.ai?.registerHandler(spec.kind, task.handler(deps));
    },
    enqueueOptions({ userId, input, priority, dedupeKey, chargeTo }) {
      // v33 INT-1: the compiler refuses a call without a Payer; a caller the compiler did not see is refused here.
      if (typeof chargeTo !== 'object' || chargeTo === null) throw new Error(`The AI task "${spec.kind}" names who pays (chargeTo: a Payer).`);
      // v33 SHARE-3: a person kind takes the person who pays as a Payer (B on A's profile; never a bare id: a Payer comes
      // from payerOf, payerOfRow, payerOfGrant or a listed ownPayer); a server kind only a server cost; a caller kind either.
      if (spec.charge !== 'caller' && (spec.charge === 'person' ? !isPersonPayer(chargeTo) : isPersonPayer(chargeTo))) {
        throw new Error(`The AI task "${spec.kind}" is charged to the ${spec.charge}: that chargeTo is not taken.`);
      }
      return {
        kind: spec.kind,
        userId,
        input,
        ...(priority ? { priority } : {}),
        ...(dedupeKey ? { dedupeKey } : {}),
        chargeTo,
      };
    },
    async enqueue(deps, options) {
      return queueOf(deps).enqueue(task.enqueueOptions(options));
    },
  };
  return Object.freeze(task);
}
