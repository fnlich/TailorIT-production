import type { AppDeps } from '../../../core/context';
import { SOURCE_KINDS, type AdapterContext, type FetchResult, type SourceAdapter, type SourceKind, type SourceRecord } from '../types';

// v30 ST0: the ingest adapter base (PLAN §6, "Ingest adapters"). Part 2 roughly doubles the adapters (USAJOBS,
// Himalayas, Jobicy, Personio, Recruitee, Workday sitemaps, career pages...), so each one says, in one definition,
// what it is and what it reads: its kind, its label, how it reaches its postings (`access`) and the hosts it reads.
// The hosts are what the recorded-answer harness (apps/api/test/helpers/adapter-harness.ts) holds it to: a test of an
// adapter fails on a request to any host it did not declare, and never reaches the network. Every adapter has such a
// test, and every adapter is made with defineAdapter (apps/api/test/structure-bases.test.ts checks it).
//
//   export const leverAdapter = defineAdapter({
//     kind: 'lever',
//     label: 'Lever job site',
//     access: 'api',
//     hosts: ['api.lever.co', 'api.eu.lever.co'],
//     async fetch(source, ctx) { ... return { postings, complete, failures }; },
//   });
//
// At run time defineAdapter adds nothing to the request path: the ingest client (http.ts) keeps its pace per host, its
// refusals (LinkedIn, the refused boards) and its User-Agent. It checks the answer's shape, so an adapter's slip is a
// failed run with a plain message, never a crash of the importer.
//
// v30 S1-API: an adapter that reads an outside host also says which paths a run of a source reads (`robotsPaths`):
// the worker judges each source's robots_status by them (scheduler.ts refreshRobotsStatuses), and a source whose
// adapter names none is never scheduled (12 §1 test 2: robots.txt for every keyless read). A listing that can answer
// a conditional GET sends the source's validators (conditionalOf) and answers `notModified` on a 304.

/**
 * How an adapter reaches its postings: `api` a board's public JSON or XML API; `page` a page's HTML (JSON-LD,
 * sitemaps); `file` an admin's upload (csv, json), no outside read; `lake` a local data set (free_tailor's lake);
 * `dev` development data (the seed), behind the dev-only seam.
 */
export const ADAPTER_ACCESS = ['api', 'page', 'file', 'lake', 'dev'] as const;
export type AdapterAccess = (typeof ADAPTER_ACCESS)[number];

/**
 * v30 S4: an outside service's key an adapter reads with (DECISIONS P1, owner question 10: USAJOBS_API_KEY,
 * HIMALAYAS_API_KEY), read from `deps.config.outside`, never from .env by hand. While it is empty the kind's sources
 * stay off: the worker never takes them (scheduler.ts runnableKinds) and Run now refuses (service.ts).
 */
export interface OutsideKey {
  /** The .env setting, named in the refusal. */
  setting: string;
  /** The key, or null while the setting is empty. */
  of(deps: Pick<AppDeps, 'config'>): string | null;
}

export interface AdapterSpec {
  kind: SourceKind;
  /** What the admin reads in Admin › Sources ("Greenhouse job board"). */
  label: string;
  access: AdapterAccess;
  /**
   * The hosts it reads, lower case, no scheme: `boards-api.greenhouse.io`; `*.myworkdayjobs.com` for every subdomain
   * of a domain; `*` for any public host (a page adapter, which reads the address an admin or a person gave). Empty
   * for an adapter with no outside read (`file`, `lake`, `dev`).
   */
  hosts: readonly string[];
  /** v30 S1-API: the paths (with their query) a run of `source` reads, for its robots.txt verdict. */
  robotsPaths?: (source: SourceRecord) => string[];
  /** v30 S4: the outside service's key it cannot read without (see OutsideKey). */
  outsideKey?: OutsideKey;
  fetch(source: SourceRecord, ctx: AdapterContext): Promise<FetchResult>;
}

/** An adapter made by defineAdapter: a SourceAdapter, plus what it declared. */
export interface DefinedAdapter extends SourceAdapter {
  readonly label: string;
  readonly access: AdapterAccess;
  readonly hosts: readonly string[];
  readonly robotsPaths?: (source: SourceRecord) => string[];
  readonly outsideKey?: OutsideKey; // v30 S4
  readonly defined: true;
}

/** v30 S4: the .env setting an adapter still waits for (its outside key is empty), or null when it may read. */
export function missingOutsideKey(adapter: SourceAdapter | undefined, deps: Pick<AppDeps, 'config'>): string | null {
  const key = adapter && isDefinedAdapter(adapter) ? adapter.outsideKey : undefined;
  return key && !key.of(deps) ? key.setting : null;
}

/** The request options of a listing read as a conditional GET (the source's last validators), for ctx.http.getJson. */
export function conditionalOf(ctx: Pick<AdapterContext, 'validators'>): { etag?: string; lastModified?: string } {
  const validators = ctx.validators;
  return {
    ...(validators?.etag ? { etag: validators.etag } : {}),
    ...(validators?.lastModified ? { lastModified: validators.lastModified } : {}),
  };
}

/** A FetchResult for a listing that answered 304: complete, unchanged, nothing to store (12 §9.4). */
export function notModifiedResult(): FetchResult {
  return { postings: [], complete: true, failures: [], notModified: true };
}

const HOST_PATTERN = /^(\*|(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+)$/;

/** Whether `host` (lower case) is one of `patterns` (defineAdapter's `hosts`). */
export function hostAllowed(host: string, patterns: readonly string[]): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  return patterns.some((pattern) => {
    if (pattern === '*') return true;
    if (pattern.startsWith('*.')) return name.endsWith(pattern.slice(1)) && name.length > pattern.length - 1;
    return name === pattern;
  });
}

/** The problems of a fetch result's shape (empty when it is a FetchResult). */
export function fetchResultProblems(result: unknown): string[] {
  if (!result || typeof result !== 'object') return ['the answer is not an object'];
  const value = result as Partial<FetchResult>;
  const problems: string[] = [];
  if (!Array.isArray(value.postings)) problems.push('postings is not a list');
  if (typeof value.complete !== 'boolean') problems.push('complete is not true or false');
  if (!Array.isArray(value.failures)) problems.push('failures is not a list');
  if (value.skippedIds !== undefined && !Array.isArray(value.skippedIds)) problems.push('skippedIds is not a list');
  if (value.notModified !== undefined && typeof value.notModified !== 'boolean') problems.push('notModified is not true or false');
  if (value.notModified && (value.postings?.length ?? 0) > 0) problems.push('a listing that was not modified has postings');
  return problems;
}

/** Defines one ingest adapter (see the comment at the top). Throws for a definition that is not sound. */
export function defineAdapter(spec: AdapterSpec): DefinedAdapter {
  if (!(SOURCE_KINDS as readonly string[]).includes(spec.kind)) throw new Error(`Unknown source kind "${spec.kind}".`);
  if (!(ADAPTER_ACCESS as readonly string[]).includes(spec.access)) throw new Error(`Unknown adapter access "${spec.access}".`);
  if (!spec.label.trim()) throw new Error(`The ${spec.kind} adapter needs a label.`);
  for (const host of spec.hosts) {
    if (!HOST_PATTERN.test(host)) throw new Error(`The ${spec.kind} adapter's host "${host}" is not a lower-case host name.`);
  }
  const reads = spec.access === 'api' || spec.access === 'page';
  if (reads && spec.hosts.length === 0) throw new Error(`The ${spec.kind} adapter reads outside hosts: name them.`);
  if (!reads && spec.hosts.length > 0) throw new Error(`The ${spec.kind} adapter (${spec.access}) reads no outside host.`);
  return Object.freeze({
    kind: spec.kind,
    label: spec.label,
    access: spec.access,
    hosts: Object.freeze([...spec.hosts]),
    ...(spec.robotsPaths ? { robotsPaths: spec.robotsPaths } : {}),
    ...(spec.outsideKey ? { outsideKey: spec.outsideKey } : {}), // v30 S4
    defined: true as const,
    async fetch(source: SourceRecord, ctx: AdapterContext): Promise<FetchResult> {
      const result = await spec.fetch(source, ctx);
      const problems = fetchResultProblems(result);
      if (problems.length > 0) throw new Error(`The ${spec.kind} adapter answered a result that is not valid: ${problems.join('; ')}.`);
      return result;
    },
  });
}

/** Whether an adapter was made with defineAdapter. */
export function isDefinedAdapter(adapter: SourceAdapter): adapter is DefinedAdapter {
  return (adapter as Partial<DefinedAdapter>).defined === true;
}
