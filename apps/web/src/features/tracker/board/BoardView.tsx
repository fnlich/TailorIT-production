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
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
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
 * dragged card (denim border, denim wash). v31 FIX-DOCS: the constants' words.
 */
function EmptyColumn({ text, dropping }: { text: string; dropping: boolean }) {
  const { t } = usePublicConstants();
  return (
    <div
      className={clsx(
        'flex h-[155px] shrink-0 flex-col items-center justify-center gap-1 rounded-card border-[1.5px] border-dashed px-4 text-center',
        dropping ? 'border-primary bg-primary-50' : 'paper-grid border-border-strong bg-surface',
      )}
    >
      <p className="text-sm font-semibold text-muted-foreground">{dropping ? t('MSG_TRACKER_LANE_DROP') : t('MSG_TRACKER_LANE_EMPTY_TITLE')}</p>
      {!dropping && <p className="text-xs text-muted-foreground">{text}</p>}
    </div>
  );
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

/** The lane's frame (v31 FIX-DOCS): a grey lane with a 3 px edge in its stage's colour along the top. */
const LANE = 'flex h-full w-[296px] shrink-0 flex-col rounded-card bg-surface-muted sm:w-[312px]';

/** The lane's header: its glyph, name and count, and its hide button. */
function LaneHeader({ icon, label, count, onHide }: { icon: ReactNode; label: string; count: number; onHide: () => void }) {
  const { t } = usePublicConstants();
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 pr-1.5 pl-3">
      <span aria-hidden="true" className="flex size-6 items-center justify-center rounded-tag border border-border bg-surface text-muted-foreground">
        {icon}
      </span>
      <h2 className="truncate text-sm font-semibold text-foreground">{label}</h2>
      <span className="num text-xs text-muted-foreground">{count}</span>
      <IconButton label={t('LABEL_TRACKER_HIDE_LANE')} size="sm" className="ml-auto" icon={<EyeSlashIcon size={18} />} onClick={onHide} />
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
      aria-label={`${label}, ${column.total}`}
      data-column={status}
      className={LANE}
      style={{ boxShadow: `inset 0 3px 0 var(${laneToken(status)})` }}
    >
      <LaneHeader
        icon={<DisplayStatusIcon status={status} size={14} />}
        label={label}
        count={column.total}
        onHide={() => (isDraftStatus(status) ? onHideDraft() : onPrefsChange(hideColumn(prefs, status)))}
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
            text={
              filtered
                ? NO_MATCH_COLUMN_TEXT
                : isDraftStatus(status)
                  ? DRAFT_EMPTY_TEXT
                  : laneEmptyText(status, t)
            }
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
}: {
  model: ArchivedColumnModel;
  activeFrom: Source | null;
  renderCard: (application: ApplicationSummary) => ReactNode;
  filtered: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: ARCHIVED_ID });
  const dropping = isOver && activeFrom !== null && activeFrom !== 'archived';
  const items = model.items ?? [];
  const { t } = usePublicConstants();
  return (
    <section
      aria-label={`Archived, ${model.total}`}
      data-column="archived"
      className={LANE}
      style={{ boxShadow: `inset 0 3px 0 var(${laneToken('archived')})` }}
    >
      <LaneHeader icon={<ArchiveIcon size={14} />} label="Archived" count={model.total} onHide={model.onHide} />
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
          <EmptyColumn text={filtered ? NO_MATCH_COLUMN_TEXT : t('MSG_TRACKER_ARCHIVED_LANE_EMPTY')} dropping={dropping} />
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

/** The board: 312 px status lanes side by side, cards dragged between them (dnd-kit). */
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
      <div
        aria-busy={refreshing || undefined}
        className={clsx('flex h-full min-h-0 gap-3 overflow-x-auto overflow-y-hidden pt-1 pb-4', PAGE_GUTTER)}
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
                />
              );
            })}
        {archived && <ArchivedColumn model={archived} activeFrom={activeFrom} renderCard={renderCard} filtered={filtered} />}
        <div aria-hidden="true" className="w-px shrink-0" />
      </div>
      <DragOverlay dropAnimation={null}>
        {active ? (
          <div className={clsx(CARD_SURFACE, 'relative w-[280px] rotate-[1.5deg] cursor-grabbing border-primary bg-surface shadow-popover sm:w-[296px]')}>
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
      <header className="flex h-12 shrink-0 items-center gap-2 pr-1.5 pl-3">
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
