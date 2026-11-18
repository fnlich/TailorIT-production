'use client';

import { clsx } from 'clsx';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconButton } from '@/components/ui/IconButton';
import { MagnifyingGlassIcon, TrashIcon, XIcon } from '@/components/ui/icons';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePublicConstants } from '@/lib/constants';
import { BulkDeleteDialog } from './BulkDeleteDialog';
import { DocumentList, type DocumentListVariant } from './DocumentList';
import { focusDocument, neighbourOf } from './focusAfterRemoval';
import { describeMatches, matchesQuery, noMatchTitle } from './gallery';
import { SearchBox } from './SearchBox';
import type { DocumentColumn, DocumentKind, Noun, ViewMode } from './types';
import { useSelection } from './useSelection';
import { useViewMode, ViewToggle } from './ViewToggle';

export interface CardRenderContext {
  selectable: boolean;
  selected: boolean;
  onSelectedChange: (checked: boolean, options: { shiftKey: boolean }) => void;
}

export interface DocumentCollectionProps<T> {
  kind: DocumentKind;
  /** { one: 'resume', many: 'resumes' } */
  noun: Noun;
  /** Every document of the tab, already in display order (see newestFirst). */
  items: readonly T[];
  getId: (item: T) => string;
  getLabel: (item: T) => string;
  /** What the search matches (default: the label). */
  searchFields?: (item: T) => ReadonlyArray<string | null | undefined>;
  /**
   * Controlled search. With `onQueryChange` and `serverFiltered`, `items` are taken as already filtered and
   * `totalCount` is the unfiltered total for the status line.
   */
  query?: string;
  onQueryChange?: (query: string) => void;
  serverFiltered?: boolean;
  totalCount?: number;

  /**
   * The list view's rows (v31 FIX-DOCS: both draw the documents table in a bordered box inside the Documents panel;
   * "table" gives the actions column its header and a wider track, "cards" a ⋮ column). Default "table".
   */
  variant?: DocumentListVariant;
  /** Views offered; a toggle shows when there are two. Default ['list']. */
  views?: readonly ViewMode[];
  defaultView?: ViewMode;
  /** localStorage key remembering the view, e.g. "tailorit.documents.resumes.view". */
  viewStorageKey?: string;

  columns: readonly DocumentColumn<T>[];
  renderActions?: (item: T) => ReactNode;
  actionsHeader?: ReactNode;
  actionsTrack?: string;
  /** Grid view: one card per document (usually <DocumentCard/>), given the selection state. */
  renderCard?: (item: T, context: CardRenderContext) => ReactNode;
  /** Grid view: the first cell (<NewTile/>). */
  newTile?: ReactNode;

  /** Checkboxes, "{n} selected", clear, Select all (v20 P10) and bulk Delete. */
  selectable?: boolean;
  isSelectable?: (item: T) => boolean;
  /** Resolve once deleted (the list reloads from the caller); reject to keep the dialog open with the error. */
  onBulkDelete?: (ids: string[], items: T[]) => Promise<void> | void;
  /** A line in the confirmation, e.g. "1 default resume will be skipped". */
  bulkDeleteNote?: (items: T[]) => ReactNode;
  // v20 P10 (A28)
  /**
   * More bulk actions for the selected documents, drawn immediately left of Delete while something is selected
   * (Documents › Resumes' Download, which shows itself from two resumes). Given the selection in display order.
   */
  bulkActions?: (items: T[]) => ReactNode;
  // end v20 P10

  /** Controls before the search (Upload button, source filter). */
  toolbarExtras?: ReactNode;
  searchPlaceholder?: string;
  searchLabel?: string;

  // v1.5 W
  /**
   * A folder level (Documents › Resumes, decision 6): drawn in the view chosen instead of the documents while nothing
   * is searched for. `items` still hold every document the search may find, and the empty state shows when there are
   * none at all.
   */
  folders?: (view: ViewMode) => ReactNode;
  // end v1.5 W

  loading?: boolean;
  /** A load failure; replaces the body (never shows "0 documents"). */
  error?: ReactNode;
  empty: { title: ReactNode; description?: ReactNode; action?: ReactNode; icon?: ReactNode };
  'aria-label'?: string;
  className?: string;
}

/**
 * One documents section: the toolbar (search and extras; Select all, "{n} selected", bulk actions and Delete; Grid |
 * List), the "N of M match." status line, then the list or the thumbnail grid, or the empty state (the stitch over
 * pattern paper) or the no-match state (v31 FIX-DOCS: in the constants' words). Data-agnostic:
 * the caller loads, sorts and mutates; this only presents.
 */
export function DocumentCollection<T>({
  kind,
  noun,
  items,
  getId,
  getLabel,
  searchFields,
  query: controlledQuery,
  onQueryChange,
  serverFiltered = false,
  totalCount,
  variant = 'table',
  views = ['list'],
  defaultView,
  viewStorageKey,
  columns,
  renderActions,
  actionsHeader,
  actionsTrack,
  renderCard,
  newTile,
  selectable = false,
  isSelectable,
  onBulkDelete,
  bulkDeleteNote,
  bulkActions, // v20 P10
  toolbarExtras,
  folders,
  searchPlaceholder = 'Search',
  searchLabel,
  loading = false,
  error,
  empty,
  className,
  ...aria
}: DocumentCollectionProps<T>) {
  const offered = renderCard ? views : views.filter((view) => view === 'list');
  const effectiveViews: readonly ViewMode[] = offered.length > 0 ? offered : ['list'];
  const [view, setView] = useViewMode(viewStorageKey, effectiveViews, defaultView ?? effectiveViews[0] ?? 'list');

  const [localQuery, setLocalQuery] = useState('');
  const query = controlledQuery ?? localQuery;
  const setQuery = onQueryChange ?? setLocalQuery;

  const shown = useMemo(
    () => viewItems(items, query, { serverFiltered, searchFields, getLabel }),
    [items, query, serverFiltered, searchFields, getLabel],
  );
  const total = serverFiltered ? (totalCount ?? items.length) : items.length;

  const selectableIds = useMemo(
    () => (selectable ? selectableIdsOf(shown, getId, isSelectable) : []),
    [selectable, shown, isSelectable, getId],
  );
  const selection = useSelection(selectableIds);
  const [confirming, setConfirming] = useState(false);
  const statusId = useId();
  const { t } = usePublicConstants();

  const searching = query.trim() !== '';
  const status = searching ? describeMatches(shown.length, total, noun) : '';
  const table = variant === 'table';
  const selectedItems = shown.filter((item) => selection.selected.has(getId(item)));

  const deleteSelected = async () => {
    if (!onBulkDelete) return;
    const ids = selectedItems.map(getId);
    const order = shown.map(getId);
    await onBulkDelete(ids, selectedItems);
    selection.clear();
    focusDocument(kind, neighbourOf(order, ids));
  };

  // v20 P10 (A28): Select all, and the bulk actions left of Delete.
  const selectionBar = selectable && (
    <SelectionBar
      count={selection.count}
      selectable={selectableIds.length}
      allSelected={selection.allSelected}
      showEmptyCount={false}
      onSelectAll={() => selection.setAll(true)}
      onClear={selection.clear}
      actions={selection.count > 0 ? bulkActions?.(selectedItems) : undefined}
      onDelete={onBulkDelete ? () => setConfirming(true) : undefined}
    />
  );

  const searchBox = (
    <SearchBox
      value={query}
      onValueChange={setQuery}
      label={searchLabel ?? `Search ${noun.many}`}
      placeholder={searchPlaceholder}
      className="w-full max-sm:order-first sm:w-72"
    />
  );
  const viewToggle =
    effectiveViews.length > 1 ? <ViewToggle value={view} onChange={setView} views={effectiveViews} /> : null;

  // v31 FIX-DOCS: one toolbar for every section, inside the Documents panel: the search (and any extras) at the left;
  // the selection (Select all, then "{n} selected", the bulk actions and Delete once something is ticked) and the
  // view switch at the right. On a phone the search takes the first row and the rest share the second.
  // v20 P10: Select all shows as soon as the view has something to select; the rest once something is.
  const showSelection = selectable && (selection.count > 0 || selectableIds.length > 0);
  const toolbar = (
    <div className="flex flex-wrap items-center gap-3 sm:flex-nowrap" data-documents-toolbar="">
      <div className="flex min-w-0 items-center gap-2 max-sm:contents">
        {searchBox}
        {toolbarExtras}
      </div>
      <div className="ml-auto flex items-center gap-3">
        {showSelection && selectionBar}
        {viewToggle}
      </div>
    </div>
  );

  const statusLine = (
    <p id={statusId} role="status" className={clsx(searching ? 'mt-3 text-[13px] text-muted-foreground' : 'sr-only')}>
      {status}
    </p>
  );

  let body: ReactNode;
  if (error) {
    body = <div className="mt-4">{typeof error === 'string' ? <Notice tone="error">{error}</Notice> : error}</div>;
  } else if (loading) {
    body = <LoadingRows grid={view === 'grid'} />;
  } else if (items.length === 0 && !searching) {
    // The stitch over pattern paper: a place where documents will be.
    body = (
      <EmptyState
        title={empty.title}
        description={empty.description}
        action={empty.action}
        icon={empty.icon}
        variant="dashed"
        className="mt-5"
      />
    );
  } else if (folders && !searching) {
    body = folders(view); // v1.5 W
  } else if (shown.length === 0) {
    body = (
      <EmptyState
        title={noMatchTitle(noun, t)}
        description={t('MSG_DOCS_NO_MATCH_TEXT')}
        icon={<MagnifyingGlassIcon size={22} />}
        action={
          <Button variant="outline" size="sm" onClick={() => setQuery('')}>
            Clear search
          </Button>
        }
        className="mt-5 rounded-card border border-border"
      />
    );
  } else if (view === 'grid' && renderCard) {
    body = (
      <ul
        aria-describedby={searching ? statusId : undefined}
        className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(min(100%,11.5rem),1fr))] sm:gap-5"
      >
        {newTile && <li className="min-w-0">{newTile}</li>}
        {shown.map((item) => {
          const id = getId(item);
          const canSelect = selectable && (isSelectable?.(item) ?? true);
          return (
            <li key={id} className="min-w-0">
              {renderCard(item, {
                selectable: canSelect,
                selected: selection.isSelected(id),
                onSelectedChange: (checked, options) => selection.toggle(id, checked, options),
              })}
            </li>
          );
        })}
      </ul>
    );
  } else {
    body = (
      <DocumentList
        kind={kind}
        variant={table ? 'table' : 'cards'}
        items={shown}
        getId={getId}
        getLabel={getLabel}
        columns={columns}
        renderActions={renderActions}
        actionsHeader={actionsHeader}
        actionsTrack={actionsTrack}
        selection={selectable ? selection : undefined}
        isSelectable={isSelectable}
        selectAllLabel={`Select all ${noun.many}`}
        aria-label={aria['aria-label'] ?? titleOf(noun)}
        className="mt-4"
      />
    );
  }

  return (
    <section aria-label={aria['aria-label'] ?? titleOf(noun)} className={className}>
      {toolbar}
      {statusLine}
      {body}
      {selectable && onBulkDelete && (
        <BulkDeleteDialog
          open={confirming}
          onOpenChange={setConfirming}
          count={selection.count}
          noun={noun}
          note={bulkDeleteNote?.(selectedItems)}
          onConfirm={deleteSelected}
        />
      )}
    </section>
  );
}

// v20 P10 (A28)
/** The documents the current view shows: those the search matches (all of them while the server filtered them). */
export function viewItems<T>(
  items: readonly T[],
  query: string,
  options: {
    serverFiltered: boolean;
    searchFields?: (item: T) => ReadonlyArray<string | null | undefined>;
    getLabel: (item: T) => string;
  },
): readonly T[] {
  if (options.serverFiltered) return items;
  return items.filter((item) => matchesQuery(query, options.searchFields ? options.searchFields(item) : [options.getLabel(item)]));
}

/** What Select all (and the list's header box) selects: every document of the current view that can be selected. */
export function selectableIdsOf<T>(shown: readonly T[], getId: (item: T) => string, isSelectable?: (item: T) => boolean): string[] {
  return shown.filter((item) => isSelectable?.(item) ?? true).map(getId);
}

export interface SelectionBarProps {
  count: number;
  /** How many documents of the current view (the folder and search shown) can be selected. */
  selectable: number;
  allSelected: boolean;
  /** "0 selected" shows while nothing is (the table's bar); otherwise only Select all does until something is ticked. */
  showEmptyCount: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  /** More bulk actions, immediately left of Delete, while something is selected. */
  actions?: ReactNode;
  onDelete?: () => void;
}

/**
 * The selection bar: "{n} selected", Clear, Select all (every selectable document of the current view; the list's
 * header box does the same), then the bulk actions and Delete, in that order: Download sits immediately left of Delete.
 */
export function SelectionBar({
  count,
  selectable,
  allSelected,
  showEmptyCount,
  onSelectAll,
  onClear,
  actions,
  onDelete,
}: SelectionBarProps) {
  const some = count > 0;
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-2" data-selection-bar="">
      {(some || showEmptyCount) && (
        <span
          aria-live="polite"
          className={clsx('text-sm font-medium whitespace-nowrap', some ? 'text-foreground' : 'text-subtle-foreground')}
        >
          {count} selected
        </span>
      )}
      {some && <IconButton label="Clear selection" size="sm" icon={<XIcon size={14} />} onClick={onClear} />}
      {selectable > 0 && (
        <Button variant="ghost" size="sm" disabled={allSelected} onClick={onSelectAll} data-select-all="">
          Select all
        </Button>
      )}
      {some && actions}
      {some && onDelete && (
        <Button variant="destructive-outline" size="sm" icon={<TrashIcon size={14} />} onClick={onDelete}>
          Delete
        </Button>
      )}
    </div>
  );
}
// end v20 P10

function titleOf(noun: Noun): string {
  return noun.many.charAt(0).toUpperCase() + noun.many.slice(1);
}

function LoadingRows({ grid }: { grid: boolean }) {
  if (grid) {
    return (
      <div className="mt-5 grid grid-cols-2 gap-5 sm:grid-cols-[repeat(auto-fill,minmax(11.5rem,1fr))]">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} rounded="surface" className="aspect-[794/1123] w-full" />
        ))}
      </div>
    );
  }
  return (
    <div className="mt-4 overflow-hidden rounded-card border border-border" aria-busy="true">
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className="flex h-14 items-center gap-4 border-b border-divider-soft px-4 last:border-b-0">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="ml-auto h-4 w-24" />
          <Skeleton className="h-4 w-24" />
        </div>
      ))}
    </div>
  );
}
