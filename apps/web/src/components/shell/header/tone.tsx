'use client';

import { createContext, useContext } from 'react';

// v3.2 SHELL (E2): the bar a header slot sits on. The app's header bar is dark denim (the sidebar's colours, which it
// replaced); the editors' EditorBar is white. The slots (usage chip, bell, account menu) read the tone and take its
// colours; their popovers are the same on both.

export type HeaderTone = 'light' | 'dark';

const HeaderToneContext = createContext<HeaderTone>('light');

/** The slots below sit on a bar of `value` ('light' when no provider: the editors' bar). */
export const HeaderToneProvider = HeaderToneContext.Provider;

export function useHeaderTone(): HeaderTone {
  return useContext(HeaderToneContext);
}

/** Each tone's classes for a header trigger (ghost look: transparent until hovered or open). */
export const TRIGGER_TONE: Readonly<Record<HeaderTone, string>> = {
  light: 'text-muted-foreground hover:bg-hover hover:text-foreground data-popup-open:bg-hover data-popup-open:text-foreground',
  dark: 'text-sidebar-foreground hover:bg-sidebar-hover hover:text-sidebar-strong data-popup-open:bg-sidebar-active data-popup-open:text-sidebar-strong',
};

/** Each tone's words on a trigger: the strong value, the quieter label, the hairline between them. */
export const TEXT_TONE: Readonly<Record<HeaderTone, { strong: string; quiet: string; rule: string }>> = {
  light: { strong: 'text-foreground', quiet: 'text-muted-foreground', rule: 'bg-border' },
  dark: { strong: 'text-sidebar-strong', quiet: 'text-sidebar-foreground', rule: 'bg-sidebar-border' },
};
