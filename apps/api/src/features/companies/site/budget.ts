// v30 E2: the company websites' own budget (docs/design/part2/13-company-enrichment.md §4 rule 4): at most
// COMPANY_SITE_FETCH_PER_MINUTE page and logo reads a minute across every host, on top of each host's pace (the shared
// reader's crawl_hosts). It is kept in the process that works the enrichment queue (the ingest worker: one process,
// S1-API's open item 3), on the real clock.

import { MINUTE_MS } from '@tailorit/shared';

export interface SiteBudget {
  /** Takes one read of the minute's budget: 0 when taken, else how long (ms) until one is free (nothing taken). */
  take(perMinute: number): number;
}

/** A sliding minute: the reads of the last 60 s are counted. */
export function createSiteBudget(now: () => number = Date.now): SiteBudget {
  const reads: number[] = [];
  return {
    take(perMinute) {
      const at = now();
      while (reads.length > 0 && reads[0]! <= at - MINUTE_MS) reads.shift();
      if (reads.length < perMinute) {
        reads.push(at);
        return 0;
      }
      return Math.max(1, reads[0]! + MINUTE_MS - at);
    },
  };
}

/** The process's budget. */
export const processSiteBudget = createSiteBudget();
