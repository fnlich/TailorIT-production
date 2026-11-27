import { z } from 'zod';
import { BOARD_CONFIG_COMMON, defineBoard } from './define';
import type { BoardUrl } from './types';
import { boardHostOf, boardSegmentsOf, boardUrlOf, configWords } from './url';

// v38 ATS-A (SP v38 PLAN "Final coverage" row 7; REQUEST.md 7, EVIDENCE.md 7): a Rippling job board,
// ats.rippling.com/<board>/jobs, listed by ats.rippling.com's /api/v2/board/<board>/jobs (pages from 0, no text) and each
// posting read from api.rippling.com's /platform/api/ats/v1/board/<board>/jobs/<uuid> (its text). The API's part:
// apps/api/src/features/ingest/boards/rippling.ts.

/** Rippling's job pages' host (and its board list's). */
export const RIPPLING_ATS_HOST = 'ats.rippling.com';
/** Rippling's API host (each posting's record). */
export const RIPPLING_API_HOST = 'api.rippling.com';

/** A board's name: letters, digits and '-' (REQUEST.md: case-sensitive, so kept as written). */
const RIPPLING_BOARD_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/;
/** A posting's id: a UUID (kept in lower case). */
const RIPPLING_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * A leading locale segment (/en-GB/, the shared lookup's RIPPLING_LOCALE), dropped only where the path goes on
 * <board>/jobs, so a board whose name looks like one stays a board.
 */
const RIPPLING_LOCALE = /^[a-z]{2,3}(?:-(?:[A-Za-z]{4}|[A-Za-z]{2}|\d{3}))?$/;
/** First path segments of ats.rippling.com that name no board. */
const NOT_A_RIPPLING_BOARD: ReadonlySet<string> = new Set(['api', 'internal', 'static', 'assets', '_next', 'favicon.ico', 'robots.txt']);

/** A board name as written, or '' when it is none Rippling writes. */
function ripplingBoardName(text: string): string {
  const board = text.trim();
  return RIPPLING_BOARD_NAME.test(board) && !NOT_A_RIPPLING_BOARD.has(board.toLowerCase()) ? board : '';
}

/** An address's path on ats.rippling.com without a leading locale (only before <board>/jobs). */
function ripplingParts(url: Pick<BoardUrl, 'pathname'>): string[] {
  const parts = boardSegmentsOf(url);
  return parts.length > 2 && parts[2] === 'jobs' && parts[1] !== 'jobs' && RIPPLING_LOCALE.test(parts[0]!) ? parts.slice(1) : parts;
}

/**
 * The Rippling board a name or an address names ("acme", https://ats.rippling.com/[<locale>/]acme/jobs[/<uuid>],
 * https://api.rippling.com/platform/api/ats/v1/board/acme/jobs/...): as written; '' for none.
 */
export function ripplingBoard(input: string): string {
  const text = input.trim();
  if (!text) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !text.includes('/') && !text.includes('.')) return ripplingBoardName(text);
  const url = boardUrlOf(text);
  if (!url) return '';
  const host = boardHostOf(url);
  if (host === RIPPLING_ATS_HOST) {
    const parts = ripplingParts(url);
    if (parts[0] === 'api' && parts[1] === 'v2' && parts[2] === 'board' && parts[3]) return ripplingBoardName(parts[3]);
    return parts[0] && (parts.length === 1 || parts[1] === 'jobs') ? ripplingBoardName(parts[0]) : '';
  }
  if (host === RIPPLING_API_HOST) {
    const parts = boardSegmentsOf(url);
    const at = parts.indexOf('board');
    return at >= 0 && parts[at + 1] ? ripplingBoardName(parts[at + 1]!) : '';
  }
  return '';
}

/** A posting a Rippling address names: /[<locale>/]<board>/jobs/<uuid>[/apply]; null for any other address. */
function ripplingPostingOf(url: BoardUrl): { board: string; id: string } | null {
  if (boardHostOf(url) !== RIPPLING_ATS_HOST) return null;
  const [board, jobs, id, ...rest] = ripplingParts(url);
  const tail = rest.join('/');
  if (board === undefined || jobs !== 'jobs' || id === undefined || !RIPPLING_UUID.test(id) || (tail !== '' && tail !== 'apply')) return null;
  const name = ripplingBoardName(board);
  return name ? { board: name, id: id.toLowerCase() } : null;
}

/** A posting's clean link: https://ats.rippling.com/<board>/jobs/<uuid> (REQUEST.md: no locale, no /apply, no query). */
export const ripplingPostingLink = (board: string, id: string) => `https://${RIPPLING_ATS_HOST}/${board}/jobs/${id}`;

export const RIPPLING_BOARD = defineBoard({
  kind: 'rippling',
  label: 'Rippling',
  row: { access: 'public_api', runs: true, precedence: 4, rawKeepDays: 30 },
  platform: 'rippling',
  hosts: String.raw`^ats\.rippling\.com$`,
  domains: ['rippling.com'],
  atsKind: 'rippling',
  configKey: 'board',
  boardWords: 'Rippling board',
  configSchema: z.strictObject({ board: z.string().min(1), ...BOARD_CONFIG_COMMON }),
  // REQUEST.md: a board's name is case-sensitive.
  keepsCase: true,
  boardOf: ripplingBoard,
  configOfBoard: (board) => ({ board }),
  hostOf: (config) => (typeof config.board === 'string' && ripplingBoard(config.board) ? RIPPLING_ATS_HOST : null),
  boardOfUrl: (url) => {
    if (boardHostOf(url) !== RIPPLING_ATS_HOST) return null;
    const parts = ripplingParts(url);
    return parts[0] && (parts.length === 1 || parts[1] === 'jobs') ? ripplingBoardName(parts[0]) || null : null;
  },
  // A link the shared lookup does not read (a board in capitals, an upper-case UUID).
  parseLink: (url) => {
    const posting = ripplingPostingOf(url);
    return posting ? { board: posting.board, externalId: posting.id, canonical: [ripplingPostingLink(posting.board, posting.id)] } : null;
  },
  cleanLink: (url) => {
    const posting = ripplingPostingOf(url);
    return posting ? ripplingPostingLink(posting.board, posting.id) : null;
  },
  // Its two hosts (the board lists, the postings' records) answer every board: one request at a time to both.
  lane: {
    key: 'rippling.lane',
    label: 'Rippling (all boards)',
    name: 'Rippling',
    hosts: String.raw`^(?:ats|api)\.rippling\.com$`,
  },
  addSource: {
    field: 'board',
    label: 'Rippling board',
    hint: "The board's name in ats.rippling.com/<board>/jobs, or any job link on it.",
    placeholder: 'https://ats.rippling.com/acme/jobs',
    help: "Reads the board's openings and each one's full posting on its schedule, one request at a time, once BOT_USER_AGENT is set.",
    invalid: 'Enter the name in ats.rippling.com/<board>/jobs, or an address on it.',
    required: "Enter the board's Rippling name or address.",
    refusal: "Enter the board's name on Rippling, or an address on ats.rippling.com/<board>/jobs.",
    refusalField: 'Enter the name in ats.rippling.com/<board>/jobs, or its address.',
    what: 'Rippling board',
  },
  detail: (config) => (configWords(config, 'board') ? `Board ${configWords(config, 'board')} (ats.rippling.com)` : null),
  examples: [
    {
      link: 'https://ats.rippling.com/acme-robotics/jobs/0b9a5f7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b?jr_id=6b0604d5460c',
      clean: 'https://ats.rippling.com/acme-robotics/jobs/0b9a5f7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b',
      board: 'acme-robotics',
      externalId: '0b9a5f7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b',
      found: 'acme-robotics',
    },
    {
      link: 'https://ats.rippling.com/en-GB/acme-robotics/jobs/0b9a5f7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b/apply?step=application',
      clean: 'https://ats.rippling.com/acme-robotics/jobs/0b9a5f7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b',
      board: 'acme-robotics',
      externalId: '0b9a5f7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b',
      found: 'acme-robotics',
    },
  ],
});
