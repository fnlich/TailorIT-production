import {
  ANNOUNCEMENT_SEVERITY_RANK,
  type Announcement,
  type AnnouncementSeverity,
} from '@tailorit/shared/announcements';

// v2.0: what the announcement banner shows (docs/design/v2.0/08-ui.md, "The announcement banner"), pure so the tests
// read it without a page. The server already answers the active, not-dismissed ones, most severe first, at most
// ANNOUNCEMENTS_SHOWN_MAX; the banner keeps that order, drops what this person just dismissed (the dismissal is
// optimistic) and what expired since the last read.

/** The Notice tone of each severity: info → info, warning → warning, critical → error. */
export const SEVERITY_TONE = {
  info: 'info',
  warning: 'warning',
  critical: 'error',
} as const satisfies Record<AnnouncementSeverity, 'info' | 'warning' | 'error'>;

/** The severity's words, for screen readers (the colour and icon say it to the eye). */
export const SEVERITY_LABEL: Record<AnnouncementSeverity, string> = {
  info: 'Info',
  warning: 'Warning',
  critical: 'Critical',
};

/** The words of the banner. */
export const BANNER_COPY = {
  region: 'Announcements',
  dismiss: (title: string) => `Dismiss announcement: ${title}`,
  dismissFailed: "The announcement wasn't dismissed",
} as const;

/**
 * The announcements to show, in order: the most severe first, then the newest. Those in `dismissed` (dismissed here,
 * the request maybe still on its way) and those whose expiry has passed at `now` are left out.
 */
export function bannerItems(
  items: readonly Announcement[],
  dismissed: ReadonlySet<string>,
  now: number,
): Announcement[] {
  return items
    .filter((item) => !dismissed.has(item.id))
    .filter((item) => item.expiresAt === null || Date.parse(item.expiresAt) > now)
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        ANNOUNCEMENT_SEVERITY_RANK[a.item.severity] - ANNOUNCEMENT_SEVERITY_RANK[b.item.severity] ||
        Date.parse(b.item.createdAt) - Date.parse(a.item.createdAt) ||
        a.index - b.index,
    )
    .map(({ item }) => item);
}

/**
 * Whether the banner announces this one as an alert (role="alert"): a critical announcement, the first time this tab
 * shows it. A warning or info one is read in the region like the rest of the page.
 */
export function announcesAsAlert(item: Pick<Announcement, 'id' | 'severity'>, announced: ReadonlySet<string>): boolean {
  return item.severity === 'critical' && !announced.has(item.id);
}
