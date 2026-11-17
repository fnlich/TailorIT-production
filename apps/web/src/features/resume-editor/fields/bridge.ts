'use client';

import { createContext, useContext } from 'react';

// What the page's editable fields ask of the editor: they hold no state of their own beyond what the browser shows,
// and report every change by the field's document path. The workspace provides it, backed by the store.

export interface FieldBridge {
  /** A plain field's new text. */
  setText(path: string, value: string): void;
  /** A rich field's new markup (canonical, from the field's own DOM). */
  setRich(path: string, markup: string): void;
  /** Enter in a bullet: it keeps `before`, a new bullet with `after` follows, and the caret moves into it. */
  splitBullet(path: string, before: string, after: string): void;
  /** Backspace at the start of a bullet: its markup joins the end of the bullet before. */
  mergeBullet(path: string, markup: string): void;
  /** Several pasted lines: the first stays in the bullet (already typed), the rest become bullets after it. */
  insertBulletsAfter(path: string, lines: string[]): void;
  /** A field took the caret (the selection, the toolbars). */
  focusField(path: string): void;
  /**
   * Whether the store already holds a newer value at `path` than the draw being committed shows. Typing is drawn in
   * the background, so a draw can land after more keys were typed: the field shows those keys, and a later draw
   * brings what the store holds.
   */
  isBehind(path: string): boolean;
  /** A date or period was clicked: the picker opens under `anchor`. */
  openDate(path: string, anchor: HTMLElement): void;
  /** A language's dots: 1 to 5, or null to clear. */
  setLevel(path: string, level: number | null): void;
  /** The header photo was clicked (Replace, Hide). */
  openPhoto(anchor: HTMLElement): void;
}

export const FieldBridgeContext = createContext<FieldBridge | null>(null);

export function useFieldBridge(): FieldBridge {
  const bridge = useContext(FieldBridgeContext);
  if (!bridge) throw new Error('An editable resume field needs a FieldBridgeContext.');
  return bridge;
}

/** Whether a path is a bullet (`<entry>.achievements.<n>`). */
export const isBulletPath = (path: string) => /\.achievements\.\d+$/.test(path);
/** Whether a path is a date or period, edited with the picker rather than by typing. */
export const isDatePath = (path: string) => /\.(?:period|date)$/.test(path);
