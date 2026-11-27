import { z } from 'zod';
import { BOARD_CONFIG_COMMON, defineBoard } from './define';
import { boardHostOf, configWords, NOT_A_BOARD } from './url';

// v38 FRAME: Ashby job boards (api.ashbyhq.com/posting-api/job-board/{name}; the API's adapters/ashby.ts).

/** The board name as typed: a name or a jobs.ashbyhq.com URL. */
export function ashbyBoard(input: string): string {
  const text = input.trim();
  const fromUrl = /ashbyhq\.com\/(?:posting-api\/job-board\/)?([A-Za-z0-9_.%-]+)/i.exec(text);
  const typed = fromUrl?.[1] ?? text;
  let name = typed;
  try {
    name = decodeURIComponent(typed);
  } catch {
    // "acme%": not percent-encoding after all (decodeURIComponent throws a URIError); the name is used as typed.
  }
  return name.replace(/[^A-Za-z0-9_. -]/g, '');
}

export const ASHBY_BOARD = defineBoard({
  kind: 'ashby',
  label: 'Ashby',
  row: { access: 'public_api', runs: true, precedence: 4, rawKeepDays: 30 },
  platform: 'ashby',
  hosts: String.raw`^jobs\.ashbyhq\.com$`,
  domains: ['ashbyhq.com'],
  atsKind: 'ashby',
  configKey: 'board',
  configSchema: z.strictObject({ board: z.string().min(1), ...BOARD_CONFIG_COMMON }),
  keepsCase: true,
  boardOf: ashbyBoard,
  configOfBoard: (board) => ({ board }),
  hostOf: () => 'api.ashbyhq.com',
  boardOfUrl: (url, parts) =>
    boardHostOf(url) === 'jobs.ashbyhq.com' && parts[0] && !NOT_A_BOARD.has(parts[0].toLowerCase()) ? parts[0] : null,
  detail: (config) => `Board ${configWords(config, 'board')}`,
  examples: [
    {
      link: 'https://jobs.ashbyhq.com/AcmeRobotics/6f1e2d3c-4b5a-4987-8f6e-5d4c3b2a1f0e?utm_source=newsletter',
      clean: 'https://jobs.ashbyhq.com/AcmeRobotics/6f1e2d3c-4b5a-4987-8f6e-5d4c3b2a1f0e',
      board: 'acmerobotics',
      externalId: '6f1e2d3c-4b5a-4987-8f6e-5d4c3b2a1f0e',
      found: 'AcmeRobotics',
    },
  ],
});
