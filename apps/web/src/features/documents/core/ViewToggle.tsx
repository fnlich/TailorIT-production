'use client';

import { clsx } from 'clsx';
import { useCallback, useState } from 'react';
import { RowsIcon, SquaresFourIcon } from '@/components/ui/icons';
import { Tooltip } from '@/components/ui/Tooltip';
import { useStoredValue } from '@/lib/storage';
import type { ViewMode } from './types';

/**
 * The view a collection shows, remembered per `storageKey` in localStorage ("tailorit.documents.resumes.view").
 * Anything stored that is not one of `views` reads as `fallback`; a refused storage just is not remembered. Without
 * a key the choice lives in component state.
 */
export function useViewMode(
  storageKey: string | undefined,
  views: readonly ViewMode[],
  fallback: ViewMode,
): [ViewMode, (mode: ViewMode) => void] {
  const allowed = views.join(',');
  const parse = useCallback(
    (raw: string | null): ViewMode => (raw && allowed.split(',').includes(raw) ? (raw as ViewMode) : fallback),
    [allowed, fallback],
  );
  const [stored, setStored] = useStoredValue<ViewMode>(storageKey ?? 'tailorit.view.unset', parse);
  const [local, setLocal] = useState<ViewMode>(fallback);
  if (!storageKey) return [local, setLocal];
  return [stored, setStored];
}

const OPTIONS: Record<ViewMode, { label: string; icon: typeof SquaresFourIcon }> = {
  grid: { label: 'Grid', icon: SquaresFourIcon },
  list: { label: 'List', icon: RowsIcon },
};

/**
 * Grid | List, two icon toggle buttons on the segmented track (grey, radius 6, a 1 px edge; the pressed one a raised
 * white tile with denim-ink icon, as the kit's SegmentedControl). `role="group"` with `aria-pressed` buttons.
 */
export function ViewToggle({
  value,
  onChange,
  views = ['grid', 'list'],
  className,
}: {
  value: ViewMode;
  onChange: (mode: ViewMode) => void;
  views?: readonly ViewMode[];
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label="View"
      className={clsx(
        'inline-flex h-9 shrink-0 items-center gap-0.5 rounded-control bg-surface-muted p-0.5 shadow-[inset_0_0_0_1px_var(--color-border)]',
        className,
      )}
    >
      {views.map((mode) => {
        const { label, icon: Icon } = OPTIONS[mode];
        const pressed = value === mode;
        return (
          <Tooltip key={mode} content={`${label} view`}>
            <button
              type="button"
              aria-label={label}
              aria-pressed={pressed}
              onClick={() => onChange(mode)}
              className={clsx(
                'inline-flex h-8 w-9 items-center justify-center rounded-tag transition-[background-color,color,box-shadow] duration-150 focus-visible:outline-offset-0',
                pressed ? 'bg-surface text-primary-ink shadow-card' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon size={18} weight={pressed ? 'fill' : 'regular'} />
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
