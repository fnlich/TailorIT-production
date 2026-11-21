import type { NotificationGroup } from '@tailorit/shared/notifications';
// Relative, not '@/': the web tests read these.
import { LIMIT_COPY } from '../../limits/copy';

// v3.1 HEADER (D8, D9; docs/design/v3.1/24-notifications-usage.md §8): the words of the top bar's usage chip and
// notifications bell, and of the notification rows the /notifications page shares with the bell. The notifications'
// own titles and bodies are message constants, rendered by the API when each is written.

export const USAGE_COPY = {
  /** The meter's accessible name (and its label in the popover). */
  meterLabel: 'AI use today',
  extra: (amount: string) => `Extra usage ${amount}`,
  popoverLabel: 'AI use and extra usage',
  title: 'AI use today',
  /** v32 SHELL (E7): today's use is a share of the daily limit, never an amount. */
  percentUsed: (percent: string) => `${percent} used`,
  unlimited: 'No daily limit',
  /** The chip's words with no daily limit. */
  unlimitedShort: 'No limit',
  /** "Resets at 12:00 AM Pacific Time (in 5 hours)": the usage meter's reset words (LIMIT_COPY) and the wait. */
  resetsIn: (when: string, wait: string) => `${LIMIT_COPY.resetsAt(when)} (${wait})`,
  reached: 'Daily limit reached. Extra credit is in use.',
  waiting: 'Daily limit reached. AI work waits for the reset.',
  extraTitle: 'Extra usage',
  /** v32 SHELL (E5): the "?" beside Extra usage. */
  extraHint: 'Credit for AI work once the daily limit is reached.',
  autoApplies: 'Auto-applies today',
  autoAppliesLabel: 'Auto-applies used today',
  autoAppliesUnlimited: 'Unlimited',
  autoAppliesOf: (used: number, limit: number) => `${used} of ${limit}`,
  freePlan: 'Free plan',
  paidPlan: 'Paid plan',
  paidUntil: (date: string) => `Until ${date}`,
  /** v32 SHELL (E5): the "?" beside a Free plan's badge. */
  freeLine: 'A Paid plan has a higher daily limit.',
  subscribe: 'Subscribe',
  buyCredit: 'Buy credit',
  account: 'Account settings',
  loadFailed: "Your AI use didn't load; it tries again in a minute.",
} as const;

export const BELL_COPY = {
  name: 'Notifications',
  nameUnread: (count: string) => `Notifications, ${count} unread`,
  title: 'Notifications',
  markAll: 'Mark all read',
  markRead: 'Mark as read',
  markReadOf: (title: string) => `Mark "${title}" as read`,
  seeAll: 'See all notifications',
  settings: 'Notification settings',
  empty: 'No notifications yet',
  /** v32 SHELL (E5): the "?" beside the bell popover's title (and the /notifications page's empty state). */
  emptyHint: 'Updates on your applications, the jobs you added and your AI use.',
  loadFailed: "Your notifications didn't load.",
  loading: 'Loading notifications',
  tryAgain: 'Try again',
  unread: 'Unread',
  /** The live region's words when new notifications arrive. */
  arrived: (added: number, unread: string) =>
    `${added} new ${added === 1 ? 'notification' : 'notifications'}, ${unread} unread`,
  markFailed: "That couldn't be marked as read. Please try again.",
} as const;

/** Each group's name, as headings and captions say it (Settings › Notification settings has the longer words). */
export const GROUP_LABEL: Readonly<Record<NotificationGroup, string>> = {
  applications: 'Applications',
  jobs: 'Jobs you added',
  account: 'Account',
  extension: 'Browser extension',
  sharing: 'Sharing', // v33 SHARE-0
  admin: 'Admin',
};
