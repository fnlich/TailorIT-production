import { constantsOf } from '../../../core/constants/index';
import type { AppDeps } from '../../../core/context';
import { NewReadRefusedError } from '../../../core/http/identity';
import { siteReader, type SiteReadResult } from '../../../core/seams';
import { HostHeldError } from '../http';
import { RobotsRefusal } from '../robots';
import type { RobotsCheck } from './guards';
import { CareerPagesOffError, CareerSiteOptedOutError } from './switch';

// v30 S5: one career-site read through the shared reader (core/seams.ts siteReader, E2's; purpose `career_page`), with
// the run's own robots.txt check first (guards.ts): an address the host's kept robots.txt disallows is never handed to
// the reader. The reader's answer, sorted for the run:
//   ok        a 2xx page (its bytes);
//   gone      404 or 410: the posting has closed (12 §8.1);
//   disallowed robots.txt keeps it out (the kept file, or the reader's own check);
//   failed    any other failure of this one address (a 5xx, too large, too slow, not the type asked for);
//   stop      nothing more may be read from the host now: the switch is off, the identity is a placeholder, the site
//             opted out, its robots.txt cannot be read, or the host is held or blocked (the reader holds it; never
//             retried with another identity).

/** How long a held host waits when the reader names no time (it holds the host in crawl_hosts itself). */
export const HELD_HOST_WAIT_MS = 60 * 60_000;

export type PageRead =
  | { kind: 'ok'; body: Buffer; finalUrl: string; status: number }
  | { kind: 'gone'; status: number }
  | { kind: 'disallowed' }
  | { kind: 'failed'; message: string }
  | { kind: 'stop'; error: Error };

function hostOf(address: string): string {
  try {
    return new URL(address).hostname.toLowerCase();
  } catch {
    return address;
  }
}

/** The run's sorting of one reader answer (see the top). */
export function pageReadOf(result: SiteReadResult, address: string, deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>): PageRead {
  const host = hostOf(address);
  if (result.ok) {
    if (result.status >= 200 && result.status < 300 && !result.notModified) return { kind: 'ok', body: result.body, finalUrl: result.finalUrl, status: result.status };
    if (result.status === 404 || result.status === 410) return { kind: 'gone', status: result.status };
    return { kind: 'failed', message: `${address} answered HTTP ${result.status}.` };
  }
  const later = (ms: number) => result.retryAt ?? new Date(deps.now().getTime() + ms).toISOString();
  switch (result.refusal) {
    case 'robots':
      return { kind: 'disallowed' };
    case 'switch_off':
      return { kind: 'stop', error: new CareerPagesOffError() };
    case 'identity_placeholder':
      return { kind: 'stop', error: new NewReadRefusedError('site_reader') };
    case 'opted_out':
      return { kind: 'stop', error: new CareerSiteOptedOutError(host) };
    case 'held':
      return { kind: 'stop', error: new HostHeldError(host, later(HELD_HOST_WAIT_MS), 'backoff') };
    case 'blocked':
      return { kind: 'stop', error: new HostHeldError(host, later(constantsOf(deps).get('INGEST_BOT_CHECK_HOLD_HOURS') * 3_600_000), 'bot_check') };
    case 'failed':
    default:
      if (result.status === 404 || result.status === 410) return { kind: 'gone', status: result.status };
      return { kind: 'failed', message: `${address} could not be read${result.status ? ` (HTTP ${result.status})` : ''}.` };
  }
}

/** Reads one address of a career site (see the top). Outside any transaction. */
export async function readPage(
  deps: AppDeps,
  robots: RobotsCheck,
  address: string,
  accept: 'html' | 'xml',
): Promise<PageRead> {
  const host = hostOf(address);
  const verdict = await robots.verdict(address);
  if (verdict === 'disallowed') return { kind: 'disallowed' };
  if (verdict === 'unreachable') {
    return {
      kind: 'stop',
      error: new RobotsRefusal('unreadable', `${host}'s robots.txt could not be read (a 429, a 5xx or no answer): nothing is read from it now.`),
    };
  }
  const result = await siteReader.read(deps, { url: address, purpose: 'career_page', accept });
  // The reader may have read the host's robots.txt just now: the next check reads the kept file again.
  if (verdict === 'unknown') robots.forget(host);
  const read = pageReadOf(result, address, deps);
  // The reader's own robots refusal: a file that could not be read is "not now" for the whole host (12 §1 test 2).
  if (read.kind === 'disallowed' && (await robots.verdict(address)) === 'unreachable') {
    return { kind: 'stop', error: new RobotsRefusal('unreadable', `${host}'s robots.txt could not be read: nothing is read from it now.`) };
  }
  return read;
}
