// v35 FIX-WEB (the coordinator's decision 7): the pasted list of Admin › Import › Many links, moved here from the v3.1
// Add links dialog (settings/admin/links, removed: the Admin header's Add links opens Many links). Pure, so the tests
// read it without a page.

/**
 * The links in pasted text, in order: one per line, or separated by spaces, commas or semicolons; a link wrapped in
 * <…> or quotes is unwrapped. Repeats stay (the server counts them once and says so).
 */
export function parseLinks(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((part) => part.trim().replace(/^[<"'(]+|[>"')]+$/g, ''))
    .filter((part) => part.length > 0);
}

/** "1 link", "3 links". */
export const linksText = (count: number) => `${count.toLocaleString('en-US')} ${count === 1 ? 'link' : 'links'}`;

/** The paste form's problem, or null: no link, or more than ADMIN_ADD_LINKS_MAX (its words: MSG_JOB_ADD_TOO_MANY_LINKS). */
export function pasteProblem(count: number, max: number): 'empty' | 'too_many' | null {
  if (count === 0) return 'empty';
  if (count > max) return 'too_many';
  return null;
}

/** The words of an empty paste. */
export const EMPTY_PASTE_TEXT = 'Paste at least one job link.';
