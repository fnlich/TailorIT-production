import { secretOrAmbiguousName } from '@tailorit/shared';
import { parseAtsUrl, type AtsKind } from '@tailorit/shared/autofill';

// The parameters a posting's own address names that look like a secret (autofill API 7), kept as written: lookup.ts's
// page addresses and the add pipeline's shared links (jobs/add/address.ts) read them. v31 FIX-LINK: moved here from
// lookup.ts (which re-exports them) so the add pipeline's address helper imports no lookup: a leaf module, no cycle
// through jobs/rows.ts (rows -> jobs/add/verification -> address -> lookup -> jobs/store -> rows).

/**
 * Autofill API 7: the parameters, by kind and in lower case, that name a posting yet look like a secret to
 * keptOnPage, kept as written when the posting's own first canonical address names them (postingParameters): JobDiva's
 * agency key `a` (64 letters and digits: a one-letter name with a token-like value). Nothing else, on no other kind
 * (the jr7 review's A-2: a whole page's parameters were kept for a Greenhouse company page). No name here may be one a
 * secret or an ambiguous parameter uses (secretOrAmbiguousName; a test holds the list to it).
 */
export const POSTING_PARAMETERS: Readonly<Partial<Record<AtsKind, readonly string[]>>> = { jobdiva: ['a'] };

function decodeSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * The query parameters, as "<name in lower case>=<value>", that the posting `address` names keeps as written whatever
 * they look like: those of POSTING_PARAMETERS' list for its kind that its first canonical address names (parseAtsUrl
 * builds it from the posting's board and id alone), and never a secret's or an ambiguous name. Empty for an address
 * that names no posting, and for every kind but those listed.
 */
export function postingParameters(address: string): ReadonlySet<string> {
  const read = parseAtsUrl(address);
  return read ? listedParameters(read.kind, read.canonical[0]) : new Set();
}

/**
 * postingParameters' reading of one canonical address of a posting of `kind`: its query's parameters whose name is in
 * POSTING_PARAMETERS' list for `kind` and is no secret's or ambiguous name, as "<name in lower case>=<value>".
 */
export function listedParameters(kind: AtsKind, canonical: string | undefined): ReadonlySet<string> {
  const names = POSTING_PARAMETERS[kind];
  const query = canonical?.split('#')[0]?.split('?')[1];
  if (!names || !query) return new Set();
  const kept = new Set<string>();
  for (const pair of query.split('&')) {
    const equals = pair.indexOf('=');
    const name = decodeSafe(equals < 0 ? pair : pair.slice(0, equals)).toLowerCase();
    const value = equals < 0 ? '' : decodeSafe(pair.slice(equals + 1).replace(/\+/g, ' '));
    if (names.includes(name) && !secretOrAmbiguousName(name)) kept.add(`${name}=${value}`);
  }
  return kept;
}
