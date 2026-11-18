import type { MessageParams } from '@tailorit/shared/constants';
import type { PublicMessageKey } from '@/lib/constants';
import type { DocumentKind, Noun } from './types';

/*
 * The documents views' decisions, free of React (unit-testable): search matching, status lines, wording.
 */

function tidy(text: unknown): string {
  return typeof text === 'string' ? text.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
}

/** Trimmed, case-insensitive substring of any field; an empty query keeps everything. */
export function matchesQuery(query: string, fields: ReadonlyArray<string | null | undefined>): boolean {
  const needle = tidy(query).toLowerCase();
  if (!needle) return true;
  return fields.some((field) => typeof field === 'string' && tidy(field).toLowerCase().includes(needle));
}

/** "1 of 3 resumes match." (the total decides the noun's number). */
export function describeMatches(shown: number, total: number, noun: Noun): string {
  return `${shown} of ${total} ${total === 1 ? noun.one : noun.many} match.`;
}

/** v31 FIX-DOCS: a page's message renderer (usePublicConstants().t), so the wording below is the constants'. */
export type Words = (key: PublicMessageKey, params?: MessageParams) => string;

/** "Your search finds no cover letters" (MSG_DOCS_NO_MATCH_TITLE). */
export function noMatchTitle(noun: Noun, t: Words): string {
  return t('MSG_DOCS_NO_MATCH_TITLE', { noun: noun.many });
}

/** The bulk delete confirmation's title, sentence and button: "Delete 3 resumes?", "Delete 3". */
export function bulkDeleteWords(count: number, noun: Noun, t: Words): { title: string; description: string; confirm: string } {
  return {
    title: t('MSG_DOCS_DELETE_MANY_TITLE', { count, noun: count === 1 ? noun.one : noun.many }),
    description: t('MSG_DOCS_DELETE_MANY_TEXT'),
    confirm: t('LABEL_DOCS_DELETE_MANY_BUTTON', { count }),
  };
}

/** One document's delete confirmation: "Delete this resume?" and '“Platform resume” leaves your documents for good. …'. */
export function deleteOneWords(name: string, noun: Noun, t: Words): { title: string; description: string } {
  return { title: t('MSG_DOCS_DELETE_ONE_TITLE', { noun: noun.one }), description: t('MSG_DOCS_DELETE_ONE_TEXT', { name }) };
}

/** A thumbnail's cache key: a new `updatedAt` is a new page. */
export function thumbKey(kind: DocumentKind, id: string, updatedAt: string | number | null | undefined): string {
  return `${kind}:${id}:${updatedAt ?? ''}`;
}

/** Newest first by `updatedAt`, ties by id, so the order never depends on how the server answered. */
export function newestFirst<T extends { id: string; updatedAt: string }>(items: readonly T[], pinnedId?: string | null): T[] {
  const time = (value: string) => {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
  };
  return [...items].sort((a, b) => {
    if (pinnedId) {
      if (a.id === pinnedId && b.id !== pinnedId) return -1;
      if (b.id === pinnedId && a.id !== pinnedId) return 1;
    }
    const byTime = time(b.updatedAt) - time(a.updatedAt);
    if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
