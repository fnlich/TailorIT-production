import { createHash } from 'node:crypto';
import type { Response } from 'express';
import type { z } from 'zod';
import type { AiTaskView } from '@tailorit/shared';
import {
  AUTOFILL_AI_RESPOND_ASYNC,
  AUTOFILL_TASK_KINDS,
  AUTOFILL_TASK_RETENTION_MS,
  type AutofillTaskKind,
} from '@tailorit/shared/autofill';
import { requireAi, sendAccepted } from '../../../ai/index';
import type { AppDeps } from '../../../core/context';
import { AppError } from '../../../core/http/errors';
import { detectionViews } from './fold';

// What the autofill AI routes share (work package AF, Phase 4): the task's dedupe key, the bounded wait before the
// route answers, the check every answer passes before it is stored, and the deletion of finished tasks.

/** A stable JSON text: object keys sorted at every depth, undefined dropped. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : stableJson(item))).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
}

/**
 * `autofill_pick:<32 hex>`: the kind and a hash of the task's input. The queue scopes it by account and reattaches a
 * request to its task only while that task is queued or running; a finished task is read again by its id.
 */
export function dedupeKeyOf(kind: AutofillTaskKind, input: unknown): string {
  return `${kind}:${createHash('sha256').update(stableJson(input), 'utf8').digest('hex').slice(0, 32)}`;
}

/** v5: whether a request asks to be answered 202 at once (RFC 7240's `Prefer: respond-async`), to read the stream. */
export function prefersAsync(header: string | undefined): boolean {
  return (header ?? '').split(',').some((part) => part.split(';')[0]!.trim().toLowerCase() === AUTOFILL_AI_RESPOND_ASYNC);
}

/**
 * Queues the task (or reattaches to its twin) and waits up to AUTOFILL_AI_WAIT_MS (the config's `aiWaitMs`) for it:
 * 200 with the finished task, else 202 {taskId}, which the extension polls on GET /api/ai/tasks/:id. Refusals are the
 * queue's: 409 `ai_busy` at two tasks of the kind in flight, 503 `ai_unavailable` when Claude cannot run. The debug
 * line holds the task's id, counts and the time only. v5: a request that prefers it (prefersAsync) is answered 202 at
 * once, with `Preference-Applied`, and reads the task's stream instead.
 */
export async function answerTask(
  deps: AppDeps,
  res: Response,
  task: { kind: AutofillTaskKind; userId: string; input: unknown; items: number; screened: number },
): Promise<void> {
  const started = performance.now();
  const ai = requireAi(deps);
  const accepted = await ai.enqueue({
    kind: task.kind,
    userId: task.userId,
    input: task.input,
    dedupeKey: dedupeKeyOf(task.kind, task.input),
  });
  let finished: AiTaskView | null = null;
  const respondAsync = prefersAsync(res.req.get('prefer'));
  if (respondAsync) {
    res.setHeader('Preference-Applied', AUTOFILL_AI_RESPOND_ASYNC);
  } else {
    try {
      finished = await ai.waitFor(accepted.taskId, deps.config.autofill.aiWaitMs);
    } catch {
      finished = null; // still queued or running: the extension polls it
    }
  }
  deps.log.debug(
    `[autofill] ${task.kind} for account ${task.userId}: task ${accepted.taskId} ` +
      `${accepted.deduped ? 'reattached' : 'queued'}, ${task.items} item(s), ${task.screened} screened, ` +
      `${finished ? `answered ${finished.status}` : 'answered 202'} in ${Math.round(performance.now() - started)} ms`,
  );
  if (finished) res.status(200).json(finished);
  else sendAccepted(res, accepted);
}

/** What a model calls itself: AI (the loose view reads "A.I." as "a i"), an LLM, a chatbot, a language model. */
const AI_NAME = String.raw`(?:ai|a\s?i|artificial\s+intelligence|llm|chatbot|(?:large\s+)?language\s+model)`;

/**
 * Talk of being an AI, in any answer or reply: the answer is not trusted. Matched over every detection view (fold.ts),
 * so a typographic apostrophe ("I’m"), dotted letters ("A.I.") and look-alike letters read as plain text.
 */
const AI_REFERENCE = new RegExp(
  [
    // "As an AI", "as an A.I.", "as an AI assistant", "as a (large) language model", "as an LLM".
    String.raw`\bas\s+an?\s+(?:ai\s+(?:assistant|model|language\s+model)|${AI_NAME})\b`,
    String.raw`\blanguage\s+models?\b`,
    // "I am an AI", "I'm only an AI", "I am Claude".
    String.raw`\bi\s*(?:am|'?m)\s+(?:(?:just|only|merely|simply)\s+)?(?:an?\s+)?(?:${AI_NAME}|claude)\b`,
    // "an AI assistant", "an AI model".
    String.raw`\b(?:ai|a\s?i)\s+(?:assistant|model|chatbot)s?\b`,
  ].join('|'),
  'i',
);

/** Whether a text talks of being an AI, in any of its detection views. */
export const talksOfBeingAnAi = (text: string) => detectionViews(text).some((view) => AI_REFERENCE.test(view));

/** What a model calls itself when it speaks as one: AI, an LLM, a chatbot, a language model, an AI assistant. */
const SELF_NAME = String.raw`(?:ai\s+(?:assistant|model|language\s+model|chatbot|system)|(?:virtual|digital)\s+assistant|ai|a\s?i|artificial\s+intelligence|llm|chatbot|bot|(?:large\s+)?language\s+model)`;
/** What follows that name when a model speaks of itself: the end of the clause, "I", "that" or "who", or how it was
 *  made. */
const SELF_END = String.raw`(?=\s*(?:[,.;:!?)\]"'\u201D]|$)|\s+(?:i|i'm|i've|i'd|i'll|myself|that|who|which|without|developed|created|trained|built|made|designed|programmed)\b|\s+and\s+(?:i|cannot|can't|don't|do\s+not)\b)`;

/**
 * A draft speaking as an AI (the Phase 6 review, T6-3): "As an AI, ...", "as an AI language model", "as a (large)
 * language model", "I am an AI", "I'm just an AI", "I am Claude", "I am an assistant". A draft may well be about AI:
 * the person's AI work ("As an AI engineer", "I'm an AI researcher", "I fine-tuned large language models") or the
 * company's AI product ("your AI assistant"), so only the self-reference counts, the name ending its clause ("As an
 * assistant, I scheduled travel" is a person's job). Pick and classify answers keep the strict check
 * (talksOfBeingAnAi): any talk of AI there is no answer of theirs.
 */
const SELF_REFERENCE = new RegExp(
  [
    String.raw`\bas\s+an?\s+${SELF_NAME}${SELF_END}`,
    String.raw`\bi\s*(?:am|'?m)\s+(?:(?:just|only|merely|simply|but)\s+)?(?:an?\s+)?(?:${SELF_NAME}|assistant|claude)${SELF_END}`,
  ].join('|'),
  'i',
);

/** Whether a draft, or a reply it came from, speaks as an AI, in any of its detection views. */
export const speaksAsAnAi = (text: string) => detectionViews(text).some((view) => SELF_REFERENCE.test(view));

/** Every string in a JSON value, its object keys included. */
export function stringsOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsOf(item, out);
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      stringsOf(item, out);
    }
  }
  return out;
}

/**
 * True when any of `texts` holds one of the page's canaries: case-insensitive, whitespace folded, and read through
 * the detection views (fold.ts), so an invisible character or a look-alike letter cannot hide one. Canaries of fewer
 * than two characters are ignored.
 */
export function holdsCanary(texts: readonly string[], canaries: readonly string[]): boolean {
  const folded = canaries.map((canary) => detectionViews(canary)[0] ?? '').filter((canary) => canary.length >= 2);
  if (folded.length === 0) return false;
  return texts.some((text) => detectionViews(text).some((view) => folded.some((canary) => view.includes(canary))));
}

/**
 * True when an answer, anywhere in it (keys included), or any reply text it came from (`replies`: each CLI reply as
 * runPrompt's onReply heard it, prose outside the sentinels included), talks of being an AI or holds one of the
 * page's canaries (case-insensitive, whitespace folded): every item of such an answer is `invalid`. Pick and classify
 * requests carry no canaries; the draft and answer handlers (draft.ts, answer.ts) tell the two apart with holdsCanary
 * and speaksAsAnAi.
 */
export function answerIsTainted(
  answer: unknown,
  canaries: readonly string[] = [],
  replies: readonly string[] = [],
): boolean {
  const texts = [...stringsOf(answer), ...replies];
  return texts.some(talksOfBeingAnAi) || holdsCanary(texts, canaries);
}

/**
 * The item numbers an answer gives, checked against the `count` items it was asked: each of 1..count exactly once,
 * as a number. Anything else (an extra item, a missing one, one twice, a number sent as a string) means the answer as a
 * whole is not trusted, and every item is `invalid`. Returns the answer's entries by item number, or null.
 */
export function entriesByItem<T extends { item?: unknown }>(
  entries: readonly T[],
  count: number,
): Map<number, T> | null {
  if (entries.length !== count) return null;
  const byItem = new Map<number, T>();
  for (const entry of entries) {
    const item = entry.item;
    const known = typeof item === 'number' && Number.isInteger(item) && item >= 1 && item <= count;
    if (!known || byItem.has(item)) return null;
    byItem.set(item, entry);
  }
  return byItem;
}

// v30 ST3
/** A task whose stored input does not read, or that has no account to answer for: it fails as ai_failed. */
export const unreadableTask = () => new AppError('ai_failed', 'This autofill request could not be read. Please try again.');

/**
 * An autofill task's stored input, read with its schema (each task's `parse`, ai-tasks.ts): one that does not read
 * fails the task (unreadableTask), as each handler did before v3.0.
 */
export function readTaskInput<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw unreadableTask();
  return parsed.data;
}
// end v30 ST3

/**
 * Deletes the autofill tasks that finished more than AUTOFILL_TASK_RETENTION_MS ago (their input holds page text):
 * their ids then answer 404, and the extension asks again. Returns how many went.
 */
export async function pruneAutofillTasks(deps: Pick<AppDeps, 'db' | 'now'>): Promise<number> {
  const before = new Date(deps.now().getTime() - AUTOFILL_TASK_RETENTION_MS).toISOString();
  const { changes } = await deps.db.run(
    `DELETE FROM ai_tasks WHERE kind IN (${deps.db.dialect.list(AUTOFILL_TASK_KINDS.length)})
       AND status IN ('succeeded', 'failed', 'cancelled') AND finished_at < ?`,
    [...AUTOFILL_TASK_KINDS, before],
  );
  return changes;
}
