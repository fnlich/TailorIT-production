'use client';

import { isCelebratedStatus, type ApplicationStatus } from '@tailorit/shared';

/** Confetti plays for 8 seconds when an application reaches Offer or Accepted. */
const CELEBRATION_MS = 8000;

/** v31 JOBSWEB: the confetti's colours are the identity's tokens (denim, the tape, success, white), read from the page. */
export const CONFETTI_TOKENS = ['--color-primary', '--color-primary-300', '--color-tape', '--color-tape-soft', '--color-success', '--color-surface'] as const;

/**
 * The tokens' colours as canvas-confetti takes them (#rrggbb), read through `read` (the root's computed style); a token
 * that is no such colour is left out, and with none at all the library's own colours are used.
 */
export function confettiColors(read: (token: string) => string): string[] | undefined {
  const colors = CONFETTI_TOKENS.map((token) => read(token).trim()).filter((value) => /^#[0-9a-f]{6}$/i.test(value));
  return colors.length > 0 ? colors : undefined;
}

let running = false;

/** Two cannons from the bottom corners for 8 seconds (nothing for people who prefer reduced motion). */
export async function celebrate(): Promise<void> {
  if (running || typeof window === 'undefined') return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  running = true;
  let confetti: typeof import('canvas-confetti');
  try {
    confetti = (await import('canvas-confetti')).default;
  } catch {
    running = false;
    return;
  }
  const end = Date.now() + CELEBRATION_MS;
  const style = getComputedStyle(document.documentElement);
  const colors = confettiColors((token) => style.getPropertyValue(token));
  const burst = () => {
    const common = { particleCount: 6, spread: 70, startVelocity: 55, ticks: 220, zIndex: 100, colors, disableForReducedMotion: true };
    void confetti({ ...common, angle: 60, origin: { x: 0, y: 0.9 } });
    void confetti({ ...common, angle: 120, origin: { x: 1, y: 0.9 } });
    if (Date.now() < end) window.setTimeout(burst, 160);
    else running = false;
  };
  burst();
}

/** Confetti when a change reaches Offer or Accepted (not when it stays there). */
export function celebrateIfReached(next: ApplicationStatus, previous: ApplicationStatus | null): void {
  if (isCelebratedStatus(next) && next !== previous) void celebrate();
}
