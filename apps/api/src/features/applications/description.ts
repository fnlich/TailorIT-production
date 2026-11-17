import type { DbQueries } from '../../core/db/types';
import { readJobText } from '../jobs/text';
import { clippedRichText } from './sanitize';

// v30 DB-JOBS (D1c; docs/design/part2/11-database.md §5.8): no posting copies. v2.0 copied the posting's text into
// every tracker entry it saved (applications.description_html); v3.0 stores none. The column holds a description of
// the entry's own only:
//   NULL      the job's text: read from job_texts (features/jobs/text.ts) when the entry is shown, cleaned as the
//             tracker cleans rich text (what v2.0's copy held), or nothing for an entry without a job
//   a value   the person's own (the detail sheet's edit, kept as written), or '' for one they emptied
// So a saved job shows the posting as its source has it now; the apply record keeps the version applied to
// (application_apply_records.posting_hash).

/** What an entry stores as its description when nobody wrote one: the job's text, read when it is shown. */
export const JOBS_OWN_TEXT = null;

/** The HTML an entry shows as its job description (its own, else its job's text, else nothing). */
export async function descriptionHtmlOf(
  db: DbQueries,
  entry: { description_html: string | null; job_id: number | null },
): Promise<string> {
  if (entry.description_html !== null) return entry.description_html;
  if (entry.job_id === null) return '';
  const text = await readJobText(db, entry.job_id);
  return text ? clippedRichText(text.html) : '';
}
