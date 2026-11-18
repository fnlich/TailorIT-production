'use client';

import type { ReactNode } from 'react';
import { NotificationBell } from './NotificationBell';
import { UsageChip, type ExtraFrom } from './UsageChip';

/*
 * v3.1: the top bar's right-hand slots, between the section title and the account menu (TopBar.tsx draws them in this
 * order: HeaderUsage, HeaderNotifications, the account menu). HEADER fills them (docs/design/v3.1/24-notifications-
 * usage.md §8; PLAN D8, D9):
 * - HeaderUsage: today's AI use against the daily budget as a compact TapeMeter chip and "Extra usage $x.xx", with a
 *   popover (plan, resets-at, today's auto-applies, Subscribe / Buy credit / Settings › Account). UsageChip.tsx.
 * - HeaderNotifications: the bell with the unread count and its popover of the latest ten. NotificationBell.tsx.
 * Both read GET /api/me/header (api.ts: once per tab, every 60 s while the page is shown, and when it comes back;
 * never in a hidden tab), and draw nothing until the account is known. Under a HeaderPreview (the dev kit, the tests)
 * they draw its data and read nothing.
 * The cluster's room (docs/design/v3.1/20-visual-identity.md, "Top bar"): each slot is one trigger 36 px tall
 * (`h-9`); below 640 px the usage chip shows the meter and the share (v31 FIX-WEB, REV-UX UX-14; the extra usage is in
 * the popover) and the bell its icon, so the menu button, the logo, the title, both slots and the account fit in 390 px.
 * v31 FIX-WEB (REV-REQ REQ-4): the full-screen editors' EditorBar draws both slots too, the usage chip's extra usage
 * words from 1280 px (1536 px on a crowded bar), so AI use and notifications are on every header bar.
 */

/** Today's AI use and extra usage. `extraFrom`: where the extra usage words start (640 px; the editors' bar later). */
export function HeaderUsage({ extraFrom = 'sm' }: { extraFrom?: ExtraFrom } = {}): ReactNode {
  return <UsageChip extraFrom={extraFrom} />;
}

/** The notifications bell. */
export function HeaderNotifications(): ReactNode {
  return <NotificationBell />;
}
