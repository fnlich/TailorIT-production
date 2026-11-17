import type { AiCapacity, AiCapacitySource } from '@tailorit/shared/ai';
import { formatUsd } from '@tailorit/shared/constants';

// v2.0: Admin › AI › "Server AI status" (docs/design/v2.0/08-ui.md; 03-ai-usage.md, "What the admin sees"): the Claude
// seat's usage against the block threshold, where the reading came from, when it resets, and today's charged total and
// write-offs. Only admins see it. Pure, so the tests read it without a page.

/** How often the card is read while the AI tab is open. */
export const CAPACITY_REFRESH_MS = 30_000;

export const CAPACITY_SOURCE_TEXT: Record<AiCapacitySource, string> = {
  event: 'Claude CLI report',
  text: 'CLI limit message',
  ledger: "TailorIT's own spend estimate",
};

const NUMBER_WORDS: Record<string, string> = { one: '1', two: '2', three: '3', five: '5', seven: '7', twelve: '12', thirty: '30' };

/** "five_hour" → "5-hour window", "seven_day_opus" → "7-day window (opus)", "ledger" → "Spend window". */
export function windowText(window: string | null): string {
  if (!window) return 'No window';
  if (window === 'ledger') return 'Spend window';
  const match = /^([a-z]+|\d+)_(hour|day|week|month)s?(?:_(.+))?$/.exec(window);
  if (!match) return window.replace(/_/g, ' ');
  const count = NUMBER_WORDS[match[1]!] ?? match[1];
  return `${count}-${match[2]} window${match[3] ? ` (${match[3].replace(/_/g, ' ')})` : ''}`;
}

/** 0.843 → "84%"; no reading → "-". */
export function percentText(utilization: number | null): string {
  return utilization === null ? '-' : `${Math.round(utilization * 100)}%`;
}

/** "Resets 3:00 PM" today, "Resets Nov 14, 3:00 PM" another day; null with no reset time. */
export function resetsText(resetsAt: string | null, now: number): string | null {
  if (!resetsAt) return null;
  const at = new Date(resetsAt);
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const sameDay = new Date(now).toDateString() === at.toDateString();
  return sameDay ? `Resets ${time}` : `Resets ${at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`;
}

/** The state line: open, or blocking every person's server AI until the reading drops. */
export function capacityState(capacity: Pick<AiCapacity, 'blocked' | 'threshold' | 'utilization'>): { tone: 'open' | 'blocked' | 'none'; text: string } {
  const threshold = percentText(capacity.threshold);
  if (capacity.blocked) return { tone: 'blocked', text: `Blocking server AI for everyone until the reading drops below ${threshold}` };
  if (capacity.utilization === null) return { tone: 'none', text: 'Server AI is open. No usage reading yet.' };
  return { tone: 'open', text: `Server AI is open. It blocks at ${threshold}.` };
}

/** Today's charged total and write-offs: "$4.12 charged today · $0.30 written off". */
export function todayText(capacity: Pick<AiCapacity, 'today'>): string {
  const { chargedMicros, writtenOffMicros } = capacity.today;
  return `${formatUsd(chargedMicros)} charged today · ${formatUsd(writtenOffMicros)} written off`;
}
