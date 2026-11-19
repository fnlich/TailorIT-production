'use client';

import { clsx } from 'clsx';
import { useEffect, useRef, type ReactNode } from 'react';

// v32 LAYOUT (E9): a phone's board shows one lane at a time, full width; this row above it names every lane shown
// with its count ("Saved 4", "Applied 7"), marks the one on screen, and brings a lane into view when it is pressed.
// Swiping the board moves the mark (BoardView follows its scroll). It is drawn below 640 px only (`sm:hidden`): from
// there the lanes sit side by side.

export interface SwitcherLane {
  /** The lane's element id (aria-controls). */
  id: string;
  label: string;
  count: number;
  icon: ReactNode;
}

/** The chip's left and right edges with this margin, scrolled into the row's view without moving the page. */
export function rowScrollFor(
  chip: { left: number; width: number },
  row: { scrollLeft: number; width: number },
  margin = 16,
): number | null {
  const start = chip.left - margin;
  const end = chip.left + chip.width + margin;
  if (start < row.scrollLeft) return Math.max(0, start);
  if (end > row.scrollLeft + row.width) return end - row.width;
  return null;
}

export function StageSwitcher({
  lanes,
  active,
  onGo,
  reduced,
}: {
  lanes: readonly SwitcherLane[];
  /** The index of the lane on screen. */
  active: number;
  onGo: (index: number) => void;
  /** Reduced motion: the row jumps instead of gliding. */
  reduced: boolean;
}) {
  const row = useRef<HTMLDivElement>(null);

  // The lane on screen keeps its chip in the row's view (the row scrolls; the page never does).
  useEffect(() => {
    const node = row.current;
    const chip = node?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!node || !chip) return;
    const left = rowScrollFor({ left: chip.offsetLeft, width: chip.offsetWidth }, { scrollLeft: node.scrollLeft, width: node.clientWidth });
    if (left !== null) node.scrollTo({ left, behavior: reduced ? 'auto' : 'smooth' });
  }, [active, lanes.length, reduced]);

  return (
    <div
      ref={row}
      role="group"
      aria-label="Lanes"
      data-stage-switcher=""
      className="relative flex shrink-0 gap-2 overflow-x-auto overscroll-x-contain px-4 pt-0.5 pb-2 [scrollbar-width:none] sm:hidden [&::-webkit-scrollbar]:hidden"
    >
      {lanes.map((lane, index) => {
        const current = index === active;
        return (
          <button
            key={lane.id}
            type="button"
            aria-controls={lane.id}
            aria-current={current ? 'true' : undefined}
            data-switcher-lane={lane.id}
            onClick={() => onGo(index)}
            className={clsx(
              'inline-flex h-11 shrink-0 items-center gap-1.5 rounded-control border px-3 text-sm font-medium whitespace-nowrap shadow-control',
              'transition-[border-color,background-color,color] duration-150',
              current
                ? 'border-primary bg-primary-50 text-primary-ink'
                : 'border-border-strong bg-surface text-foreground hover:border-control-hover hover:bg-surface-low',
            )}
          >
            <span aria-hidden="true" className="flex">
              {lane.icon}
            </span>
            {lane.label}
            <span
              className={clsx(
                'num inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] leading-none',
                current ? 'bg-primary text-on-primary' : 'bg-surface-muted text-muted-foreground',
              )}
            >
              {lane.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
