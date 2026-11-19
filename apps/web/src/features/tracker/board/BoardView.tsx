'use client';

import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
} from '@dnd-kit/core';
import { clsx } from 'clsx';
import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  STATUS,
  STATUS_INFO,
  hideColumn,
  isApplicationStatus,
  isDraftStatus,
  type ApplicationStatus,
  type ApplicationSummary,
  type BoardColumn,
  type ColumnPrefs,
  type DisplayStatus,
} from '@tailorit/shared';
import { useReducedMotion } from '@/components/queue';
import { PAGE_GUTTER } from '@/components/shell/layout';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconButton } from '@/components/ui/IconButton';
import { Skeleton } from '@/components/ui/Skeleton';
import { Spinner } from '@/components/ui/Spinner';
import { ArchiveIcon, EyeSlashIcon } from '@/components/ui/icons';
import { usePublicConstants } from '@/lib/constants';
import { STAGE_TOKEN } from '../chart/FlowChart';
import { laneEmptyText } from '../stage';
import { NO_MATCH_COLUMN_TEXT } from '../state';
import { DisplayStatusIcon } from '../status';
import { ApplicationCard, CARD_SURFACE, CardFace, type CardHandlers } from './ApplicationCard';
import { StageSwitcher, type SwitcherLane } from './StageSwitcher';

const COLUMN_ID = (status: DisplayStatus) => `column-${status}`;
/** v20 A30: the Draft column's empty words (a card gets there through Prepare & Queue, never by a drop). */
export const DRAFT_EMPTY_TEXT = 'Prepare & Queue saved jobs on the Auto-apply page.';
/** The optional Archived lane ("Lanes shown" lists it after the statuses). */
const ARCHIVED_ID = 'column-archived';

/** Where a dragged card comes from: a status column, or the Archived column. */
type Source = ApplicationStatus | 'archived';
const sourceOf = (application: ApplicationSummary): Source => (application.archivedAt ? 'archived' : application.currentStatus);

/** Pointer drags use the column under the pointer; the keyboard (no pointer) uses the card's rectangle. */
const collisions: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length > 0 ? hits : rectIntersection(args);
};

/** Left and right arrows jump the dragged card to the neighbouring column (dnd-kit moves 25 px by default). */
const columnCoordinates: KeyboardCoordinateGetter = (event, { context }) => {
  const { collisionRect, droppableRects, droppableContainers } = context;
  if (!collisionRect || (event.code !== 'ArrowRight' && event.code !== 'ArrowLeft')) return undefined;
  event.preventDefault();
  const columns = droppableContainers
    .getEnabled()
    .map((container) => droppableRects.get(container.id))
    .filter((rect): rect is NonNullable<typeof rect> => Boolean(rect))
    .sort((a, b) => a.left - b.left);
  const center = collisionRect.left + collisionRect.width / 2;
  const index = columns.findIndex((rect) => center >= rect.left && center <= rect.right);
  const target = event.code === 'ArrowRight' ? columns[index + 1] : columns[index - 1];
  if (!target) return undefined;
  return { x: target.left, y: Math.max(target.top, collisionRect.top) };
};

function statusOf(id: string | number | undefined): ApplicationStatus | null {
  const status = Number(String(id ?? '').replace('column-', ''));
  return isApplicationStatus(status) ? status : null;
}

/**
 * An empty lane's stitched box over pattern paper: "Nothing here yet" and what to do, or "Drop to move it here" under a
 * dragged card (denim border, denim wash). v31 FIX-DOCS: the constants' words. v32 FIX-UX (UXREQ-8, the coordinator:
 * next steps stay visible): what to do is a line under the title (it was the "?" beside it), with its link where the
 * step is on another page (Saved: Find jobs; Draft: Go to Auto-apply); a lane a search or filter emptied says so as its
 * title ("None match your search or filters.").
 */
function EmptyColumn({
  next,
  link,
  filtered,
  dropping,
}: {
  next: string;
  link?: { href: string; label: string } | null;
  filtered: boolean;
  dropping: boolean;
}) {
  const { t } = usePublicConstants();
  return (
    <div
      data-empty-lane=""
      className={clsx(
        'flex h-[155px] shrink-0 flex-col items-center justify-center gap-1 rounded-card border-[1.5px] border-dashed px-4 text-center',
        dropping ? 'border-primary bg-primary-50' : 'paper-grid border-border-strong bg-surface',
      )}
    >
      <p className="text-sm font-semibold text-muted-foreground">
        {dropping ? t('MSG_TRACKER_LANE_DROP') : filtered ? NO_MATCH_COLUMN_TEXT : t('MSG_TRACKER_LANE_EMPTY_TITLE')}
      </p>
      {!dropping && !filtered && (
        <>
          <p className="max-w-full text-[13px] leading-5 text-muted-foreground" data-empty-lane-next="">
            {next}
          </p>
          {link && (
            <Link href={link.href} className="mt-1 text-[13px] font-medium text-primary underline-offset-2 hover:underline" data-empty-lane-link="">
              {link.label}
            </Link>
          )}
        </>
      )}
    </div>
  );
}

/** Where an empty lane's next step happens, when it is on another page. */
function laneLink(status: DisplayStatus): { href: string; label: string } | null {
  if (isDraftStatus(status)) return { href: '/auto-apply', label: 'Go to Auto-apply' };
  if (status === STATUS.saved) return { href: '/jobs', label: 'Find jobs' };
  return null;
}

function LoadMore({ onLoad, loading }: { onLoad: () => void; loading: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  // Infinite scroll inside the column: loading starts when the button scrolls into view.
  useEffect(() => {
    const node = ref.current;
    if (!node || loading) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onLoad();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [onLoad, loading]);
  return (
    <div ref={ref} className="flex justify-center py-1">
      <Button variant="ghost" size="sm" onClick={onLoad} loading={loading}>
        Load more applications
      </Button>
    </div>
  );
}

/** The token of a lane's top edge: the chart's stage colour (Draft a denim tint, Archived the strong border). */
function laneToken(status: DisplayStatus | 'archived'): string {
  if (status === 'archived') return '--color-border-strong';
  if (isDraftStatus(status)) return '--color-primary-200';
  return STAGE_TOKEN[status];
}

/**
 * The lane's frame (v31 FIX-DOCS): a grey lane with a 3 px edge in its stage's colour along the top.
 *
 * v32 LAYOUT (E9, the owner: "All shown view width will be same, and every board view width will be changed by current
 * the number of shown boards and current page width"): every lane shown has the same width, which follows how many are
 * shown and the board's width. From 640 px the lanes share the board's width equally (`flex: 1 1 0`), never narrower
 * than LANE_MIN_REM (264 px: a card stays readable, and five lanes fit a 1440 px window); v32 FIX-UX (UXREQ-6, the
 * coordinator): no widest, so the lanes shown always fill the board, one lane or two included. When the lanes shown do
 * not fit at the minimum, the board scrolls sideways and stops at a lane's start (scroll snap). Hiding or showing a
 * lane re-flows them. A phone (below 640 px) shows one lane at a time, the board's width between its two gutters, with
 * the stage switcher above (StageSwitcher, which names the lane: the lane draws no header of its own there) and a
 * swipe that stops at each lane.
 */
const LANE = clsx(
  'flex h-full snap-start flex-col rounded-card bg-surface-muted',
  'max-sm:w-[calc(100%-1rem)] max-sm:flex-none max-sm:snap-always max-sm:pt-2',
  'sm:min-w-66 sm:flex-[1_1_0%]',
);
/** The narrowest a lane gets beside the others (rem), as LANE's `min-w-66` draws it. */
export const LANE_MIN_REM = 16.5;

/**
 * The lane's header: its glyph, name and count, and its hide button (v32 LAYOUT, E11: none on the only lane shown, so
 * the board keeps one, as Lanes shown does).
 */
function LaneHeader({ icon, label, count, onHide }: { icon: ReactNode; label: string; count: number; onHide: (() => void) | null }) {
  const { t } = usePublicConstants();
  return (
    // v32 FIX-UX (UXREQ-5): a phone's switcher above names the lane and counts it; the lane itself starts with its cards
    // (Lanes shown in ⋮ hides one there). The lane's region keeps its name and count for screen readers.
    <header className="flex h-12 shrink-0 items-center gap-2 pr-1.5 pl-3 max-sm:hidden">
      <span aria-hidden="true" className="flex size-6 items-center justify-center rounded-tag border border-border bg-surface text-muted-foreground">
        {icon}
      </span>
      <h2 className="truncate text-sm font-semibold text-foreground">{label}</h2>
      <span className="num text-xs text-muted-foreground">{count}</span>
      {onHide && <IconButton label={t('LABEL_TRACKER_HIDE_LANE')} size="sm" className="ml-auto" icon={<EyeSlashIcon size={18} />} onClick={onHide} />}
    </header>
  );
}

function Column({
  column,
  prefs,
  onPrefsChange,
  onHideDraft,
  draftLabel,
  activeFrom,
  renderCard,
  onLoadMore,
  loadingMore,
  filtered,
  laneId,
  canHide,
}: {
  column: BoardColumn;
  prefs: ColumnPrefs;
  onPrefsChange: (prefs: ColumnPrefs) => void;
  onHideDraft: () => void;
  /** Draft's words (the constant STATUS_DRAFT_LABEL). */
  draftLabel: string;
  /** The column the dragged card comes from (no highlight over its own column). */
  activeFrom: Source | null;
  renderCard: (application: ApplicationSummary) => ReactNode;
  onLoadMore: (status: DisplayStatus) => void;
  loadingMore: boolean;
  /** A search or filter narrows the board. */
  filtered: boolean;
  /** v32 LAYOUT: the lane's element id (the phone's stage switcher controls it). */
  laneId: string;
  /** v32 LAYOUT (E11): other lanes are shown, so this one can be hidden. */
  canHide: boolean;
}) {
  const { status } = column;
  const draft = isDraftStatus(status);
  const label = draft ? draftLabel : STATUS_INFO[status].label;
  // v20 A30: Draft is derived (a Saved entry in the queue), so nothing is dropped into it.
  const { setNodeRef, isOver } = useDroppable({ id: COLUMN_ID(status), data: { status }, disabled: draft });
  const dropping = !draft && isOver && activeFrom !== null && activeFrom !== status;
  const loadMore = useCallback(() => onLoadMore(status), [onLoadMore, status]);
  const { t } = usePublicConstants();
  return (
    <section
      id={laneId}
      aria-label={`${label}, ${column.total}`}
      data-column={status}
      className={LANE}
      style={{ boxShadow: `inset 0 3px 0 var(${laneToken(status)})` }}
    >
      <LaneHeader
        icon={<DisplayStatusIcon status={status} size={14} />}
        label={label}
        count={column.total}
        onHide={canHide ? () => (isDraftStatus(status) ? onHideDraft() : onPrefsChange(hideColumn(prefs, status))) : null}
      />
      <div
        ref={setNodeRef}
        className={clsx(
          'flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto overscroll-contain rounded-b-card px-2 pt-0.5 pb-3 transition-colors duration-150',
          dropping && column.items.length > 0 && 'bg-primary-50 outline outline-1 -outline-offset-1 outline-primary/40',
        )}
      >
        {column.items.length === 0 ? (
          <EmptyColumn
            next={isDraftStatus(status) ? DRAFT_EMPTY_TEXT : laneEmptyText(status, t)}
            link={laneLink(status)}
            filtered={filtered}
            dropping={dropping}
          />
        ) : (
          column.items.map(renderCard)
        )}
        {column.nextCursor && <LoadMore onLoad={loadMore} loading={loadingMore} />}
      </div>
    </section>
  );
}

export interface ArchivedColumnModel {
  /** null while the first page loads. */
  items: ApplicationSummary[] | null;
  total: number;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onHide: () => void;
}

/** The Archived column: archived cards (restore by dragging them out), and a drop target that archives. */
function ArchivedColumn({
  model,
  activeFrom,
  renderCard,
  filtered,
  laneId,
  canHide,
}: {
  model: ArchivedColumnModel;
  activeFrom: Source | null;
  renderCard: (application: ApplicationSummary) => ReactNode;
  filtered: boolean;
  laneId: string;
  canHide: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: ARCHIVED_ID });
  const dropping = isOver && activeFrom !== null && activeFrom !== 'archived';
  const items = model.items ?? [];
  const { t } = usePublicConstants();
  return (
    <section
      id={laneId}
      aria-label={`Archived, ${model.total}`}
      data-column="archived"
      className={LANE}
      style={{ boxShadow: `inset 0 3px 0 var(${laneToken('archived')})` }}
    >
      <LaneHeader icon={<ArchiveIcon size={14} />} label="Archived" count={model.total} onHide={canHide ? model.onHide : null} />
      <div
        ref={setNodeRef}
        className={clsx(
          'flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto overscroll-contain rounded-b-card px-2 pt-0.5 pb-3 transition-colors duration-150',
          dropping && items.length > 0 && 'bg-primary-50 outline outline-1 -outline-offset-1 outline-primary/40',
        )}
      >
        {model.items === null ? (
          <Skeleton className="h-[155px] w-full" rounded="surface" />
        ) : items.length === 0 ? (
          <EmptyColumn next={t('MSG_TRACKER_ARCHIVED_LANE_EMPTY')} filtered={filtered} dropping={dropping} />
        ) : (
          items.map(renderCard)
        )}
        {model.hasMore && <LoadMore onLoad={model.onLoadMore} loading={model.loadingMore} />}
      </div>
    </section>
  );
}

export interface BoardViewProps {
  columns: BoardColumn[] | null;
  /** The columns to show, in order (boardColumnsShown: Draft between Saved and Applied). */
  visible: readonly DisplayStatus[];
  prefs: ColumnPrefs;
  onPrefsChange: (prefs: ColumnPrefs) => void;
  /** v20 A30: the Draft column's eye. */
  onHideDraft: () => void;
  /** Draft's words (the constant STATUS_DRAFT_LABEL). */
  draftLabel: string;
  handlers: CardHandlers;
  openId: string | null;
  selectMode: boolean;
  selected: ReadonlySet<string>;
  onLoadMore: (status: DisplayStatus) => void;
  loadingMore: DisplayStatus | null;
  /** A card was dropped on another column. */
  onDrop: (application: ApplicationSummary, to: ApplicationStatus) => void;
  /** The Archived column, when it is shown. */
  archived: ArchivedColumnModel | null;
  /** A card was dropped on the Archived column. */
  onArchiveDrop: (application: ApplicationSummary) => void;
  /** An archived card was dropped on a status column. */
  onRestoreDrop: (application: ApplicationSummary, to: ApplicationStatus) => void;
  refreshing: boolean;
  /** A search or filter narrows the board: empty columns say so, and a board with no match at all says it once. */
  filtered: boolean;
}

/**
 * The board: status lanes side by side, all the same width (v32 LAYOUT: they share the board's width, LANE), cards
 * dragged between them (dnd-kit); on a phone one lane at a time with the stage switcher.
 */
export function BoardView({
  columns,
  visible,
  prefs,
  onPrefsChange,
  onHideDraft,
  draftLabel,
  handlers,
  openId,
  selectMode,
  selected,
  onLoadMore,
  loadingMore,
  onDrop,
  archived,
  onArchiveDrop,
  onRestoreDrop,
  refreshing,
  filtered,
}: BoardViewProps) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor, {
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter'] },
      coordinateGetter: columnCoordinates,
    }),
  );
  const [active, setActive] = useState<ApplicationSummary | null>(null);
  const justDropped = useRef(false);
  const { t } = usePublicConstants();
  const reduced = useReducedMotion();
  const laneIds = useId();
  const laneId = (key: DisplayStatus | 'archived') => `${laneIds}-lane-${key}`;
  // v32 LAYOUT (E9): the board's scroll box (state, so following it starts whenever it mounts: after a "no match"
  // board too), and the lane at its start (the phone's stage switcher marks it).
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const laneKeys = [...visible, ...(archived ? ['archived'] : [])].join(',');
  const canHideLane = visible.length + (archived ? 1 : 0) > 1;
  const activeLane = useLaneAtStart(scroller, laneKeys);
  const goToLane = (index: number) => {
    const node = scroller;
    const lane = node?.querySelectorAll<HTMLElement>(':scope > [data-column]')[index];
    if (!node || !lane) return;
    node.scrollTo({ left: lane.offsetLeft - parseFloat(getComputedStyle(node).paddingLeft || '0'), behavior: reduced ? 'auto' : 'smooth' });
  };

  const consumeDragClick = useCallback(() => {
    if (!justDropped.current) return false;
    justDropped.current = false;
    return true;
  }, []);

  const onDragStart = (event: DragStartEvent) => {
    const application = event.active.data.current?.application as ApplicationSummary | undefined;
    setActive(application ?? null);
  };

  const onDragEnd = (event: DragEndEvent) => {
    const application = event.active.data.current?.application as ApplicationSummary | undefined;
    setActive(null);
    // The click that ends a mouse drag must not open the card.
    justDropped.current = true;
    window.setTimeout(() => {
      justDropped.current = false;
    }, 0);
    if (!application || !event.over) return;
    if (event.over.id === ARCHIVED_ID) {
      if (!application.archivedAt) onArchiveDrop(application);
      return;
    }
    const to = statusOf(event.over.id);
    if (to === null) return;
    if (application.archivedAt) onRestoreDrop(application, to);
    else if (to !== application.currentStatus) onDrop(application, to);
  };

  const label = (id: string | number) => {
    for (const column of columns ?? []) {
      const found = column.items.find((item) => item.id === id);
      if (found) return found.title;
    }
    return archived?.items?.find((item) => item.id === id)?.title ?? 'The application';
  };
  const columnName = (id: string | number | undefined) => {
    if (id === ARCHIVED_ID) return 'Archived';
    const status = statusOf(id);
    return status !== null ? STATUS_INFO[status].label : null;
  };
  const announcements: Announcements = {
    onDragStart: ({ active: dragged }) =>
      `Picked up ${label(dragged.id)}. Use the left and right arrow keys to move it to another status, Space to drop it, Escape to cancel.`,
    onDragOver: ({ active: dragged, over }) => {
      const name = columnName(over?.id);
      return name ? `${label(dragged.id)} is over ${name}.` : `${label(dragged.id)} is not over a column.`;
    },
    onDragEnd: ({ active: dragged, over }) => {
      const name = columnName(over?.id);
      return name ? `${label(dragged.id)} was dropped in ${name}.` : `${label(dragged.id)} was dropped.`;
    },
    onDragCancel: ({ active: dragged }) => `Moving ${label(dragged.id)} was cancelled.`,
  };

  const byStatus = new Map((columns ?? []).map((column) => [column.status, column] as const));
  const activeFrom = active ? sourceOf(active) : null;
  // The phone's stage switcher: every lane shown, with its count.
  const switcherLanes: SwitcherLane[] = [
    ...visible.map((status) => ({
      id: laneId(status),
      label: isDraftStatus(status) ? draftLabel : STATUS_INFO[status].label,
      count: byStatus.get(status)?.total ?? 0,
      icon: <DisplayStatusIcon status={status} size={14} />,
    })),
    ...(archived ? [{ id: laneId('archived'), label: 'Archived', count: archived.total, icon: <ArchiveIcon size={14} /> }] : []),
  ];

  const renderCard = (application: ApplicationSummary) => (
    <ApplicationCard
      key={application.id}
      application={application}
      handlers={handlers}
      selected={openId === application.id}
      selectMode={selectMode}
      checked={selected.has(application.id)}
      draggingAny={active !== null}
      consumeDragClick={consumeDragClick}
    />
  );

  // Nothing anywhere matches the search or filters: one message (the list's) instead of a row of empty columns.
  const nothingMatches =
    filtered &&
    columns !== null &&
    columns.every((column) => column.total === 0) &&
    (archived === null || (archived.items !== null && archived.items.length === 0));
  if (nothingMatches) {
    return (
      <div className={clsx('pt-1', PAGE_GUTTER)}>
        <div className="rounded-card border border-border bg-surface shadow-card">
          <EmptyState title={t('MSG_TRACKER_NO_MATCH_TITLE')} description={t('MSG_TRACKER_NO_MATCH_TEXT')} />
        </div>
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisions}
      // Scroll the board only when the pointer is near its edges (dnd-kit's default zone is 20% of its width, which
      // keeps scrolling while a card waits over the first or last visible column).
      autoScroll={{ threshold: { x: 0.08, y: 0.15 }, acceleration: 8 }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActive(null)}
      accessibility={{
        announcements,
        screenReaderInstructions: {
          draggable:
            'Press Enter to open this application. To move it, press Space, use the left and right arrow keys to choose a status, then press Space again to drop it.',
        },
      }}
    >
      <div className="flex h-full min-h-0 flex-col">
        {columns !== null && <StageSwitcher lanes={switcherLanes} active={activeLane} onGo={goToLane} reduced={reduced} />}
        <div
          ref={setScroller}
          aria-busy={refreshing || undefined}
          data-board-scroller=""
          className={clsx(
            // The lanes are this box's children (LANE); the left gutter is its padding, the right one the spacer after them.
            'relative flex min-h-0 flex-1 gap-4 overflow-x-auto overflow-y-hidden overscroll-x-contain pt-1 pb-4 sm:gap-3',
            'pl-4 sm:pl-6 lg:pl-7 scroll-pl-4 sm:scroll-pl-6 lg:scroll-pl-7',
            // Snap to a lane's start (each one on a phone); off while a card is dragged, so the board scrolls freely under it.
            active ? 'snap-none' : 'snap-x snap-mandatory sm:snap-proximity',
          )}
        >
          {columns === null
            ? visible.map((status) => <ColumnSkeleton key={status} status={status} draftLabel={draftLabel} />)
            : visible.map((status) => {
                const column = byStatus.get(status) ?? { status, total: 0, items: [] };
                return (
                  <Column
                    key={status}
                    column={column}
                    prefs={prefs}
                    onPrefsChange={onPrefsChange}
                    onHideDraft={onHideDraft}
                    draftLabel={draftLabel}
                    activeFrom={activeFrom}
                    renderCard={renderCard}
                    onLoadMore={onLoadMore}
                    loadingMore={loadingMore === status}
                    filtered={filtered}
                    laneId={laneId(status)}
                    canHide={canHideLane}
                  />
                );
              })}
          {archived && (
            <ArchivedColumn
              model={archived}
              activeFrom={activeFrom}
              renderCard={renderCard}
              filtered={filtered}
              laneId={laneId('archived')}
              canHide={canHideLane}
            />
          )}
          {/* The right gutter after the last lane: the gap before it plus its width (16 px on a phone, 24, 28 from 1024). */}
          <div aria-hidden="true" data-board-end="" className="w-0 shrink-0 sm:w-3 lg:w-4" />
        </div>
      </div>
      <DragOverlay dropAnimation={null}>
        {active ? (
          // The overlay box has the dragged card's size (dnd-kit), whatever its lane's width.
          <div className={clsx(CARD_SURFACE, 'relative w-full rotate-[1.5deg] cursor-grabbing border-primary bg-surface shadow-popover')}>
            <CardFace
              application={active}
              title={<p className="line-clamp-2 text-[15px] leading-5 font-semibold break-words text-foreground">{active.title}</p>}
            />
          </div>
        ) : null}
      </DragOverlay>
      {refreshing && (
        <span className="sr-only" role="status">
          <Spinner label="Updating the board" />
        </span>
      )}
    </DndContext>
  );
}

function ColumnSkeleton({ status, draftLabel }: { status: DisplayStatus; draftLabel: string }) {
  return (
    <section aria-hidden="true" className={LANE} style={{ boxShadow: `inset 0 3px 0 var(${laneToken(status)})` }}>
      <header className="flex h-12 shrink-0 items-center gap-2 pr-1.5 pl-3 max-sm:hidden">
        <span className="flex size-6 items-center justify-center rounded-tag border border-border bg-surface text-muted-foreground">
          <DisplayStatusIcon status={status} size={14} />
        </span>
        <span className="text-sm font-semibold text-foreground">{isDraftStatus(status) ? draftLabel : STATUS_INFO[status].label}</span>
      </header>
      <div className="flex flex-col gap-2.5 px-2">
        {[0, 1].map((index) => (
          <div key={index} className={clsx(CARD_SURFACE, 'border-border bg-surface shadow-card')}>
            <div className="flex items-center gap-2.5">
              <Skeleton className="size-8" rounded="control" />
              <Skeleton className="h-3.5 w-32" />
            </div>
            <Skeleton className="mt-4 h-3.5 w-48" />
            <Skeleton className="mt-3 h-3 w-24" />
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * v32 LAYOUT (E9): the index of the lane at the board's start (where a phone shows its one lane), followed as the board
 * scrolls; `lanes` names the lanes shown, so a change of lanes reads it again.
 */
function useLaneAtStart(node: HTMLDivElement | null, lanes: string): number {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!node) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const start = node.getBoundingClientRect().left + parseFloat(getComputedStyle(node).paddingLeft || '0');
      const lefts = [...node.querySelectorAll<HTMLElement>(':scope > [data-column]')].map((lane) => lane.getBoundingClientRect().left);
      setIndex(laneAt(lefts, start));
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    node.addEventListener('scroll', onScroll, { passive: true });
    frame = window.requestAnimationFrame(measure);
    return () => {
      node.removeEventListener('scroll', onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [node, lanes]);
  return index;
}

/** The lane whose left edge is nearest `start` (the board's start, past its gutter); 0 when there is none. */
export function laneAt(lefts: readonly number[], start: number): number {
  let best = 0;
  let distance = Number.POSITIVE_INFINITY;
  lefts.forEach((left, index) => {
    const away = Math.abs(left - start);
    if (away < distance) {
      best = index;
      distance = away;
    }
  });
  return best;
}
