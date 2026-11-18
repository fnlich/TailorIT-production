'use client';

import { clsx } from 'clsx';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { PencilSimpleIcon } from '@/components/ui/icons';
import { Tooltip } from '@/components/ui/Tooltip';
import { ActionMenu } from './ActionMenu';
import type { ActionMenuItem } from './types';

/*
 * Cell renderers for DocumentList columns (the documents table). A section builds its columns from these:
 *   { key: 'name', header: 'Name', track: 'minmax(0,1.06fr)', cell: (r) => <DocumentNameCell name={r.title} badges={…} /> }
 */

/** The main cell: the name (14 px semibold, wraps) with badges under it and an optional preview line. */
export function DocumentNameCell({
  name,
  href,
  onOpen,
  badges,
  preview,
}: {
  name: string;
  href?: string;
  onOpen?: () => void;
  /** <Badge/>s: Default, Uploaded, PDF, Generated, Built in… */
  badges?: ReactNode;
  /** A muted line under the badges (templates: the first 80 characters of the body). */
  preview?: ReactNode;
}) {
  // The name is set solid (14 px lines) with the badges 8 px under it: a 72 px row (14 px padding) with one badge line.
  const nameClasses =
    'text-left text-sm leading-none font-semibold text-foreground [overflow-wrap:anywhere] hover:underline hover:underline-offset-2';
  return (
    <div className="flex min-w-0 flex-col items-start gap-2">
      {href ? (
        <Link href={href} className={nameClasses}>
          {name}
        </Link>
      ) : onOpen ? (
        <button type="button" onClick={onOpen} className={nameClasses}>
          {name}
        </button>
      ) : (
        <span className="text-sm leading-none font-semibold text-foreground [overflow-wrap:anywhere]">{name}</span>
      )}
      {badges && <div className="flex flex-wrap items-center gap-1.5">{badges}</div>}
      {preview && <p className="line-clamp-1 text-[13px] leading-4 text-muted-foreground">{preview}</p>}
    </div>
  );
}

/** A plain text cell ("3 days ago", "-"). */
export function TextCell({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return <span className={clsx('text-sm', muted ? 'text-muted-foreground' : 'text-foreground')}>{children}</span>;
}

/**
 * v31 FIX-DOCS: a table row's actions, two icon buttons: ✎ "Edit {label}" (a link to the editor; shown disabled with
 * its reason when the document cannot be edited, e.g. an uploaded PDF) and ⋮ "Actions for {label}" (the menu).
 */
export function TableRowActions({
  label,
  editHref,
  onEdit,
  editDisabled,
  editDisabledReason,
  editLabel = 'Edit',
  menuItems,
}: {
  /** The document's name, for "Edit {label}" / "Actions for {label}". */
  label: string;
  editHref?: string;
  onEdit?: () => void;
  editDisabled?: boolean;
  editDisabledReason?: string;
  editLabel?: string;
  menuItems?: readonly ActionMenuItem[];
}) {
  const name = `${editLabel} ${label}`;
  const classes = clsx(
    'inline-flex size-8 shrink-0 items-center justify-center rounded-control transition-colors duration-150',
    editDisabled ? 'cursor-not-allowed text-disabled-foreground' : 'text-muted-foreground hover:bg-hover hover:text-foreground active:bg-pressed',
  );
  const icon = <PencilSimpleIcon size={18} aria-hidden="true" />;
  let edit: ReactNode = null;
  if (editDisabled) {
    edit = (
      <Tooltip content={editDisabledReason} disabled={!editDisabledReason}>
        <button type="button" aria-disabled="true" aria-label={name} className={classes}>
          {icon}
        </button>
      </Tooltip>
    );
  } else if (editHref) {
    edit = (
      <Tooltip content={editLabel}>
        <Link href={editHref} aria-label={name} className={classes}>
          {icon}
        </Link>
      </Tooltip>
    );
  } else if (onEdit) {
    edit = (
      <Tooltip content={editLabel}>
        <button type="button" onClick={onEdit} aria-label={name} className={classes}>
          {icon}
        </button>
      </Tooltip>
    );
  }
  return (
    <div className="flex items-center gap-1">
      {edit}
      {menuItems && menuItems.length > 0 && <ActionMenu items={menuItems} label={`Actions for ${label}`} />}
    </div>
  );
}
