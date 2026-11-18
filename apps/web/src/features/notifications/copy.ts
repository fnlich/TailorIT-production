import type { NotificationGroup } from '@tailorit/shared/notifications';
// Relative, not '@/': the web tests read these.
import { BELL_COPY } from '../../components/shell/header/copy';

// v3.1 HEADER (D8; docs/design/v3.1/24-notifications-usage.md §2, §8): the words of the /notifications page and of
// Settings › Notification settings. The notifications' own words are message constants (the API renders them).

export const PAGE_COPY = {
  title: 'Notifications',
  description: 'What TailorIT did for you: your applications, the jobs you added, your account and the extension.',
  filterLabel: 'Show',
  all: 'All',
  unread: 'Unread',
  unreadCount: (count: string) => `Unread (${count})`,
  markAll: BELL_COPY.markAll,
  settings: BELL_COPY.settings,
  more: 'Show more',
  emptyAll: BELL_COPY.empty,
  emptyAllHint: BELL_COPY.emptyHint,
  emptyUnread: "You're all caught up",
  emptyUnreadHint: 'You have no unread notifications. Earlier ones are under All.',
  showAll: 'Show all',
  loadFailed: "Your notifications couldn't be loaded",
  loadFailedHint: 'Check your connection, then try again.',
  tryAgain: BELL_COPY.tryAgain,
  loading: 'Loading notifications',
} as const;

export const SETTINGS_COPY = {
  title: 'Notification settings',
  description: 'Choose what the bell tells you about. Changes save at once; turning one off stops new ones and keeps the ones you have.',
  loadFailed: "Your notification settings couldn't be loaded",
  saveFailed: "That setting couldn't be saved. Please try again.",
  tryAgain: BELL_COPY.tryAgain,
  loading: 'Loading your notification settings',
} as const;

/** Each group's switch: its name and what it tells you about (the kinds of NOTIFICATION_KIND_GROUP). */
export const GROUP_SETTINGS: Readonly<Record<NotificationGroup, { title: string; hint: string }>> = {
  applications: {
    title: 'Applications',
    hint: 'When Prepare & Queue finishes or fails, and when an auto-apply is submitted, needs you or fails.',
  },
  jobs: {
    title: 'Jobs you added',
    hint: 'When TailorIT has checked a job you added: published, waiting for a review, only visible to you, or refused.',
  },
  account: {
    title: 'Account',
    hint: "When today's AI budget is used, your extra credit runs low or out, or your Paid plan is about to end.",
  },
  extension: {
    title: 'Browser extension',
    hint: 'When the extension disconnects itself or its connection runs out.',
  },
  admin: {
    title: 'Admin',
    hint: 'New items in Review, failed runs, sources turned off after failing, and runs another admin paused or continued.',
  },
};
