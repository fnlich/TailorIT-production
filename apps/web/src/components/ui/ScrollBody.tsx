'use client';

import { clsx } from 'clsx';
import { useEffect, useRef, useState, type ReactNode } from 'react';

// v34 FIX-WEB (final review U-M3, U-M5): the scrolling middle of a confirm or an alert that can grow past a short window
// (a line per profile, a sentence per kept switch). The popup holds its title and buttons (`shrink-0`) and caps its
// height at the window's; this part takes the rest and scrolls. A keyboard reaches it: it holds a control, or, while it
// scrolls with none, it takes the focus itself (WCAG 2.1.1; axe's scrollable-region-focusable).

/** What a keyboard can land on inside the body (then the body needs no focus of its own). */
const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Whether `element` scrolls with nothing inside a keyboard can reach (pure but for the DOM read; the tests call it). */
export function needsOwnFocus(element: Pick<HTMLElement, 'scrollHeight' | 'clientHeight' | 'querySelector'>): boolean {
  return element.scrollHeight > element.clientHeight + 1 && element.querySelector(TABBABLE) === null;
}

export function ScrollBody({ children, className, ...rest }: { children: ReactNode; className?: string } & Record<`data-${string}`, string>) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [focusable, setFocusable] = useState(false);
  useEffect(() => {
    const element = outer.current;
    if (!element) return;
    const check = () => setFocusable(needsOwnFocus(element));
    check();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(check);
    observer.observe(element);
    if (inner.current) observer.observe(inner.current);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={outer}
      // `relative`: an absolutely placed piece inside (a checkbox's hidden input, an sr-only name) stays in the body.
      className={clsx('relative min-h-0 overflow-y-auto overscroll-contain', className)}
      tabIndex={focusable ? 0 : undefined}
      data-scroll-body={focusable ? 'focusable' : ''}
      {...rest}
    >
      <div ref={inner}>{children}</div>
    </div>
  );
}
