import type { CreateApplicationBody } from '@tailorit/shared';
import type { AppDeps } from '../../../core/context';
import { refuse } from '../../../core/http/refuse';
import { noteHeldAdd } from '../../job-reviews/new-jobs';
import { tryTakeAddSlot } from './limits';
import { addJobByLink } from './pipeline';

// v31 LINK (21-jobs-from-links.md §3): a tracker entry added by hand with a posting's link (POST /api/applications, the
// Tracker's "+ Add application") goes through the one pipeline: TailorIT reads the posting from the link, and when it
// can, the entry is the job's (its title, company and place TailorIT's, never the typed ones, which are dropped); when
// it cannot, the entry keeps what the person typed, theirs alone, as before (no job is made: the entry is the person's
// own record). Each such read takes one of the account's JOB_ADDS_PER_HOUR; past them the entry is kept as typed.

/**
 * The entry's body after its link was read: with the job TailorIT read (the typed title, company and place dropped),
 * or as given when the link cannot be read. 400 (MSG_JOB_ADD_NEEDS_DETAILS) for a link TailorIT cannot read sent with
 * no title or company.
 */
export async function trackerEntryOfLink(deps: AppDeps, userId: string, body: CreateApplicationBody): Promise<CreateApplicationBody> {
  if (body.jobId !== undefined || !body.postingUrl) return body;
  if (tryTakeAddSlot(deps, userId)) {
    const added = await addJobByLink(deps, { url: body.postingUrl, userId, origin: 'tracker', privateJob: false });
    if (added.jobId !== null && (added.state === 'published' || added.state === 'waiting_admin')) {
      // A held job is its adders' alone: this account's report row first, as Add job's save writes it.
      if (added.state === 'waiting_admin') await noteHeldAdd(deps, userId, added.jobId);
      const { title: _title, companyName: _company, location: _location, ...rest } = body;
      return { ...rest, jobId: added.jobId, ...(added.url ? { postingUrl: added.url } : {}) };
    }
  }
  if (!body.title || !body.companyName) {
    throw refuse(deps, 'validation_failed', 'MSG_JOB_ADD_NEEDS_DETAILS', {}, { fields: { ...(!body.title ? { title: 'Required' } : {}), ...(!body.companyName ? { companyName: 'Required' } : {}) } });
  }
  return body;
}
