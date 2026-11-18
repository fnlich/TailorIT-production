import { z } from 'zod';
import { IsoDateTime } from '../core/list';

// v3.1 NOTIFY (docs/design/v3.1/24-notifications-usage.md; build plan D8, D9): in-app notifications (the bell and the
// /notifications page; nothing is mailed) and the header's summary (today's AI use against the daily budget, extra
// credit left, the unread count). The API writes notifications where their events happen (features/notifications);
// each is kept NOTIFICATIONS_KEEP_DAYS. A person turns a group of kinds off in Settings › Notifications.
//   GET  /api/notifications?cursor&unread=1&limit   (session) → NotificationList, newest first
//   GET  /api/notifications/count                   (session) → NotificationCount
//   POST /api/notifications/:id/read                (session) → 204 (404 when it is not theirs)
//   POST /api/notifications/read-all                (session) → NotificationReadAll
//   GET  /api/notifications/prefs                   (session) → NotificationPrefs
//   PUT  /api/notifications/prefs                   (session) NotificationPrefsUpdate → NotificationPrefs
//   GET  /api/me/header                             (session) → HeaderSummary (every page, every 60 s: one query)

/** The groups a person turns on or off (Settings › Notifications). `admin` is listed for admins only. */
export const NOTIFICATION_GROUPS = ['applications', 'jobs', 'account', 'extension', 'admin'] as const;
export type NotificationGroup = (typeof NOTIFICATION_GROUPS)[number];

/** Every kind of notification, by group (NOTIFICATION_KIND_GROUP). */
export const NOTIFICATION_KINDS = [
  // applications: Prepare's batches and the auto-apply agent's runs
  'prepare_finished',
  'prepare_failed',
  'auto_apply_submitted',
  'auto_apply_needs_you',
  'auto_apply_failed',
  // jobs: a job the person added, read (or not) by TailorIT's server (LINK's states)
  'job_verified',
  'job_waiting',
  'job_unverified',
  'job_refused',
  // account: the day's AI budget, extra credit, the Paid plan
  'ai_budget_reached',
  'credit_low',
  'credit_used_up',
  'paid_ending',
  // extension
  'extension_disconnected',
  // admin (admins only)
  'admin_review_items',
  'admin_run_failed',
  'admin_source_disabled',
  'admin_runs_paused',
  'admin_runs_continued',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_KIND_GROUP: Readonly<Record<NotificationKind, NotificationGroup>> = {
  prepare_finished: 'applications',
  prepare_failed: 'applications',
  auto_apply_submitted: 'applications',
  auto_apply_needs_you: 'applications',
  auto_apply_failed: 'applications',
  job_verified: 'jobs',
  job_waiting: 'jobs',
  job_unverified: 'jobs',
  job_refused: 'jobs',
  ai_budget_reached: 'account',
  credit_low: 'account',
  credit_used_up: 'account',
  paid_ending: 'account',
  extension_disconnected: 'extension',
  admin_review_items: 'admin',
  admin_run_failed: 'admin',
  admin_source_disabled: 'admin',
  admin_runs_paused: 'admin',
  admin_runs_continued: 'admin',
};

/** The groups whose kinds only admins get. */
export const ADMIN_NOTIFICATION_GROUPS: readonly NotificationGroup[] = ['admin'];

/** How a notification reads at a glance (the bell's dot colour; tokens decide the colour, never this contract). */
export const NOTIFICATION_TONES = ['info', 'success', 'warning', 'danger'] as const;
export type NotificationTone = (typeof NOTIFICATION_TONES)[number];

export const NOTIFICATION_KIND_TONE: Readonly<Record<NotificationKind, NotificationTone>> = {
  prepare_finished: 'success',
  prepare_failed: 'danger',
  auto_apply_submitted: 'success',
  auto_apply_needs_you: 'warning',
  auto_apply_failed: 'danger',
  job_verified: 'success',
  job_waiting: 'info',
  job_unverified: 'warning',
  job_refused: 'danger',
  ai_budget_reached: 'warning',
  credit_low: 'warning',
  credit_used_up: 'danger',
  paid_ending: 'warning',
  extension_disconnected: 'warning',
  admin_review_items: 'info',
  admin_run_failed: 'danger',
  admin_source_disabled: 'danger',
  admin_runs_paused: 'info',
  admin_runs_continued: 'info',
};

/** The stored words' longest forms (the table's CHECKs). */
export const NOTIFICATION_TITLE_MAX = 160;
export const NOTIFICATION_BODY_MAX = 1000;
export const NOTIFICATION_LINK_MAX = 500;
/** The unread count stops at this number (the bell says "99+"): the count stays one cheap index read. */
export const NOTIFICATION_UNREAD_COUNT_CAP = 100;
/** One page of the list at most (the bell asks for 10, the page for more). */
export const NOTIFICATION_PAGE_MAX = 50;
export const NOTIFICATION_PAGE_DEFAULT = 20;

/** One notification as its person sees it. `link` is an address inside TailorIT (a path), or null. */
export const NotificationSchema = z.object({
  id: z.string(),
  kind: z.enum(NOTIFICATION_KINDS),
  group: z.enum(NOTIFICATION_GROUPS),
  tone: z.enum(NOTIFICATION_TONES),
  title: z.string(),
  body: z.string(),
  link: z.string().nullable(),
  createdAt: IsoDateTime,
  /** null: unread. */
  readAt: IsoDateTime.nullable(),
});
export type Notification = z.infer<typeof NotificationSchema>;

/** GET /api/notifications's query. `unread=1` lists only unread ones; `cursor` is the last page's `nextCursor`. */
export const NotificationListQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  unread: z
    .enum(['0', '1', 'true', 'false'])
    .optional()
    .transform((value) => value === '1' || value === 'true'),
  limit: z.coerce.number().int().min(1).max(NOTIFICATION_PAGE_MAX).default(NOTIFICATION_PAGE_DEFAULT),
});
export type NotificationListQuery = z.infer<typeof NotificationListQuerySchema>;
export type NotificationListQueryInput = z.input<typeof NotificationListQuerySchema>;

export const NotificationListSchema = z.object({
  items: z.array(NotificationSchema),
  /** The next page's cursor; null on the last page. */
  nextCursor: z.string().nullable(),
  /** Unread notifications (at most NOTIFICATION_UNREAD_COUNT_CAP). */
  unread: z.number().int().nonnegative(),
});
export type NotificationList = z.infer<typeof NotificationListSchema>;

export const NotificationCountSchema = z.object({
  /** Unread notifications, at most NOTIFICATION_UNREAD_COUNT_CAP ("99+" from it on). */
  unread: z.number().int().nonnegative(),
});
export type NotificationCount = z.infer<typeof NotificationCountSchema>;

export const NotificationReadAllSchema = z.object({
  /** How many were marked read. */
  marked: z.number().int().nonnegative(),
});
export type NotificationReadAll = z.infer<typeof NotificationReadAllSchema>;

/** One group's switch. Every group is on until its person turns it off. */
export const NotificationPrefSchema = z.object({ group: z.enum(NOTIFICATION_GROUPS), enabled: z.boolean() });
export type NotificationPref = z.infer<typeof NotificationPrefSchema>;

/** GET /api/notifications/prefs: every group the person may get (admin for admins only), in NOTIFICATION_GROUPS' order. */
export const NotificationPrefsSchema = z.object({ groups: z.array(NotificationPrefSchema) });
export type NotificationPrefs = z.infer<typeof NotificationPrefsSchema>;

/** PUT /api/notifications/prefs: the groups to change; the others keep their switch. */
export const NotificationPrefsUpdateSchema = z.object({
  groups: z
    .array(NotificationPrefSchema)
    .min(1)
    .max(NOTIFICATION_GROUPS.length)
    .refine((groups) => new Set(groups.map((g) => g.group)).size === groups.length, 'Name each group once'),
});
export type NotificationPrefsUpdate = z.infer<typeof NotificationPrefsUpdateSchema>;

/**
 * GET /api/me/header (D9): what the top bar shows on every page. `ai` is today's server-AI use against the person's
 * daily budget (`budgetMicros` null: unlimited); `extraCredit` is what is left once the day's budget is used ("Extra
 * usage"). Money is whole micro-dollars ($1 = 1,000,000).
 */
export const HeaderSummarySchema = z.object({
  unread: z.number().int().nonnegative(),
  ai: z.object({
    usedMicros: z.number().int().nonnegative(),
    budgetMicros: z.number().int().nonnegative().nullable(),
    /** When today's budget starts again (the day's reset: DAY_RESET_TIME in DAY_RESET_TIME_ZONE). */
    resetsAt: IsoDateTime,
  }),
  extraCredit: z.object({ balanceMicros: z.number().int().nonnegative() }),
  /** The effective plan now (a lapsed Paid term reads free). */
  plan: z.enum(['free', 'paid']),
  /** The Paid term's end; null on Free or for a term with no end. */
  paidUntil: IsoDateTime.nullable(),
});
export type HeaderSummary = z.infer<typeof HeaderSummarySchema>;
