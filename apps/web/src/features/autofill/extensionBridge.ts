// Hands a connect code to the TailorIT extension in this browser. Chrome gives a page chrome.runtime.sendMessage only
// when an installed extension lists the page's origin in its externally_connectable; the extension's worker checks the
// sender's origin and the pairing `state` it opened this page with, redeems the code itself and answers {ok: true}, so
// its token never reaches the page. Anything else (no such API, no extension ids, no answer within 3 s, a refusal)
// leaves the person to type the code into the extension instead.

/** The part of chrome.runtime this page uses: the callback form, which Chrome offers web pages (no @types/chrome). */
export interface PageRuntime {
  sendMessage(extensionId: string, message: unknown, responseCallback: (response: unknown) => void): void;
  /** Set while a sendMessage callback runs when the message failed. */
  readonly lastError?: { message?: string } | undefined;
}

/** How long one extension has to answer before the next is tried, or the code is shown. */
export const PAIR_TIMEOUT_MS = 3_000;

/** The one message the extension accepts from this page. */
export interface PairMessage {
  v: 1;
  type: 'pair/complete';
  state: string;
  code: string;
}

/**
 * Why the code was not handed over. `unavailable`: nothing to try (no pairing state, no extension ids, or Chrome
 * offers this page no runtime). `not_installed`: no extension with that id listens in this browser. `timeout`: no
 * answer within PAIR_TIMEOUT_MS. `refused`: the extension answered without taking it. `failed`: anything else.
 */
export type PairFailure = 'unavailable' | 'not_installed' | 'timeout' | 'refused' | 'failed';

export type PairOutcome = { ok: true; extensionId: string } | { ok: false; reason: PairFailure };

/** The runtime Chrome put on this page, when it put one there. */
export function pageRuntime(scope: unknown = globalThis): PageRuntime | null {
  const chrome = (scope as { chrome?: { runtime?: unknown } } | null | undefined)?.chrome;
  const runtime = chrome?.runtime as Partial<PageRuntime> | undefined;
  return runtime && typeof runtime.sendMessage === 'function' ? (runtime as PageRuntime) : null;
}

/** The pairing state from the page's address: opaque to the page, but only URL-safe characters are passed on. */
export function pairingState(value: string | null | undefined): string | null {
  return value && /^[A-Za-z0-9_-]{16,256}$/.test(value) ? value : null;
}

/**
 * Chrome's sentence for a message no extension received (none with that id is installed, or it does not listen):
 * "Could not establish connection. Receiving end does not exist."
 */
const NOT_RECEIVED = /receiving end does not exist/i;

/** A failed message's lastError (or thrown error) sentence as a reason. */
export function failureOf(message: string | undefined): PairFailure {
  return message && NOT_RECEIVED.test(message) ? 'not_installed' : 'failed';
}

function accepted(response: unknown): boolean {
  return typeof response === 'object' && response !== null && (response as { ok?: unknown }).ok === true;
}

function sendOnce(runtime: PageRuntime, extensionId: string, message: PairMessage, timeoutMs: number) {
  return new Promise<PairOutcome>((resolve) => {
    let settled = false;
    // Set before anything can call finish: the timer itself, the callback and the catch all come after it.
    const finish = (outcome: PairOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);
    try {
      runtime.sendMessage(extensionId, message, (response) => {
        // Read inside the callback (a late one too), or Chrome logs "Unchecked runtime.lastError".
        const error = runtime.lastError;
        if (error) finish({ ok: false, reason: failureOf(error.message) });
        else finish(accepted(response) ? { ok: true, extensionId } : { ok: false, reason: 'refused' });
      });
    } catch (error) {
      finish({ ok: false, reason: failureOf(error instanceof Error ? error.message : undefined) });
    }
  });
}

/** The reasons to report when every extension failed, the most telling first. */
const FAILURE_ORDER: readonly PairFailure[] = ['refused', 'timeout', 'failed', 'not_installed', 'unavailable'];

/**
 * Offers the code to each extension id in turn, `timeoutMs` each, until one takes it. Nothing is sent without a
 * pairing state, an id and a runtime.
 */
export async function sendConnectCode({
  state,
  code,
  extensionIds,
  runtime = pageRuntime(),
  timeoutMs = PAIR_TIMEOUT_MS,
}: {
  state: string | null;
  code: string;
  extensionIds: readonly string[];
  runtime?: PageRuntime | null;
  timeoutMs?: number;
}): Promise<PairOutcome> {
  if (!state || !runtime || extensionIds.length === 0) return { ok: false, reason: 'unavailable' };
  const message: PairMessage = { v: 1, type: 'pair/complete', state, code };
  let reason: PairFailure = 'unavailable';
  for (const extensionId of extensionIds) {
    const outcome = await sendOnce(runtime, extensionId, message, timeoutMs);
    if (outcome.ok) return outcome;
    if (FAILURE_ORDER.indexOf(outcome.reason) < FAILURE_ORDER.indexOf(reason)) reason = outcome.reason;
  }
  return { ok: false, reason };
}
