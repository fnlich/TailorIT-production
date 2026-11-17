import { z } from 'zod';
import { isTimeZone } from '../constants/day';
import { messageError } from '../constants/public/defaults';
import { IsoDateTime } from '../core/list';
import { EMPLOYMENT_TYPES, EXPERIENCE_LEVELS, WORK_ARRANGEMENTS } from '../jobs/enums';
import { CA_PROVINCES, US_STATES } from '../jobs/geo';

// Passwordless sign-in (free_tailor's flow): Google Identity Services button, or a six-digit code sent by email.
// Sessions are an httpOnly cookie only; the API never returns a bearer token.

export const ROLES = ['user', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const AccountSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
  role: z.enum(ROLES),
  defaultResumeId: z.string().nullable(),
  createdAt: IsoDateTime,
});
export type Account = z.infer<typeof AccountSchema>;

export const AuthOptionsSchema = z.object({
  google: z.object({ available: z.boolean(), clientId: z.string().nullable() }),
  email: z.object({
    available: z.boolean(),
    /** Development only: codes are printed by the API instead of emailed. */
    devCodesInConsole: z.boolean(),
  }),
  /** "Trouble signing in? Contact admin" opens a mailto to this address when set. */
  contactEmail: z.string().nullable(),
});
export type AuthOptions = z.infer<typeof AuthOptionsSchema>;

export const GoogleSignInBodySchema = z.object({ credential: z.string() });
export const EmailCodeRequestBodySchema = z.object({ email: z.string() });
export const EmailCodeVerifyBodySchema = z.object({ email: z.string(), code: z.string() });

export const EmailCodeRequestResponseSchema = z.object({
  sent: z.literal(true),
  email: z.string(),
  expiresInMinutes: z.number().int(),
  /** e.g. "A six-digit code is on its way to you@example.com. It expires in 10 minutes." */
  message: z.string(),
});
export type EmailCodeRequestResponse = z.infer<typeof EmailCodeRequestResponseSchema>;

export const SignInResponseSchema = z.object({ account: AccountSchema, created: z.boolean() });
export type SignInResponse = z.infer<typeof SignInResponseSchema>;

/** GET /api/auth/me always answers 200; a signed-out caller gets `{ account: null }`. */
export const MeResponseSchema = z.object({ account: AccountSchema.nullable() });
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const UpdateMeBodySchema = z.object({ name: z.string() });

// v2.0 (A22; docs/design/v2.0/01-data-model.md 0824, 06-filters-analysis.md "The person's facts"): where the person
// lives, for the prepare filters' location rule, which reads "<country>-<region>" and the zone's standard offset. Never
// sent to an employer or an AI.

/** The longest home city (user_preferences.home_city's CHECK). */
export const HOME_CITY_MAX = 100;
/** The longest region code without its country (user_preferences.home_region's CHECK): "TX", "ON", "NSW". */
export const HOME_REGION_MAX = 6;

/** ISO 3166-2:US's outlying areas, which US_STATES (a place-name table) does not list. */
const US_OUTLYING: readonly string[] = ['AS', 'GU', 'MP', 'UM', 'VI'];
/** Two-letter codes Intl names that are not one country. */
const NOT_A_COUNTRY = new Set(['ZZ', 'EU', 'EZ', 'UN', 'QO', 'UK']);
const REGION_SHAPE = new RegExp(`^[A-Z0-9]{1,${HOME_REGION_MAX}}$`);
let regionNames: Intl.DisplayNames | null | undefined;

/** An ISO 3166-1 alpha-2 country code, upper case ("US", "CA", "GB"; never "UK", "EU" or "ZZ"). */
export function isCountryCode(code: string): boolean {
  if (!/^[A-Z]{2}$/.test(code) || NOT_A_COUNTRY.has(code)) return false;
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
    } catch {
      regionNames = null;
    }
  }
  // Without Intl's region names (a runtime without ICU data) the shape is all that can be checked.
  return regionNames === null || regionNames.of(code) !== undefined;
}

/**
 * A state or province code without its country, upper case: one of US_STATES (and the outlying areas) for the US, one
 * of CA_PROVINCES for Canada, and 1-6 letters or digits elsewhere.
 */
export function isRegionCode(country: string, region: string): boolean {
  if (country === 'US') return Object.hasOwn(US_STATES, region) || US_OUTLYING.includes(region);
  if (country === 'CA') return Object.hasOwn(CA_PROVINCES, region);
  return REGION_SHAPE.test(region);
}

/** The zone's canonical spelling ("america/new_york" → "America/New_York"); null when it is not a time zone. */
export function canonicalTimeZone(name: string): string | null {
  if (!isTimeZone(name)) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** "" and blanks read as "not set" (null). */
const blankToNull = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? null : value);

const HomeCountrySchema = z.preprocess(
  blankToNull,
  z
    .string()
    .trim()
    .toUpperCase()
    .refine(isCountryCode, 'Choose a country by its two-letter code, such as US or CA')
    .nullable(),
);
/** Its fit with the country is checked by the API (isRegionCode): the country may be the stored one. */
const HomeRegionSchema = z.preprocess(
  blankToNull,
  z.string().trim().toUpperCase().regex(REGION_SHAPE, 'Use the state or province code, such as TX or ON').nullable(),
);
const HomeCitySchema = z.preprocess(
  blankToNull,
  z
    .string()
    .transform((city) => city.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim())
    .pipe(z.string().max(HOME_CITY_MAX, messageError('MSG_TEXT_TOO_LONG', { max: HOME_CITY_MAX })))
    .nullable(),
);
const TimeZoneSchema = z.preprocess(
  blankToNull,
  z
    .string()
    .trim()
    .refine((zone) => canonicalTimeZone(zone) !== null, 'Choose a time zone such as America/New_York')
    .transform((zone) => canonicalTimeZone(zone) ?? zone)
    .nullable(),
);

/** The location fields (GET always answers them, null when unset; a PUT that leaves one out keeps the stored one). */
export const HOME_LOCATION_FIELDS = ['homeCountry', 'homeRegion', 'homeCity', 'timeZone'] as const;
export type HomeLocationField = (typeof HOME_LOCATION_FIELDS)[number];

export const PreferencesSchema = z.object({
  experienceLevels: z.array(z.enum(EXPERIENCE_LEVELS)),
  jobTypes: z.array(z.enum(EMPLOYMENT_TYPES)),
  workArrangements: z.array(z.enum(WORK_ARRANGEMENTS)),
  categories: z.array(z.string()),
  locations: z.array(z.string()),
  minSalary: z.number().int().nonnegative().nullable(),
  // Contact details used for cover-letter profile variables when the resume lacks them.
  phone: z.string(),
  linkedinUrl: z.string(),
  location: z.string(),
  portfolioUrl: z.string(),
  // v2.0 (A22): where the person lives, for the location filter. ISO 3166-1 alpha-2 ("US"); the state or province
  // code without its country ("TX"); a city; an IANA time zone ("America/Los_Angeles"). Optional on a PUT: left out,
  // the stored value stays.
  homeCountry: HomeCountrySchema.optional(),
  homeRegion: HomeRegionSchema.optional(),
  homeCity: HomeCitySchema.optional(),
  timeZone: TimeZoneSchema.optional(),
});
export type Preferences = z.infer<typeof PreferencesSchema>;
export type PreferencesInput = z.input<typeof PreferencesSchema>;

export const EMPTY_PREFERENCES: Preferences = {
  experienceLevels: [],
  jobTypes: [],
  workArrangements: [],
  categories: [],
  locations: [],
  minSalary: null,
  phone: '',
  linkedinUrl: '',
  location: '',
  portfolioUrl: '',
  homeCountry: null,
  homeRegion: null,
  homeCity: null,
  timeZone: null,
};

export const SetDefaultResumeBodySchema = z.object({ resumeId: z.string().nullable() });

/** Display initials for the header avatar: "Dana Jack" -> "DJ"; falls back to the email's first letter. */
export function initialsOf(name: string, email: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${words[0]![0]}${words[words.length - 1]![0]}`.toUpperCase();
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (email.trim()[0] ?? '?').toUpperCase();
}
