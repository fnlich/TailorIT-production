/*
 * Where focus goes once something the person acted on leaves the page (a removed row, a deleted item): without a place
 * to go, the focused button unmounts, focus falls to the document, and a keyboard user starts again from the top.
 */

/**
 * Focuses the first element one of `selectors` finds, in that order, once the page has re-rendered (two animation
 * frames, so a list updated in this tick and a dialog closing have settled). Does nothing when none is found.
 */
export function focusLater(...selectors: string[]): void {
  if (typeof window === 'undefined') return;
  const frame = window.requestAnimationFrame.bind(window);
  frame(() =>
    frame(() => {
      for (const selector of selectors) {
        const target = document.querySelector<HTMLElement>(selector);
        if (target) {
          target.focus();
          return;
        }
      }
    }),
  );
}

/** Frames focusSoon keeps watching a target it focused, in case a dialog takes focus back to itself meanwhile. */
const SETTLE_FRAMES = 10;

/**
 * v30 FIX-WEB (REV-UX UX-4): like focusLater, for a change that lands after a request, or inside a dialog: the page may
 * re-render in a later task (not at the end of the click), the target may still be disabled while a busy state clears,
 * and a modal dialog whose focused control just went takes focus back to itself a few frames later. So it tries every
 * animation frame, up to `frames` of them, until one of `selectors` (in that order) finds an element that is not
 * disabled and takes focus, then watches it for a few frames: focus taken back to the page or to a dialog's own box is
 * given to the target again; focus the person moved to another control is left alone.
 */
export function focusSoon(selectors: readonly string[], frames = 60): void {
  if (typeof window === 'undefined') return;
  let left = frames;
  let target: HTMLElement | null = null;
  let held = 0;
  const lost = () => {
    const active = document.activeElement as HTMLElement | null;
    return !active || active === document.body || active.matches('[role="dialog"], [role="alertdialog"]');
  };
  const attempt = () => {
    if (target && document.activeElement === target) {
      held += 1;
      if (held >= SETTLE_FRAMES) return;
    } else if (target && !lost()) {
      return;
    } else {
      target = null;
      for (const selector of selectors) {
        const found = document.querySelector<HTMLElement>(selector);
        if (found && !found.matches(':disabled')) {
          found.focus();
          if (document.activeElement === found) {
            target = found;
            held = 0;
            break;
          }
        }
      }
    }
    left -= 1;
    if (left > 0) window.requestAnimationFrame(attempt);
  };
  window.requestAnimationFrame(attempt);
}
