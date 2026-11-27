import { decodeHtmlEntities, htmlToText } from '@tailorit/shared';
import { assertNewReadAllowed, type NewReadKind } from '../../../core/http/identity';
import { GEM_API_HOST, GEM_JOBS_HOST, gemBoard, gemPostLink } from '@tailorit/shared/sourcing';
import type { CompanyFacts } from '../boards/types';
import type { IngestHttp } from '../http';
import { IngestError, SourceNotFoundError, type FetchFailure, type RawPosting } from '../types';
import { keepBamboohrCompanyName as keepCompanyName } from './bamboohr';
import { arrangementOf, isRecord, nameFromSlug, records, str, type Json } from './common';
import { defineAdapter } from './define';

// v38 ATS-A (SP v38 PLAN "Final coverage" row 4; REQUEST.md 4; EVIDENCE.md 4, read 2026-11-25): a Gem job board,
// read from Gem's public job-board API on api.gem.com (no key):
//   - every open post: GET /job_board/v0/{board}/job_posts/ (an array, no paging: about 630 kB on a board of some
//     tens of posts, so it is read once a run);
//   - one post: GET /job_board/v0/{board}/job_posts/{id}/ (the trailing slash kept); an unknown id answers 404.
// A post: { id, absolute_url (its clean link), title, content (HTML), content_plain, created_at, first_published_at,
// updated_at, departments [{ name }], employment_type "full_time", location { name }, location_type "remote", offices
// [{ name, location { name } }], requisition_id }. No company name, no status, no pay. EVIDENCE.md's correction: the job
// page names no company either; the company is the content's first heading's "<title> at <Company>", else the board's
// name made readable. robots.txt: api.gem.com answers 403 (no file: no rules), jobs.gem.com 404.
//
// A source: config `{ board, companyName? }`. A new kind of read: the identity guard first ('feed_read').

const NEW_READ: NewReadKind = 'feed_read';

/** The most of the board's list read (about 630 kB for some tens of posts): 16 MB. Past it the run fails (413). */
export const GEM_LIST_MAX_BYTES = 16 * 1024 * 1024;
/** The most of one post's answer read: 2 MB. */
export const GEM_POST_MAX_BYTES = 2 * 1024 * 1024;

/** A post's id as Gem writes it (opaque, case-sensitive). */
const GEM_POST_ID = /^[A-Za-z0-9_-]{6,200}$/;

/** A Gem source's board; throws IngestError for none. */
export function gemBoardOf(config: Record<string, unknown>): string {
  const board = gemBoard(str(config.board) ?? '');
  if (!board) throw new IngestError('This source has no Gem board (jobs.gem.com/<board>). Edit the source and add it.');
  return board;
}

/** The board's list's address. */
export const gemListUrl = (board: string) => `https://${GEM_API_HOST}/job_board/v0/${encodeURIComponent(board)}/job_posts/`;
/** One post's address (its trailing slash kept: REQUEST.md). */
export const gemPostUrl = (board: string, id: string) =>
  `https://${GEM_API_HOST}/job_board/v0/${encodeURIComponent(board)}/job_posts/${encodeURIComponent(id)}/`;

/** The board's name made readable ("acme-robotics-inc-": "Acme Robotics Inc"). */
export const gemCompanyOfBoard = (board: string) => nameFromSlug(board.replace(/-+$/, '')) || board;

/**
 * The company a post's content names in its first heading, "<title> at <Company>" (EVIDENCE.md 4), or null.
 */
export function gemCompanyOfContent(content: string | null, title: string): string | null {
  if (!content) return null;
  const heading = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]\s*>/i.exec(content);
  if (!heading) return null;
  const text = decodeHtmlEntities(htmlToText(heading[1]!)).replace(/\s+/g, ' ').trim();
  const at = text.toLowerCase().lastIndexOf(' at ');
  if (at <= 0) return null;
  const role = text.slice(0, at).trim().toLowerCase();
  const company = text.slice(at + 4).trim().replace(/[.!:]+$/, '');
  // Only when the heading is the post's own title (a heading that names another role is no company line).
  if (role !== title.trim().toLowerCase() || company.length < 2 || company.length > 120) return null;
  return company;
}

/** The post's own link on jobs.gem.com (its absolute_url's path), else its clean link. */
function postUrlOf(given: unknown, board: string, id: string): string {
  try {
    const url = str(given) ? new URL(str(given)!) : null;
    if (url && url.protocol === 'https:' && url.hostname === GEM_JOBS_HOST) return `https://${GEM_JOBS_HOST}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    /* the built address */
  }
  return gemPostLink(board, id);
}

/** A post's places: its location's name, else its offices' (each once). */
function placesOf(post: Json): string[] {
  const location = isRecord(post.location) ? str(post.location.name) : null;
  if (location) return [location];
  const offices = records(post.offices)
    .map((office) => (isRecord(office.location) ? str(office.location.name) : null) ?? str(office.name))
    .filter((place): place is string => Boolean(place));
  return [...new Set(offices)];
}

/** "full_time" as words ("full time"). */
const wordsOf = (value: unknown) => str(value)?.replace(/_/g, ' ') ?? null;

/** What a post says about its company (A6): the name its content's first heading gives. */
export function gemCompanyFacts(post: Json): CompanyFacts {
  return { name: gemCompanyOfContent(str(post.content), str(post.title) ?? '') };
}

/** One post as a RawPosting; null when it lacks an id or a title. */
export function gemPosting(post: Json, board: string, companyName: string): RawPosting | null {
  const id = str(post.id);
  const title = str(post.title);
  if (!id || !GEM_POST_ID.test(id) || !title) return null;
  const content = str(post.content);
  const department = records(post.departments).map((each) => str(each.name)).find(Boolean) ?? null;
  return {
    sourceJobId: id,
    title,
    company: { name: companyName },
    descriptionHtml: content,
    descriptionText: content ? null : str(post.content_plain),
    url: postUrlOf(post.absolute_url, board, id),
    locations: placesOf(post),
    workArrangement: arrangementOf(post.location_type),
    employmentText: wordsOf(post.employment_type),
    department,
    postedAt: str(post.first_published_at) ?? str(post.created_at),
    updatedAt: str(post.updated_at),
  };
}

/** The name a post's company goes by: the source's, else its content's, else the board's made readable. */
export const gemCompanyNameOf = (post: Json, board: string, named: string | null) => named ?? gemCompanyFacts(post).name ?? gemCompanyOfBoard(board);

/**
 * One post read on its own (at most GEM_POST_MAX_BYTES): the post and what it says about its company, or null when it is
 * gone (404). Throws IngestHttpError when Gem fails, IngestError for an answer that is no post or another one.
 */
export async function readGemPost(
  http: IngestHttp,
  board: string,
  id: string,
  named: string | null,
  signal?: AbortSignal,
): Promise<{ raw: RawPosting; company: CompanyFacts } | null> {
  const answer = await http.getJson(gemPostUrl(board, id), {
    signal,
    allow: [404],
    maxBytes: GEM_POST_MAX_BYTES,
    allowRedirectHost: (host) => host === GEM_API_HOST,
  });
  if (answer.status === 404) return null;
  if (!isRecord(answer.data)) throw new IngestError('Gem answered without a job post.');
  const raw = gemPosting(answer.data, board, gemCompanyNameOf(answer.data, board, named));
  if (!raw) throw new IngestError("Gem's job post has no id or title.");
  if (raw.sourceJobId !== id) throw new IngestError('Gem answered with another job post.');
  return { raw, company: gemCompanyFacts(answer.data) };
}

export const gemAdapter = defineAdapter({
  kind: 'gem',
  label: 'Gem job board',
  access: 'api',
  hosts: [GEM_API_HOST],
  robotsPaths(source) {
    try {
      return [`/job_board/v0/${encodeURIComponent(gemBoardOf(source.config))}/job_posts/`];
    } catch {
      return [];
    }
  },
  async fetch(source, ctx) {
    assertNewReadAllowed(ctx.deps, NEW_READ);
    const board = gemBoardOf(source.config);
    // The whole board in one answer, read once a run.
    const answer = await ctx.http.getJson(gemListUrl(board), {
      signal: ctx.signal,
      allow: [404],
      maxBytes: GEM_LIST_MAX_BYTES,
      allowRedirectHost: (host) => host === GEM_API_HOST,
    });
    if (answer.status === 404) throw new SourceNotFoundError(`Gem has no job board "${board}". Check the board's name (jobs.gem.com/<board>).`);
    if (!Array.isArray(answer.data)) throw new IngestError(`Gem answered without the job posts of "${board}".`);
    // One name for the whole board: the source's, else the first post's heading's, else the board's made readable.
    const posts = records(answer.data);
    const named = str(source.config.companyName);
    const fromPosts = named ? null : (posts.map((post) => gemCompanyFacts(post).name).find(Boolean) ?? null);
    const companyName = named ?? fromPosts ?? gemCompanyOfBoard(board);
    // v38 FIX-A (SP v38 FIXES-38 item 12, REVIEW38-beh L17): the name the posts gave is kept as the source's companyName
    // (when it has none), so a link's read of one post names the board's company as this run does (one name per board,
    // one hash per post: no rewrite each time a run and a link's read alternate).
    if (fromPosts && !ctx.listingOnly && source.id > 0) {
      await keepCompanyName(ctx.deps.db, source.id, fromPosts);
      ctx.log(`Gem ${board}: its posts name the company "${fromPosts}" (kept as the source's company name).`);
    }
    const postings: RawPosting[] = [];
    const failures: FetchFailure[] = [];
    for (const post of posts) {
      const posting = gemPosting(post, board, companyName);
      if (posting) postings.push(posting);
      else failures.push({ sourceJobId: str(post.id) ?? undefined, message: 'A job post has no id or title.' });
    }
    ctx.log(`Gem ${board}: ${postings.length} job posts.`);
    return { postings, complete: true, failures };
  },
});
