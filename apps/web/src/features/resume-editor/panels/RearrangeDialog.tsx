'use client';

import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { DotsSixVerticalIcon } from '@phosphor-icons/react/DotsSixVertical';
import { clsx } from 'clsx';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { effectiveTemplateId, RESUME_TEMPLATES, type ResumeDocument } from '@tailorit/shared';
import { layoutResume, type PagePlan } from '@tailorit/resume-templates';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/Dialog';
import { ArrowDownIcon, ArrowUpIcon, ArrowsLeftRightIcon, LockSimpleIcon, XIcon } from '@/components/ui/icons';
import { ResumeCanvas } from '../pages/ResumeCanvas';
import { viewOf } from '../pages/views';
import { sectionLabel } from '../store/actions';
import type { EditorStore } from '../store/store';
import { boardOf, columnOrder, dropTarget, type BoardColumnName, type BoardItem, type Drop } from './rearrange';
import { useEditorField } from '../../roles/EditorField'; // v33 ROLES

// Enhancv's Rearrange: "Hold & Drag the boxes to rearrange the sections". The pages one under another, each drawn as
// the page itself at a small scale (its margins, its columns at their widths) with the header locked at the top of
// page 1 and a box per section as tall as the section is there. A dragged box follows the pointer, a line shows
// where it will land, and once dropped the boxes slide to their new places. Each box's buttons do the same by
// keyboard, and its X takes the section off the page (its content kept). The whole visit is one undo step.

/** How wide a page is on the board (CSS px); everything on it is the page at that scale. */
const BOARD_PAGE_WIDTH = 300;
/** A box never shorter than its name. */
const MIN_BOX_PX = 30;
/** How long a box takes to slide to its new place. */
const SLIDE_MS = 220;

/** What a box is called on the board, and its place for the slide. */
const boardKey = (item: BoardItem) => (item.continued ? `${item.ref}@${item.page}` : item.ref);

function SectionBox({
  item,
  label,
  height,
  onHide,
  onMove,
  onSwitch,
  twoColumns,
}: {
  item: BoardItem;
  label: string;
  height: number;
  onHide(): void;
  onMove(delta: number): void;
  onSwitch(): void;
  twoColumns: boolean;
}) {
  // A group, not a button: the box holds buttons of its own, and a button may hold none. It still takes the focus,
  // for the keyboard.
  const { setNodeRef: setDragRef, attributes, listeners, isDragging } = useDraggable({
    id: item.key,
    data: { ref: item.ref, label, height },
    attributes: { role: 'group', roleDescription: 'movable section' },
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `before:${item.key}`,
    data: { kind: 'before', ref: item.ref, column: item.column } satisfies Drop,
  });
  const small =
    'flex size-5 items-center justify-center rounded-tag text-muted-foreground hover:bg-pressed group-hover:text-on-primary group-hover:hover:bg-on-primary/20';
  const stop = (event: { stopPropagation(): void }) => event.stopPropagation();
  const name = `${label}${item.continued ? ' (continued)' : ''}`;
  return (
    <div
      ref={(element) => {
        setDragRef(element);
        setDropRef(element);
      }}
      {...attributes}
      {...listeners}
      aria-label={name}
      data-board-key={boardKey(item)}
      className={clsx(
        'group relative flex shrink-0 cursor-grab touch-none items-center justify-center rounded-control border border-primary-200 bg-primary-50 px-5 text-center',
        'text-xs font-medium text-primary-ink transition-[height,background-color,color,border-color] duration-200 outline-none',
        'hover:border-primary hover:bg-primary hover:text-on-primary focus-visible:ring-2 focus-visible:ring-primary active:cursor-grabbing',
        isDragging && 'opacity-40',
      )}
      style={{ height }}
    >
      {isOver && !isDragging ? (
        <span aria-hidden="true" className="absolute inset-x-0 -top-[5px] h-[3px] rounded-full bg-primary" />
      ) : null}
      <DotsSixVerticalIcon size={12} weight="bold" aria-hidden="true" className="absolute top-1 left-1 opacity-60" />
      <span className={clsx('max-w-full min-w-0 break-words', height < 40 ? 'truncate' : 'line-clamp-2')}>
        {item.continued ? `${label} (cont.)` : label}
      </span>
      <span className="absolute top-0.5 right-0.5 flex">
        {/* For the keyboard: shown when the box or one of these has the keyboard's focus (not a click's). */}
        <span className="hidden gap-0.5 group-focus-visible:flex group-has-[:focus-visible]:flex">
          <button type="button" className={small} aria-label={`Move ${label} up`} onPointerDown={stop} onClick={() => onMove(-1)}>
            <ArrowUpIcon size={12} />
          </button>
          <button type="button" className={small} aria-label={`Move ${label} down`} onPointerDown={stop} onClick={() => onMove(1)}>
            <ArrowDownIcon size={12} />
          </button>
          {twoColumns ? (
            <button
              type="button"
              className={small}
              aria-label={`Move ${label} to the other column`}
              onPointerDown={stop}
              onClick={onSwitch}
            >
              <ArrowsLeftRightIcon size={12} />
            </button>
          ) : null}
        </span>
        <button
          type="button"
          className={clsx(small, 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 group-has-[:focus-visible]:opacity-100')}
          aria-label={`Remove ${label}`}
          onPointerDown={stop}
          onClick={onHide}
        >
          <XIcon size={12} />
        </button>
      </span>
    </div>
  );
}

/** The rest of a column on a page: a drop there goes after its last section. */
function EndZone({ page, column }: { page: number; column: BoardColumnName }) {
  const { setNodeRef, isOver } = useDroppable({ id: `end:${page}:${column}`, data: { kind: 'end', page, column } satisfies Drop });
  return (
    <div ref={setNodeRef} className="relative min-h-6 flex-1">
      {isOver ? <span aria-hidden="true" className="absolute inset-x-0 top-0.5 h-[3px] rounded-full bg-primary" /> : null}
    </div>
  );
}

/**
 * After every change of the board, each box that moved slides from where it was (in the board's own coordinates, so
 * scrolling the dialog moves nothing). Not for someone who asked their system for less motion.
 */
function useSlide(board: RefObject<HTMLElement | null>) {
  const places = useRef(new Map<string, { left: number; top: number }>());
  useLayoutEffect(() => {
    const root = board.current;
    if (!root) return;
    const origin = root.getBoundingClientRect();
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const next = new Map<string, { left: number; top: number }>();
    for (const element of root.querySelectorAll<HTMLElement>('[data-board-key]')) {
      const key = element.dataset.boardKey ?? '';
      const rect = element.getBoundingClientRect();
      const place = { left: rect.left - origin.left + root.scrollLeft, top: rect.top - origin.top + root.scrollTop };
      next.set(key, place);
      const before = places.current.get(key);
      if (still || !before || (before.left === place.left && before.top === place.top)) continue;
      element.animate(
        [{ transform: `translate(${before.left - place.left}px, ${before.top - place.top}px)` }, { transform: 'none' }],
        { duration: SLIDE_MS, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
      );
    }
    places.current = next;
  });
}

export function RearrangeDialog({ open, onClose, document, store }: { open: boolean; onClose(): void; document: ResumeDocument; store: EditorStore }) {
  const [measured, setMeasured] = useState<{ plan: PagePlan; heights: Readonly<Record<string, number>> } | null>(null);
  const wordings = useEditorField().copy.sections; // v33 ROLES: the field's section names ("Skills" for a nurse)
  const [dragging, setDragging] = useState<{ label: string; height: number } | null>(null);
  const spec = RESUME_TEMPLATES[effectiveTemplateId(document)];
  const twoColumns = spec.columns === 2;
  const columns: BoardColumnName[] = twoColumns ? ['main', 'side'] : ['main'];
  // The page's own geometry and the space above each box, for a board at the page's proportions.
  const layout = useMemo(() => layoutResume(document, 'static', viewOf(document, 'static')), [document]);
  const margins = useMemo(
    () => new Map([...layout.flows.main, ...layout.flows.side].map((box) => [box.id, box.marginTop])),
    [layout],
  );
  const board = measured
    ? boardOf(measured.plan, columns, (id) => {
        const height = measured.heights[id];
        return height === undefined ? undefined : { height, marginTop: margins.get(id) ?? 0 };
      })
    : [];
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const onPlan = useCallback((plan: PagePlan, heights: Readonly<Record<string, number>>) => setMeasured({ plan, heights }), []);
  const boardRef = useRef<HTMLDivElement | null>(null);
  useSlide(boardRef);

  // Everything done here is one undo step.
  useEffect(() => {
    if (!open) return;
    store.begin('Rearranged the sections');
    return () => store.end();
  }, [open, store]);

  const geometry = layout.geometry;
  const scale = BOARD_PAGE_WIDTH / geometry.pageWidth;
  const sized = (height: number) => Math.max(MIN_BOX_PX, Math.round(height * scale));
  const columnsInOrder = [...columns].sort((a, b) => (geometry[a]?.x ?? 0) - (geometry[b]?.x ?? 0));

  const onDragStart = ({ active }: DragStartEvent) => {
    const data = active.data.current as { label?: string; height?: number } | undefined;
    setDragging({ label: data?.label ?? '', height: data?.height ?? MIN_BOX_PX });
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(null);
    const moved = (active.data.current as { ref?: string } | undefined)?.ref;
    const drop = over?.data.current as Drop | undefined;
    if (!moved || !drop) return;
    const target = dropTarget(board, moved, drop);
    if (target) store.moveSectionTo(moved, target);
  };
  const switchColumn = (item: BoardItem) => {
    const other: BoardColumnName = item.column === 'main' ? 'side' : 'main';
    store.moveSectionTo(item.ref, { column: other, index: columnOrder(board, other).length });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent title="Rearrange sections" help="Drag the boxes to reorder the sections." size="md">
        <DndContext
          sensors={sensors}
          collisionDetection={pointerWithin}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={() => setDragging(null)}
        >
          <div ref={boardRef} className="relative flex max-h-[min(70vh,760px)] flex-col items-center gap-5 overflow-y-auto py-1">
            {board.map((page) => (
              <div key={page.page} className="flex flex-col items-center gap-1.5">
                <span className="num text-xs text-muted-foreground">
                  Page {page.page + 1} of {board.length}
                </span>
                <div
                  className="flex flex-col rounded-control border border-border bg-surface shadow-card"
                  style={{
                    width: BOARD_PAGE_WIDTH,
                    minHeight: Math.round(geometry.pageHeight * scale),
                    padding: Math.max(6, Math.round(geometry.margin * scale)),
                    gap: 4,
                  }}
                >
                  {page.page === 0 ? (
                    <div
                      className="relative flex shrink-0 items-center justify-center rounded-control border border-border bg-surface-muted text-xs text-muted-foreground"
                      style={{ height: sized(measured?.heights.header ?? 0) }}
                    >
                      <LockSimpleIcon size={12} aria-hidden="true" className="absolute top-1 left-1" />
                      Header
                    </div>
                  ) : null}
                  <div className="flex flex-1" style={{ gap: Math.max(4, Math.round(geometry.columnGap * scale)) }}>
                    {columnsInOrder.map((column) => (
                      <div
                        key={column}
                        className="flex min-w-0 flex-col gap-1"
                        style={{
                          width: twoColumns ? Math.round((geometry[column]?.width ?? 0) * scale) : '100%',
                        }}
                      >
                        {page.columns[column].map((item) => (
                          <SectionBox
                            key={boardKey(item)}
                            item={item}
                            label={sectionLabel(document, item.ref, wordings)}
                            height={sized(item.height)}
                            twoColumns={twoColumns}
                            onHide={() => store.disableSection(item.ref)}
                            onMove={(delta) => store.moveSection(item.ref, delta)}
                            onSwitch={() => switchColumn(item)}
                          />
                        ))}
                        <EndZone page={page.page} column={column} />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
          {/* The box being dragged, following the pointer (out of the dialog, whose transform would offset it). */}
          {createPortal(
            <DragOverlay zIndex={1000} dropAnimation={null}>
              {dragging ? (
                <div
                  className="flex h-full w-full cursor-grabbing items-center justify-center rounded-control bg-primary px-5 text-center text-xs font-medium text-on-primary shadow-popover"
                  style={{ minHeight: dragging.height }}
                >
                  <DotsSixVerticalIcon size={12} weight="bold" aria-hidden="true" className="absolute top-1 left-1 opacity-80" />
                  <span className="line-clamp-2">{dragging.label}</span>
                </div>
              ) : null}
            </DragOverlay>,
            globalThis.document.body,
          )}
        </DndContext>
        <DialogFooter>
          <Button onClick={onClose}>Continue editing</Button>
        </DialogFooter>
        {open ? (
          // The resume as it prints, off screen: its plan and its boxes' heights lay out the board.
          <div aria-hidden="true" inert className="pointer-events-none fixed top-0 -left-[10000px] w-[816px] opacity-0">
            <ResumeCanvas document={document} mode="static" onPlan={onPlan} />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
