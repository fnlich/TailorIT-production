'use client';

import { Toolbar } from '@base-ui/react/toolbar';
import { clsx } from 'clsx';
import { useCallback, useEffect, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/Popover';
import { Tooltip } from '@/components/ui/Tooltip';
import type { Box } from './dom';

// The pieces every toolbar is made of: a white bar in Simplify's menu style (Base UI Toolbar: one tab stop, the
// arrows move between the buttons, Escape goes back to the page), icon buttons with their tooltip, text buttons
// ("+ Entry"), and buttons that open a popover. A bar floats above the box it acts on and stays inside the canvas.

export const TOOLBAR_SHORTCUT = 'Alt+F10';

const BAR =
  'flex items-center gap-0.5 rounded-menu bg-white p-1 text-sm text-foreground shadow-menu outline outline-1 ' +
  'outline-black/[0.08]';

export function ToolbarShell({
  label,
  children,
  onEscape,
}: {
  label: string;
  children: ReactNode;
  /** Escape inside the bar (not in one of its popovers): back to the field the person was in. */
  onEscape(): void;
}) {
  return (
    <Toolbar.Root
      aria-label={label}
      aria-keyshortcuts={TOOLBAR_SHORTCUT}
      className={BAR}
      data-editor-toolbar=""
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Escape' || !event.currentTarget.contains(event.target as Node)) return;
        event.preventDefault();
        onEscape();
      }}
    >
      {children}
    </Toolbar.Root>
  );
}

export function ToolSeparator() {
  return <Toolbar.Separator className="mx-0.5 h-5 w-px bg-border" />;
}

/** An icon button of a toolbar; `label` is its name and its tooltip. */
export function ToolIcon({
  label,
  tooltip,
  icon,
  disabled,
  onClick,
}: {
  label: string;
  tooltip?: string;
  icon: ReactNode;
  disabled?: boolean;
  onClick(event: MouseEvent<HTMLButtonElement>): void;
}) {
  return (
    <Toolbar.Button
      disabled={disabled}
      onClick={onClick}
      render={<IconButton label={label} tooltip={tooltip ?? label} icon={icon} size="sm" variant="ghost" />}
    />
  );
}

/** A text button of a toolbar ("+ Entry"); `label` is its full name ("Add an entry after Staff Engineer"). */
export function ToolText({
  label,
  tooltip,
  icon,
  children,
  disabled,
  onClick,
}: {
  label: string;
  tooltip: string;
  icon?: ReactNode;
  children: ReactNode;
  disabled?: boolean;
  onClick(): void;
}) {
  return (
    <Tooltip content={tooltip}>
      <Toolbar.Button
        disabled={disabled}
        onClick={onClick}
        aria-label={label}
        render={
          <Button variant="ghost" size="sm" icon={icon} className="px-2">
            {children}
          </Button>
        }
      />
    </Tooltip>
  );
}

/** How long a hint points at its button. */
const HINT_MS = 3_000;

/** A toolbar button that opens a popover under it (Settings, Write with AI). */
export function ToolPopover({
  label,
  tooltip,
  icon,
  title,
  open,
  onOpenChange,
  width = 'w-72',
  hint,
  children,
}: {
  label: string;
  tooltip?: string;
  icon: ReactNode;
  /** The popover's accessible name. */
  title: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  width?: string;
  /** Each new count points at the button for a few seconds: a ring, and `text` under it. */
  hint?: { count: number; text: string };
  children: ReactNode;
}) {
  const count = hint?.count ?? 0;
  const [spent, setSpent] = useState(0);
  useEffect(() => {
    if (count === 0) return;
    const timer = window.setTimeout(() => setSpent(count), HINT_MS);
    return () => window.clearTimeout(timer);
  }, [count]);
  const hinting = count > 0 && spent !== count && !open;
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <span className="relative inline-flex">
        <Toolbar.Button
          render={
            <PopoverTrigger
              render={
                <IconButton
                  label={label}
                  tooltip={tooltip ?? label}
                  icon={icon}
                  size="sm"
                  variant="ghost"
                  className={hinting ? 'ring-2 ring-primary motion-safe:animate-pulse' : undefined}
                  data-hint={hinting ? '' : undefined}
                />
              }
            />
          }
        />
        {hinting ? (
          // Said in the page's live region; this is the picture of it.
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-full right-0 z-10 mt-2 rounded-[8px] bg-foreground px-2.5 py-1.5 text-xs leading-4 font-medium whitespace-nowrap text-white shadow-popover"
          >
            {hint?.text}
          </span>
        ) : null}
      </span>
      <PopoverContent aria-label={title} side="bottom" align="end" padding="sm" className={width}>
        {children}
      </PopoverContent>
    </Popover>
  );
}

/** A popover's heading row. */
/** Why a chip was not added, as a skill box says it. */
export const CHIP_REFUSALS = {
  duplicate: 'That one is on the list already.',
  capped: 'The list is full.',
  blank: 'Type something first.',
} as const;

export function PanelTitle({ children }: { children: ReactNode }) {
  return <p className="px-1 pb-2 text-[13px] font-semibold text-foreground">{children}</p>;
}

/** A small muted group heading inside a popover. */
export function PanelGroup({ label, children, className }: { label?: string; children: ReactNode; className?: string }) {
  return (
    <div className={clsx('flex flex-col gap-2 px-1', className)} role="group" aria-label={label}>
      {label ? <p className="text-xs font-medium text-muted-foreground">{label}</p> : null}
      {children}
    </div>
  );
}

/**
 * Something floating over the page: above `anchor` with its right edge on the anchor's right edge, or under the
 * anchor when there is no room above, and kept inside the canvas's width. It measures itself to place itself, so it
 * is hidden for the frame before it knows its size.
 */
export function FloatingBar({
  anchor,
  bounds,
  children,
  gap = 6,
}: {
  anchor: Box;
  /** The canvas's width. */
  bounds: number;
  children: ReactNode;
  gap?: number;
}) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const measure = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const watcher = new ResizeObserver(() => setSize({ width: element.offsetWidth, height: element.offsetHeight }));
    watcher.observe(element);
    return () => watcher.disconnect();
  }, []);
  const width = size?.width ?? 0;
  const height = size?.height ?? 0;
  const left = Math.max(0, Math.min(anchor.left + anchor.width - width, bounds - width));
  const above = anchor.top - height - gap;
  const top = above < -40 ? anchor.top + anchor.height + gap : above;
  return (
    <div
      ref={measure}
      className="pointer-events-auto absolute"
      style={{ left, top, visibility: size ? 'visible' : 'hidden' }}
    >
      {children}
    </div>
  );
}

/** An outline drawn over the page (selection, hover): it lies on top, so nothing on the page moves. */
export function Outline({ box, tone }: { box: Box; tone: 'selected' | 'section' | 'hover' }) {
  const pad = tone === 'selected' ? 4 : 6;
  return (
    <div
      aria-hidden="true"
      className={clsx(
        'pointer-events-none absolute rounded-[6px]',
        tone === 'selected' && 'border-[1.5px] border-primary',
        tone === 'section' && 'border border-primary/45 bg-primary/[0.025]',
        tone === 'hover' && 'border border-dashed border-primary/50',
      )}
      style={{ left: box.left - pad, top: box.top - pad, width: box.width + pad * 2, height: box.height + pad * 2 }}
    />
  );
}
