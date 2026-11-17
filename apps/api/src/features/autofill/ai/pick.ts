import { z } from 'zod';
import {
  AUTOFILL_AI_LIMITS,
  AutofillPickItemSchema,
  AutofillPickResultSchema,
  type AutofillPick,
  type AutofillPickItem,
  type AutofillPickRequest,
  type AutofillPickResult,
} from '@tailorit/shared/autofill';
import { createResultCache, itemHash, recordCachedItems, type AiTaskContext } from '../../../ai/index';
import { autofillPickPrompt, type PickOutput } from '../../../ai/prompts/autofill/pick';
import type { AppDeps } from '../../../core/context';
import { isSensitivePickValue, namesSensitiveTopic } from './screen';
import { answerIsTainted, entriesByItem, readTaskInput } from './tasks';

// The tiebreak (POST /api/autofill/ai/pick, task kind autofill_pick): which of a field's options names what the person
// means? The extension asks only when its own matcher found two or more candidates it could not choose between. Claude
// answers an option's number or null; the handler keeps an answer only when it is one of the numbers the item sent.
// v30 ST3: the prompt is ai/prompts/autofill/pick.ts.

const LIMITS = AUTOFILL_AI_LIMITS.pick;

/** An item the screen held back: its key and option set only, never its label, options or value. */
const ScreenedPickSchema = AutofillPickItemSchema.pick({ key: true, optionSetHash: true }).extend({
  screened: z.literal('sensitive'),
});
type ScreenedPick = z.infer<typeof ScreenedPickSchema>;

/** What an autofill_pick task stores (its input, read again by the handler): the request's items in its order. */
const PickTaskInputSchema = z.object({
  items: z.array(z.union([ScreenedPickSchema, AutofillPickItemSchema])).min(1).max(LIMITS.items),
});
export type PickTaskInput = z.infer<typeof PickTaskInputSchema>;

/** v30 ST3: the autofill_pick task's `parse` (ai-tasks.ts): its stored input, or the task fails. */
export const readPickTaskInput = (raw: unknown): PickTaskInput => readTaskInput(PickTaskInputSchema, raw);

const isScreened = (item: PickTaskInput['items'][number]): item is ScreenedPick => 'screened' in item;

/**
 * An item looks sensitive when its question, the value it is about, or another name for that value does. Its question
 * is screened with the server's stricter terms too (screen.ts, namesSensitiveTopic), since a saved answer's value can
 * be the person's own answer to it ("Have you been charged with a crime?": "No"). A school's, a degree's or a field of
 * study's value is a name, screened as a sum of money only (screen.ts, isSensitivePickValue).
 */
function pickIsSensitive(item: AutofillPickItem): boolean {
  const valueIsSensitive = (text: string) => isSensitivePickValue(item.category, text);
  return namesSensitiveTopic(item.label) || valueIsSensitive(item.intendedValue) || item.aliases.some(valueIsSensitive);
}

/** Whether any of these texts is one of the person's own sensitive answers (yes or no only). */
export type AnswerScreen = (texts: readonly string[]) => boolean;

/**
 * The task's input: every item in the request's order, a sensitive one as its key and option set alone. An item is
 * sensitive by its own text (screen.ts) or, through `isAnswer` (profile/sensitive-screen.ts), when its intended value
 * or an alias is one of the person's sensitive answers.
 */
export function pickTaskInput(
  request: AutofillPickRequest,
  isAnswer: AnswerScreen = () => false,
): { input: PickTaskInput; screened: number } {
  let screened = 0;
  const items = request.items.map((item): PickTaskInput['items'][number] => {
    if (!pickIsSensitive(item) && !isAnswer([item.intendedValue, ...item.aliases])) return item;
    screened += 1;
    return { key: item.key, optionSetHash: item.optionSetHash, screened: 'sensitive' };
  });
  return { input: { items }, screened };
}

type Settled = Pick<AutofillPick, 'index' | 'reason'>;

/**
 * Claude's answer, checked against what each item sent: `matched` only for one of the item's own option indices,
 * `no_match` for null, `invalid` for anything else (another number, a string, a fraction). An answer that is not one
 * entry per item (an extra, missing or repeated item, an item number that is not a number) or that talks of being an
 * AI, in its JSON or anywhere in the reply texts it came from (`replies`), is not trusted at all: every item is
 * `invalid`.
 */
export function settlePicks(
  items: readonly AutofillPickItem[],
  answer: PickOutput,
  replies: readonly string[] = [],
): Settled[] {
  const invalid = (): Settled => ({ index: null, reason: 'invalid' });
  const byItem = answerIsTainted(answer, [], replies) ? null : entriesByItem(answer.picks, items.length);
  if (!byItem) return items.map(invalid);
  return items.map((item, at) => {
    const index = byItem.get(at + 1)!.index;
    if (index === null) return { index: null, reason: 'no_match' };
    if (typeof index !== 'number' || !item.options.some((option) => option.index === index)) return invalid();
    return { index, reason: 'matched' };
  });
}

/**
 * v1.3 C (decision 11): what a tiebreak's answer depends on, hashed for the result cache: the item's kind of value, the
 * person's value and its other names, the field's label and its options with their numbers. Not its key or option set
 * hash (the extension's own names for it), which the answer is given back under.
 */
export const pickCacheHash = (item: AutofillPickItem) =>
  itemHash({ category: item.category, intendedValue: item.intendedValue, aliases: item.aliases, label: item.label, options: item.options });

/** The answers a later request may take from the cache: a match, or Claude's null. */
const CACHED_PICKS: ReadonlySet<AutofillPick['reason']> = new Set(['matched', 'no_match']);

/**
 * The autofill_pick task: Claude is asked about the items the screen let through, if any. v1.3 C (decision 11): an
 * item answered within the last 30 days for this account (by the same model and prompt version) is answered from the
 * result cache, and only the rest are asked. A tiebreak carries the person's own value (their school, their degree),
 * so its answers are cached for their account alone, never shared.
 */
export async function runAutofillPick(deps: AppDeps, input: PickTaskInput, ctx: AiTaskContext): Promise<AutofillPickResult> {
  const started = performance.now();
  const asked = input.items.filter((item): item is AutofillPickItem => !isScreened(item));
  const cache = createResultCache(deps.db, deps.now);
  const model = deps.config.ai.features.autofill_pick.model;
  const cacheKey = ctx.userId === null ? null
    : { kind: 'autofill_pick' as const, model, version: autofillPickPrompt.version, scope: { userId: ctx.userId } };
  const hashes = asked.map(pickCacheHash);
  const cached = cacheKey ? await cache.getMany<Settled>(cacheKey, hashes) : new Map<string, Settled>();
  const missing = asked.filter((_, at) => !cached.has(hashes[at]!));
  // Every reply's whole text, for the check for talk of being an AI: held here only, never stored or logged.
  const replies: string[] = [];
  const onReply = (text: string) => void replies.push(text);
  const answered = missing.length
    ? settlePicks(missing, await ctx.runPrompt(autofillPickPrompt, { items: missing }, { onReply }), replies)
    : [];
  if (cacheKey) {
    const keep = missing.flatMap((item, at) =>
      CACHED_PICKS.has(answered[at]!.reason) ? [[pickCacheHash(item), answered[at]!] as const] : []);
    await cache.putMany(cacheKey, keep);
  }
  let fresh = 0;
  const settled = asked.map((_, at) => cached.get(hashes[at]!) ?? answered[fresh++]!);
  await recordCachedItems(deps.db, { atMs: deps.now().getTime(), kind: 'autofill_pick', model, items: asked.length - missing.length });
  let next = 0;
  const picks = input.items.map((item): AutofillPick => {
    const { key, optionSetHash } = item;
    if (isScreened(item)) return { key, optionSetHash, index: null, reason: 'sensitive' };
    const { index, reason } = settled[next++]!;
    return { key, optionSetHash, index, reason };
  });
  const count = (reason: AutofillPick['reason']) => picks.filter((pick) => pick.reason === reason).length;
  deps.log.debug(
    `[autofill] autofill_pick task ${ctx.taskId}: ${asked.length} asked, ${count('matched')} matched, ` +
      `${count('no_match')} no match, ${count('invalid')} invalid, ${count('sensitive')} screened, ` +
      `${asked.length - missing.length} from the cache, ${Math.round(performance.now() - started)} ms`,
  );
  return AutofillPickResultSchema.parse({ picks });
}
