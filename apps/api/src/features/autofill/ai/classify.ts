import { z } from 'zod';
import {
  ATS_KINDS,
  AUTOFILL_AI_LIMITS,
  AUTOFILL_FIELD_CATEGORIES,
  AutofillClassifyItemSchema,
  AutofillClassifyResultSchema,
  type AtsKind,
  type AutofillClassification,
  type AutofillClassifyItem,
  type AutofillClassifyRequest,
  type AutofillClassifyResult,
  type AutofillFieldCategory,
} from '@tailorit/shared/autofill';
import { createResultCache, itemHash, recordCachedItems, type AiTaskContext } from '../../../ai/index';
import { autofillClassifyPrompt, type ClassifyOutput } from '../../../ai/prompts/autofill/classify';
import type { AppDeps } from '../../../core/context';
import { isSensitiveQuestion } from './screen';
import { answerIsTainted, entriesByItem, readTaskInput } from './tasks';

// What an unusual question asks (POST /api/autofill/ai/classify, task kind autofill_classify). The extension asks only
// about fields none of its own rules classified. Claude answers a category from the closed list or null; the handler
// keeps an answer only when it is in that list. The last group of categories never leads to a fill, so a
// classification can only make the extension more careful. v30 ST3: the prompt is ai/prompts/autofill/classify.ts.

const LIMITS = AUTOFILL_AI_LIMITS.classify;

/** An item the screen held back: its key alone. */
const ScreenedClassifySchema = AutofillClassifyItemSchema.pick({ key: true }).extend({
  screened: z.literal('sensitive'),
});
type ScreenedClassify = z.infer<typeof ScreenedClassifySchema>;

/** What an autofill_classify task stores: the form's ATS and the request's items in its order. */
const ClassifyTaskInputSchema = z.object({
  platform: z.enum(ATS_KINDS),
  items: z.array(z.union([ScreenedClassifySchema, AutofillClassifyItemSchema])).min(1).max(LIMITS.items),
});
export type ClassifyTaskInput = z.infer<typeof ClassifyTaskInputSchema>;

/** v30 ST3: the autofill_classify task's `parse` (ai-tasks.ts): its stored input, or the task fails. */
export const readClassifyTaskInput = (raw: unknown): ClassifyTaskInput => readTaskInput(ClassifyTaskInputSchema, raw);

const isScreened = (item: ClassifyTaskInput['items'][number]): item is ScreenedClassify => 'screened' in item;

/** A question looks sensitive when its label, its description or the heading of its part of the form does. */
const classifyIsSensitive = (item: AutofillClassifyItem) =>
  isSensitiveQuestion(item.label) || isSensitiveQuestion(item.hint) || isSensitiveQuestion(item.section);

/** The task's input: every item in the request's order, a sensitive one as its key alone. */
export function classifyTaskInput(request: AutofillClassifyRequest): { input: ClassifyTaskInput; screened: number } {
  let screened = 0;
  const items = request.items.map((item): ClassifyTaskInput['items'][number] => {
    if (!classifyIsSensitive(item)) return item;
    screened += 1;
    return { key: item.key, screened: 'sensitive' };
  });
  return { input: { platform: request.platform, items }, screened };
}

const CATEGORIES: ReadonlySet<string> = new Set(AUTOFILL_FIELD_CATEGORIES);

type Settled = Pick<AutofillClassification, 'category' | 'reason'>;

/**
 * Claude's answer, checked: `classified` only for a category in the closed list, `unknown` for null, `invalid` for
 * anything else. An answer that is not one entry per item, or that talks of being an AI (in its JSON or anywhere in
 * the reply texts it came from, `replies`), is not trusted at all.
 */
export function settleClassifications(
  count: number,
  answer: ClassifyOutput,
  replies: readonly string[] = [],
): Settled[] {
  const invalid = (): Settled => ({ category: null, reason: 'invalid' });
  const byItem = answerIsTainted(answer, [], replies) ? null : entriesByItem(answer.items, count);
  if (!byItem) return Array.from({ length: count }, invalid);
  return Array.from({ length: count }, (_, at): Settled => {
    const category = byItem.get(at + 1)!.category;
    if (category === null) return { category: null, reason: 'unknown' };
    if (typeof category !== 'string' || !CATEGORIES.has(category)) return invalid();
    return { category: category as AutofillFieldCategory, reason: 'classified' };
  });
}

/**
 * v1.3 C (decision 11): what a classification depends on, hashed for the result cache: the form's ATS and the field's
 * type, label, description, section and options, all page text. Not its key (the extension's own name for it).
 */
export const classifyCacheHash = (platform: AtsKind, item: AutofillClassifyItem) =>
  itemHash({ platform, kind: item.kind, label: item.label, hint: item.hint, section: item.section, options: item.options });

/** The answers a later request may take from the cache: a category from the list, or Claude's null. */
const CACHED_CLASSIFICATIONS: ReadonlySet<AutofillClassification['reason']> = new Set(['classified', 'unknown']);

/**
 * The autofill_classify task: Claude is asked about the items the screen let through, if any. v1.3 C (decision 11): an
 * item classified within the last 30 days (by the same model and prompt version) is answered from the result cache,
 * and only the rest are asked. A classification is read off the form's own text alone (no fact or value of the
 * person's is in the prompt), so the cache is shared by every account: the same question on the same ATS is asked once.
 */
export async function runAutofillClassify(
  deps: AppDeps,
  input: ClassifyTaskInput,
  ctx: AiTaskContext,
): Promise<AutofillClassifyResult> {
  const started = performance.now();
  const { platform } = input;
  const asked = input.items.filter((item): item is AutofillClassifyItem => !isScreened(item));
  const cache = createResultCache(deps.db, deps.now);
  const model = deps.config.ai.features.autofill_classify.model;
  const cacheKey = { kind: 'autofill_classify' as const, model, version: autofillClassifyPrompt.version, scope: { shared: true as const } };
  const hashes = asked.map((item) => classifyCacheHash(platform, item));
  const cached = await cache.getMany<Settled>(cacheKey, hashes);
  const missing = asked.filter((_, at) => !cached.has(hashes[at]!));
  // Every reply's whole text, for the check for talk of being an AI: held here only, never stored or logged.
  const replies: string[] = [];
  const onReply = (text: string) => void replies.push(text);
  const answered = missing.length
    ? settleClassifications(
        missing.length,
        await ctx.runPrompt(autofillClassifyPrompt, { platform, items: missing }, { onReply }),
        replies,
      )
    : [];
  await cache.putMany(
    cacheKey,
    missing.flatMap((item, at) =>
      CACHED_CLASSIFICATIONS.has(answered[at]!.reason) ? [[classifyCacheHash(platform, item), answered[at]!] as const] : []),
  );
  let fresh = 0;
  const settled = asked.map((_, at) => cached.get(hashes[at]!) ?? answered[fresh++]!);
  await recordCachedItems(deps.db, { atMs: deps.now().getTime(), kind: 'autofill_classify', model, items: asked.length - missing.length });
  let next = 0;
  const items = input.items.map((item): AutofillClassification => {
    if (isScreened(item)) return { key: item.key, category: null, reason: 'sensitive' };
    const { category, reason } = settled[next++]!;
    return { key: item.key, category, reason };
  });
  const count = (reason: AutofillClassification['reason']) => items.filter((item) => item.reason === reason).length;
  deps.log.debug(
    `[autofill] autofill_classify task ${ctx.taskId}: ${asked.length} asked, ${count('classified')} classified, ` +
      `${count('unknown')} unknown, ${count('invalid')} invalid, ${count('sensitive')} screened, ` +
      `${asked.length - missing.length} from the cache, ${Math.round(performance.now() - started)} ms`,
  );
  return AutofillClassifyResultSchema.parse({ items });
}
