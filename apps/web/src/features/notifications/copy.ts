import type { NotificationGroup } from '@tailorit/shared/notifications';
// Relative, not '@/': the web tests read these.
import { BELL_COPY } from '../../components/shell/header/copy';

// v3.1 HEADER (D8; docs/design/v3.1/24-notifications-usage.md §2, §8): the words of the /notifications page and of
// Settings › Notification settings. The notifications' own words are message constants (the API renders them).

export const PAGE_COPY = {
  title: 'Notifications',
  description: 'What TailorIT did for you.',
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
  emptyUnreadHint: 'Earlier ones are under All.',
  showAll: 'Show all',
  loadFailed: "Your notifications didn't load.",
  loadFailedHint: 'Check your connection and try again.',
  tryAgain: BELL_COPY.tryAgain,
  loading: 'Loading notifications',
} as const;

export const SETTINGS_COPY = {
  title: 'Notification settings',
  description: 'What the bell tells you about; changes save at once.',
  loadFailed: "Your notification settings didn't load",
  saveFailed: "That setting wasn't saved. Try again.",
  tryAgain: BELL_COPY.tryAgain,
  loading: 'Loading your notification settings',
} as const;

/** Each group's switch: its name and what it tells you about (the kinds of NOTIFICATION_KIND_GROUP). */
export const GROUP_SETTINGS: Readonly<Record<NotificationGroup, { title: string; hint: string }>> = {
  applications: {
    title: 'Applications',
    hint: 'Prepare & Queue and auto-apply results.',
  },
  jobs: {
    title: 'Jobs you added',
    hint: 'When a job you added is checked.',
  },
  account: {
    title: 'Account',
    hint: "Today's AI use, extra credit and your Paid plan's end.",
  },
  extension: {
    title: 'Browser extension',
    hint: 'When the extension disconnects.',
  },
  admin: {
    title: 'Admin',
    hint: 'Review items, failed runs and paused sources.',
  },
};
