'use client';

import { DotsSixVerticalIcon } from '@phosphor-icons/react/DotsSixVertical';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { Tooltip } from '@/components/ui/Tooltip';
import { boxOf, pageOf, sectionElement, type Box } from './dom';
import { dropIndex, dropLine, type DropLine, type Point } from './drag';
import type { EntryTools } from './tools';
import type { ToolbarCommands } from './useToolbarCommands';

// The selected entry's corner handle: drag it to move the entry within its section (a line shows where it will go,
// the window scrolls near its top and bottom, Escape gives up), or press the arrow keys on it. One undo step.

/** How far a press moves before it is a drag (a click on the handle does nothing). */
const DRAG_THRESHOLD_PX = 4;
/** How near the window's top or bottom the pointer scrolls it, and by how much a frame. */
const SCROLL_EDGE_PX = 60;
const SCROLL_STEP_PX = 14;

interface Drag {
  pointer: number;
  start: Point;
  /** Where the pointer is now, in the window. */
  client: Point;
  moving: boolean;
}

export function EntryDrag({
  canvas,
  tools,
  anchor,
  commands,
}: {
  canvas: RefObject<HTMLElement | null>;
  tools: EntryTools;
  /** The entry's box, in the canvas's coordinates. */
  anchor: Box;
  commands: ToolbarCommands;
}) {
  const drag = useRef<Drag | null>(null);
  const frame = useRef(0);
  const [shown, setShown] = useState<{ line: DropLine | null; at: Point } | null>(null);

  /** The section's other entries in page order, in the canvas's coordinates; null when the page and the list differ. */
  const others = (container: HTMLElement): Box[] | null => {
    const page = pageOf(container);
    const section = page ? sectionElement(page, tools.ref) : null;
    if (!section) return null;
    const origin = container.getBoundingClientRect();
    const entries = Array.from(section.querySelectorAll('[data-rt-entry]')).filter((entry) => !entry.hasAttribute('data-placeholder-entry'));
    if (entries.length !== tools.count) return null;
    return entries
      .filter((entry) => entry.getAttribute('data-rt-entry') !== tools.path)
      .map((entry) => boxOf(entry.getBoundingClientRect(), origin));
  };

  /** Where a drop now would put the entry. */
  const place = () => {
    const current = drag.current;
    const container = canvas.current;
    const boxes = container ? others(container) : null;
    if (!current || !container || !boxes) return null;
    const origin = container.getBoundingClientRect();
    const at = { x: current.client.x - origin.left, y: current.client.y - origin.top };
    const index = dropIndex(boxes, at);
    return { index, line: dropLine(boxes, index), at };
  };

  const show = () => {
    const placed = place();
    setShown(placed ? { line: placed.line, at: placed.at } : null);
  };

  // Near the window's top or bottom the page scrolls a step a frame, for as long as the drag lasts.
  const scroll = () => {
    const current = drag.current;
    if (!current?.moving) return;
    const y = current.client.y;
    const step = y < SCROLL_EDGE_PX ? -SCROLL_STEP_PX : y > window.innerHeight - SCROLL_EDGE_PX ? SCROLL_STEP_PX : 0;
    if (step) {
      window.scrollBy(0, step);
      show();
    }
    frame.current = requestAnimationFrame(scroll);
  };

  const end = (drop: boolean) => {
    cancelAnimationFrame(frame.current);
    const placed = drop && drag.current?.moving ? place() : null;
    drag.current = null;
    setShown(null);
    if (placed) commands.moveEntryTo(tools, placed.index);
  };

  // Escape gives the drag up, before anything else hears it.
  const dragging = shown !== null;
  const endRef = useRef(end);
  useEffect(() => {
    endRef.current = end;
  });
  useEffect(() => {
    if (!dragging) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      endRef.current(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [dragging]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  return (
    <>
      {dragging ? <style>{`[data-resume-canvas] [data-rt-entry="${tools.path}"]{opacity:.4}`}</style> : null}
      <Tooltip content="Drag to move">
        <button
          type="button"
          aria-label={`Move ${tools.name}: drag, or press the arrow keys`}
          aria-keyshortcuts="ArrowUp ArrowDown"
          data-entry-drag=""
          className="pointer-events-auto absolute flex h-6 w-5 cursor-grab touch-none items-center justify-center rounded-tag border border-border bg-surface text-muted-foreground shadow-popover hover:text-foreground active:cursor-grabbing"
          style={{ left: anchor.left - 26, top: anchor.top }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            const point = { x: event.clientX, y: event.clientY };
            drag.current = { pointer: event.pointerId, start: point, client: point, moving: false };
          }}
          onPointerMove={(event) => {
            const current = drag.current;
            if (!current || current.pointer !== event.pointerId) return;
            current.client = { x: event.clientX, y: event.clientY };
            if (!current.moving) {
              if (Math.hypot(current.client.x - current.start.x, current.client.y - current.start.y) < DRAG_THRESHOLD_PX) return;
              current.moving = true;
              frame.current = requestAnimationFrame(scroll);
            }
            show();
          }}
          onPointerUp={(event) => {
            if (drag.current?.pointer === event.pointerId) end(true);
          }}
          onPointerCancel={() => end(false)}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            event.preventDefault();
            commands.moveEntry(tools, event.key === 'ArrowUp' ? -1 : 1);
          }}
        >
          <DotsSixVerticalIcon size={14} weight="bold" />
        </button>
      </Tooltip>
      {shown?.line ? (
        <div
          aria-hidden="true"
          data-drop-line=""
          className="pointer-events-none absolute rounded-full bg-primary"
          style={{ left: shown.line.left, top: shown.line.top, width: shown.line.width, height: shown.line.height }}
        />
      ) : null}
      {shown ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute max-w-60 truncate rounded-control border border-border bg-surface px-2 py-1 text-xs font-medium text-foreground shadow-popover"
          style={{ left: shown.at.x + 14, top: shown.at.y + 10 }}
        >
          {tools.name}
        </div>
      ) : null}
    </>
  );
}
