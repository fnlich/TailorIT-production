import {
  CRAWL_HOST_HOLD_LABEL,
  type AdminHostRow,
  type SiteRobots,
  type SiteRobotsStatus,
} from '@tailorit/shared/sourcing';

// v30 S1-WEB: the words Admin › Hosts shows for a host (12 §9.2, §9.4): its pace (one request at a time, at least the
// floor or the Crawl-delay apart), its hold (Retry-After, the breaker, a bot check, an admin), its failures and its
// robots.txt with the content signals. Pure.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** "1 request a second", "1 request every 10 seconds", "1 request every 1.5 seconds", "1 request a minute". */
export function paceText(minIntervalMs: number): string {
  if (minIntervalMs <= 0) return 'No floor';
  if (minIntervalMs === SECOND) return '1 request a second';
  if (minIntervalMs === MINUTE) return '1 request a minute';
  if (minIntervalMs < MINUTE) {
    const seconds = Math.round((minIntervalMs / SECOND) * 10) / 10;
    return `1 request every ${seconds.toLocaleString('en-US')} ${seconds === 1 ? 'second' : 'seconds'}`;
  }
  const minutes = Math.round((minIntervalMs / MINUTE) * 10) / 10;
  return `1 request every ${minutes.toLocaleString('en-US')} minutes`;
}

/** Whether a hold is on now. */
export function isHeld(host: Pick<AdminHostRow, 'holdUntil'>, now: number): boolean {
  return host.holdUntil !== null && Date.parse(host.holdUntil) > now;
}

/** "3:00 PM" today, "Nov 16, 3:00 PM" later. */
export function clockText(value: string, now: number): string {
  const date = new Date(value);
  const sameDay = new Date(now).toDateString() === date.toDateString();
  return date.toLocaleString('en-US', sameDay ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Why and until when a host is held; null when it is not held now. */
export function holdText(host: Pick<AdminHostRow, 'holdUntil' | 'holdReason'>, now: number): string | null {
  if (!isHeld(host, now) || !host.holdUntil) return null;
  const reason = host.holdReason ? CRAWL_HOST_HOLD_LABEL[host.holdReason] : 'Held';
  return `${reason}, until ${clockText(host.holdUntil, now)}`;
}

/** "Held for 2 hours more", for a hold's badge; "Held" under a minute. */
export function holdLeftText(holdUntil: string, now: number): string {
  const left = Date.parse(holdUntil) - now;
  if (left >= HOUR) {
    const hours = Math.round(left / HOUR);
    return `Held ${hours} ${hours === 1 ? 'hour' : 'hours'} more`;
  }
  if (left >= MINUTE) {
    const minutes = Math.round(left / MINUTE);
    return `Held ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} more`;
  }
  return 'Held';
}

/** "4 sources, 1 failing". */
export function sourcesText(host: Pick<AdminHostRow, 'sources' | 'failingSources'>): string {
  const sources = `${host.sources.toLocaleString('en-US')} ${host.sources === 1 ? 'source' : 'sources'}`;
  return host.failingSources > 0 ? `${sources}, ${host.failingSources.toLocaleString('en-US')} failing` : sources;
}

/** A host's last answer: "200", "429"; "None yet" before its first. */
export function lastStatusText(status: number | null): string {
  return status === null ? 'None yet' : String(status);
}

export const ROBOTS_STATUS_LABEL: Record<SiteRobotsStatus, string> = {
  ok: 'Read',
  no_rules: 'No rules (the file answered 4xx)',
  unreachable: 'Not reachable: no reads until it answers',
};

/** What the content signals say about AI. */
export function aiInputText(robots: Pick<SiteRobots, 'aiInput'>): string {
  if (robots.aiInput === false) return 'ai-input=no: its postings are never sent to AI';
  if (robots.aiInput === true) return 'AI input allowed';
  return 'No content signal about AI';
}

/** "10 seconds" (Crawl-delay), or "None". */
export function crawlDelayText(seconds: number | null): string {
  if (seconds === null) return 'None';
  return `${seconds.toLocaleString('en-US')} ${seconds === 1 ? 'second' : 'seconds'}`;
}

/** The holds an admin picks from, in hours (each inside AdminHostHoldBodySchema's range; a test checks it). */
export const HOLD_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: '1', label: '1 hour' },
  { value: '6', label: '6 hours' },
  { value: '24', label: '1 day' },
  { value: '72', label: '3 days' },
  { value: '168', label: '1 week' },
];
