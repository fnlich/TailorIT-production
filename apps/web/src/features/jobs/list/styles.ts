/** v31 FIX-JOBS: a quiet text button of the results bar (Select, Save all, the sort): 32 px, ink, a hover wash. */
export const BAR_BUTTON =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-control px-2 text-[13px] font-medium text-foreground hover:bg-hover ' +
  'data-popup-open:bg-hover disabled:pointer-events-none disabled:opacity-50';

/**
 * v32 FIX-UX (UXREQ-1): a results bar button's word. The bar is the list card's header, so in a narrow list card (the
 * split from 1024 px) Select and Save all show their icons alone; the word stays their name for screen readers.
 */
export const BAR_WORD = '@max-[30rem]/job-list:sr-only';
