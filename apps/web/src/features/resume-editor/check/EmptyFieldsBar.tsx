'use client';

import type { ResumeDocument } from '@tailorit/shared/resume';
import { clsx } from 'clsx';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { WarningCircleIcon } from '@/components/ui/icons';
import { emptyFieldsCss, emptyVisibleFields } from './emptyFields';

// "Empty fields detected: n": the fields the page shows but that hold nothing (they print as gaps). Highlight paints
// them yellow on the page (a background only, nothing moves); Hide puts the bar away. The Download dialog asks the
// same question through `emptyVisibleFields`.

export interface EmptyFieldsBarProps {
  document: ResumeDocument;
  /** Highlight controlled from outside (the Download dialog's "Back to editing"); the bar keeps its own otherwise. */
  highlighted?: boolean;
  onHighlightedChange?: (highlighted: boolean) => void;
  /** Hide was pressed (the bar also hides itself). */
  onHide?: () => void;
  className?: string;
}

export function EmptyFieldsBar({ document, highlighted, onHighlightedChange, onHide, className }: EmptyFieldsBarProps) {
  const fields = useMemo(() => emptyVisibleFields(document), [document]);
  const [ownHighlight, setOwnHighlight] = useState(false);
  const [hidden, setHidden] = useState(false);
  const on = highlighted ?? ownHighlight;
  const setOn = (next: boolean) => {
    setOwnHighlight(next);
    onHighlightedChange?.(next);
  };
  if (hidden || fields.length === 0) return null;
  return (
    <div
      role="region"
      aria-label="Empty fields"
      // v32 COPY (E4): a compact row on the page's surface (a warning icon, the count, its buttons), never a coloured banner.
      className={clsx(
        'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-control border border-border bg-surface px-3.5 py-2 text-sm text-foreground shadow-card',
        className,
      )}
    >
      {on ? <style>{emptyFieldsCss(fields.map((field) => field.path))}</style> : null}
      <WarningCircleIcon size={18} weight="fill" className="shrink-0 text-warning" />
      <span className="min-w-0 flex-1 font-medium">Empty fields detected: {fields.length}</span>
      <Button size="sm" variant="outline" aria-pressed={on} onClick={() => setOn(!on)}>
        {on ? 'Stop highlighting' : 'Highlight'}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setOn(false);
          setHidden(true);
          onHide?.();
        }}
      >
        Hide
      </Button>
    </div>
  );
}
