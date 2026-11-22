import { CONSTANTS, type AiBilling } from '@tailorit/shared'; // v34 AIKEY: AiBilling
import { priceOf, usageOfResult, type AiUsage, type UsageReadOptions } from '../usage';

// Reduces the CLI's stream-json events into one turn's outcome. Unknown event types are ignored by construction: new
// CLI versions add events (active_goal, autocompact_state, ...) and a parser that rejects them breaks on upgrade.

export interface RateLimitInfo {
  status?: string;
  /** Epoch seconds. */
  resetsAt?: number;
  /** v2.0: the window the reading is of ('five_hour', 'seven_day', 'seven_day_opus', ...). */
  rateLimitType?: string;
  /** v2.0: how much of the window is used, a fraction (a value above 1 is a percent); not sent on every event. */
  utilization?: number;
  isUsingOverage?: boolean;
}

export interface TurnState {
  /** Text from `text_delta` events; the fallback when no successful `result` arrives. */
  deltaText: string;
  /** Text blocks of the `assistant` message; the fallback when no deltas arrived either. */
  assistantText: string;
  /** `result.result`: the authoritative answer, when the turn did not fail. */
  resultText: string | null;
  sawResult: boolean;
  isError: boolean;
  apiErrorStatus: number | null;
  stopReason: string | null;
  /** Error marks from `assistant.error` and `result.errors`. */
  errors: string[];
  /** The model that answered (from `assistant`), else the one `system/init` names. */
  model: string | null;
  /** From `system/init`. Anything but "none" means an API key is paying for this call. */
  apiKeySource: string | null;
  rateLimit: RateLimitInfo | null;
  /** v1.3 C: what the turn used, from the `result` event (usage, modelUsage, total_cost_usd); null when unsaid. */
  usage: AiUsage | null;
  /**
   * v20 FIX-A (SEC-1): what the stream said the turn used so far, for a turn that ends with no `result` event (cancelled,
   * killed, timed out): each message's `message_start` usage (input and cache tokens) and its output (the largest
   * `output_tokens` it reported, else the generated characters / 4). See streamedUsage.
   */
  streamed: StreamedUsage;
  retries: number;
  events: number;
  /**
   * v34 AIKEY (review fix L1): the CLI's system/init arrived, or an event other than `system` did (the CLI is past its
   * init, whether it sent one or not). Either way an apiKeySource still unnamed will never be named.
   */
  pastInit: boolean;
}

/** v20 FIX-A (SEC-1): the usage a turn's stream reported before its end. */
export interface StreamedUsage {
  /** `message_start` events seen: each one is a request the API bills from its start. */
  messages: number;
  /** Whether any message_start carried its usage (else the prompt's length stands in for the input). */
  inputReported: boolean;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** The output tokens of the messages before the current one. */
  outputTokens: number;
  /** The current message's largest reported `output_tokens`. */
  messageOutputTokens: number;
  /** The current message's generated characters (text, thinking and tool input deltas). */
  messageChars: number;
}

export function createTurnState(): TurnState {
  return {
    deltaText: '',
    assistantText: '',
    resultText: null,
    sawResult: false,
    isError: false,
    apiErrorStatus: null,
    stopReason: null,
    errors: [],
    model: null,
    apiKeySource: null,
    rateLimit: null,
    usage: null,
    streamed: {
      messages: 0,
      inputReported: false,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      messageOutputTokens: 0,
      messageChars: 0,
    },
    retries: 0,
    events: 0,
    pastInit: false, // v34 AIKEY
  };
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
/** A token count as the stream reports it: a whole number of 0 or more, else 0. */
const tokens = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0);
/** About one token per 4 characters: the output of a message whose stream named no count. */
const CHARS_PER_TOKEN = 4;

/** The current message's output: its largest reported count, or its characters / 4 when that is more. */
const messageOutput = (streamed: StreamedUsage) =>
  Math.max(streamed.messageOutputTokens, Math.ceil(streamed.messageChars / CHARS_PER_TOKEN));

/** v20 FIX-A (SEC-1): one stream_event's part in the turn's streamed usage. */
function noteStreamed(streamed: StreamedUsage, inner: Json): void {
  switch (inner.type) {
    case 'message_start': {
      // A new request: the previous message's output is final.
      if (streamed.messages > 0) streamed.outputTokens += messageOutput(streamed);
      streamed.messages += 1;
      streamed.messageOutputTokens = 0;
      streamed.messageChars = 0;
      const usage = isObject(inner.message) && isObject(inner.message.usage) ? inner.message.usage : null;
      if (usage) {
        streamed.inputReported = true;
        streamed.inputTokens += tokens(usage.input_tokens);
        streamed.cacheReadTokens += tokens(usage.cache_read_input_tokens);
        streamed.cacheWriteTokens += tokens(usage.cache_creation_input_tokens);
        streamed.messageOutputTokens = Math.max(streamed.messageOutputTokens, tokens(usage.output_tokens));
      }
      return;
    }
    case 'message_delta': {
      const usage = isObject(inner.usage) ? inner.usage : null;
      if (usage) streamed.messageOutputTokens = Math.max(streamed.messageOutputTokens, tokens(usage.output_tokens));
      return;
    }
    case 'content_block_delta': {
      const delta = isObject(inner.delta) ? inner.delta : null;
      const generated = delta?.text ?? delta?.thinking ?? delta?.partial_json;
      if (typeof generated === 'string') streamed.messageChars += generated.length;
      return;
    }
    default:
      return;
  }
}

/**
 * Applies one NDJSON line. Lines that are not JSON objects (banners, warnings) are skipped, never fatal. v2.0: `read`
 * gives the price table a result's cost is computed with when the CLI reports none (the model is the turn's own).
 */
export function reduceEvent(state: TurnState, line: string, read: Pick<UsageReadOptions, 'prices'> = {}): void {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (!isObject(event)) return;
  state.events += 1;
  // v34 AIKEY (review fix L1): an init names its source in the same event, so after it (or after any later event) a
  // source still unnamed will not come.
  if (event.type !== 'system' || event.subtype === 'init') state.pastInit = true;

  switch (event.type) {
    case 'system':
      if (event.subtype === 'init') {
        state.model = text(event.model) ?? state.model;
        if (typeof event.apiKeySource === 'string') state.apiKeySource = event.apiKeySource;
      } else if (event.subtype === 'api_retry') {
        // A retry restarts the message: what streamed before it is not the start of the answer any more.
        state.deltaText = '';
        state.retries += 1;
      }
      return;
    case 'stream_event': {
      const delta = isObject(event.event) && isObject(event.event.delta) ? event.event.delta : null;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') state.deltaText += delta.text;
      if (isObject(event.event)) noteStreamed(state.streamed, event.event);
      return;
    }
    case 'assistant': {
      const message = isObject(event.message) ? event.message : null;
      const model = text(message?.model);
      if (model && model !== '<synthetic>') state.model = model;
      state.stopReason = text(message?.stop_reason) ?? state.stopReason;
      if (Array.isArray(message?.content)) {
        const parts = message.content.filter(isObject).filter((block) => block.type === 'text');
        const joined = parts.map((block) => (typeof block.text === 'string' ? block.text : '')).join('');
        if (joined) state.assistantText = joined;
      }
      const mark = text(event.error);
      if (mark) state.errors.push(mark);
      return;
    }
    case 'rate_limit_event':
      if (isObject(event.rate_limit_info)) state.rateLimit = event.rate_limit_info as RateLimitInfo;
      return;
    case 'result':
      state.sawResult = true;
      state.isError = event.is_error === true;
      state.apiErrorStatus = num(event.api_error_status);
      state.stopReason = state.stopReason ?? text(event.stop_reason);
      state.resultText = typeof event.result === 'string' ? event.result : null;
      state.usage = usageOfResult(event, { prices: read.prices, model: state.model });
      if (Array.isArray(event.errors)) {
        for (const entry of event.errors) if (text(entry)) state.errors.push(entry as string);
      }
      return;
    default:
      return;
  }
}

/**
 * The answer: `result.result` when the turn did not fail (on a failure it holds the CLI's explanation, which must not
 * reach a JSON parser), else the streamed deltas, else the assistant message's text.
 */
export function turnText(state: TurnState): string {
  if (state.sawResult && !state.isError && state.resultText?.trim()) return state.resultText;
  return state.deltaText || state.assistantText;
}

/** True when `system/init` named any credential source other than "none" (i.e. not the subscription). */
export function billedToKey(state: TurnState): boolean {
  return state.apiKeySource !== null && state.apiKeySource !== 'none';
}

// v34 AIKEY
/**
 * True when `system/init` said "none": the CLI's own sign-in, a Claude subscription, pays for the call. A turn whose
 * init named no source at all is neither (an older CLI), as billedToKey reads it.
 */
export function billedToSubscription(state: TurnState): boolean {
  return state.apiKeySource === 'none';
}

/**
 * Review fix L1: the CLI's init named no credential source (or the CLI went past its init without one: an event other
 * than `system` arrived). With AI_BILLING=api-key that turn is stopped too, at that event: nothing says the key pays,
 * and whichever sign-in the CLI used would.
 */
export function keySourceUnnamed(state: TurnState): boolean {
  return state.pastInit && !state.apiKeySource?.trim();
}

/**
 * Whether the turn is billed the way AI_BILLING forbids, read at every event so the child is stopped at system/init:
 * to a key with `subscription` (the default, billedToKey as before v3.4), to the subscription with `api-key`, or, with
 * `api-key`, to a source the CLI never named (review fix L1: stopped at its init, or at its first event without one).
 */
export function billedAgainst(state: TurnState, billing: AiBilling): boolean {
  return billing === 'api-key' ? billedToSubscription(state) || keySourceUnnamed(state) : billedToKey(state);
}
// end v34 AIKEY

/**
 * v20 FIX-A (SEC-1): what a turn that ended with no `result` event used, as far as its stream showed: the input and
 * cache tokens each `message_start` reported (or, when none reported them, the prompt's characters / 4), and each
 * message's output (its largest reported `output_tokens`, else its generated characters / 4), priced with AI_PRICES at
 * the answering model's price (`costSource: 'computed'`). Null when the turn never reached the model (no message
 * started and nothing streamed): a call killed before it started costs nothing. The CLI bills every token it generated
 * before a kill, so a cancelled, timed-out or stalled run is charged this instead of 0.
 */
export function streamedUsage(
  state: TurnState,
  read: Pick<UsageReadOptions, 'prices'> & { model?: string | null; promptChars?: number } = {},
): AiUsage | null {
  const streamed = state.streamed;
  if (streamed.messages === 0 && streamed.messageChars === 0) return null;
  const inputTokens = streamed.inputReported
    ? streamed.inputTokens
    : Math.ceil(Math.max(0, read.promptChars ?? 0) / CHARS_PER_TOKEN);
  const outputTokens = streamed.outputTokens + messageOutput(streamed);
  const model = state.model ?? read.model ?? null;
  const price = priceOf(read.prices ?? CONSTANTS.AI_PRICES.default, model);
  const costUsd =
    (inputTokens * price.input +
      outputTokens * price.output +
      streamed.cacheReadTokens * price.cacheRead +
      streamed.cacheWriteTokens * price.cacheWrite) /
    1e6;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: streamed.cacheReadTokens,
    cacheWriteTokens: streamed.cacheWriteTokens,
    costUsd,
    costSource: 'computed',
    models: model ? [model] : [],
  };
}
