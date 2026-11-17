import { JSON_BEGIN } from '../../../ai/index';
import { entriesByItem, holdsCanary, speaksAsAnAi, stringsOf } from './tasks';

// v5 (Jobright parity, Phase 2): an answer or draft task's items released while Claude is still writing the rest, so
// the extension fills each field as its answer lands (GET /api/ai/tasks/:id/stream). The reply streams as text
// (CompletionRequest.onText); each time it grows, the complete entries of its JSON's item array are read, and each new
// one is released once:
// - it names an item number of the request (1..count), one not named before in this reply;
// - the reply up to its end, prose before the JSON included, does not speak as an AI (speaksAsAnAi);
// - the item's own checks (the handler's `settle`) decide its verdict, as the finished task's do.
// A released item is committed: the finished task's result holds it unchanged. The first entry that fails the reply's
// checks (an unknown or repeated number, talk of being an AI, an entry that is no object, a second JSON block) stops the
// release: what is left waits for the finished task's checks, which judge the reply whole as before. A request that
// carries canaries never streams (the handlers create no release for one): a reply that follows a page's trap may name
// its canary only at the end, and every item of such a reply is discarded. A retry the CLI makes mid-reply restarts
// the text; the numbers already committed keep their verdicts. Nothing here logs or stores a reply's text.

/**
 * The review's security 5: whether a reply is voided as a whole, so the items its stream released are marked
 * `streamedThenVoided` in the finished result: a canary or talk of being an AI anywhere in it (prose included), an
 * item array that does not name each item once, or a reply holding two JSON blocks (the stream reads the first,
 * extractJSON the last: such a reply is never trusted for what it released). A reply that never read as JSON (the
 * repair retry's `malformed`) is voided by its caller.
 */
export function voidsReleased(answer: unknown, entries: unknown, count: number, canaries: readonly string[],
  replies: readonly string[]): boolean {
  const texts = [...stringsOf(answer), ...replies];
  if (holdsCanary(texts, canaries) || texts.some(speaksAsAnAi)) return true;
  if (!Array.isArray(entries) || entriesByItem(entries as Array<{ item?: unknown }>, count) === null) return true;
  return replies.some((reply) => reply.indexOf(JSON_BEGIN) !== reply.lastIndexOf(JSON_BEGIN));
}

/** One complete entry of the item array, and where it ends in the reply's text. */
export interface StreamedEntry {
  value: unknown;
  end: number;
}

/**
 * The complete entries of the array the first JSON block's top-level object holds under `field`, in a reply streamed
 * so far. `broken`: the block does not read as that shape (an entry that is no object, an entry that does not parse);
 * `again`: a second JSON block began after the first (extractJSON reads the last one, so nothing more is released).
 */
export function streamedEntries(text: string, field: string): { entries: StreamedEntry[]; broken: boolean; again: boolean } {
  const entries: StreamedEntry[] = [];
  const begin = text.indexOf(JSON_BEGIN);
  if (begin < 0) return { entries, broken: false, again: false };
  const again = text.indexOf(JSON_BEGIN, begin + JSON_BEGIN.length) >= 0;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  /** The top-level object's key just read, and the key whose value is being read. */
  let lastString: string | null = null;
  let key: string | null = null;
  /** Inside the item array (stack depth 2), and where the entry being read began. */
  let inArray = false;
  let entryStart = -1;
  for (let at = begin + JSON_BEGIN.length; at < text.length; at += 1) {
    const ch = text[at]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') {
        inString = false;
        if (stack.length === 1) lastString = text.slice(stringStart, at + 1);
      }
      continue;
    }
    if (ch === '"') {
      if (inArray && stack.length === 2) return { entries, broken: true, again };
      inString = true;
      stringStart = at;
      continue;
    }
    if (ch === '{' || ch === '[') {
      if (stack.length === 0 && ch !== '{') return { entries, broken: true, again };
      if (stack.length === 1 && ch === '[' && key === field) inArray = true;
      else if (inArray && stack.length === 2) {
        if (ch !== '{') return { entries, broken: true, again };
        entryStart = at;
      }
      stack.push(ch);
      continue;
    }
    if (ch === '}' || ch === ']') {
      stack.pop();
      if (inArray && stack.length === 2 && ch === '}' && entryStart >= 0) {
        let value: unknown;
        try {
          value = JSON.parse(text.slice(entryStart, at + 1));
        } catch {
          return { entries, broken: true, again };
        }
        entries.push({ value, end: at + 1 });
        entryStart = -1;
      } else if (inArray && stack.length === 1) {
        // The item array closed: nothing more of it to read.
        return { entries, broken: false, again };
      }
      if (stack.length === 0) return { entries, broken: false, again };
      continue;
    }
    if (stack.length === 1) {
      if (ch === ':') {
        try {
          key = lastString === null ? null : (JSON.parse(lastString) as string);
        } catch {
          key = null;
        }
      } else if (ch === ',') key = null;
    } else if (inArray && stack.length === 2 && !/[\s,]/.test(ch)) {
      // A number, true, false or null where an entry belongs.
      return { entries, broken: true, again };
    }
  }
  return { entries, broken: false, again };
}

/** The release of one reply's items (module header). */
export interface ItemRelease<S> {
  /** The reply's whole text so far (CompletionRequest.onText). */
  feed(text: string): void;
  /** The items released, by item number (1-based, the request's order). */
  committed(): ReadonlyMap<number, S>;
}

export function releaseItems<S>(options: {
  /** The key of the reply's item array ("answers", "drafts"). */
  field: string;
  /** How many items the request asked. */
  count: number;
  /** The item's own checks: its verdict, as the finished task's checks give it. */
  settle(entry: Record<string, unknown>, item: number): S;
  /** Sends a released item to the task's stream (AiTaskContext.publish). */
  publish(item: number, settled: S): void;
}): ItemRelease<S> {
  const committed = new Map<number, S>();
  let stopped = false;
  let seen = '';
  /** The entries of this text's run already looked at, and the numbers they named (a retry starts a new run). */
  let looked = 0;
  let named = new Set<number>();
  return {
    feed(text) {
      if (stopped) return;
      if (!text.startsWith(seen)) {
        looked = 0;
        named = new Set();
      }
      seen = text;
      const { entries, broken, again } = streamedEntries(text, options.field);
      for (; looked < entries.length; looked += 1) {
        const { value, end } = entries[looked]!;
        const raw = (value as { item?: unknown } | null)?.item;
        const item = typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= options.count ? raw : null;
        if (value === null || typeof value !== 'object' || Array.isArray(value) || item === null || named.has(item)
          || speaksAsAnAi(text.slice(0, end))) {
          stopped = true;
          return;
        }
        named.add(item);
        if (committed.has(item)) continue;
        // The review's security 7b: an item its own checks or the stream cannot take ends the release; the finished
        // task's checks judge what is left.
        let settled: S;
        try {
          settled = options.settle(value as Record<string, unknown>, item);
          options.publish(item, settled);
        } catch {
          stopped = true;
          return;
        }
        committed.set(item, settled);
      }
      if (broken || again) stopped = true;
    },
    committed: () => committed,
  };
}
