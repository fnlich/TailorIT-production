'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { focusSoon } from '../../lib/focusLater';
import { Button, type ButtonVariant } from '../ui/Button';

// v30 FIX-WEB (REV-UX UX-4): an admin list's "Show more …" button. Pressed from the keyboard, focus stays on it while the
// next page loads (focusableWhenDisabled: a loading Button is disabled, and a disabled button drops focus to the page,
// so paging 80,000 sources started Tab from the top each time). When that page was the last one the button goes; focus
// then moves to `afterLast` (the list's last row) instead of falling to the page.

export interface ShowMoreButtonProps {
  /** Whether there is another page (the button shows only then). */
  hasMore: boolean;
  loading: boolean;
  onMore: () => void;
  /** Where focus goes when the last page came in while the button had it: selectors, the first found wins. */
  afterLast: readonly string[];
  children: ReactNode;
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  className?: string;
}

export function ShowMoreButton({ hasMore, loading, onMore, afterLast, children, variant = 'outline', size = 'md', className = 'mt-4 flex justify-center' }: ShowMoreButtonProps) {
  // Whether the button had focus when it was pressed: only then, and only while focus fell to the page, does its going
  // move focus.
  const held = useRef(false);
  const targets = afterLast.join('\n');
  useEffect(() => {
    if (hasMore || !held.current) return;
    held.current = false;
    const active = document.activeElement;
    if (!active || active === document.body) focusSoon(targets.split('\n'));
  }, [hasMore, targets]);
  if (!hasMore) return null;
  return (
    <div className={className}>
      <Button
        variant={variant}
        size={size}
        loading={loading}
        focusableWhenDisabled
        onClick={(event) => {
          held.current = document.activeElement === event.currentTarget;
          onMore();
        }}
        data-show-more=""
      >
        {children}
      </Button>
    </div>
  );
}
