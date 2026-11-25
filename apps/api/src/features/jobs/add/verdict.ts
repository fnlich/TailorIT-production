import { resetText, type JobVerifyReason } from '@tailorit/shared';
import { constantsOf } from '../../../core/constants/service';
import type { AppDeps } from '../../../core/context';
import { AppError } from '../../../core/http/errors';
import { lanePauseOf } from '../../ingest/hosts'; // v37 INT-A (one pause signal); v37 FIX-LANE (any lane, its name)
import { HostHeldError, type HostHoldReason } from '../../ingest/http';
import { RobotsRefusal } from '../../ingest/robots';
import { TermsRefusalError } from '../../ingest/terms'; // v37 FIX-37B (E2)
import { IngestError } from '../../ingest/types';

// v37 CLOSED (SP v37 PLAN.md C1, C3): the one verdict on TailorIT's read of a job link, for every path that reads one
// (Add job, Add by link and the tracker's link, the extension's add and From page, the MCP tool, an admin's and a
// person's import, Retry read, the page re-checks):
//   - open: TailorIT read the posting (a shared job stored);
//   - closed: the posting is gone: 404 or 410, Workday's error code or `posted: false`, a past validThrough;
//   - try later: the site failed for now or paused TailorIT: a 429, a held host or Workday's paused lane, a 5xx, a
//     timeout, a robots.txt that could not be read (`unavailable`), a sign-in wall or a bot check (`blocked`);
//   - can't read: the read's lasting word: robots.txt disallows it, no posting on the page, an address that names no
//     posting, a site TailorIT never reads, page reads not set up, an opt-out, an admin's rejection; v37 FIX-37B (E2):
//     a board whose source's terms an admin recorded as not allowing automated access (`terms`, nothing sent).
// A read while the site's host (or every Workday site: the LANE package's `workday.lane`) is paused carries the pause
// (`pause`: its end, the site's name, and whether the site asked TailorIT to slow down): the link queue reads it again
// after the pause without using a try (queue.ts), and a person's read answers at once with the time to try again
// (MSG_JOB_ADD_PAUSED, MSG_JOB_ADD_HELD; router.ts addJobResultOf), never "couldn't read".

export type LinkVerdict = 'open' | 'closed' | 'try_later' | 'cant_read';

/** A read made while its site (or every Workday site) paused TailorIT. */
export interface ReadPause {
  /** When the pause ends (ISO). */
  until: string;
  /** The site in words ("Workday", "Greenhouse", a careers page's host). */
  site: string;
  /** The site asked TailorIT to slow down (a 429, its Retry-After); else TailorIT holds the host itself. */
  slowDown: boolean;
}

/** What TailorIT's own read of a link came to (pipeline.ts readLink). */
export type LinkRead =
  | { kind: 'shared'; jobId: number; created: boolean; held: boolean }
  | { kind: 'closed' }
  | { kind: 'unreadable'; reason: JobVerifyReason; pause?: ReadPause };

/** The reasons a read failed for now, never a lasting answer about the job: try later (v31 FIX-LINK's BEH-3 set). */
export const TRY_LATER_REASONS: ReadonlySet<JobVerifyReason> = new Set(['unavailable', 'blocked']);

/** The verdict on a read (see the top). */
export function verdictOf(read: { kind: 'shared' } | { kind: 'closed' } | { kind: 'unreadable'; reason: JobVerifyReason }): LinkVerdict {
  if (read.kind === 'unreadable') return TRY_LATER_REASONS.has(read.reason) ? 'try_later' : 'cant_read';
  return read.kind === 'shared' ? 'open' : 'closed';
}

/**
 * v37 INT-A (the one pause signal): a host's hold a read met, as people hear it: a host held because its site answered
 * 429 (`retry_after`) is "{site} asked us to slow down"; any other hold (a bot check, a breaker after failures, an
 * admin's hold, a backoff) is TailorIT's own wait ("TailorIT is waiting before it reads {site} again"), which a person's
 * read answers as before (pipeline.ts: only a slow-down is refused at once). The site reader's `held` refusal is read
 * through it too (page.ts).
 */
export function pauseOfHold(hold: { until: string; reason: HostHoldReason }, site: string): ReadPause {
  return { until: hold.until, site, slowDown: hold.reason === 'retry_after' };
}

/**
 * The pause a held host's refusal names (HostHeldError), or null. v37 INT-A: the Workday lane's (LANE's workdayPauseOf:
 * a 429 from any Workday site paused all of Workday, or its breaker holds it after 429s in a row) is "Workday asked us
 * to slow down", ending when the lane's hold ends; an admin's hold of the lane is TailorIT's own wait. v37 FIX-LANE: any
 * lane's (the lane registry's name: "Workday"). Every person's
 * read (Add job, Add job to profiles, the extension's add and From page, the MCP tool, Retry read, a tracker entry's
 * link) and the link queue read a hold through this one helper.
 */
export function pauseOf(error: unknown, site: string): ReadPause | null {
  if (!(error instanceof HostHeldError)) return null;
  const lane = lanePauseOf(error);
  if (lane) return { until: lane.until, site: lane.lane.name, slowDown: lane.reason === 'retry_after' || lane.reason === 'breaker' };
  return pauseOfHold(error, site);
}

/**
 * An ATS read's failure (autofill/jobs.ts readAndStore's AppError) as a read: closed (404, gone), or why it could not be
 * read, its pause when the host was held (`site`: the ATS's name). Anything else is thrown.
 */
export function atsFailure(error: unknown, site: string): LinkRead {
  if (!(error instanceof AppError)) throw error;
  if (error.code === 'not_found') return { kind: 'closed' };
  // v37 FIX-37B (E2): the board's source has terms that don't allow automated access: nothing was read.
  if (error.cause instanceof TermsRefusalError) return { kind: 'unreadable', reason: 'terms' };
  if (error.code === 'unsupported') {
    return { kind: 'unreadable', reason: error.cause instanceof RobotsRefusal ? 'robots' : 'unlisted' };
  }
  const pause = pauseOf(error.cause, site);
  if (pause) return { kind: 'unreadable', reason: 'unavailable', pause };
  if (error.code === 'ats_failed') return { kind: 'unreadable', reason: error.cause instanceof IngestError ? 'no_posting' : 'unavailable' };
  if (error.code === 'ats_unavailable') return { kind: 'unreadable', reason: 'unavailable' };
  throw error;
}

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/**
 * A moment as the app says a time to people: its time of day in DAY_RESET_TIME_ZONE with the zone's words ("3:42 PM
 * Pacific Time"), as the daily reset's {reset_time} is written (@tailorit/shared resetText).
 */
export function timeForPeople(deps: Deps, at: string): string {
  const constants = constantsOf(deps);
  const zone = constants.get('DAY_RESET_TIME_ZONE');
  let clock = '';
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at));
    const hour = parts.find((part) => part.type === 'hour')?.value ?? '00';
    const minute = parts.find((part) => part.type === 'minute')?.value ?? '00';
    clock = `${hour}:${minute}`;
  } catch {
    clock = new Date(at).toISOString().slice(11, 16);
  }
  return resetText(clock, constants.get('DAY_RESET_ZONE_LABEL'));
}

/** What a person's read says while the site paused TailorIT: "Workday asked us to slow down. Try again after 3:42 PM …". */
export function pauseMessage(deps: Deps, pause: ReadPause): string {
  return constantsOf(deps).message(pause.slowDown ? 'MSG_JOB_ADD_PAUSED' : 'MSG_JOB_ADD_HELD', {
    site: pause.site,
    time: timeForPeople(deps, pause.until),
  });
}

/**
 * v37 CLOSED (C4): a Workday host is never read as a page (its candidate site is a single-page application over the
 * posting's JSON): a link of one that names no posting TailorIT reads is "can't read", without a request.
 */
export const isWorkdayPageHost = (host: string): boolean =>
  /(?:^|\.)myworkdayjobs\.com$/.test(host) || /(?:^|\.)myworkdaysite\.com$/.test(host) || /(?:^|\.)myworkday\.com$/.test(host);
