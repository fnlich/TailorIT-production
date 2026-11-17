import { z } from 'zod';
import { messageError } from '../constants/public/defaults';
import { IsoDateTime } from '../core/list';

// v2.0: admin announcements (A19; docs/design/v2.0/01-data-model.md 0826, 08-ui.md). Plain text only, shown to every
// signed-in person until it expires or they dismiss it; a dismissal is theirs alone.
//   GET    /api/announcements                     (session) → AnnouncementList: active, not dismissed, most severe
//                                                 first, at most ANNOUNCEMENTS_SHOWN_MAX
//   POST   /api/announcements/:id/dismiss         (session) → 204
//   GET    /api/admin/announcements               (admin) → AdminAnnouncementList (expired ones too)
//   POST   /api/admin/announcements               (admin) AnnouncementBody → 201 AdminAnnouncement
//   PUT    /api/admin/announcements/:id           (admin) AnnouncementBody → AdminAnnouncement
//   DELETE /api/admin/announcements/:id           (admin) → 204

export const ANNOUNCEMENT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type AnnouncementSeverity = (typeof ANNOUNCEMENT_SEVERITIES)[number];

/** The banner's order: the most severe first. */
export const ANNOUNCEMENT_SEVERITY_RANK: Record<AnnouncementSeverity, number> = { critical: 0, warning: 1, info: 2 };

export const ANNOUNCEMENT_TITLE_MAX = 120;
export const ANNOUNCEMENT_BODY_MAX = 2000;

/** Control characters other than line breaks and tabs are removed: an announcement is plain text. */
const plainText = (text: string) =>
  text.replace(/\r\n?/g, '\n').replace(/[\p{Cc}\p{Cf}]/gu, (char) => (char === '\n' || char === '\t' ? char : ''));

/** One announcement as a person sees it. */
export const AnnouncementSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  severity: z.enum(ANNOUNCEMENT_SEVERITIES),
  /** null: until the admin deletes it. */
  expiresAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Announcement = z.infer<typeof AnnouncementSchema>;

export const AnnouncementListSchema = z.object({ items: z.array(AnnouncementSchema) });
export type AnnouncementList = z.infer<typeof AnnouncementListSchema>;

/** One announcement in Admin › Announcements: whether it shows now, and how many people dismissed it. */
export const AdminAnnouncementSchema = AnnouncementSchema.extend({
  active: z.boolean(),
  dismissedCount: z.number().int().nonnegative(),
  /** The admin who made it (null once that account is gone). */
  createdBy: z.object({ id: z.string(), name: z.string() }).nullable(),
});
export type AdminAnnouncement = z.infer<typeof AdminAnnouncementSchema>;

export const AdminAnnouncementListSchema = z.object({ items: z.array(AdminAnnouncementSchema) });
export type AdminAnnouncementList = z.infer<typeof AdminAnnouncementListSchema>;

/**
 * POST and PUT /api/admin/announcements: plain text (control characters but line breaks and tabs removed). The route
 * refuses an `expiresAt` that is not in the future (400).
 */
export const AnnouncementBodySchema = z.object({
  title: z
    .string()
    .overwrite(plainText)
    .trim()
    .min(1, 'Give the announcement a title')
    .max(ANNOUNCEMENT_TITLE_MAX, messageError('MSG_TEXT_TOO_LONG', { max: ANNOUNCEMENT_TITLE_MAX }))
    .refine((title) => !title.includes('\n'), 'Keep the title on one line'),
  body: z
    .string()
    .overwrite(plainText)
    .max(ANNOUNCEMENT_BODY_MAX, messageError('MSG_TEXT_TOO_LONG', { max: ANNOUNCEMENT_BODY_MAX }))
    .default(''),
  severity: z.enum(ANNOUNCEMENT_SEVERITIES).default('info'),
  expiresAt: z.iso.datetime().nullable().default(null),
});
export type AnnouncementBody = z.infer<typeof AnnouncementBodySchema>;
export type AnnouncementBodyInput = z.input<typeof AnnouncementBodySchema>;
