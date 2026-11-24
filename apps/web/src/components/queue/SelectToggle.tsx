'use client';

import { ListChecksIcon } from '@phosphor-icons/react/ListChecks';
import { clsx } from 'clsx';
import { forwardRef } from 'react';
import { IconButton, type IconButtonProps } from '../ui/IconButton';

// v36 JOBS (PLAN J2, A4; SP v36 REQUEST.md: "Only select button (without text) will exist"): the icon-only button that
// starts a list's select mode, one look on the Jobs page's results bar and the Auto-apply page's Saved pane. A
// checklist icon, no visible word; its name is "Select" (what a screen reader and a test find) and its tooltip says what
// it does ("Select jobs"). The bar that replaces it while rows are chosen is the page's own (the Jobs page's selection
// bar; components/queue SelectBar on the Saved pane).

/** The toggle's accessible name. */
export const SELECT_TOGGLE_NAME = 'Select';
/** Its tooltip. */
export const SELECT_TOGGLE_TIP = 'Select jobs';

export interface SelectToggleProps extends Omit<IconButtonProps, 'label' | 'icon' | 'tooltip'> {
  /** Starts the select mode. */
  onClick: () => void;
  /** The tooltip's words (default "Select jobs"). */
  tooltip?: string;
}

/**
 * The select mode's icon button: `variant` `ghost` (default: a quiet bar, the Jobs results bar) or `outline` (a pane's
 * toolbar beside its other outlined buttons); `size` as IconButton's (default `sm`, 32 px), 44 px on a phone. Any
 * other prop (a `data-*` hook, `disabled`) goes to the button.
 */
export const SelectToggle = forwardRef<HTMLButtonElement, SelectToggleProps>(function SelectToggle(
  { tooltip = SELECT_TOGGLE_TIP, variant = 'ghost', size = 'sm', className, ...rest },
  ref,
) {
  return (
    <IconButton
      ref={ref}
      label={SELECT_TOGGLE_NAME}
      tooltip={tooltip}
      variant={variant}
      size={size}
      icon={<ListChecksIcon size={18} aria-hidden="true" />}
      className={clsx('max-sm:size-11', className)}
      data-select-toggle=""
      {...rest}
    />
  );
});
