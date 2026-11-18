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
  of: (used: string, budget: string) => `${used} of ${budget}`,
  unlimited: 'No daily limit',
  unlimitedUsed: (used: string) => `${used} today`,
  /** "Resets at 12:00 AM Pacific Time (in 5 hours)": the usage meter's reset words (LIMIT_COPY) and the wait. */
  resetsIn: (when: string, wait: string) => `${LIMIT_COPY.resetsAt(when)} (${wait})`,
  reached: "Today's AI budget is used. New AI work uses your extra credit until it resets.",
  waiting: "Today's AI budget is used and you have no extra credit, so new AI work waits until it resets. Buy extra credit to keep going.",
  extraTitle: 'Extra usage',
  extraHint: "What's left for AI work once today's budget is used.",
  autoApplies: 'Auto-applies today',
  autoAppliesLabel: 'Auto-applies used today',
  autoAppliesUnlimited: 'Unlimited',
  autoAppliesOf: (used: number, limit: number) => `${used} of ${limit}`,
  freePlan: 'Free plan',
  paidPlan: 'Paid plan',
  paidUntil: (date: string) => `Until ${date}`,
  freeLine: "Subscribe for a Paid account's daily budget and limits.",
  subscribe: 'Subscribe',
  buyCredit: 'Buy credit',
  account: 'Account settings',
  loadFailed: "Your AI use couldn't be loaded. It tries again in a minute.",
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
  emptyHint: 'TailorIT tells you here when applications are prepared, a job you added is checked, or your AI use runs low.',
  loadFailed: "Your notifications couldn't be loaded.",
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
  admin: 'Admin',
};
