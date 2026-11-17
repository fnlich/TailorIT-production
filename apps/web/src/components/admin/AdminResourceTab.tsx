'use client';

import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { userMessage } from '../../lib/api';
import { EmptyState } from '../ui/EmptyState';
import { Notice } from '../ui/Notice';
import { AdminTable, SectionHeader, TableSkeleton, type AdminColumn } from './AdminTable';

// v30 ST0: the admin tab base (PLAN §6, "Admin tabs"). Every Admin tab is the same frame around its own table: the
// heading row (title, description, the filters on the right), then one of an error notice, the loading rows, the empty
// state in a card, or the table, with a bar above it (bulk actions) and a foot under it (Load more). A tab gives its
// words, its columns and its query's state; this draws the rest. Taken from the tabs as v2.0 draws them (Admin ›
// Reports' frame, unchanged). Register the tab in features/settings/admin/registry.ts.
//
// v30 ST5: every tab is built on it, so it takes what each one drew around the frame, unchanged: a row between the
// heading and the body (Users' and Constants' search), the section's own attributes, the error notice's Try again,
// the empty state's own form (its size, a dashed outline, a button, or no card), the table's class, the rows drawn by
// the tab itself (Constants' groups), the tab's dialogs after the body, and a body that is no list at all (AI's health
// cards, Import's forms).

/** The section's own attributes: aria-labelledby, a data- mark the tests read. */
export type AdminSectionProps = Omit<ComponentPropsWithoutRef<'section'>, 'children' | 'title'> & {
  [mark: `data-${string}`]: string | boolean | undefined;
};

/** What every tab draws: its heading row, then its body, then its dialogs. */
interface AdminTabFrame {
  title: string;
  description?: ReactNode;
  /** The heading row's right side: the filters (a SegmentedControl), a search box, a New button. */
  actions?: ReactNode;
  /** Between the heading row and the body, whatever the state: a search row, the section's name for screen readers. */
  lead?: ReactNode;
  sectionProps?: AdminSectionProps;
  /** After the body, whatever the state: the tab's dialogs and sheets. */
  children?: ReactNode;
}

/** The empty state: its words and icon, in a card unless `card` is false. */
export interface AdminEmpty {
  icon?: ReactNode;
  /** A filter's own words: "No open reports". */
  title: string;
  description?: ReactNode;
  /** A button under the words ("Add source"). */
  action?: ReactNode;
  size?: 'sm' | 'md';
  /** "dashed" draws its own outline (Announcements, with no card). */
  variant?: 'plain' | 'dashed';
  /** In a card (the default), or on its own (a search with no match). */
  card?: boolean;
}

/** A list's states: an error notice, the loading rows, the empty state, or the rows. */
interface AdminListState<T> {
  /** The rows, or undefined while the first page loads. */
  items: readonly T[] | undefined;
  /** The query failed (its error says why): the error notice replaces the table. */
  error?: unknown;
  /** The error notice's title ("The reports could not be loaded"). */
  errorTitle: string;
  /** The error notice's button (Try again). */
  errorAction?: ReactNode;
  empty: AdminEmpty;
  /** Above the rows, once they are shown (a select mode's bulk bar, a summary line). */
  toolbar?: ReactNode;
  /** Under the rows, once they are shown (Load more). */
  footer?: ReactNode;
  /** Rows of the loading state. */
  skeletonRows?: number;
}

/** The rows as the admin table. */
interface AdminTableRows<T> {
  /** The table's name for assistive technology ("Job reports"). */
  tableLabel: string;
  columns: readonly AdminColumn<T>[];
  getKey: (item: T) => string | number;
  /** A full-width row under a row whose key is in `expanded` (a run's log). */
  renderExpanded?: (item: T) => ReactNode;
  expanded?: ReadonlySet<string | number>;
  /** The table card's class (Users: dimmed while a new search loads). */
  tableClassName?: string;
  renderItems?: never;
  body?: never;
}

/** The rows as the tab draws them (Constants: a list per group). */
interface AdminOwnRows<T> {
  renderItems: (items: readonly T[]) => ReactNode;
  tableLabel?: never;
  columns?: never;
  body?: never;
}

/** A tab that is no list (AI's health cards, Import's forms): its body as it draws it. */
interface AdminOwnBody {
  body: ReactNode;
  items?: never;
  columns?: never;
  renderItems?: never;
}

type AdminList<T> = AdminListState<T> & (AdminTableRows<T> | AdminOwnRows<T>);

export type AdminResourceTabProps<T> = AdminTabFrame & (AdminList<T> | AdminOwnBody);

export function AdminResourceTab<T>(props: AdminResourceTabProps<T>) {
  const { title, description, actions, lead, sectionProps, children } = props;
  return (
    <section {...sectionProps}>
      <SectionHeader title={title} description={description} actions={actions} />
      {lead}
      {'body' in props && props.body !== undefined ? props.body : listBody(props as AdminList<T>)}
      {children}
    </section>
  );
}

function listBody<T>(list: AdminList<T>): ReactNode {
  const { items, error, errorTitle, errorAction, empty, toolbar, footer, skeletonRows } = list;
  if (error) {
    return (
      <Notice tone="error" title={errorTitle} action={errorAction}>
        {userMessage(error)}
      </Notice>
    );
  }
  if (items === undefined) return <TableSkeleton rows={skeletonRows} />;
  if (items.length === 0) {
    const state = (
      <EmptyState
        icon={empty.icon}
        title={empty.title}
        description={empty.description}
        action={empty.action}
        size={empty.size}
        variant={empty.variant}
      />
    );
    return empty.card === false ? state : <div className="rounded-surface border border-border bg-surface shadow-soft">{state}</div>;
  }
  return (
    <>
      {toolbar}
      {list.renderItems ? (
        list.renderItems(items)
      ) : (
        <AdminTable
          aria-label={list.tableLabel}
          items={items}
          columns={list.columns}
          getKey={list.getKey}
          renderExpanded={list.renderExpanded}
          expanded={list.expanded}
          className={list.tableClassName}
        />
      )}
      {footer}
    </>
  );
}
