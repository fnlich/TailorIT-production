import type { CreateApplicationBody } from '@tailorit/shared';
import type { AppDeps } from '../../../core/context';
import { AppError } from '../../../core/http/errors';
import { refuse } from '../../../core/http/refuse';
import { noteHeldAdd } from '../../job-reviews/new-jobs';
import { tryTakeAddSlot } from './limits';
import { addJobByLink } from './pipeline';
import { pauseMessage } from './verdict'; // v37 CLOSED (C3)

// v31 LINK (21-jobs-from-links.md §3): a tracker entry added by hand with a posting's link (POST /api/applications, the
// Tracker's "+ Add application") goes through the one pipeline: TailorIT reads the posting from the link, and when it
// can, the entry is the job's (its title, company and place TailorIT's, never the typed ones, which are dropped); when
// it cannot, the entry keeps what the person typed, theirs alone, as before (no job is made: the entry is the person's
// own record). Each such read takes one of the account's JOB_ADDS_PER_HOUR; past them the entry is kept as typed.

/**
 * The entry's body after its link was read: with the job TailorIT read (the typed title, company and place dropped),
 * or as given when the link cannot be read. 400 (MSG_JOB_ADD_NEEDS_DETAILS) for a link TailorIT cannot read sent with
 * no title or company. v33 SHARE-9 fix (SHARE-3's edit 5; PLAN-sharing.md §4: an hourly limit is the person's, never
 * multiplied by profiles): the read takes an add from `actorId`'s hour (the signed-in person, B on a shared profile);
 * the entry and the job stay `userId`'s.
 */
export async function trackerEntryOfLink(
  deps: AppDeps,
  userId: string,
  body: CreateApplicationBody,
  actorId: string, // v33 SHARE-9 fix (required: every caller names who adds)
  grantId: string | null = null, // v33 SHARE-6: the grant `actorId` adds under on `userId`'s profile (its notices)
): Promise<CreateApplicationBody> {
  if (body.jobId !== undefined || !body.postingUrl) return body;
  if (tryTakeAddSlot(deps, actorId)) {
    const actor = actorId !== userId ? { actor: { id: actorId, grantId } } : {}; // v33 SHARE-6
    const added = await addJobByLink(deps, { url: body.postingUrl, userId, origin: 'tracker', privateJob: false, ...actor });
    if (added.jobId !== null && (added.state === 'published' || added.state === 'waiting_admin')) {
      // A held job is its adders' alone: this account's report row first, as Add job's save writes it.
      // v33 SHARE-6: named with who adds it (B on this profile hears its approval there).
      if (added.state === 'waiting_admin') await noteHeldAdd(deps, userId, added.jobId, { addedBy: actorId, grantId });
      const { title: _title, companyName: _company, location: _location, ...rest } = body;
      return { ...rest, jobId: added.jobId, ...(added.url ? { postingUrl: added.url } : {}) };
    }
    // v37 CLOSED (C3): the site (every Workday site) paused TailorIT: an entry with no title or company says when to try
    // again (503), never "add the title and company" for a link TailorIT reads.
    if (added.pause && (!body.title || !body.companyName)) throw new AppError('ats_unavailable', pauseMessage(deps, added.pause));
  }
  if (!body.title || !body.companyName) {
    throw refuse(deps, 'validation_failed', 'MSG_JOB_ADD_NEEDS_DETAILS', {}, { fields: { ...(!body.title ? { title: 'Required' } : {}), ...(!body.companyName ? { companyName: 'Required' } : {}) } });
  }
  return body;
}
