// v30 ST0: the one job-visibility rule (PLAN §6, "Job visibility"). A person sees a job of the shared lake (no owner)
// or a job of their own (`owner_user_id`, added from a page or by hand); every query that shows, counts, opens or uses
// a job by id for a person filters with jobVisibleTo, never with a predicate of its own
// (apps/api/test/structure-visibility.test.ts checks it). One rule means one place to change it.
//
// v30 SCH: the held rule (docs/design/part2/14-extension-reports.md §4.1, §9). A lake job that Add job reads from an
// ATS for the first time is held for review (`jobs.held_since`) until an admin approves it: it is in the Saved Jobs,
// Tracker, Queue and Prepare of the accounts that added it at once, and in nobody else's. So a held lake job is
// visible only to an account that has it in its tracker (an `applications` row) or reported it (a `job_review_reports`
// row of a review of the job: Add job writes the adding account's row before its tracker entry). Approval clears
// `held_since` and the job is everyone's again; a rejected job stays its adders' own.
//
//   `SELECT … FROM jobs j WHERE j.id = ? AND ${jobVisibleTo('j')}`             .get(jobId, userId)
//   `… WHERE j.active AND ${jobVisibleTo('j', '@viewer')}`                      .all({ viewer: userId })
//   `SELECT 1 FROM jobs WHERE id = ? AND ${jobVisibleTo('')}`                   .get(jobId, userId)
//
// Searches read the projection (`job_search`, PG-SEARCH), whose rows are only open, verified and unheld jobs: they
// filter its rows with searchRowVisibleTo (job_search has no held_since). Every function here names the viewer's id
// exactly ONCE in what it returns, so a positional `?` takes one value; each predicate is parenthesised, so it can
// stand beside AND and OR.

/** `alias.` for a table alias, nothing for none. */
const column = (alias: string, name: string) => (alias ? `${alias}.${name}` : name);

/**
 * The SQL predicate "a job this viewer may see": `alias` is the jobs table's alias ('' when the query reads `jobs` with
 * no alias), `viewer` the placeholder of the viewer's account id: `?` (positional, the default) or a named one
 * (`@userId`). A shared job that is not held; the viewer's own job (a page job); a held shared job the viewer has in
 * their tracker or reported.
 */
export function jobVisibleTo(alias = 'j', viewer = '?'): string {
  // Inside the subqueries a bare `id` would name their own tables' ids: with no alias the job is `jobs.<column>`.
  const job = (name: string) => `${alias || 'jobs'}.${name}`;
  const owner = job('owner_user_id');
  return (
    `((${owner} IS NULL AND ${job('held_since')} IS NULL) OR EXISTS (SELECT 1 FROM (SELECT CAST(${viewer} AS text) AS viewer_id) vw ` +
    `WHERE ${owner} = vw.viewer_id OR (${owner} IS NULL AND (` +
    `EXISTS (SELECT 1 FROM applications va WHERE va.job_id = ${job('id')} AND va.user_id = vw.viewer_id) OR ` +
    `EXISTS (SELECT 1 FROM job_reviews vr JOIN job_review_reports vp ON vp.review_id = vr.id ` +
    `WHERE vr.job_id = ${job('id')} AND vp.user_id = vw.viewer_id)))))`
  );
}

/**
 * v30 SCH: the rule for a row of the search projection (`job_search`, alias `s` by default; '' for none). Its rows are
 * open, verified and unheld jobs (search-projection's searchableSql), so a viewer sees a shared row or one of their
 * own. Every search, count and facet (the Jobs page and its count, MCP, the extension's job search) filters with it.
 */
export function searchRowVisibleTo(alias = 's', viewer = '?'): string {
  return `(${searchRowShared(alias)} OR ${searchRowOwnedBy(alias, viewer)})`;
}

/**
 * v30 FIX-PG (PGL-5): the two halves of searchRowVisibleTo, for a count that keeps the shared half once for everyone
 * (the filter lists, facet-counts.ts) and adds the viewer's own half (js_owner) at each request. Together they are
 * exactly the rule above.
 */
export function searchRowShared(alias = 's'): string {
  return `${column(alias, 'owner_user_id')} IS NULL`;
}

/** The viewer's own rows of the search projection (their page jobs): searchRowVisibleTo's other half. */
export function searchRowOwnedBy(alias = 's', viewer = '?'): string {
  return `${column(alias, 'owner_user_id')} = ${viewer}`;
}

/**
 * The same rule for a company row (`companies.owner_user_id`: a company made for a job a person added stays theirs
 * until the lake has it): a lake company, or one of the viewer's own.
 */
export function companyVisibleTo(alias = 'c', viewer = '?'): string {
  return `(${column(alias, 'owner_user_id')} IS NULL OR ${column(alias, 'owner_user_id')} = ${viewer})`;
}
