import { z } from 'zod';
import { BOARD_CONFIG_KEYS, type BoardDescriptor } from './types';

// v38 FRAME: defineBoard, the shared board descriptor's base (as the API's defineAdapter is an adapter's): it checks a
// descriptor is sound when its module loads, and fills the defaults. A descriptor that is not sound throws, so a slip
// fails every test at once.

/** A kind's name (job_source_kinds' check: kinds.ts JOB_SOURCE_KIND_PATTERN). */
const KIND = /^[a-z][a-z0-9_]{1,39}$/;
/** A platforms key (platforms' check). */
const PLATFORM = /^[a-z][a-z0-9]{1,39}$/;
/** A lane's crawl_hosts row (HostIdSchema reads it as a host name: `<platform>.lane`). */
const LANE_KEY = /^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?\.lane$/;

/** The stored config's common keys beside a kind's own: the employer's name and Add job's mark. */
export const BOARD_CONFIG_COMMON = { companyName: z.string().optional(), addedBy: z.string().optional() } as const;

/** Whether a host pattern reads the same in JavaScript and PostgreSQL (the subset both share; see BoardDescriptor.hosts). */
export function isPortableHostPattern(pattern: string): boolean {
  if (pattern.includes("'") || /\\(?![.\-dw/])/.test(pattern)) return false;
  if (/\(\?<[=!]/.test(pattern) || /\(\?<[a-z]/i.test(pattern)) return false; // no lookbehind, no named group
  if (/\((?!\?)/.test(pattern)) return false; // only non-capturing groups
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/** Defines one board kind's shared part (see types.ts). Throws for a definition that is not sound. */
export function defineBoard<const K extends string>(spec: BoardDescriptor<K>): BoardDescriptor<K> {
  const where = `The ${spec.kind} board`;
  if (!KIND.test(spec.kind)) throw new Error(`${where}: "${spec.kind}" is no kind name.`);
  if (!spec.label.trim()) throw new Error(`${where} needs a label.`);
  if (!PLATFORM.test(spec.platform) && spec.platform !== 'site') throw new Error(`${where}: "${spec.platform}" is no platforms key.`);
  if (!(BOARD_CONFIG_KEYS as readonly string[]).includes(spec.configKey)) {
    throw new Error(`${where}: its config key "${spec.configKey}" is none migration 0028's index reads (${BOARD_CONFIG_KEYS.join(', ')}).`);
  }
  if (spec.hosts !== null && !isPortableHostPattern(spec.hosts)) throw new Error(`${where}: its hosts pattern is not portable.`);
  if (spec.lane) {
    if (!LANE_KEY.test(spec.lane.key)) throw new Error(`${where}: its lane key "${spec.lane.key}" is not <platform>.lane.`);
    const hosts = spec.lane.hosts ?? spec.hosts;
    if (!hosts || !isPortableHostPattern(hosts)) throw new Error(`${where}: its lane needs a portable hosts pattern.`);
  }
  if (spec.row.precedence < 0 || spec.row.precedence > 4) throw new Error(`${where}: precedence is 0 to 4.`);
  if (spec.examples.length === 0) throw new Error(`${where} needs example links.`);
  return Object.freeze({
    ...spec,
    boardOfConfig: spec.boardOfConfig ?? ((config: Record<string, unknown>) => (typeof config[spec.configKey] === 'string' ? (config[spec.configKey] as string) : null)),
  });
}
