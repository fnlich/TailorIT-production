import { z } from 'zod';
import { BOARD_CONFIG_COMMON, defineBoard } from './define';
import { boardHostOf, configWords, NOT_A_BOARD } from './url';

// v38 FRAME: Greenhouse job boards (boards-api.greenhouse.io/v1/boards/{token}/jobs; the API's adapters/greenhouse.ts).

/** The board token as typed: a token, or a board URL (boards.greenhouse.io/acme, job-boards.greenhouse.io/acme). */
export function greenhouseToken(input: string): string {
  const text = input.trim();
  const fromUrl = /greenhouse\.io\/(?:v1\/boards\/|embed\/job_board\?for=)?([A-Za-z0-9_-]+)/i.exec(text);
  return (fromUrl?.[1] ?? text).replace(/[^A-Za-z0-9_-]/g, '');
}

/** Greenhouse's board hosts (the EU twins too: validation tells whether the global API reads the board). */
const GREENHOUSE_HOSTS: ReadonlySet<string> = new Set([
  'boards.greenhouse.io',
  'job-boards.greenhouse.io',
  'boards.eu.greenhouse.io',
  'job-boards.eu.greenhouse.io',
]);

export const GREENHOUSE_BOARD = defineBoard({
  kind: 'greenhouse',
  label: 'Greenhouse',
  row: { access: 'public_api', runs: true, precedence: 4, rawKeepDays: 30 },
  platform: 'greenhouse',
  hosts: String.raw`^(?:job-)?boards(?:\.eu)?\.greenhouse\.io$`,
  domains: ['greenhouse.io'],
  atsKind: 'greenhouse',
  configKey: 'token',
  configSchema: z.strictObject({ token: z.string().min(1), ...BOARD_CONFIG_COMMON }),
  boardOf: greenhouseToken,
  configOfBoard: (board) => ({ token: board }),
  hostOf: () => 'boards-api.greenhouse.io',
  boardOfUrl: (url, parts) => {
    if (!GREENHOUSE_HOSTS.has(boardHostOf(url))) return null;
    if (parts[0] === 'embed') return url.searchParams.get('for') || null;
    return parts[0] && !NOT_A_BOARD.has(parts[0].toLowerCase()) ? parts[0] : null;
  },
  detail: (config) => `Board ${configWords(config, 'token')}`,
  examples: [
    {
      link: 'https://job-boards.greenhouse.io/acmerobotics/jobs/4012345678?gh_src=a1b2c3',
      clean: 'https://job-boards.greenhouse.io/acmerobotics/jobs/4012345678',
      board: 'acmerobotics',
      externalId: '4012345678',
      found: 'acmerobotics',
    },
  ],
});
