import type { DbQueries } from '../../../core/db/types';
import { storedSourceJobId } from '../../ingest/normalize';
import type { PostingAnswer } from '../../ingest/postings';

// v38 FIX-APP (SP v38 FIXES-38 D1; REVIEW38-ux H1): TailorIT never makes up an employer's name (a host label, an id, the
// platform's name). A posting read from its link that names no company (ADP's; an Oracle site whose list names no single
// organisation; UKG's; Dayforce's without its site's name) is named, in order, by its source's Company name or an import
// row's (board-link.ts, as before), by the company the job TailorIT stored of it has (a name given before), or by the
// company the person typed in Add job (`company`). When none names it, Add job asks for the company: nothing is stored,
// and the read is kept here a while, so the add that brings the company saves it without reading the posting again
// (one request less on the platform's lane). Kept per app (a WeakMap on the deps), for KEPT_READ_MS, at most
// KEPT_READ_MAX reads (the oldest goes first); a restart forgets them (the add then reads the posting again).

/** How long a read that named no company is kept for the add that brings the company: 30 minutes. */
export const KEPT_READ_MS = 30 * 60_000;
/** The most reads kept at once (per app). */
export const KEPT_READ_MAX = 200;

interface Kept {
  answer: Extract<PostingAnswer, { found: true }>;
  at: number;
}

const KEPT = new WeakMap<object, Map<string, Kept>>();

type Clock = { now: () => Date };

function keptOf(deps: object): Map<string, Kept> {
  let kept = KEPT.get(deps);
  if (!kept) {
    kept = new Map();
    KEPT.set(deps, kept);
  }
  return kept;
}

/** Keeps a read that named no company, by its link (its shared form). */
export function keepRead(deps: Clock, link: string, answer: PostingAnswer): void {
  if (!answer.found) return;
  const kept = keptOf(deps);
  kept.delete(link);
  kept.set(link, { answer, at: deps.now().getTime() });
  while (kept.size > KEPT_READ_MAX) kept.delete(kept.keys().next().value!);
}

/** The read kept for a link, taken (a later add reads the posting again), or null when none is kept or it is too old. */
export function takeKeptRead(deps: Clock, link: string): PostingAnswer | null {
  const kept = keptOf(deps);
  const found = kept.get(link);
  kept.delete(link);
  return found && deps.now().getTime() - found.at <= KEPT_READ_MS ? found.answer : null;
}

/**
 * The company of the shared job TailorIT stored of a source's posting (a name given before: an import row's, a person's
 * typed one, its source's of the time), or null.
 */
export async function storedCompanyName(db: DbQueries, sourceId: number | null | undefined, sourceJobId: string): Promise<string | null> {
  if (!sourceId) return null;
  const row = await db.one<{ name: string }>(
    `SELECT c.name FROM job_source_links l JOIN jobs j ON j.id = l.job_id JOIN companies c ON c.id = j.company_id
     WHERE l.source_id = ? AND l.source_job_id = ? AND j.owner_user_id IS NULL AND j.superseded_by IS NULL
     ORDER BY j.id LIMIT 1`,
    [sourceId, storedSourceJobId(sourceJobId)],
  );
  return row?.name?.trim() || null;
}
