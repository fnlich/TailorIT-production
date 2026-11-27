import { addablePosting, parseAtsUrl } from '@tailorit/shared/autofill';
import { WORKDAY_BOARD, workdayTenant } from '@tailorit/shared/sourcing';
import { str } from '../adapters/common';
import { readWorkdayPosting, workdayAdapter, workdayPostingUrl, type WorkdayRef } from '../adapters/workday';
import { IngestError } from '../types';
import { configString } from './read-json';
import type { ApiBoardDescriptor, LinkToRead, PostingRef } from './types';

// v38 FRAME: Workday's one-posting kind's API part (its shared part: @tailorit/shared/sourcing WORKDAY_BOARD).
// One posting: /wday/cxs/<tenant>/<site>/job/<location>/<slug>_<reqId> on the posting's own host, the read its page makes,
// once the host's robots.txt allows it (adapters/workday.ts); a Workday career site's postings are read the same way
// (./workday-site.ts: their refs are Workday's). A link is read through the autofill contract's addable posting
// (autofill/jobs.ts).

/** A Workday posting's reference for its reader, or an IngestError when the ref lacks its address parts. */
function workdayRefOf(ref: PostingRef): WorkdayRef {
  const tenant = workdayTenant(ref.board);
  if (!ref.workday || !tenant) throw new IngestError("TailorIT does not know this Workday posting's address.");
  return { ...ref.workday, tenant, reqId: ref.externalId };
}

/**
 * The posting a stored link of a Workday source names (either kind): the tenant is the source's; the site, location and
 * name are the job's own link's, the posting the link's id.
 */
export function workdayRefOfLink(link: LinkToRead): PostingRef | null {
  const { source, sourceJobId } = link;
  const tenant = workdayTenant(configString(source.config, 'tenant'));
  const posting = addablePosting(parseAtsUrl(link.jobUrl));
  if (!tenant || posting?.kind !== 'workday' || !posting.workday || posting.board !== tenant) return null;
  // The job's link names the posting the link's id names, or (a posting added by its requisition's address, …_JR123,
  // whose job links the page Workday named, …_JR123-2) one of that requisition's postings.
  const id = sourceJobId.toLowerCase();
  const named = posting.externalId.toLowerCase();
  const ofRequisition = named.startsWith(`${id}-`) && /^\d+$/.test(named.slice(id.length + 1));
  if (named !== id && !ofRequisition) return null;
  return { kind: 'workday', board: tenant, externalId: sourceJobId, region: 'global', workday: posting.workday };
}

export const WORKDAY: ApiBoardDescriptor<'workday'> = {
  board: WORKDAY_BOARD,
  adapter: workdayAdapter,
  terms: { status: 'allowed', url: null },
  // Read one posting at a time, each read asking its tenant's robots.txt itself: no source-level verdict.
  noRobots: true,
  posting: {
    refOf: workdayRefOfLink,
    apiUrl: (ref) => workdayPostingUrl(workdayRefOf(ref)),
    // Without a companyName, the hiring organisation Workday names is the company.
    read: (http, ref, options) => readWorkdayPosting(http, workdayRefOf(ref), str(options.config?.companyName), options.signal),
  },
};
