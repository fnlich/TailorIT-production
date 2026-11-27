import { z } from 'zod';
import { BOARD_CONFIG_COMMON, defineBoard } from './define';
import type { BoardUrl } from './types';
import { boardHostOf, boardUrlOf, configWords } from './url';

// v38 ATS-B: ADP Workforce Now career centers (SP v38 REQUEST.md 21, EVIDENCE.md §21; the API's adapters/adp.ts). A board
// is one client's career center: its client id (cid, a uuid, in lower case: the extension's lookup's `adp` board), with
// its career center's id (ccId) when that is not ADP's usual one ("<cid>/<ccId>"). A posting's id is the link's jobId:
// the posting's ExternalJobID, not the API's itemID.

/** ADP Workforce Now's candidate host. */
export const ADP_HOST = 'workforcenow.adp.com';
/** The guest careers page (its posting's clean link), and every step of an application after the emailed code. */
export const ADP_GUEST_PAGE = '/mascsr/default/mdf/recruitment/recruitment.html';
const ADP_STEPS_PAGE = '/mascsr/applicant/mdf/recruitment/postLogin.html';
/**
 * The career center every ADP careers link names unless the client has another (each example link and live answer of
 * SP v38 EVIDENCE.md §21): a board name leaves it out.
 */
export const ADP_DEFAULT_CC_ID = '19000101_000001';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CC_ID = /^\d{8}_\d{6}$/;
export const ADP_JOB_ID = /^\d{1,15}$/;

/** One client's career center. */
export interface AdpCenter {
  /** The client id, lower case. */
  cid: string;
  /** The career center's id, or null for ADP's usual one. */
  ccId: string | null;
}

/** A query parameter's value, compared by its exact name (ADP writes cid, jobId, ccId so); null for none. */
function paramOf(url: BoardUrl, name: string): string | null {
  for (const [key, value] of url.searchParams) if (key === name) return value;
  return null;
}

/** The career center a careers page names (?cid=…[&ccId=…]), on ADP's candidate host; null for none. */
function centerOfUrl(url: BoardUrl): AdpCenter | null {
  if (boardHostOf(url) !== ADP_HOST || (url.pathname !== ADP_GUEST_PAGE && url.pathname !== ADP_STEPS_PAGE)) return null;
  const cid = paramOf(url, 'cid') ?? '';
  const ccId = paramOf(url, 'ccId');
  if (!UUID.test(cid) || (ccId !== null && !CC_ID.test(ccId))) return null;
  return { cid: cid.toLowerCase(), ccId: ccId && ccId !== ADP_DEFAULT_CC_ID ? ccId : null };
}

/** A career center's board name: its cid, then "/<ccId>" for a career center other than ADP's usual one. */
export const adpBoardName = (center: AdpCenter) => (center.ccId ? `${center.cid}/${center.ccId}` : center.cid);

/** The career center a board's name ("<cid>[/<ccId>]") or any careers page's address names; null for none. */
export function adpCenterOf(input: string): AdpCenter | null {
  const text = input.trim();
  const bare = /^([0-9a-f-]{36})(?:\/(\d{8}_\d{6}))?$/i.exec(text);
  if (bare) {
    if (!UUID.test(bare[1]!)) return null;
    const ccId = bare[2] && bare[2] !== ADP_DEFAULT_CC_ID ? bare[2] : null;
    return { cid: bare[1]!.toLowerCase(), ccId };
  }
  const url = boardUrlOf(text);
  return url ? centerOfUrl(url) : null;
}

/** A board's name from a name or an address ('' for none). */
export function adpBoardOf(input: string): string {
  const center = adpCenterOf(input);
  return center ? adpBoardName(center) : '';
}

/** The career center a source's config names ({ tenant: "<cid>[/<ccId>]" }: its board's name), or null. */
export function adpCenterOfConfig(config: Record<string, unknown>): AdpCenter | null {
  return typeof config.tenant === 'string' ? adpCenterOf(config.tenant) : null;
}

/** A posting's clean link: the guest page with cid, jobId and ccId alone (REQUEST.md 21), in the canonical (sorted) order. */
export function adpPostingUrl(center: AdpCenter, jobId: string): string {
  return `https://${ADP_HOST}${ADP_GUEST_PAGE}?ccId=${center.ccId ?? ADP_DEFAULT_CC_ID}&cid=${center.cid}&jobId=${jobId}`;
}

/** The posting a careers link names (its career center and its jobId, once), or null. */
export function adpPostingOf(url: BoardUrl): { center: AdpCenter; jobId: string; ccId: string | null } | null {
  const center = centerOfUrl(url);
  if (!center) return null;
  const jobIds = [...new Set([...url.searchParams].filter(([key]) => key === 'jobId').map(([, value]) => value))];
  if (jobIds.length !== 1 || !ADP_JOB_ID.test(jobIds[0]!)) return null;
  return { center, jobId: jobIds[0]!, ccId: paramOf(url, 'ccId') };
}

export const ADP_BOARD = defineBoard({
  kind: 'adp',
  label: 'ADP Workforce Now',
  row: { access: 'public_api', runs: true, precedence: 4, rawKeepDays: 30 },
  platform: 'adp',
  hosts: String.raw`^workforcenow\.adp\.com$`,
  domains: ['adp.com'],
  atsKind: 'adp',
  configKey: 'tenant',
  boardWords: 'ADP career center',
  configSchema: z.strictObject({ tenant: z.string().min(1), ...BOARD_CONFIG_COMMON }),
  boardOf: adpBoardOf,
  configOfBoard: (board) => ({ tenant: adpBoardOf(board) || board }),
  // One host for every client.
  hostOf: () => ADP_HOST,
  // v38 FIX-A (SP v38 FIXES-38 D4, REVIEW38-beh M12): one request at a time to ADP Workforce Now, at the lanes' pace
  // (LANE_DEFAULT_MIN_INTERVAL_MS), as every v3.8 platform.
  lane: { key: 'adp.lane', label: 'ADP Workforce Now (all career centers)', name: 'ADP Workforce Now' },
  boardOfUrl: (url) => {
    const center = centerOfUrl(url);
    return center ? adpBoardName(center) : null;
  },
  // REQUEST.md 21: keep cid, jobId and ccId, drop the rest (jr_id, the steps' codes); an application's step is its posting.
  // In TailorIT's canonical order (every stored link's query is sorted by name: ccId, cid, jobId).
  cleanLink: (url) => {
    const posting = adpPostingOf(url);
    if (!posting) return null;
    const ccId = posting.ccId && CC_ID.test(posting.ccId) ? posting.ccId : null;
    return `https://${ADP_HOST}${ADP_GUEST_PAGE}?${ccId ? `ccId=${ccId}&` : ''}cid=${posting.center.cid}&jobId=${posting.jobId}`;
  },
  addSource: {
    field: 'tenant',
    label: 'ADP careers page',
    hint: "The careers page's address on workforcenow.adp.com (it names the company's cid).",
    placeholder: 'https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=…&ccId=…',
    help: "Reads the career center's job list and each job's details on its schedule, one request at a time, once BOT_USER_AGENT is set.",
    invalid: 'Enter the careers page address on workforcenow.adp.com, with its cid.',
    required: "Enter the company's ADP careers page address.",
    refusal: "Enter the company's ADP careers page: an address on workforcenow.adp.com with ?cid= in it.",
    refusalField: 'Enter the careers page address, with its cid.',
    what: 'ADP career center',
    inputMode: 'url',
    companyHint: "ADP doesn't name the company: type it so its jobs show the right name.",
    // v38 FIX-APP (SP v38 FIXES-38 D1): ADP names no employer anywhere, and TailorIT never makes one up from the cid.
    companyRequired: "Type the company's name: ADP's careers page doesn't name it.",
  },
  // v38 FIX-APP (REVIEW38-ux L12): named by its company, else by the client id's first part (never the whole GUID).
  sourceName: (board) => `ADP career center ${board.slice(0, 8)}`,
  detail: (config) => {
    const center = adpCenterOfConfig(config);
    return center ? `Client ${center.cid}${center.ccId ? `, career center ${center.ccId}` : ''}` : configWords(config, 'tenant') || null;
  },
  examples: [
    {
      link: 'https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=0b5e8a4c-1d2f-4e3a-9b7c-6d5e4f3a2b1c&jobId=480112&ccId=19000101_000001&jr_id=6b0400000000000000000001&lang=en_US',
      clean: 'https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?ccId=19000101_000001&cid=0b5e8a4c-1d2f-4e3a-9b7c-6d5e4f3a2b1c&jobId=480112',
      board: '0b5e8a4c-1d2f-4e3a-9b7c-6d5e4f3a2b1c',
      externalId: '480112',
      found: '0b5e8a4c-1d2f-4e3a-9b7c-6d5e4f3a2b1c',
    },
  ],
});
