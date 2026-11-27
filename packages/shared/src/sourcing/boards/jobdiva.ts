import { z } from 'zod';
import { BOARD_CONFIG_COMMON, defineBoard } from './define';
import type { BoardUrl } from './types';
import { boardHostOf, configWords, hostOfTyped } from './url';

// v38 ATS-D: JobDiva's candidate portals (@tailorit/shared/autofill parseAtsUrl's `jobdiva`): an agency's portal,
// https://www<n>.jobdiva.com/portal/?a=<portal key>#/jobs/<job id>, where the job lives only in the fragment (browsers
// never send it). The portal is a script-drawn page that gates itself with Cloudflare Turnstile and reCAPTCHA (SP v38
// EVIDENCE.md §25), and the job's data needs the agency's own API user: TailorIT never reads it. A link is recognised,
// cleaned (REQUEST.md #25: `a` and the #/jobs/<id> fragment kept), and its verdict is can't read (`bot_check`), with no
// request (the API part).

const JOBDIVA_HOSTS = String.raw`^www\d{0,2}\.jobdiva\.com$`;
const JOBDIVA_HOST = new RegExp(JOBDIVA_HOSTS);
/** An agency's portal key (letters and digits, 16 to 128 of them; parseAtsUrl's rule) and a job's id. */
const PORTAL_KEY = /^[0-9A-Za-z]{16,128}$/;
const JOB_ID = /^\d{1,12}$/;
/** The portal's job route in the fragment: #/jobs/<id>, a later number and a query of its own allowed (parseAtsUrl's). */
const JOB_ROUTE = /^#\/jobs\/(\d{1,12})(?:\/\d{1,12})?\/?(?:\?.*)?$/;

/** The job a portal's address names (its key as written, its job's id); null for any other page (the legacy page too). */
export function jobDivaPostingOf(url: BoardUrl): { key: string; id: string } | null {
  if (!JOBDIVA_HOST.test(boardHostOf(url)) || (url.pathname !== '/portal/' && url.pathname !== '/portal')) return null;
  const keys = [...url.searchParams].filter(([name]) => name === 'a').map(([, value]) => value);
  if (keys.length !== 1 || !PORTAL_KEY.test(keys[0]!)) return null;
  // The job is the fragment's route; with no fragment at all, the query's `id` (an older link's spelling of the same job).
  const ids = [...url.searchParams].filter(([name]) => name === 'id').map(([, value]) => value);
  const id = url.hash && url.hash !== '#' ? (JOB_ROUTE.exec(url.hash)?.[1] ?? null) : ids.length === 1 ? ids[0]! : null;
  return id !== null && JOB_ID.test(id) ? { key: keys[0]!, id } : null;
}

/** An agency's portal key from a typed key or any portal address naming it (?a=); '' for none. */
export function jobDivaPortalKey(input: string): string {
  const text = input.trim();
  if (PORTAL_KEY.test(text)) return text;
  const host = hostOfTyped(text);
  if (!host || !JOBDIVA_HOST.test(host)) return '';
  const key = /[?&]a=([0-9A-Za-z]+)(?:[&#]|$)/.exec(text)?.[1] ?? '';
  return PORTAL_KEY.test(key) ? key : '';
}

export const JOBDIVA_BOARD = defineBoard({
  kind: 'jobdiva',
  label: 'JobDiva',
  row: { access: 'licensed_api', runs: false, precedence: 4, rawKeepDays: 30 },
  platform: 'jobdiva',
  hosts: JOBDIVA_HOSTS,
  domains: ['jobdiva.com'],
  atsKind: 'jobdiva',
  configKey: 'board',
  boardWords: 'JobDiva portal',
  configSchema: z.strictObject({ board: z.string().min(1), ...BOARD_CONFIG_COMMON }),
  // The portal key is case-sensitive.
  keepsCase: true,
  boardOf: jobDivaPortalKey,
  configOfBoard: (board) => ({ board }),
  // An agency's portal answers on any of JobDiva's www<n> hosts: no one host.
  hostOf: () => null,
  // The portal's job: /portal/?a=<key>#/jobs/<id> (its trailing slash, its key and its route kept; the rest dropped).
  cleanLink: (url) => {
    const posting = jobDivaPostingOf(url);
    return posting ? `https://${boardHostOf(url)}/portal/?a=${posting.key}#/jobs/${posting.id}` : null;
  },
  lane: {
    key: 'jobdiva.lane',
    label: 'JobDiva (all portals)',
    name: 'JobDiva',
  },
  detail: (config) => (configWords(config, 'board') ? `Portal ${configWords(config, 'board').slice(0, 12)}…` : null),
  examples: [
    {
      link: 'https://www2.jobdiva.com/portal/?a=q8w7e6r5t4y3u2i1o0p9a8s7d6f5g4h3j2k1l0z9x8c7v6b5n4m3q2w1e0r9t8y7&compid=-1&jr_id=6b0613b5aa11#/jobs/12345678?jobtitle=Robotics%20Engineer',
      clean: 'https://www2.jobdiva.com/portal/?a=q8w7e6r5t4y3u2i1o0p9a8s7d6f5g4h3j2k1l0z9x8c7v6b5n4m3q2w1e0r9t8y7#/jobs/12345678',
      board: 'q8w7e6r5t4y3u2i1o0p9a8s7d6f5g4h3j2k1l0z9x8c7v6b5n4m3q2w1e0r9t8y7',
      externalId: '12345678',
      found: null,
    },
  ],
});
