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
export function holdText(host: Pick<AdminHostRow, 'holdUntil' | 'holdReason' | 'label'>, now: number): string | null {
  if (!isHeld(host, now) || !host.holdUntil) return null;
  return `${holdReasonText(host)}, until ${clockText(host.holdUntil, now)}`;
}

// v37 LANE (SP v37 PLAN W10): the Workday lane's row. Every Workday site takes its turns on it ("Workday (all sites)"):
// its gap is the Workday gap constant (v37 FIX-LANE: or wider after 429s), its failures are 429 answers, and a 429
// pauses every Workday site. v37 FIX-LANE (the generic lane): a lane is any platform the server registers (only Workday
// in v3.6.1; v37 INT-2b: BambooHR and iCIMS too); its words name its platform (`platform`: "Workday", "BambooHR",
// "iCIMS"), never Workday by itself.

/** A row's name: a lane's ("Workday (all sites)"), else its host. */
export function hostName(host: Pick<AdminHostRow, 'host' | 'label'>): string {
  return host.label ?? host.host;
}

/** Whether a row is a lane many hosts share (not one host). */
export function isLaneRow(host: Pick<AdminHostRow, 'label'>): boolean {
  return Boolean(host.label);
}

/**
 * v37 FIX-LANE: a lane's (or a lane's site's) platform in a sentence: "Workday" (the server names it; else the lane's
 * name without its "(all sites)").
 */
export function platformOf(host: Pick<AdminHostRow, 'platform' | 'label' | 'lane'>): string {
  if (host.platform) return host.platform;
  const named = (host.label ?? host.lane ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  return named || 'its platform';
}

/** Why a row is held, in words: a lane's pause says its platform asked to slow down. */
export function holdReasonText(host: Pick<AdminHostRow, 'holdReason' | 'label' | 'platform'>): string {
  if (!host.holdReason) return 'Held';
  if (isLaneRow(host) && host.holdReason === 'retry_after') return `${platformOf(host)} asked to slow down (429)`;
  if (isLaneRow(host) && host.holdReason === 'breaker') return 'Too many 429s: held by the circuit breaker';
  return CRAWL_HOST_HOLD_LABEL[host.holdReason];
}

// v37 FIX-LANE (SP v37 FIXES-361 D3, F6; the ux review's M3): a lane's pace adapts to its platform's 429s (its gap
// widens, then eases back), its failures are its 429s in a window, and its breaker holds the whole platform after enough
// of them. A held row says so in its host cell (readable at 390 px without the table's sideways scroll); a lane's site
// whose lane is paused says it is paused with all of its platform; while held, the next free slot is after the hold.

/** "the last hour", "the last 30 minutes": the lane's 429 window. */
function windowText(minutes: number | undefined): string {
  const value = minutes ?? 60;
  if (value === 60) return 'the last hour';
  if (value % 60 === 0) return `the last ${value / 60} hours`;
  return `the last ${value} ${value === 1 ? 'minute' : 'minutes'}`;
}

/** The failures column's meaning: a lane counts its platform's 429 answers in its window. */
export function failuresLabel(host: Pick<AdminHostRow, 'label' | 'windowMinutes'>): string {
  return isLaneRow(host) ? `429s in ${windowText(host.windowMinutes)}` : 'Failures in a row';
}

/** A row's pace: a lane's gap now and, while 429s widened it, when it eases back ("…, easing back at 4:10 PM"). */
export function gapText(host: Pick<AdminHostRow, 'minIntervalMs' | 'easesAt' | 'label'>, now: number): string {
  const pace = paceText(host.minIntervalMs);
  return isLaneRow(host) && host.easesAt ? `${pace}, easing back at ${clockText(host.easesAt, now)}` : pace;
}

/** A lane's breaker in words: when it holds all of its platform, or (holding now) that it does. */
export function breakerText(
  host: Pick<AdminHostRow, 'breakerAfter' | 'breakerMinutes' | 'windowMinutes' | 'holdReason' | 'holdUntil' | 'platform' | 'label'>,
  now: number,
): string {
  const platform = platformOf(host);
  if (host.holdReason === 'breaker' && host.holdUntil && Date.parse(host.holdUntil) > now) return `Holding all of ${platform} until ${clockText(host.holdUntil, now)}`;
  const after = host.breakerAfter ?? 5;
  const minutes = host.breakerMinutes ?? 60;
  return `${after} 429s in ${windowText(host.windowMinutes)} hold all of ${platform} for ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

/** Why a host is held, after "Held until 3:00 PM: ". */
const HOLD_LINE_REASON: Record<NonNullable<AdminHostRow['holdReason']>, string> = {
  retry_after: 'the site asked TailorIT to wait',
  breaker: 'its requests failed too often',
  bot_check: 'a bot check or a 403',
  admin: 'an admin held it',
};

/** Whether a lane's site's requests wait for its lane's pause or hold now. */
export function lanePaused(host: Pick<AdminHostRow, 'laneHoldUntil'>, now: number): boolean {
  return Boolean(host.laneHoldUntil && Date.parse(host.laneHoldUntil) > now);
}

/**
 * A held row's hold, said in its host cell: "Paused until 7:53 PM: Workday asked to slow down" (the lane), "Held until
 * 3:00 PM: a bot check or a 403" (a host), "Paused with all of Workday until 7:53 PM" (a Workday site); null when
 * nothing holds it.
 */
export function holdLine(host: Pick<AdminHostRow, 'holdUntil' | 'holdReason' | 'label' | 'lane' | 'platform' | 'laneHoldUntil'>, now: number): string | null {
  if (isHeld(host, now) && host.holdUntil) {
    const until = clockText(host.holdUntil, now);
    if (isLaneRow(host) && host.holdReason === 'retry_after') return `Paused until ${until}: ${platformOf(host)} asked to slow down`;
    if (isLaneRow(host) && host.holdReason === 'breaker') return `Held until ${until}: too many 429s from ${platformOf(host)}`;
    if (isLaneRow(host) && host.holdReason === 'admin') return `Held until ${until}: an admin held all of ${platformOf(host)}`;
    return `Held until ${until}: ${HOLD_LINE_REASON[host.holdReason ?? 'admin']}`;
  }
  if (lanePaused(host, now) && host.laneHoldUntil) return `Paused with all of ${platformOf(host)} until ${clockText(host.laneHoldUntil, now)}`;
  return null;
}

/** When a row's next request may go: "Now", a time, or (held) after the hold or pause. */
export function nextSlotText(host: Pick<AdminHostRow, 'nextSlotAt' | 'holdUntil' | 'label' | 'lane' | 'platform' | 'laneHoldUntil'>, now: number): string {
  if (isHeld(host, now) && host.holdUntil) return `${isLaneRow(host) ? 'After the pause' : 'After the hold'} (${clockText(host.holdUntil, now)})`;
  if (lanePaused(host, now) && host.laneHoldUntil) return `After ${platformOf(host)}'s pause (${clockText(host.laneHoldUntil, now)})`;
  return Date.parse(host.nextSlotAt) <= now ? 'Now' : clockText(host.nextSlotAt, now);
}

/** D2: whether releasing a row's hold needs a warning first: the platform itself asked TailorIT to wait (a 429, its breaker). */
export function releaseNeedsWarning(host: Pick<AdminHostRow, 'label' | 'holdReason'>): boolean {
  return isLaneRow(host) && (host.holdReason === 'retry_after' || host.holdReason === 'breaker');
}

/** "12 Workday sources" for a lane; a host's sourcesText otherwise. */
export function rowSourcesText(host: Pick<AdminHostRow, 'sources' | 'failingSources' | 'label' | 'platform'>): string {
  if (!isLaneRow(host)) return sourcesText(host);
  const sources = `${host.sources.toLocaleString('en-US')} ${platformOf(host)} ${host.sources === 1 ? 'source' : 'sources'}`;
  return host.failingSources > 0 ? `${sources}, ${host.failingSources.toLocaleString('en-US')} failing` : sources;
}
// end v37 LANE

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
