'use client';

import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';
import { clsx } from 'clsx';
import { useId, useState, type ReactNode } from 'react';
import { QuestionIcon } from './icons';
import type { TooltipSide } from './Tooltip';

// v32 COPY (E5): every description and helper line of the app is a "?" beside its title, the text in a tooltip, cut
// to one short sentence. Visible text is labels, values and actions only.

export interface HelpTipProps {
  /** The tip: one short sentence. Nothing renders when it is empty. */
  children: ReactNode;
  /**
   * What the tip explains (the title it sits beside). v32 FIX-UX (UXREQ-11, the coordinator): it names the button,
   * "About Account", so a screen reader's list of buttons tells every "?" apart (WCAG 2.4.6); a title that is not a
   * string (a node) leaves the button "More info". It also marks the button for tests (`data-help-tip-for="Account"`).
   */
  label?: ReactNode;
  side?: TooltipSide;
  align?: 'start' | 'center' | 'end';
  className?: string;
}

// v32 FIX-UX (UXREQ-11): the tip is where a description is read now, so its text is 13 px (it was the tooltip's 12).
const POPUP =
  'max-w-[min(21rem,calc(100vw-2rem))] origin-(--transform-origin) rounded-control bg-sidebar px-3 py-2 text-[13px] leading-[18px] ' +
  'font-medium text-sidebar-strong shadow-popover transition-[opacity,scale] duration-150 ease-out-soft ' +
  'data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0 ' +
  'data-instant:transition-none';

/** The "?" button's name when its title is not a string (a node): "More info". */
export const HELP_TIP_NAME = 'More info';

/** The "?" button's name: "About <title>" (v32 FIX-UX, UXREQ-11), "More info" for a title that is not a string. */
export function helpTipName(label: ReactNode): string {
  const subject = helpTipFor(label);
  return subject ? `About ${subject}` : HELP_TIP_NAME;
}

const TABBABLE =
  'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/**
 * A dialog's first focus: its first control that is not a "?" (a dialog or sheet whose title, or first field, has a
 * tip opens on its form, not on the tip). `true` (the default behaviour) when it has none.
 */
export function firstFocusSkippingTips(root: HTMLElement | null): HTMLElement | true {
  if (!root) return true;
  for (const element of root.querySelectorAll<HTMLElement>(TABBABLE)) {
    if (element.closest('[data-help-tip]') || element.getAttribute('aria-hidden') === 'true') continue;
    if (element.tabIndex < 0 || element.getClientRects().length === 0) continue;
    return element;
  }
  return true;
}

/** The title a tip sits beside, as its `data-help-tip-for` mark: the string's words, else nothing. */
export function helpTipFor(label: ReactNode): string | undefined {
  return typeof label === 'string' && label.trim() ? label.trim() : undefined;
}

/**
 * A "?" button beside a title whose tooltip holds the description. It opens on hover and on keyboard focus, and a
 * press (a tap on a phone) opens or closes it; Escape or a press elsewhere closes it. Screen readers hear "About
 * <title>" and the text as the button's description (a hidden copy it points at), so nothing depends on seeing the
 * tooltip.
 */
export function HelpTip({ children, label, side = 'top', align = 'center', className }: HelpTipProps) {
  const [open, setOpen] = useState(false);
  const tipId = `help-tip-${useId()}`;
  if (children === null || children === undefined || children === false || children === '') return null;
  return (
    <span className={clsx('inline-flex shrink-0 align-middle', className)} data-help-tip="">
      <BaseTooltip.Root open={open} onOpenChange={setOpen}>
        <BaseTooltip.Trigger
          closeOnClick={false}
          delay={250}
          render={
            <button
              type="button"
              aria-label={helpTipName(label)}
              aria-describedby={tipId}
              data-help-tip-trigger=""
              data-help-tip-for={helpTipFor(label)}
              onClick={() => setOpen((was) => !was)}
              className={clsx(
                // The button is the target: 24 px (WCAG 2.5.8), 44 px on a phone (the app's touch targets), its
                // negative margin keeping the 20 px circle's place in the line.
                'group relative -m-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full max-sm:-m-3 max-sm:size-11',
              )}
            />
          }
        >
          <span
            className={clsx(
              'flex size-5 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150',
              'group-hover:bg-hover group-hover:text-foreground group-data-popup-open:bg-hover group-data-popup-open:text-foreground',
            )}
          >
            <QuestionIcon size={16} weight="bold" aria-hidden="true" />
          </span>
        </BaseTooltip.Trigger>
        <BaseTooltip.Portal>
          <BaseTooltip.Positioner side={side} align={align} sideOffset={6} collisionPadding={8} className="z-[70]">
            {/* The hidden copy below is what assistive technology reads; the popup is for the eye only. */}
            <BaseTooltip.Popup className={POPUP} aria-hidden="true" data-help-tip-popup="">
              {children}
            </BaseTooltip.Popup>
          </BaseTooltip.Positioner>
        </BaseTooltip.Portal>
      </BaseTooltip.Root>
      <span id={tipId} hidden>
        {children}
      </span>
    </span>
  );
}

/**
 * A title with its "?" after it, on one line that wraps: the pattern PageHeader, Section, Card and the dialogs use.
 * `children` is the title's own element (an h1, h2, a label), the tip sits beside it.
 */
export function TitleWithTip({
  children,
  tip,
  label,
  className,
}: {
  children: ReactNode;
  tip?: ReactNode;
  /** The tip's subject for its button's name (defaults to nothing: "More info"). */
  label?: ReactNode;
  className?: string;
}) {
  if (tip === null || tip === undefined || tip === false || tip === '') return <>{children}</>;
  return (
    <span className={clsx('inline-flex max-w-full min-w-0 items-center gap-1.5', className)}>
      {children}
      <HelpTip label={label}>{tip}</HelpTip>
    </span>
  );
}
