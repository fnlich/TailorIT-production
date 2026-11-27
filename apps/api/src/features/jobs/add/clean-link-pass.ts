import { canonicalJobUrl, linkKey } from '@tailorit/shared';
import { BOARD_DESCRIPTORS, type BoardDescriptor } from '@tailorit/shared/sourcing';
import type { AppDeps } from '../../../core/context';
import type { DailyStep } from '../../../core/feature';
import { aliasValueHash } from '../../autofill/alias-key';
import { storedPageAddress } from '../../autofill/lookup';
import { storedSourceJobId } from '../../ingest/normalize';
import { projectJobs } from '../search-projection/project';

// v38 ATS-D (SP v38 FRAME's open item 3): when a platform gains a clean link (its board descriptor's cleanLink: REQUEST.md
// "Clean job link", applied by canonicalJobUrl and linkKey from then on), the links TailorIT stored of it before keep
// their old form and key, so a new add of the same posting would not find them. This one-off pass re-cleans them, once
// per platform, on a server updated in place: only the rows on the hosts of the platforms not yet done (the mark's list),
// each with the one shared function its writer uses (not an SQL copy), in batches of PASS_BATCH rows, a transaction each:
//   - jobs.apply_url (and the job's search row: projectJobs), applications.posting_url (canonicalJobUrl);
//   - job_keys' `link` keys, job_link_rejections, the page reviews' subjects ('page:<link key>') (linkKey);
//   - job_link_aliases (storedPageAddress), only where the new alias keeps every parameter as written (a hashed value is
//     never hashed again);
//   - job_verifications' link and key ("Couldn't verify": canonicalJobUrl, linkKey);
//   - the open rows of the link queue (its link and key);
//   - the career sites' and published page copies' links whose id is their link's key (careerPostingIdOf's form).
// Nothing is merged: a key, an alias, a rejection, a review, a queued link or a posting id whose clean form another row
// holds already is left as it was, counted and logged as a duplicate (two jobs that are one posting stay two jobs, for an
// admin to see). The pass is idempotent (a clean link stays as it is), so one cut short runs again whole at the next daily
// pass. Done, it writes app_settings `v38:board-links` with the platforms it cleaned, what changed and the duplicates by
// table; a later platform's clean link runs it again for that platform's hosts alone. A database with no job and no
// tracker entry (a new install) writes nothing.

const MARK = 'v38:board-links';
const PASS_BATCH = 1000;

/** The tables the pass rewrites, by name (the mark's and the log's words). */
type Table = 'jobs' | 'applications' | 'keys' | 'aliases' | 'verifications' | 'rejections' | 'reviews' | 'queue' | 'links';

interface Tally {
  changed: number;
  duplicates: Partial<Record<Table, number>>;
}

const changedIn = (tally: Tally, count = 1) => {
  tally.changed += count;
};
const duplicateIn = (tally: Tally, table: Table) => {
  tally.duplicates[table] = (tally.duplicates[table] ?? 0) + 1;
};

/** The board kinds that clean their links (a descriptor's cleanLink), with their hosts' pattern. */
export function cleaningBoards(): Array<{ kind: string; hosts: string }> {
  return (BOARD_DESCRIPTORS as readonly BoardDescriptor[])
    .filter((board) => board.cleanLink && board.hosts)
    .map((board) => ({ kind: board.kind, hosts: board.hosts! }));
}

/** One pattern over the hosts of `boards` (each reads the same in PostgreSQL: the registry's rule). */
const hostsPattern = (boards: ReadonlyArray<{ hosts: string }>) => boards.map((board) => `(?:${board.hosts})`).join('|');

/** The query's parameters and fragment of an address, as written ("a=1", "#/jobs/1"). */
function writtenParts(address: string): string[] {
  const hash = address.indexOf('#');
  const fragment = hash < 0 ? [] : [address.slice(hash)];
  const before = hash < 0 ? address : address.slice(0, hash);
  const query = before.indexOf('?');
  return [...(query < 0 ? [] : before.slice(query + 1).split('&').filter(Boolean)), ...fragment];
}

async function rewriteJobs(deps: AppDeps, hosts: string, tally: Tally): Promise<void> {
  for (let after = 0; ; ) {
    const rows = await deps.db.all<{ id: number; apply_url: string }>(
      'SELECT id, apply_url FROM jobs WHERE id > ? AND apply_host ~ CAST(? AS text) ORDER BY id LIMIT ?',
      [after, hosts, PASS_BATCH],
    );
    if (rows.length === 0) return;
    after = Number(rows[rows.length - 1]!.id);
    const changes = rows
      .map((row) => ({ id: Number(row.id), before: row.apply_url, url: canonicalJobUrl(row.apply_url) }))
      .filter((row): row is { id: number; before: string; url: string } => row.url !== null && row.url !== row.before);
    if (changes.length === 0) continue;
    await deps.db.tx(
      async (t) => {
        for (const change of changes) await t.run('UPDATE jobs SET apply_url = ? WHERE id = ?', [change.url, change.id]);
        await projectJobs(t, changes.map((change) => change.id));
      },
      { label: 'board links: jobs' },
    );
    changedIn(tally, changes.length);
  }
}

async function rewriteEntries(deps: AppDeps, hosts: string, tally: Tally): Promise<void> {
  for (let after = 0; ; ) {
    const rows = await deps.db.all<{ seq: number; id: string; posting_url: string }>(
      `SELECT seq, id, posting_url FROM applications
       WHERE seq > ? AND posting_url <> '' AND tailorit_url_host(posting_url) ~ CAST(? AS text) ORDER BY seq LIMIT ?`,
      [after, hosts, PASS_BATCH],
    );
    if (rows.length === 0) return;
    after = Number(rows[rows.length - 1]!.seq);
    const changes = rows
      .map((row) => ({ id: row.id, before: row.posting_url, url: canonicalJobUrl(row.posting_url) }))
      .filter((row): row is { id: string; before: string; url: string } => row.url !== null && row.url !== row.before);
    if (changes.length === 0) continue;
    await deps.db.tx(
      async (t) => {
        for (const change of changes) await t.run('UPDATE applications SET posting_url = ? WHERE id = ?', [change.url, change.id]);
      },
      { label: 'board links: tracker' },
    );
    changedIn(tally, changes.length);
  }
}

async function rewriteKeys(deps: AppDeps, hosts: string, tally: Tally): Promise<void> {
  for (let after = ''; ; ) {
    // On the primary key's order (key_kind, key): each batch is a range of the index, never a sort of every key.
    const rows = await deps.db.all<{ key: string }>(
      `SELECT key FROM job_keys WHERE key_kind = 'link' AND key > ? AND tailorit_url_host(key) ~ CAST(? AS text) ORDER BY key LIMIT ?`,
      [after, hosts, PASS_BATCH],
    );
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
          if (moved > 0) changedIn(tally);
          else duplicateIn(tally, 'keys');
        }
      },
      { label: 'board links: keys' },
    );
  }
}

async function rewriteAliases(deps: AppDeps, hosts: string, tally: Tally): Promise<void> {
  const hash = aliasValueHash(deps);
  for (let after = 0; ; ) {
    const rows = await deps.db.all<{ id: number; alias: string }>(
      'SELECT id, alias FROM job_link_aliases WHERE id > ? AND tailorit_url_host(alias) ~ CAST(? AS text) ORDER BY id LIMIT ?',
      [after, hosts, PASS_BATCH],
    );
    if (rows.length === 0) return;
    after = Number(rows[rows.length - 1]!.id);
    const changes = rows
      .map((row) => ({ id: Number(row.id), before: row.alias, alias: storedPageAddress(row.alias, hash) }))
      .filter((row): row is { id: number; before: string; alias: string } => {
        if (row.alias === null || row.alias === row.before || !row.alias.startsWith('https://')) return false;
        // Only an alias whose parameters (and fragment) were dropped, never one whose value was written anew.
        const kept = new Set(writtenParts(row.before));
        return writtenParts(row.alias).every((part) => kept.has(part));
      });
    if (changes.length === 0) continue;
    await deps.db.tx(
      async (t) => {
        for (const change of changes) {
          const { changes: moved } = await t.run(
            `UPDATE job_link_aliases SET alias = ? WHERE id = ?
               AND NOT EXISTS (SELECT 1 FROM job_link_aliases o WHERE o.user_id = job_link_aliases.user_id AND o.alias = ?)`,
            [change.alias, change.id, change.alias],
          );
          if (moved > 0) changedIn(tally);
          else duplicateIn(tally, 'aliases');
        }
      },
      { label: 'board links: aliases' },
    );
  }
}

async function rewriteVerifications(deps: AppDeps, hosts: string, tally: Tally): Promise<void> {
  for (let after = 0; ; ) {
    const rows = await deps.db.all<{ job_id: number; url: string; url_key: string }>(
      'SELECT job_id, url, url_key FROM job_verifications WHERE job_id > ? AND host ~ CAST(? AS text) ORDER BY job_id LIMIT ?',
      [after, hosts, PASS_BATCH],
    );
    if (rows.length === 0) return;
    after = Number(rows[rows.length - 1]!.job_id);
    const changes = rows
      .map((row) => {
        const url = canonicalJobUrl(row.url) ?? row.url;
        return { jobId: Number(row.job_id), url, key: linkKey(url) ?? row.url_key, before: row };
      })
      .filter((row) => row.url.startsWith('https://') && (row.url !== row.before.url || row.key !== row.before.url_key));
    if (changes.length === 0) continue;
    await deps.db.tx(
      async (t) => {
        for (const change of changes) await t.run('UPDATE job_verifications SET url = ?, url_key = ? WHERE job_id = ?', [change.url, change.key, change.jobId]);
      },
      { label: "board links: couldn't verify" },
    );
    changedIn(tally, changes.length);
  }
}

async function rewriteRejections(deps: AppDeps, hosts: string, tally: Tally): Promise<void> {
  const rows = await deps.db.all<{ url_key: string }>(
    'SELECT url_key FROM job_link_rejections WHERE tailorit_url_host(url_key) ~ CAST(? AS text) ORDER BY url_key',
    [hosts],
  );
  for (const row of rows) {
    const key = linkKey(row.url_key);
    if (!key || key === row.url_key) continue;
    const { changes } = await deps.db.run(
      `UPDATE job_link_rejections SET url_key = ? WHERE url_key = ?
         AND NOT EXISTS (SELECT 1 FROM job_link_rejections o WHERE o.url_key = ?)`,
      [key, row.url_key, key],
    );
    if (changes > 0) changedIn(tally);
    else duplicateIn(tally, 'rejections');
  }
}

async function rewriteReviews(deps: AppDeps, hosts: string, tally: Tally): Promise<void> {
  const rows = await deps.db.all<{ id: number; kind: string; subject_key: string }>(
    `SELECT id, kind, subject_key FROM job_reviews
     WHERE subject_key LIKE 'page:%' AND tailorit_url_host(substr(subject_key, 6)) ~ CAST(? AS text) ORDER BY id`,
    [hosts],
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
    if (changes > 0) changedIn(tally);
    else duplicateIn(tally, 'reviews');
  }
}

/** The link queue's open rows (a done row keeps the link it was read as). */
async function rewriteQueue(deps: AppDeps, hosts: string, tally: Tally): Promise<void> {
  const rows = await deps.db.all<{ id: number; url: string; url_key: string }>(
    "SELECT id, url, url_key FROM job_link_queue WHERE state <> 'done' AND host ~ CAST(? AS text) ORDER BY id",
    [hosts],
  );
  for (const row of rows) {
    const url = canonicalJobUrl(row.url) ?? row.url;
    const key = linkKey(url) ?? row.url_key;
    if (!url.startsWith('https://') || (url === row.url && key === row.url_key)) continue;
    const { changes } = await deps.db.run(
      `UPDATE job_link_queue SET url = ?, url_key = ? WHERE id = ? AND state <> 'done'
         AND NOT EXISTS (SELECT 1 FROM job_link_queue o WHERE o.url_key = ? AND o.state <> 'done' AND o.id <> ?)`,
      [url, key, row.id, key, row.id],
    );
    if (changes > 0) changedIn(tally);
    else duplicateIn(tally, 'queue');
  }
}

/** The career sites' and published page copies' links whose id is their link's key (career/run.ts careerPostingIdOf). */
async function rewritePostingIds(deps: AppDeps, hosts: string, tally: Tally): Promise<void> {
  const rows = await deps.db.all<{ source_id: number; source_job_id: string }>(
    `SELECT l.source_id, l.source_job_id FROM job_source_links l JOIN job_sources s ON s.id = l.source_id
     WHERE s.kind IN ('career_site', 'ext_page') AND l.source_job_id LIKE 'https://%'
       AND tailorit_url_host(l.source_job_id) ~ CAST(? AS text)
     ORDER BY l.source_id, l.source_job_id`,
    [hosts],
  );
  for (const row of rows) {
    const key = linkKey(row.source_job_id);
    // A long id is kept as its start and its hash (storedSourceJobId): never written anew.
    if (!key || key === row.source_job_id || storedSourceJobId(key) !== key || storedSourceJobId(row.source_job_id) !== row.source_job_id) continue;
    const { changes } = await deps.db.run(
      `UPDATE job_source_links SET source_job_id = ? WHERE source_id = ? AND source_job_id = ?
         AND NOT EXISTS (SELECT 1 FROM job_source_links o WHERE o.source_id = ? AND o.source_job_id = ?)`,
      [key, row.source_id, row.source_job_id, row.source_id, key],
    );
    if (changes > 0) changedIn(tally);
    else duplicateIn(tally, 'links');
  }
}

/** The platforms a server cleaned its stored links for already (the mark's list). */
async function cleanedKinds(deps: AppDeps): Promise<Set<string>> {
  const row = await deps.db.one<{ value: unknown }>('SELECT value FROM app_settings WHERE key = ?', [MARK]);
  const value = typeof row?.value === 'string' ? (JSON.parse(row.value) as unknown) : row?.value;
  const kinds = value && typeof value === 'object' && Array.isArray((value as { kinds?: unknown }).kinds) ? (value as { kinds: unknown[] }).kinds : [];
  return new Set(kinds.filter((kind): kind is string => typeof kind === 'string'));
}

/** The daily step (see the top): rows changed; nothing once every cleaning platform is done. */
export const boardLinksStep: DailyStep = {
  name: 'links-board-clean',
  async run(deps) {
    const boards = cleaningBoards();
    const done = await cleanedKinds(deps);
    const todo = boards.filter((board) => !done.has(board.kind));
    if (todo.length === 0) return 0;
    const any = await deps.db.one('SELECT 1 FROM jobs UNION ALL SELECT 1 FROM applications LIMIT 1');
    if (!any) return 0;
    const hosts = hostsPattern(todo);
    const tally: Tally = { changed: 0, duplicates: {} };
    await rewriteJobs(deps, hosts, tally);
    await rewriteEntries(deps, hosts, tally);
    await rewriteKeys(deps, hosts, tally);
    await rewriteAliases(deps, hosts, tally);
    await rewriteVerifications(deps, hosts, tally);
    await rewriteRejections(deps, hosts, tally);
    await rewriteReviews(deps, hosts, tally);
    await rewriteQueue(deps, hosts, tally);
    await rewritePostingIds(deps, hosts, tally);
    const duplicates = Object.values(tally.duplicates).reduce((sum, count) => sum + (count ?? 0), 0);
    if (duplicates > 0) {
      const where = Object.entries(tally.duplicates)
        .map(([table, count]) => `${table} ${count}`)
        .join(', ');
      deps.log.warn(`[jobs] board links: ${duplicates} link(s) left as they were (their clean form is another row's already: ${where})`);
    }
    const at = deps.now().toISOString();
    const kinds = [...new Set([...done, ...todo.map((board) => board.kind)])];
    await deps.db.run(
      `INSERT INTO app_settings(key, value, updated_at) VALUES (?, CAST(? AS json), ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [MARK, JSON.stringify({ done: at, kinds, changed: tally.changed, duplicates: tally.duplicates }), at],
    );
    return tally.changed;
  },
};
