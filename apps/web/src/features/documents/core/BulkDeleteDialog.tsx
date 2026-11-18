'use client';

import type { ReactNode } from 'react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { usePublicConstants } from '@/lib/constants';
import { bulkDeleteWords } from './gallery';
import type { Noun } from './types';

/**
 * The bulk delete confirmation (v31 FIX-DOCS, the constants' words): "Delete 3 resumes?", "They leave your documents
 * for good. This can't be undone.", an optional note ("1 default resume will be skipped") and the button "Delete 3".
 */
export function BulkDeleteDialog({
  open,
  onOpenChange,
  count,
  noun,
  note,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  count: number;
  noun: Noun;
  note?: ReactNode;
  /** Resolve when the documents are gone; reject to keep the dialog open with the error shown. */
  onConfirm: () => Promise<void> | void;
}) {
  const { t } = usePublicConstants();
  const words = bulkDeleteWords(count, noun, t);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={words.title}
      description={words.description}
      confirmLabel={words.confirm}
      busyLabel="Deleting..."
      tone="destructive"
      onConfirm={onConfirm}
    >
      {note ? <p className="text-muted-foreground">{note}</p> : null}
    </ConfirmDialog>
  );
}
