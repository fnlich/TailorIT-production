import {
  EMPLOYMENT_TYPES,
  EMPTY_PREFERENCES,
  EXPERIENCE_LEVELS,
  WORK_ARRANGEMENTS,
  canonicalTimeZone,
  isCountryCode,
  isRegionCode,
  type Preferences,
} from '@tailorit/shared';
import { nowIso, type AppDeps } from '../../core/context';
import { readAutofillProfile } from '../autofill/profile/repository';

// The signed-in user's job preferences and the contact fields cover letters fall back on. One row per user, created
// on first save; a user without one has EMPTY_PREFERENCES. v2.0 (A22): where the person lives (home_country,
// home_region, home_city, time_zone, 0824), read by the prepare filters' location rule; this module is their only
// writer (01-data-model.md, "Who writes each new table").
// v3.0 D2: async on deps.db.

export interface PreferencesRow {
  experience_levels: string;
  job_types: string;
  work_arrangements: string;
  categories: string;
  locations: string;
  min_salary: number | null;
  phone: string;
  linkedin_url: string;
  location: string;
  portfolio_url: string;
  home_country: string | null;
  home_region: string | null;
  home_city: string | null;
  time_zone: string | null;
}

/** The autofill profile's address, as the location fallback reads it. */
export interface ProfileAddress {
  country: string | null;
  region: string;
  city: string;
}

/** A stored JSON list, keeping only allowed strings (a value retired from an enum quietly drops out). */
function readList<T extends string>(json: string, allowed?: readonly T[]): T[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is T => typeof item === 'string' && (!allowed || (allowed as readonly string[]).includes(item)),
  );
}

/**
 * The stored location as the contract allows it: a value that does not pass the checks (a prefill from an autofill
 * address the migration copied, a hand edit) reads as unset, so a page that saves it back is never refused for it.
 */
function readLocation(row: PreferencesRow): Pick<Preferences, 'homeCountry' | 'homeRegion' | 'homeCity' | 'timeZone'> {
  const country = row.home_country !== null && isCountryCode(row.home_country) ? row.home_country : null;
  const region = country !== null && row.home_region !== null && isRegionCode(country, row.home_region) ? row.home_region : null;
  const city = row.home_city?.trim() ? row.home_city.trim() : null;
  const zone = row.time_zone !== null ? canonicalTimeZone(row.time_zone) : null;
  return { homeCountry: country, homeRegion: region, homeCity: city, timeZone: zone };
}

/** The longest home city the column takes (0824's CHECK). */
const HOME_CITY_MAX = 100;

/**
 * v20 FIX-A (A22, INT open item): where the person lives, read from the autofill profile's address while the
 * preferences hold none (country, region and city all unset). 0824 copied the addresses of that day once; this reads
 * them at every read, so an address filled in later counts too (the location filter would otherwise pass every job for
 * them). The same rules as 0824: a region that is not a short code of the country ("Texas") is left for the person.
 * Nothing is written: Settings › Where you live shows the values, and saving them stores them.
 */
function locationFromAddress(address: ProfileAddress): Pick<Preferences, 'homeCountry' | 'homeRegion' | 'homeCity'> | null {
  const country = address.country !== null && isCountryCode(address.country) ? address.country : null;
  if (country === null) return null;
  const regionText = address.region.trim().toUpperCase();
  const region = regionText && isRegionCode(country, regionText) ? regionText : null;
  const cityText = address.city.trim();
  const city = cityText && cityText.length <= HOME_CITY_MAX ? cityText : null;
  return { homeCountry: country, homeRegion: region, homeCity: city };
}

/** The stored row as the contract reads it (EMPTY_PREFERENCES without one), before the address fallback. */
export function preferencesOfRow(row: PreferencesRow | undefined): Preferences {
  if (!row) return { ...EMPTY_PREFERENCES };
  return {
    experienceLevels: readList(row.experience_levels, EXPERIENCE_LEVELS),
    jobTypes: readList(row.job_types, EMPLOYMENT_TYPES),
    workArrangements: readList(row.work_arrangements, WORK_ARRANGEMENTS),
    categories: readList(row.categories),
    locations: readList(row.locations),
    minSalary: row.min_salary,
    phone: row.phone,
    linkedinUrl: row.linkedin_url,
    location: row.location,
    portfolioUrl: row.portfolio_url,
    ...readLocation(row),
  };
}

/** Whether the preferences hold no location, so the profile address is read (A22's read-time prefill). */
export function needsAddress(preferences: Preferences): boolean {
  return preferences.homeCountry == null && preferences.homeRegion == null && preferences.homeCity == null;
}

/** The location read, or the profile address's when the preferences hold none. */
export function withAddress(preferences: Preferences, address: ProfileAddress | null): Preferences {
  if (!address || !needsAddress(preferences)) return preferences;
  const fromAddress = locationFromAddress(address);
  return fromAddress ? { ...preferences, ...fromAddress } : preferences;
}

export const PREFERENCES_ROW_SQL = 'SELECT * FROM user_preferences WHERE user_id = ?';

export async function getPreferences(deps: Pick<AppDeps, 'db'>, userId: string): Promise<Preferences> {
  const preferences = preferencesOfRow(await deps.db.one<PreferencesRow>(PREFERENCES_ROW_SQL, [userId]));
  if (!needsAddress(preferences)) return preferences;
  const profile = await readAutofillProfile(deps, userId);
  return withAddress(preferences, profile.value.contact.address);
}

/** Trims every value and drops blank and repeated list entries, so the stored form is canonical. */
export function normalizePreferences(input: Preferences): Preferences {
  const list = <T extends string>(items: T[]) => [...new Set(items.map((item) => item.trim() as T).filter(Boolean))];
  return {
    experienceLevels: list(input.experienceLevels),
    jobTypes: list(input.jobTypes),
    workArrangements: list(input.workArrangements),
    categories: list(input.categories),
    locations: list(input.locations),
    minSalary: input.minSalary,
    phone: input.phone.trim(),
    linkedinUrl: input.linkedinUrl.trim(),
    location: input.location.trim(),
    portfolioUrl: input.portfolioUrl.trim(),
    // The shared schema has trimmed, upper-cased and checked them; undefined (left out) keeps the stored value.
    homeCountry: input.homeCountry,
    homeRegion: input.homeRegion,
    homeCity: input.homeCity,
    timeZone: input.timeZone,
  };
}

/** The save (an upsert of the person's row). The `keep*` flags keep a stored location field the body left out. */
export const SAVE_PREFERENCES_SQL = `INSERT INTO user_preferences(user_id, experience_levels, job_types, work_arrangements,
     categories, locations, min_salary, phone, linkedin_url, location, portfolio_url, home_country, home_region, home_city,
     time_zone, updated_at)
   VALUES (@userId, @experienceLevels, @jobTypes, @workArrangements, @categories, @locations, @minSalary, @phone,
     @linkedinUrl, @location, @portfolioUrl, @homeCountry, @homeRegion, @homeCity, @timeZone, @updatedAt)
   ON CONFLICT(user_id) DO UPDATE SET experience_levels = excluded.experience_levels,
     job_types = excluded.job_types, work_arrangements = excluded.work_arrangements,
     categories = excluded.categories, locations = excluded.locations, min_salary = excluded.min_salary,
     phone = excluded.phone, linkedin_url = excluded.linkedin_url, location = excluded.location,
     portfolio_url = excluded.portfolio_url,
     home_country = CASE WHEN @keepCountry THEN user_preferences.home_country ELSE excluded.home_country END,
     home_region = CASE WHEN @keepRegion THEN user_preferences.home_region ELSE excluded.home_region END,
     home_city = CASE WHEN @keepCity THEN user_preferences.home_city ELSE excluded.home_city END,
     time_zone = CASE WHEN @keepZone THEN user_preferences.time_zone ELSE excluded.time_zone END,
     updated_at = excluded.updated_at`;

/** The save's values; the `keep*` flags are booleans (the SQLite client binds them as 1/0). */
export function savePreferencesParams(userId: string, preferences: Preferences, updatedAt: string) {
  return {
    userId,
    experienceLevels: JSON.stringify(preferences.experienceLevels),
    jobTypes: JSON.stringify(preferences.jobTypes),
    workArrangements: JSON.stringify(preferences.workArrangements),
    categories: JSON.stringify(preferences.categories),
    locations: JSON.stringify(preferences.locations),
    minSalary: preferences.minSalary,
    phone: preferences.phone,
    linkedinUrl: preferences.linkedinUrl,
    location: preferences.location,
    portfolioUrl: preferences.portfolioUrl,
    homeCountry: preferences.homeCountry ?? null,
    homeRegion: preferences.homeRegion ?? null,
    homeCity: preferences.homeCity ?? null,
    timeZone: preferences.timeZone ?? null,
    keepCountry: preferences.homeCountry === undefined,
    keepRegion: preferences.homeRegion === undefined,
    keepCity: preferences.homeCity === undefined,
    keepZone: preferences.timeZone === undefined,
    updatedAt,
  };
}

/**
 * Saves the whole object. A location field left out (undefined) keeps its stored value, so a caller that does not know
 * the location fields (the demo seed, an older page) never clears them; null clears one.
 */
export async function savePreferences(deps: AppDeps, userId: string, preferences: Preferences): Promise<Preferences> {
  await deps.db.run(SAVE_PREFERENCES_SQL, savePreferencesParams(userId, preferences, nowIso(deps)));
  return getPreferences(deps, userId);
}
