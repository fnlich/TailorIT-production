'use client';

import { Tabs } from '@base-ui/react/tabs';
import { clsx } from 'clsx';
import type { ReactNode } from 'react';

export interface SegmentedItem<V extends string> {
  value: V;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  /** The accessible name when the label is an icon alone. */
  'aria-label'?: string;
}

export interface SegmentedControlProps<V extends string> {
  items: readonly SegmentedItem<V>[];
  value: V;
  onValueChange: (value: V) => void;
  'aria-label': string;
  size?: 'sm' | 'md';
  /** Classes for the outer element (layout: margins, alignment). */
  className?: string;
  /** Classes for the track (its height: `max-sm:h-11` for 44 px touch targets on a phone). */
  listClassName?: string;
  /** TabPanel-s to render after the track, when the control switches content. */
  children?: ReactNode;
}

/**
 * Segmented tabs: a grey track (radius 6, a 1 px edge) whose active segment shows a raised white tile (radius 4, 2 px
 * inside the track) with denim-ink text ("Active (87) | Archived (0)", "Board | List | Chart", "Summary | Full
 * posting"). Each segment fills the track's full height (the tile is drawn inside it), so a 44 px track on a phone
 * (`listClassName="max-sm:h-11"`) gives 44 px touch targets. Arrow keys move between segments (Base UI Tabs).
 */
export function SegmentedControl<V extends string>({
  items,
  value,
  onValueChange,
  size = 'md',
  className,
  listClassName,
  children,
  ...aria
}: SegmentedControlProps<V>) {
  return (
    <Tabs.Root value={value} onValueChange={(next) => onValueChange(next as V)} className={className}>
      <Tabs.List
        activateOnFocus
        aria-label={aria['aria-label']}
        className={clsx(
          'inline-flex shrink-0 items-stretch rounded-control bg-surface-muted shadow-[inset_0_0_0_1px_var(--color-border)]',
          size === 'sm' ? 'h-8' : 'h-9',
          listClassName,
        )}
      >
        {items.map((item) => (
          <Tabs.Tab
            key={item.value}
            value={item.value}
            disabled={item.disabled}
            aria-label={item['aria-label']}
            className={clsx(
              'relative isolate inline-flex h-full items-center justify-center gap-1.5 rounded-control whitespace-nowrap',
              size === 'sm' ? 'px-3 text-[13px]' : 'px-3.5 text-sm',
              'font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground',
              // The white tile, 2 px inside the segment.
              "before:absolute before:inset-0.5 before:-z-10 before:rounded-tag before:transition-[background-color,box-shadow] before:duration-150 before:content-['']",
              'data-active:text-primary-ink data-active:before:bg-surface data-active:before:shadow-card',
              'focus-visible:outline-offset-[-2px] data-disabled:pointer-events-none data-disabled:opacity-50',
            )}
          >
            {item.icon && <span className="flex">{item.icon}</span>}
            {item.label}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      {children}
    </Tabs.Root>
  );
}

/**
 * Content shown while its tab is active (SegmentedControl or UnderlineTabs). Unmounted otherwise. Base UI puts the
 * panel in the Tab order, so it draws the keyboard focus ring (v31 FIX-WEB, REV-UX UX-9: WCAG 2.4.7), 4 px out.
 */
export function TabPanel({
  value,
  children,
  className,
  keepMounted,
}: {
  value: string;
  children: ReactNode;
  className?: string;
  keepMounted?: boolean;
}) {
  return (
    <Tabs.Panel value={value} keepMounted={keepMounted} className={clsx('rounded-control focus-visible:outline-offset-4', className)}>
      {children}
    </Tabs.Panel>
  );
}
