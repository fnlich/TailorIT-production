import { constantsOf } from '../../../core/constants/index';
import type { AppDeps } from '../../../core/context';
import { assertNewReadAllowed } from '../../../core/http/identity';
import { OutboundRefusedError } from '../../../core/http/outbound';

// v30 S5: the two gates of every career-page read (docs/design/part2/12-job-sourcing.md §3.4, PLAN §5, DECISIONS P1):
//   1. the admin switch SITE_READER_CAREER_PAGES ("Read career pages"), off until the owner has a lawyer's view (owner
//      question 8). It also keeps the discovery of career sites off (discover.ts);
//   2. the identity guard (core/http/identity.ts assertNewReadAllowed, kind `site_reader`): no new kind of outside read
//      while BOT_USER_AGENT is a placeholder (owner question 7).
// The shared reader (core/seams.ts siteReader, E2's) checks both again before it sends anything; these checks come
// first so a run refuses before it asks the reader for anything.

/** The deps the switch reads (the central constants: DB > .env > default). */
export type CareerDeps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** Whether career pages may be read and career sites discovered now (SITE_READER_CAREER_PAGES; default off). */
export function careerPagesOn(deps: CareerDeps): boolean {
  return constantsOf(deps).get('SITE_READER_CAREER_PAGES') === true;
}

/** A career-page read refused because "Read career pages" is off (nothing was sent). */
export class CareerPagesOffError extends OutboundRefusedError {
  constructor() {
    super(
      'TailorIT reads no career page while "Read career pages" (SITE_READER_CAREER_PAGES) is off: an admin turns it on ' +
        "in Admin › Settings once the lawyer's view is in (owner question 8).",
    );
    this.name = 'CareerPagesOffError';
  }
}

/** A career site whose domain opted out of TailorIT's reads (crawl_opt_outs, a company's do_not_fetch). */
export class CareerSiteOptedOutError extends OutboundRefusedError {
  constructor(host: string) {
    super(`${host} opted out of TailorIT's reads (Admin › Companies' opt-out list): nothing is read from it.`);
    this.name = 'CareerSiteOptedOutError';
  }
}

/**
 * Throws CareerPagesOffError while the switch is off, then NewReadRefusedError while BOT_USER_AGENT is a placeholder.
 * Call it before any career-page read.
 */
export function assertCareerPagesAllowed(deps: CareerDeps): void {
  if (!careerPagesOn(deps)) throw new CareerPagesOffError();
  assertNewReadAllowed(deps, 'site_reader');
}
