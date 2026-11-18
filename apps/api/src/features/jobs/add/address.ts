import { shareableJobUrl } from '@tailorit/shared';
import { postingParameters } from '../../autofill/posting-parameters';

// v31 FIX-LINK (SEC-2, docs/design/v3.1/21-jobs-from-links.md §2): the form every address the add pipeline stores or
// shares takes (a job's Apply link and keys, a "Couldn't verify" row, a queued link, an answer's link): the shared
// canonical form without a person's secret parameters (packages/shared canonical.ts shareableJobUrl: ?email=, ?token=,
// ?session_id=, ?_s.crb=, ?candidate_id=, ...), keeping a parameter the posting's own address names whatever it looks like
// (autofill/posting-parameters.ts: JobDiva's agency key). A person's own link is read as they gave it; what is kept is this.

/** The address as the add pipeline stores and shares it (see the top), or null for what is no link. */
export function sharedAddress(link: string | null | undefined): string | null {
  if (!link) return null;
  return shareableJobUrl(link, postingParameters(link));
}
