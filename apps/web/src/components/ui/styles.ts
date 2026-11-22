/*
 * Class strings shared by the kit's floating surfaces (v3.1 "Denim & Tape"): white popups with a 1 px border, radius
 * 10 and the short cool popover shadow; rows radius 6 that light up in the denim soft tone; group labels in small
 * spaced capitals.
 */

export const POPUP_MOTION =
  'origin-(--transform-origin) transition-[opacity,scale] duration-150 ease-out-soft ' +
  'data-starting-style:scale-[0.97] data-starting-style:opacity-0 data-ending-style:scale-[0.97] data-ending-style:opacity-0';

export const MENU_SURFACE =
  'rounded-popup border border-border bg-surface p-1 text-sm text-foreground shadow-popover outline-none ' +
  'focus-visible:outline-none ' +
  POPUP_MOTION;

/**
 * A menu row without colours: the popup sets the text colour and each row adds its highlight
 * (MENU_ROW = the usual one). Kept apart because the kit merges classes with clsx only, so two utilities for the
 * same property must never be combined.
 */
export const MENU_ROW_BASE =
  'flex min-h-8 w-full cursor-default select-none items-center gap-2.5 rounded-menu-row px-2 py-1.5 text-left text-sm leading-5 ' +
  'outline-none data-disabled:cursor-not-allowed data-disabled:opacity-45 [&_svg]:shrink-0';

export const MENU_ROW = `${MENU_ROW_BASE} data-highlighted:bg-primary-soft`;

export const MENU_GROUP_LABEL =
  'px-2 pt-2 pb-1 text-[11px] leading-4 font-semibold tracking-[0.06em] text-subtle-foreground uppercase select-none';

export const MENU_SEPARATOR = '-mx-1 my-1 h-px bg-border';

/** Popovers (date picker, filter panels): the popup surface without the menu's padding. */
export const POPOVER_SURFACE =
  'rounded-popup border border-border bg-surface text-sm text-foreground shadow-popover outline-none focus-visible:outline-none ' +
  POPUP_MOTION;

/**
 * Stacking order: sticky top bar 30, the menu sheet and dialogs 50, floating layers (menus, popovers) 60, tooltips 70,
 * toasts 80 (40 on a phone while a kit dialog is open, under it: v34 FIX-WEB, final review U-M4).
 */
export const Z_FLOATING = 'z-[60]';
