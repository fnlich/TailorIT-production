'use client';

import type { Notification } from '@tailorit/shared/notifications';
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { HeaderSummaryRead } from './api';
import { allRead, markedRead } from './view';

// v3.1 HEADER: the header's usage chip and bell on given data, with no request at all: the development kit (/dev/kit
// needs no API and no session) and the tests draw the real top bar this way. Mark read and Mark all read change the
// given data in memory. Every page of the app reads the API instead (no provider: the slots' default).

export interface HeaderPreviewData {
  /** As GET /api/me/header answers (v32 SHELL: `ai.percent`, or the micros of a v3.1 API). */
  summary: HeaderSummaryRead;
  /** Newest first, as GET /api/notifications answers. */
  notifications: Notification[];
  /** AI_USE_WARNING_PERCENT (the app reads the public constants). */
  warningPercent: number;
  /** "12:00 AM Pacific Time" (the app reads DAY_RESET_TIME and DAY_RESET_ZONE_LABEL). */
  resetText: string;
  /** Today's auto-applies (the app reads GET /api/account); null limit: unlimited. */
  autoApply: { used: number; limit: number | null };
}

export interface HeaderPreviewState extends HeaderPreviewData {
  markRead: (id: string) => void;
  markAllRead: () => void;
}

const HeaderPreviewContext = createContext<HeaderPreviewState | null>(null);

/** The header's slots below draw `data` and make no request. */
export function HeaderPreview({ data, children }: { data: HeaderPreviewData; children: ReactNode }) {
  const [summary, setSummary] = useState(data.summary);
  const [notifications, setNotifications] = useState(data.notifications);
  const value = useMemo<HeaderPreviewState>(
    () => ({
      ...data,
      summary,
      notifications,
      markRead: (id) => {
        const at = new Date().toISOString();
        const wasUnread = notifications.some((item) => item.id === id && item.readAt === null);
        setNotifications((current) => markedRead(current, id, at));
        if (wasUnread) setSummary((current) => ({ ...current, unread: Math.max(0, current.unread - 1) }));
      },
      markAllRead: () => {
        setNotifications((current) => allRead(current, new Date().toISOString()));
        setSummary((current) => ({ ...current, unread: 0 }));
      },
    }),
    [data, summary, notifications],
  );
  return <HeaderPreviewContext.Provider value={value}>{children}</HeaderPreviewContext.Provider>;
}

/** The preview's data and actions, or null on the app's pages (the slots then read the API). */
export function useHeaderPreview(): HeaderPreviewState | null {
  return useContext(HeaderPreviewContext);
}
