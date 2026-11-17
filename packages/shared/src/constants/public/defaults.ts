import type { MessageKey, PublicConstantKey } from '../constants';
import { renderMessage, type MessageParams } from '../render';
import { PUBLIC_CONSTANT_SPECS } from './specs';

// v30 INT-0: the words of a shared contract's own checks (a zod message, a validator the web and the API both run),
// from the constants file, so they have one source. These checks run where no constants service is (a form in the
// browser, a request body before any route); the server's refusals read the constants service, an admin's edit
// included. Reads ./specs (generated, public values only), never the whole table.
//
// v30 CT (INT-0's open item): an admin's edit reaches these checks too. The words in use are set once per process, and
// again after each change, from the values the app already resolves: the API from its constants service (at start,
// after a reload and after an admin's edit), the web from GET /api/constants/public. A zod check takes
// messageError(key, params), whose words are read when the check fails, not when the schema is made; a validator that
// answers a sentence calls sharedMessage. Until the words are set (a test, a script), the defaults apply.

/** A public message's key. */
export type PublicMessageKeyOf = Extract<MessageKey, PublicConstantKey>;

/** Message `key` at its default words, its placeholders filled: defaultMessage('MSG_TEXT_TOO_LONG', { max: 500 }). */
export function defaultMessage(key: PublicMessageKeyOf, params?: MessageParams): string {
  return renderMessage(PUBLIC_CONSTANT_SPECS[key].default as string, params);
}

/** The words set by setSharedMessages, by key; a key not here says its default. */
const inUse = new Map<string, string>();

/**
 * Sets the words the shared contracts' checks say, from a map of public constant values (the constants service's
 * resolved public values, or GET /api/constants/public's `values`). Each call replaces the last: a message the map
 * leaves out says its default again. Keys that name no public message, and words that are not text, are skipped.
 */
export function setSharedMessages(values: Readonly<Record<string, unknown>>): void {
  inUse.clear();
  for (const [key, words] of Object.entries(values)) {
    if (!Object.hasOwn(PUBLIC_CONSTANT_SPECS, key)) continue;
    const spec = PUBLIC_CONSTANT_SPECS[key as PublicConstantKey];
    if (spec.kind === 'message' && typeof words === 'string' && words.trim() !== '') inUse.set(key, words);
  }
}

/** Message `key` in the words in use (an admin's, once set; else its default), its placeholders filled. */
export function sharedMessage(key: PublicMessageKeyOf, params?: MessageParams): string {
  return renderMessage(inUse.get(key) ?? (PUBLIC_CONSTANT_SPECS[key].default as string), params);
}

/**
 * A zod check's message that says message `key` in the words in use when the check fails:
 * `z.string().max(500, messageError('MSG_TEXT_TOO_LONG', { max: 500 }))`.
 */
export function messageError(key: PublicMessageKeyOf, params?: MessageParams): { error: () => string } {
  return { error: () => sharedMessage(key, params) };
}
