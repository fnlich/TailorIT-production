'use client';

import { Tabs } from '@base-ui/react/tabs';
import { clsx } from 'clsx';
import type { ReactNode } from 'react';

export interface UnderlineTabItem<V extends string> {
  value: V;
  label: ReactNode;
  disabled?: boolean;
}

export interface UnderlineTabsProps<V extends string> {
  items: readonly UnderlineTabItem<V>[];
  value: V;
  onValueChange: (value: V) => void;
  'aria-label': string;
  /**
   * "lg": page-level tabs (48 px, 15 px labels padded 12 px; the bar spans the padded tab).
   * "md": 44 px, 14 px labels. "tight": the job detail's "Overview | Company" (61 px, no padding, 28 px apart, the bar
   * under the label only).
   */
  size?: 'lg' | 'md' | 'tight';
  /**
   * From 768 px the tabs wrap onto a second row (each row on its own baseline) instead of scrolling sideways: a strip
   * of many tabs (Admin's) shows every tab at every desktop width. Below 768 px it scrolls, as without it.
   */
  wrap?: boolean;
  className?: string;
  listClassName?: string;
  /** TabPanel-s for the content under the tabs. */
  children?: ReactNode;
}

const SIZES = {
  lg: { list: 'gap-1', tab: 'h-12 text-[15px]', pad: 'px-3' },
  md: { list: 'gap-1', tab: 'h-11 text-sm', pad: 'px-3' },
  tight: { list: 'gap-7', tab: 'h-[61px] text-[15px]', pad: 'px-0' },
} as const;

/**
 * Tabs on a baseline (Admin's sections, Settings › Autofill's): medium-weight muted labels; the active one ink,
 * sitting on a 2 px denim bar with rounded top corners over the full-width border baseline. Hover shows a
 * grey bar. Arrow keys move between tabs.
 */
export function UnderlineTabs<V extends string>({
  items,
  value,
  onValueChange,
  size = 'lg',
  wrap = false,
  className,
  listClassName,
  children,
  ...aria
}: UnderlineTabsProps<V>) {
  const sizing = SIZES[size];
  return (
    <Tabs.Root value={value} onValueChange={(next) => onValueChange(next as V)} className={className}>
      <Tabs.List
        activateOnFocus
        aria-label={aria['aria-label']}
        // The baseline is an inset shadow (not a border) so the active bar can sit on it inside the scroll box.
        // v31 FIX-WEB (REV-UX UX-2): `wrap` lays the tabs on rows from 768 px; each tab draws the baseline under itself
        // (no gap between tabs), so every row has one.
        className={clsx(
          'flex items-stretch overflow-x-auto shadow-[inset_0_-1px_0_var(--color-border)]',
          wrap ? 'md:flex-wrap md:overflow-x-visible' : sizing.list,
          listClassName,
        )}
      >
        {items.map((item) => (
          <Tabs.Tab
            key={item.value}
            value={item.value}
            disabled={item.disabled}
            className={clsx(
              'relative inline-flex shrink-0 items-center font-medium whitespace-nowrap text-muted-foreground',
              sizing.tab,
              wrap ? 'px-3 md:shadow-[inset_0_-1px_0_var(--color-border)]' : sizing.pad,
              'transition-colors duration-150 hover:text-foreground focus-visible:outline-offset-[-2px]',
              'after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-t-full after:bg-transparent after:content-[""]',
              'hover:after:bg-border-strong data-active:text-foreground data-active:after:bg-primary',
              'data-disabled:pointer-events-none data-disabled:opacity-50',
            )}
          >
            {item.label}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      {children}
    </Tabs.Root>
  );
}
