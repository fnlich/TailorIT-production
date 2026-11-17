import { isTimeZone } from '@tailorit/shared/constants';
import { CA_PROVINCES, COUNTRIES, US_STATES } from '@tailorit/shared/jobs';
import { z } from 'zod';
import { defaultTooLong, type TooLongText } from '../../lib/constants';

// v2.0 (A22; docs/design/v2.0/08-ui.md, "Settings › Job preferences: your location"): where the person lives and their
// time zone, for the location filter. Kept in user_preferences (0824: home_country, home_region, home_city, time_zone)
// and sent with the other preferences (PUT /api/me/preferences). Pure, so the tests read it without a page.
//
// v20 P8 → INT: the wire names below (homeCountry, homeRegion, homeCity, timeZone) are this package's reading of
// 01-data-model.md's columns; P6b adds them to PreferencesSchema. If P6b names them otherwise, change LOCATION_KEYS'
// users here only (read and write go through this file).

export interface LocationPreferences {
  /** ISO 3166-1 alpha-2 ("US"). */
  homeCountry: string | null;
  /** The subdivision code without its country ("TX", "ON"). */
  homeRegion: string | null;
  homeCity: string | null;
  /** An IANA time zone ("America/New_York"). */
  timeZone: string | null;
}

export const EMPTY_LOCATION: LocationPreferences = { homeCountry: null, homeRegion: null, homeCity: null, timeZone: null };

/** The longest city the column takes (0824's CHECK). */
export const CITY_MAX = 100;

const Nullable = z
  .string()
  .nullish()
  .transform((value) => (value && value.trim() ? value.trim() : null))
  .catch(null);

const LocationReadSchema = z.object({
  homeCountry: Nullable,
  homeRegion: Nullable,
  homeCity: Nullable,
  timeZone: Nullable,
});

/** The location fields of a GET /api/me/preferences answer (absent or malformed fields read as unset). */
export function readLocation(record: unknown): LocationPreferences {
  const parsed = LocationReadSchema.safeParse(record && typeof record === 'object' ? record : {});
  return parsed.success ? parsed.data : EMPTY_LOCATION;
}

export const LOCATION_COPY = {
  group: 'Where you live',
  helper: "The location filter compares a job's rules about where candidates must live with these. TailorIT never sends them to employers.",
  country: 'Country',
  countryPlaceholder: 'Choose a country',
  region: 'State or province',
  regionPlaceholder: 'Choose one',
  regionCodeHint: 'Its short code, such as NSW',
  city: 'City',
  timeZone: 'Time zone',
  timeZonePlaceholder: 'Choose a time zone',
  deviceZone: (zone: string) => `Use this device's time zone (${zone})`,
} as const;

export const LOCATION_ERRORS = {
  country: 'Choose a country from the list',
  region: 'Use the short code: letters and digits, at most 6',
  timeZone: 'Choose a time zone from the list',
} as const;

export type LocationErrors = Partial<Record<keyof LocationPreferences, string>>;

const byName = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label);

/** The countries the Combobox lists, by name (the shared table postings are read with). */
export const COUNTRY_CHOICES: readonly { value: string; label: string }[] = Object.entries(COUNTRIES)
  .map(([value, country]) => ({ value, label: country.name }))
  .sort(byName);

/** A country's name ("United States"), or its code when the table does not know it. */
export function countryName(code: string | null): string | null {
  if (!code) return null;
  return COUNTRY_CHOICES.find((choice) => choice.value === code)?.label ?? code;
}

/** The code of a name the Combobox gave back ("United States" → "US"); a two-letter code stays itself. */
export function countryCode(name: string | null): string | null {
  if (!name) return null;
  const found = COUNTRY_CHOICES.find((choice) => choice.label === name || choice.value === name.toUpperCase());
  return found?.value ?? null;
}

const SUBDIVISIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = { US: US_STATES, CA: CA_PROVINCES };

/** A country's states or provinces for a Select (US and Canada); null for others (a short code is typed). */
export function regionChoices(country: string | null): { value: string; label: string }[] | null {
  const table = country ? SUBDIVISIONS[country] : undefined;
  if (!table) return null;
  return Object.entries(table)
    .map(([value, label]) => ({ value, label }))
    .sort(byName);
}

/** Every IANA zone this browser knows, A to Z (Intl.supportedValuesOf), with `current` kept when it is not among them. */
export function timeZoneChoices(current: string | null): string[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = [];
  }
  const list = [...zones];
  if (current && !list.includes(current)) list.push(current);
  if (!list.includes('UTC')) list.push('UTC');
  return list.sort((a, b) => a.localeCompare(b));
}

/** This device's time zone (Intl), or null when the browser does not say. */
export function deviceTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && isTimeZone(zone) ? zone : null;
  } catch {
    return null;
  }
}

/** The fields as they are saved: trimmed, the region in capitals, a region the new country does not have dropped. */
export function cleanLocation(location: LocationPreferences): LocationPreferences {
  const country = location.homeCountry?.trim().toUpperCase() || null;
  let region = location.homeRegion?.trim().toUpperCase() || null;
  const choices = regionChoices(country);
  if (region && choices && !choices.some((choice) => choice.value === region)) region = null;
  if (!country) region = null;
  return {
    homeCountry: country,
    homeRegion: region,
    homeCity: location.homeCity?.trim() || null,
    timeZone: location.timeZone?.trim() || null,
  };
}

/**
 * What is wrong with the fields, per field (nothing: all fine). Every field may be left empty. A city past CITY_MAX
 * reads MSG_TEXT_TOO_LONG (`tooLong`: the page passes its `t`'s, v2.0 fix wave REQ-3).
 */
export function validateLocation(location: LocationPreferences, tooLong: TooLongText = defaultTooLong): LocationErrors {
  const errors: LocationErrors = {};
  if (location.homeCountry && !/^[A-Z]{2}$/.test(location.homeCountry)) errors.homeCountry = LOCATION_ERRORS.country;
  if (location.homeRegion && !/^[A-Z0-9]{1,6}$/.test(location.homeRegion)) errors.homeRegion = LOCATION_ERRORS.region;
  if (location.homeCity && location.homeCity.length > CITY_MAX) errors.homeCity = tooLong(CITY_MAX);
  if (location.timeZone && !isTimeZone(location.timeZone)) errors.timeZone = LOCATION_ERRORS.timeZone;
  return errors;
}
