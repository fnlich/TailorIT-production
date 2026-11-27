import { isRecord, nameFromSlug, str, type Json } from '../adapters/common';
import type { IngestHttp } from '../http';
import { IngestError, type RawPosting } from '../types';
import type { PostingAnswer, PostingReadOptions, PostingRef } from './types';

// v38 FRAME: one posting read from a board's JSON API by its own address (Greenhouse's /jobs/{id}, Lever's
// /v0/postings/{site}/{id}: v37's postings.ts reads, moved here unchanged), for a descriptor whose readPosting is that.

/**
 * The posting at `url`: gone on a 404; else the answer read by `parse` (the adapter's own reader, so a posting read here
 * is stored exactly as a run stores it), named by the source's companyName, else by the posting's own company, else by
 * the board's slug. Throws IngestError when the answer is no posting, has no id, title or link, or is another posting.
 */
export async function readPostingJson(
  http: IngestHttp,
  url: string,
  label: string,
  ref: PostingRef,
  options: PostingReadOptions,
  parse: (data: Json, companyName: string) => RawPosting | null,
  finish?: (raw: RawPosting, data: Json) => void,
): Promise<PostingAnswer> {
  const answer = await http.getJson(url, { signal: options.signal, allow: [404] });
  if (answer.status === 404) return { found: false };
  if (!isRecord(answer.data)) throw new IngestError(`${label} answered without a posting.`);
  const named = str(options.config?.companyName);
  const companyName = named ?? nameFromSlug(ref.board);
  const raw = parse(answer.data, companyName);
  if (!raw) throw new IngestError(`${label}'s posting has no id, title or link.`);
  if (raw.sourceJobId.toLowerCase() !== ref.externalId.toLowerCase()) {
    throw new IngestError(`${label} answered with another posting.`);
  }
  if (named) raw.company.name = named;
  finish?.(raw, answer.data);
  return { found: true, raw };
}

/** A string config value as a board's normaliser takes it ('' for none). */
export const configString = (config: Record<string, unknown>, key: string): string => (typeof config[key] === 'string' ? (config[key] as string) : '');
