import { z } from 'zod';
import { BOARD_CONFIG_COMMON, defineBoard } from './define';
import type { BoardUrl } from './types';
import { boardHostOf, boardSegmentsOf, boardUrlOf, configWords } from './url';

// v38 ATS-A (SP v38 PLAN "Final coverage" row 4; REQUEST.md 4, EVIDENCE.md 4): a Gem job board, jobs.gem.com/<board>,
// read through Gem's public job-board API (api.gem.com/job_board/v0/<board>/job_posts/: every open post in one answer;
// .../job_posts/<id>/: one post). The API's part: apps/api/src/features/ingest/boards/gem.ts.

/** Gem's job pages' host (a board's page and its posts' pages). */
export const GEM_JOBS_HOST = 'jobs.gem.com';
/** Gem's API host (every read). */
export const GEM_API_HOST = 'api.gem.com';

/**
 * A board's name as Gem writes it: letters, digits, '.', '_' and '-', and it may END with '-'
 * ("acme-robotics-inc-": REQUEST.md, match it with anything but / ? #).
 * v38 FIX-A (SP v38 FIXES-38 D5, REVIEW38-beh M8): kept as written (whether Gem reads a board in any case was never
 * checked; a 404 closes): it is read so, and its sources are looked up in any case.
 */
const GEM_BOARD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
/** A post's id: Gem's own opaque id (base64-like, case-sensitive: never lower-cased). */
const GEM_POST_ID = /^[A-Za-z0-9_-]{6,200}$/;
/** First path segments of jobs.gem.com that name no board. */
const NOT_A_GEM_BOARD: ReadonlySet<string> = new Set(['api', 'static', 'assets', '_next', 'favicon.ico', 'robots.txt', 'sitemap.xml', 'embed', 'login']);

/** A board's name as written, or '' when it is none Gem writes (v38 FIX-A: no longer lower-cased). */
function gemBoardName(text: string): string {
  const board = text.trim();
  return GEM_BOARD_NAME.test(board) && !NOT_A_GEM_BOARD.has(board.toLowerCase()) ? board : '';
}

/**
 * The Gem board a name or an address names ("acme-robotics-inc-", https://jobs.gem.com/acme-robotics-inc-[/<post>],
 * https://api.gem.com/job_board/v0/acme-robotics-inc-/job_posts/): its name as written; '' for none.
 */
export function gemBoard(input: string): string {
  const text = input.trim();
  if (!text) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !text.includes('/') && !text.includes('.')) return gemBoardName(text);
  const url = boardUrlOf(text);
  if (!url) return '';
  const host = boardHostOf(url);
  const parts = boardSegmentsOf(url);
  if (host === GEM_JOBS_HOST) return parts[0] ? gemBoardName(parts[0]) : '';
  if (host === GEM_API_HOST && parts[0] === 'job_board' && parts[1] === 'v0' && parts[2]) return gemBoardName(parts[2]);
  return '';
}

/** A Gem post's link parts: /<board>/<post id>[/], on jobs.gem.com; null for any other address. */
function gemPostOf(url: BoardUrl): { board: string; id: string } | null {
  if (boardHostOf(url) !== GEM_JOBS_HOST) return null;
  const parts = boardSegmentsOf(url);
  if (parts.length !== 2) return null;
  const board = gemBoardName(parts[0]!);
  const id = parts[1]!;
  return board && GEM_POST_ID.test(id) ? { board, id } : null;
}

/** A Gem post's clean link: https://jobs.gem.com/<board>/<post id> (REQUEST.md: the query dropped). */
export const gemPostLink = (board: string, id: string) => `https://${GEM_JOBS_HOST}/${board}/${id}`;

export const GEM_BOARD = defineBoard({
  kind: 'gem',
  label: 'Gem',
  row: { access: 'public_api', runs: true, precedence: 4, rawKeepDays: 30 },
  platform: 'gem',
  hosts: String.raw`^jobs\.gem\.com$`,
  domains: ['gem.com'],
  configKey: 'board',
  boardWords: 'Gem board',
  configSchema: z.strictObject({ board: z.string().min(1), ...BOARD_CONFIG_COMMON }),
  keepsCase: true, // v38 FIX-A (D5): read as written, looked up in any case
  boardOf: gemBoard,
  configOfBoard: (board) => ({ board }),
  // Every board is read on Gem's one API host.
  hostOf: (config) => (typeof config.board === 'string' && gemBoard(config.board) ? GEM_API_HOST : null),
  // v38 FIX-A (SP v38 FIXES-38 D4, REVIEW38-beh M12): one request at a time to Gem (its API host; its job pages' host is
  // never read), at the lanes' pace (LANE_DEFAULT_MIN_INTERVAL_MS), as every v3.8 platform.
  lane: { key: 'gem.lane', label: 'Gem (all boards)', name: 'Gem', hosts: String.raw`^(?:api|jobs)\.gem\.com$` },
  boardOfUrl: (url, parts) => (boardHostOf(url) === GEM_JOBS_HOST && parts[0] ? gemBoardName(parts[0]) || null : null),
  parseLink: (url) => {
    const post = gemPostOf(url);
    return post ? { board: post.board, externalId: post.id, canonical: [gemPostLink(post.board, post.id)] } : null;
  },
  cleanLink: (url) => {
    const post = gemPostOf(url);
    return post ? gemPostLink(post.board, post.id) : null;
  },
  addSource: {
    field: 'board',
    label: 'Gem board',
    hint: "The board's name in jobs.gem.com/<board>, or any job link on it.",
    placeholder: 'https://jobs.gem.com/acme',
    help: "Reads the board's open posts, each with its full text, on its schedule, once BOT_USER_AGENT is set.",
    invalid: 'Enter the name in jobs.gem.com/<board>, or an address on it.',
    required: "Enter the board's Gem name or address.",
    refusal: "Enter the board's name on Gem, or an address on jobs.gem.com/<board>.",
    refusalField: 'Enter the name in jobs.gem.com/<board>, or its address.',
    what: 'Gem board',
    companyHint: "Gem doesn't name the company: TailorIT reads it from each post's first heading. Type it to choose it yourself.",
  },
  detail: (config) => (configWords(config, 'board') ? `Board ${configWords(config, 'board')} (jobs.gem.com)` : null),
  examples: [
    {
      link: 'https://jobs.gem.com/acme-robotics-inc-/am9icG9zdDpBY21lUm9ib3RpY3MwMQ?jr_id=6ab13a57d43e',
      clean: 'https://jobs.gem.com/acme-robotics-inc-/am9icG9zdDpBY21lUm9ib3RpY3MwMQ',
      board: 'acme-robotics-inc-',
      externalId: 'am9icG9zdDpBY21lUm9ib3RpY3MwMQ',
      found: 'acme-robotics-inc-',
    },
  ],
});
