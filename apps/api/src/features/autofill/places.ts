import type { AppDeps } from '../../core/context';

// Places as autofill API version 5 compares them, for page jobs (from-page.ts) and their upgrade (jobs.ts): as the
// places reader reads them (city, region code, country, remote), in any order, so "Austin, Texas" is "Austin, TX" and
// "Remote - US" is "United States (Remote)".

/** A place as the places reader reads it: its city, region code, country and whether it is remote. */
export interface Place {
  city: string | null;
  region: string | null;
  country: string | null;
  remote: boolean;
}

/** A city as places compare it: lower case, accents and punctuation aside. */
const cityKey = (city: string | null) =>
  city
    ? city
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
    : null;

/** A place as one text, for a mark that must not depend on how the page wrote it. */
export function placeKey(place: Place): string {
  return [cityKey(place.city) ?? '', place.region?.toUpperCase() ?? '', place.country?.toUpperCase() ?? '', place.remote ? 'r' : ''].join(',');
}

/** A job's places as it keeps them (job_locations). */
export async function jobPlaces(deps: Pick<AppDeps, 'db'>, jobId: number): Promise<Place[]> {
  const rows = await deps.db.all<{ city: string | null; region: string | null; country_code: string | null; is_remote: unknown }>(
    'SELECT city, region, country_code, is_remote FROM job_locations WHERE job_id = ? ORDER BY position',
    [jobId],
  );
  const { isTrue } = deps.db.dialect;
  return rows.map((row) => ({ city: row.city, region: row.region, country: row.country_code, remote: isTrue(row.is_remote) }));
}

/** Whether two places can be one: both remote or neither, and each of city, region and country the same where both say it. */
function samePlace(a: Place, b: Place): boolean {
  const same = (x: string | null, y: string | null) => x === null || y === null || x === y;
  return (
    a.remote === b.remote &&
    same(cityKey(a.city), cityKey(b.city)) &&
    same(a.region?.toUpperCase() ?? null, b.region?.toUpperCase() ?? null) &&
    same(a.country?.toUpperCase() ?? null, b.country?.toUpperCase() ?? null)
  );
}

/**
 * Whether two sets of places, in any order, can be one posting's: they tell two postings apart only when both have
 * places and none of one's can be any of the other's ("Austin, TX; Remote" and "Remote; Austin, TX" meet, and so do
 * "Remote" and "United States (Remote)"; "Austin, TX" and "Berlin, Germany" do not).
 */
export function placesMeet(a: readonly Place[], b: readonly Place[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  return a.some((place) => b.some((other) => samePlace(place, other)));
}
