// v36 JOBS (PLAN J2, J3): the Jobs list's selection bar's words, and what it does to the chosen jobs (pure: the help
// guide reads them too). selection.ts says each result.

/** What the Select bar is doing to the chosen jobs. */
export type SelectionAction = 'save' | 'unsave';

/** The bar's words. */
export const SELECTION_COPY = {
  /** The toolbar's name. */
  bar: 'Selected jobs',
  selectAll: 'Select every job shown',
  count: (count: number) => `${count} selected`,
  save: 'Save',
  unsave: 'Unsave',
  done: 'Done',
  saveFailed: 'The jobs could not be saved',
  unsaveFailed: 'The jobs could not be removed from saved jobs',
} as const;

/**
 * v36 FIX-WEB (ux L4): the bar's first control, where focus goes when select mode starts: the select-all box (a
 * span[role=checkbox]), else its first button that is on (Save and Unsave are off while nothing is chosen, so a plain
 * first button was Done, the bar's last).
 */
export const SELECTION_BAR_FIRST = '[data-selection-bar] [role="checkbox"]:not([data-disabled]), [data-selection-bar] button:not([disabled])';
