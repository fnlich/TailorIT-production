import { canonicalJobUrl, linkKey, withoutLinkNoise } from '@tailorit/shared';
import type { AppDeps } from '../../../core/context';
import type { DailyStep } from '../../../core/feature';
import { storedSourceJobId } from '../../ingest/normalize';
import { projectJobs } from '../search-projection/project';

// v31 LINK (21-jobs-from-links.md §2, migration 0039's note): the links stored before v3.1 in their canonical form, once.
// The form is the one shared function's (canonicalJobUrl, linkKey), so this pass computes it, not an SQL copy:
//   - jobs.apply_url (and the job's search row, in the same transaction: projectJobs);
//   - applications.posting_url (a tracker entry's link; a local development address stays as written);
//   - job_keys' `link` keys, where the new key names no other job yet (a duplicate is counted, logged and left);
//   - job_link_aliases (a page alias keeps its own form, hashed values and all: only its noise parameters go), where
//     the person has no alias of that address yet;
//   - job_reviews' page subjects ('page:<link key>'), where no pending review of that subject is open;
//   - v31 FIX-LINK (REV-BEH BEH-12): the links of v3.0's published page copies (`ext_page`: their id is the review
//     subject's link key), where the source holds no link of the new id, so the legacy pass still finds a copy's one
//     adder through its review (legacy.ts soleAdderOf joins the two).
// Each table in batches of PASS_BATCH rows, a transaction each; the pass is idempotent (a canonical link stays as it is),
// so one cut short runs again whole at the next daily pass. Done, it writes app_settings `v31:canonical-links` and
// never runs again; a database with no job and no tracker entry (a new install) writes nothing.

const MARK = 'v31:canonical-links';
const PASS_BATCH = 1000;

interface Tally {
  changed: number;
  duplicates: number;
}

async function rewriteJobs(deps: AppDeps, tally: Tally): Promise<void> {
  for (let after = 0; ; ) {
    const rows = await deps.db.all<{ id: number; apply_url: string }>('SELECT id, apply_url FROM jobs WHERE id > ? ORDER BY id LIMIT ?', [
      after,
      PASS_BATCH,
    ]);
    if (rows.length === 0) return;
    after = Number(rows[rows.length - 1]!.id);
    const changes = rows
      .map((row) => ({ id: Number(row.id), url: canonicalJobUrl(row.apply_url) }))
      .filter((row, at): row is { id: number; url: string } => row.url !== null && row.url !== rows[at]!.apply_url);
    if (changes.length === 0) continue;
    await deps.db.tx(
      async (t) => {
        for (const change of changes) await t.run('UPDATE jobs SET apply_url = ? WHERE id = ?', [change.url, change.id]);
        await projectJobs(t, changes.map((change) => change.id));
      },
      { label: 'canonical links: jobs' },
    );
    tally.changed += changes.length;
  }
}

async function rewriteEntries(deps: AppDeps, tally: Tally): Promise<void> {
  for (let after = 0; ; ) {
    const rows = await deps.db.all<{ seq: number; id: string; posting_url: string }>(
      "SELECT seq, id, posting_url FROM applications WHERE seq > ? AND posting_url <> '' ORDER BY seq LIMIT ?",
      [after, PASS_BATCH],
    );
    if (rows.length === 0) return;
    after = Number(rows[rows.length - 1]!.seq);
    const changes = rows
      .filter((row) => !/^https?:\/\/localhost(?::\d+)?(?:\/|$)/i.test(row.posting_url))
      .map((row) => ({ id: row.id, before: row.posting_url, url: canonicalJobUrl(row.posting_url) }))
      .filter((row): row is { id: string; before: string; url: string } => row.url !== null && row.url !== row.before);
    if (changes.length === 0) continue;
    await deps.db.tx(
      async (t) => {
        for (const change of changes) await t.run('UPDATE applications SET posting_url = ? WHERE id = ?', [change.url, change.id]);
      },
      { label: 'canonical links: tracker' },
    );
    tally.changed += changes.length;
  }
}

async function rewriteKeys(deps: AppDeps, tally: Tally): Promise<void> {
  for (let after = ''; ; ) {
    // On the primary key's order (key_kind, key): each batch is a range of the index, never a sort of every key.
    const rows = await deps.db.all<{ key: string }>("SELECT key FROM job_keys WHERE key_kind = 'link' AND key > ? ORDER BY key LIMIT ?", [
      after,
      PASS_BATCH,
    ]);
    if (rows.length === 0) return;
    after = rows[rows.length - 1]!.key;
    const changes = rows
      .map((row) => ({ before: row.key, key: linkKey(row.key) }))
      .filter((row): row is { before: string; key: string } => row.key !== null && row.key !== row.before);
    if (changes.length === 0) continue;
    await deps.db.tx(
      async (t) => {
        for (const change of changes) {
          const { changes: moved } = await t.run(
            `UPDATE job_keys SET key = ? WHERE key_kind = 'link' AND key = ?
               AND NOT EXISTS (SELECT 1 FROM job_keys o WHERE o.key_kind = 'link' AND o.key = ?)`,
            [change.key, change.before, change.key],
          );
          if (moved > 0) tally.changed += 1;
          else tally.duplicates += 1;
        }
      },
      { label: 'canonical links: keys' },
    );
  }
}

async function rewriteAliases(deps: AppDeps, tally: Tally): Promise<void> {
  for (let after = 0; ; ) {
    const rows = await deps.db.all<{ id: number; alias: string }>('SELECT id, alias FROM job_link_aliases WHERE id > ? ORDER BY id LIMIT ?', [
      after,
      PASS_BATCH,
    ]);
    if (rows.length === 0) return;
    after = Number(rows[rows.length - 1]!.id);
    const changes = rows
      .map((row) => ({ id: Number(row.id), before: row.alias, alias: withoutLinkNoise(row.alias) }))
      .filter((row) => row.alias !== row.before && row.alias.startsWith('https://') && row.alias.length >= 9);
    if (changes.length === 0) continue;
    await deps.db.tx(
      async (t) => {
        for (const change of changes) {
          const { changes: moved } = await t.run(
            `UPDATE job_link_aliases SET alias = ? WHERE id = ?
               AND NOT EXISTS (SELECT 1 FROM job_link_aliases o WHERE o.user_id = job_link_aliases.user_id AND o.alias = ?)`,
            [change.alias, change.id, change.alias],
          );
          if (moved > 0) tally.changed += 1;
          else tally.duplicates += 1;
        }
      },
      { label: 'canonical links: aliases' },
    );
  }
}

async function rewriteReviews(deps: AppDeps, tally: Tally): Promise<void> {
  const rows = await deps.db.all<{ id: number; kind: string; subject_key: string; state: string }>(
    "SELECT id, kind, subject_key, state FROM job_reviews WHERE subject_key LIKE 'page:%' ORDER BY id",
  );
  for (const row of rows) {
    const key = linkKey(row.subject_key.slice('page:'.length));
    const subject = key ? `page:${key}` : null;
    if (!subject || subject === row.subject_key) continue;
    const { changes } = await deps.db.run(
      `UPDATE job_reviews SET subject_key = ? WHERE id = ?
         AND (state <> 'pending' OR NOT EXISTS (SELECT 1 FROM job_reviews o WHERE o.kind = ? AND o.subject_key = ? AND o.state = 'pending'))`,
      [subject, row.id, row.kind, subject],
    );
    if (changes > 0) tally.changed += 1;
    else tally.duplicates += 1;
  }
}

/** v31 FIX-LINK (BEH-12): `ext_page` links' ids (a page review subject's link key) in their linkKey form, as the subjects. */
async function rewritePageCopyLinks(deps: AppDeps, tally: Tally): Promise<void> {
  const rows = await deps.db.all<{ source_id: number; source_job_id: string }>(
    `SELECT l.source_id, l.source_job_id FROM job_source_links l JOIN job_sources s ON s.id = l.source_id
     WHERE s.kind = 'ext_page' AND l.source_job_id LIKE 'http%' ORDER BY l.source_id, l.source_job_id`,
  );
  for (const row of rows) {
    const key = linkKey(row.source_job_id);
    if (!key || key === row.source_job_id || storedSourceJobId(key) !== key) continue;
    const { changes } = await deps.db.run(
      `UPDATE job_source_links SET source_job_id = ? WHERE source_id = ? AND source_job_id = ?
         AND NOT EXISTS (SELECT 1 FROM job_source_links o WHERE o.source_id = ? AND o.source_job_id = ?)`,
      [key, row.source_id, row.source_job_id, row.source_id, key],
    );
    if (changes > 0) tally.changed += 1;
    else tally.duplicates += 1;
  }
}

/** The daily step (see the top): rows changed; nothing once done. */
export const canonicalLinksStep: DailyStep = {
  name: 'links-canonical',
  async run(deps) {
    if (await deps.db.one('SELECT 1 FROM app_settings WHERE key = ?', [MARK])) return 0;
    const any = await deps.db.one('SELECT 1 FROM jobs UNION ALL SELECT 1 FROM applications LIMIT 1');
    if (!any) return 0;
    const tally: Tally = { changed: 0, duplicates: 0 };
    await rewriteJobs(deps, tally);
    await rewriteEntries(deps, tally);
    await rewriteKeys(deps, tally);
    await rewriteAliases(deps, tally);
    await rewriteReviews(deps, tally);
    await rewritePageCopyLinks(deps, tally);
    if (tally.duplicates > 0) {
      deps.log.warn(`[jobs] canonical links: ${tally.duplicates} link(s) left as they were (their canonical form is another job's or alias's already)`);
    }
    const at = deps.now().toISOString();
    await deps.db.run(
      'INSERT INTO app_settings(key, value, updated_at) VALUES (?, CAST(? AS json), ?) ON CONFLICT (key) DO NOTHING',
      [MARK, JSON.stringify({ done: at, changed: tally.changed, duplicates: tally.duplicates }), at],
    );
    return tally.changed;
  },
};
