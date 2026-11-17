import {
  ANNOUNCEMENT_BODY_MAX,
  ANNOUNCEMENT_TITLE_MAX,
  AnnouncementBodySchema,
  type AdminAnnouncement,
  type AnnouncementBody,
  type AnnouncementSeverity,
} from '@tailorit/shared/announcements';

// v2.0: Admin › Announcements (docs/design/v2.0/08-ui.md, "Announcements"): the editor's state and what it sends, the
// list's words. Pure, so the tests read it without a page.

export const SEVERITY_OPTIONS: readonly { value: AnnouncementSeverity; label: string }[] = [
  { value: 'info', label: 'Info' },
  { value: 'warning', label: 'Warning' },
  { value: 'critical', label: 'Critical' },
];

export const SEVERITY_BADGE: Record<AnnouncementSeverity, 'sky' | 'warning' | 'destructive'> = {
  info: 'sky',
  warning: 'warning',
  critical: 'destructive',
};

/** "Expires Dec 1, 9:00 AM" or "No expiry". */
export function expiryText(expiresAt: string | null): string {
  if (!expiresAt) return 'No expiry';
  const when = new Date(expiresAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `Expires ${when}`;
}

export interface AnnouncementDraft {
  title: string;
  body: string;
  severity: AnnouncementSeverity;
  noExpiry: boolean;
  /** The expiry's local day, or null while none is picked. */
  expiresOn: Date | null;
  /** "HH:MM", a half hour. */
  expiresAt: string;
}

/** A new announcement's editor: no expiry, Info. */
export const EMPTY_DRAFT: AnnouncementDraft = {
  title: '',
  body: '',
  severity: 'info',
  noExpiry: true,
  expiresOn: null,
  expiresAt: '09:00',
};

/** An announcement in the editor: its expiry split into a day and the half hour before it. */
export function draftOfAnnouncement(item: Pick<AdminAnnouncement, 'title' | 'body' | 'severity' | 'expiresAt'>): AnnouncementDraft {
  if (!item.expiresAt) return { ...EMPTY_DRAFT, title: item.title, body: item.body, severity: item.severity };
  const at = new Date(item.expiresAt);
  const minutes = at.getHours() * 60 + at.getMinutes();
  const half = Math.min(47, Math.floor(minutes / 30));
  return {
    title: item.title,
    body: item.body,
    severity: item.severity,
    noExpiry: false,
    expiresOn: new Date(at.getFullYear(), at.getMonth(), at.getDate()),
    expiresAt: `${String(Math.floor(half / 2)).padStart(2, '0')}:${half % 2 ? '30' : '00'}`,
  };
}

/** The local instant of a day and a time ("09:30"). */
export function expiryInstant(day: Date, time: string): Date {
  const [hours, minutes] = time.split(':').map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours ?? 0, minutes ?? 0, 0, 0);
}

export type DraftErrors = Partial<Record<'title' | 'body' | 'expires', string>>;
export type DraftResult = { ok: true; body: AnnouncementBody } | { ok: false; errors: DraftErrors };

/** What Save sends: plain text (AnnouncementBodySchema), an expiry in the future or none. */
export function bodyOfDraft(draft: AnnouncementDraft, now: number): DraftResult {
  const errors: DraftErrors = {};
  let expiresAt: string | null = null;
  if (!draft.noExpiry) {
    if (!draft.expiresOn) errors.expires = 'Pick the day it expires, or tick No expiry';
    else {
      const instant = expiryInstant(draft.expiresOn, draft.expiresAt);
      if (instant.getTime() <= now) errors.expires = 'Pick a time in the future';
      else expiresAt = instant.toISOString();
    }
  }
  const parsed = AnnouncementBodySchema.safeParse({ title: draft.title, body: draft.body, severity: draft.severity, expiresAt });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if ((field === 'title' || field === 'body') && !errors[field]) errors[field] = issue.message;
    }
  }
  if (Object.keys(errors).length > 0 || !parsed.success) return { ok: false, errors };
  return { ok: true, body: parsed.data };
}

export const LIMITS = { title: ANNOUNCEMENT_TITLE_MAX, body: ANNOUNCEMENT_BODY_MAX } as const;
