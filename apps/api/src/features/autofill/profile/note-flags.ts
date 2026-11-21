import { hasSensitiveLabel, statesSensitiveAnswer } from '../ai/statements';

// The profile's "Anything else we should know?" note (version 3) as the save answers it: the lines that state a
// sensitive answer, which are saved as the person wrote them but never reach the AI (draft-facts.ts leaves them out of
// the facts by the same two checks), so Settings and the side panel can say so. Answers yes or no per line, nothing
// else; it logs nothing.

/**
 * The 0-based indexes, in `note` split at its line breaks, of the lines that state a sensitive answer (a visa, a
 * salary, an age...: statesSensitiveAnswer) or read "label: value" under a sensitive label ("Nationality: ...").
 */
export function flaggedNoteLines(note: string): number[] {
  const flagged: number[] = [];
  note.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line !== '' && (statesSensitiveAnswer(line) || hasSensitiveLabel(line))) flagged.push(index);
  });
  return flagged;
}

/**
 * What a caller that may not read the sensitive part (a token without profile:sensitive) sees in place of each line
 * that states a sensitive answer (audit A2): such a line is one of those answers in other words.
 */
export const HIDDEN_NOTE_LINE = '[hidden: sensitive]';

/** The note as such a caller sees it, and the 0-based indexes of the lines hidden in it (its flagged lines). */
export interface NoteView {
  note: string;
  flagged: number[];
}

/**
 * The note for a caller without profile:sensitive: each flagged line is HIDDEN_NOTE_LINE, which the answer's
 * `anythingElseFlaggedLines` names, so the count of hidden lines is said. A view that would be longer than the
 * profile's cap (a note of many short flagged lines) drops the last placeholders whole; mergeHiddenNoteLines keeps
 * every hidden line either way.
 */
export function noteWithoutSensitive(note: string, max: number): NoteView {
  const hidden = new Set(flaggedNoteLines(note));
  if (hidden.size === 0) return { note, flagged: [] };
  let view = note.split(/\r?\n/).map((line, index) => (hidden.has(index) ? HIDDEN_NOTE_LINE : line));
  while (view.join('\n').length > max) {
    const last = view.lastIndexOf(HIDDEN_NOTE_LINE);
    if (last === -1) break;
    view = [...view.slice(0, last), ...view.slice(last + 1)];
  }
  const flagged = view.flatMap((line, index) => (line === HIDDEN_NOTE_LINE ? [index] : []));
  return { note: view.join('\n'), flagged };
}

/**
 * v33 SHARE-6 (PLAN-sharing §3 "Sensitive answers"): the note as a caller that saw every line but may not change the
 * sensitive answers sends it back (a shared profile's Sensitive answers See without its Change), each flagged line made a
 * placeholder again, so mergeHiddenNoteLines puts the stored lines back in their places: such a caller never writes,
 * rewrites or erases a line that states a sensitive answer.
 */
export function maskSensitiveLines(note: string): string {
  const flagged = new Set(flaggedNoteLines(note));
  if (flagged.size === 0) return note;
  return note
    .split(/\r?\n/)
    .map((line, index) => (flagged.has(index) ? HIDDEN_NOTE_LINE : line))
    .join('\n');
}

/**
 * v33 SHARE-6 (the SHARE-6 review): the note as someone working on a shared profile without Sensitive answers' See or
 * Change sends it, each line of theirs that states a sensitive answer left out (they never saw the stored ones: those
 * come back through mergeHiddenNoteLines' placeholders), so such a caller never adds one.
 */
export function dropSensitiveLines(note: string): string {
  const flagged = new Set(flaggedNoteLines(note));
  if (flagged.size === 0) return note;
  return note
    .split(/\r?\n/)
    .filter((_line, index) => !flagged.has(index))
    .join('\n');
}

/**
 * A note saved by a caller without profile:sensitive, with the stored note's hidden lines kept (audit A2): each
 * HIDDEN_NOTE_LINE it sends back stands for the next hidden line, in order; hidden lines whose placeholder it left out
 * follow at the end, so such a caller never erases or rewrites one. A placeholder with no hidden line left is dropped.
 */
export function mergeHiddenNoteLines(stored: string, sent: string): string {
  const storedLines = stored.split(/\r?\n/);
  const hidden = flaggedNoteLines(stored).map((index) => storedLines[index]!);
  if (hidden.length === 0) return sent;
  let next = 0;
  const merged = sent.split(/\r?\n/).flatMap((line) => {
    if (line.trim() !== HIDDEN_NOTE_LINE) return [line];
    return next < hidden.length ? [hidden[next++]!] : [];
  });
  const rest = hidden.slice(next);
  const lines = rest.length > 0 && merged.length === 1 && merged[0] === '' ? rest : [...merged, ...rest];
  return lines.join('\n');
}
