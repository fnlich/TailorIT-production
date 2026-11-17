import {
  ASIAN_SUBGROUPS,
  CLEARANCE_LEVELS,
  DEGREE_LEVELS,
  EXPECTED_SALARY_PERIODS,
  GENDER_IDENTITIES,
  LANGUAGE_PROFICIENCIES,
  PHONE_DEVICE_TYPES,
  POLYGRAPH_KINDS,
  RACE_CATEGORIES,
  REFERRAL_CATEGORIES,
  SEXUAL_ORIENTATIONS,
  WORK_ARRANGEMENTS,
  WORK_STATUSES,
  type AsianSubgroup,
  type ClearanceLevel,
  type DegreeLevel,
  type ExpectedSalaryPeriod,
  type GenderIdentity,
  type LanguageProficiency,
  type PhoneDeviceType,
  type PolygraphKind,
  type RaceCategory,
  type ReferralCategory,
  type SexualOrientation,
  type WorkStatus,
} from '@tailorit/shared/autofill';
import { CA_PROVINCES, COUNTRIES, COUNTRY_CURRENCY, US_STATES, WORK_ARRANGEMENT_LABEL } from '@tailorit/shared/jobs';

// The words the Profile tab shows for the contract's value lists (the work arrangements in Settings' words), and the
// place lists its pickers offer.

export const DEGREE_LEVEL_LABEL: Record<DegreeLevel, string> = {
  highSchool: 'High school',
  associate: 'Associate',
  bachelor: "Bachelor's",
  master: "Master's",
  doctorate: 'Doctorate',
  professional: 'Professional (MBA, JD, MD)',
  other: 'Other',
};

export const LANGUAGE_PROFICIENCY_LABEL: Record<LanguageProficiency, string> = {
  elementary: 'Elementary',
  'limited-working': 'Limited working',
  'professional-working': 'Professional working',
  'full-professional': 'Full professional',
  native: 'Native or bilingual',
};

export const RACE_LABEL: Record<RaceCategory, string> = {
  'american-indian-alaska-native': 'American Indian or Alaska Native',
  asian: 'Asian',
  'black-african-american': 'Black or African American',
  'middle-eastern-north-african': 'Middle Eastern or North African',
  'native-hawaiian-pacific-islander': 'Native Hawaiian or Other Pacific Islander',
  white: 'White',
};

export const GENDER_LABEL: Record<GenderIdentity, string> = {
  female: 'Female',
  male: 'Male',
  'non-binary': 'Non-binary',
  'self-describe': 'I describe myself',
};

export const WORK_STATUS_LABEL: Record<WorkStatus, string> = {
  citizen: 'Citizen',
  'permanent-resident': 'Permanent resident',
  'work-visa': 'Work visa',
  'student-visa': 'Student visa',
  other: 'Other',
};

export const SALARY_PERIOD_LABEL: Record<ExpectedSalaryPeriod, string> = {
  year: 'A year',
  month: 'A month',
  hour: 'An hour',
};

// The extension's snapshot round 2 (2026-11-07): the answers its forms asked for that the profile could not give.

export const PHONE_DEVICE_TYPE_LABEL: Record<PhoneDeviceType, string> = { mobile: 'Mobile', home: 'Home', work: 'Work' };

export const REFERRAL_CATEGORY_LABEL: Record<ReferralCategory, string> = {
  'job-board': 'A job board or job site',
  'company-website': "The company's website",
  'employee-referral': 'An employee referral',
  recruiter: 'A recruiter',
  'social-media': 'Social media',
  event: 'An event or job fair',
  other: 'Something else',
};

export const ASIAN_SUBGROUP_LABEL: Record<AsianSubgroup, string> = {
  'east-asian': 'East Asian',
  'south-asian': 'South Asian',
  'southeast-asian': 'Southeast Asian',
};

export const SEXUAL_ORIENTATION_LABEL: Record<SexualOrientation, string> = {
  asexual: 'Asexual',
  'bisexual-pansexual': 'Bisexual or pansexual',
  gay: 'Gay',
  heterosexual: 'Heterosexual',
  lesbian: 'Lesbian',
  queer: 'Queer',
  'self-describe': 'I describe myself',
};

export const CLEARANCE_LEVEL_LABEL: Record<ClearanceLevel, string> = {
  none: 'None',
  'public-trust': 'Public Trust',
  confidential: 'Confidential',
  secret: 'Secret',
  'top-secret': 'Top Secret',
  'ts-sci': 'Top Secret / SCI',
};

export const POLYGRAPH_LABEL: Record<PolygraphKind, string> = {
  none: 'No polygraph',
  ci: 'Counterintelligence polygraph',
  'full-scope': 'Full-scope polygraph',
};

export const PHONE_DEVICE_TYPE_OPTIONS = PHONE_DEVICE_TYPES.map((value) => ({ value, label: PHONE_DEVICE_TYPE_LABEL[value] }));
export const REFERRAL_CATEGORY_OPTIONS = REFERRAL_CATEGORIES.map((value) => ({ value, label: REFERRAL_CATEGORY_LABEL[value] }));
export const ASIAN_SUBGROUP_OPTIONS = ASIAN_SUBGROUPS.map((value) => ({ value, label: ASIAN_SUBGROUP_LABEL[value] }));
export const SEXUAL_ORIENTATION_OPTIONS = SEXUAL_ORIENTATIONS.map((value) => ({
  value,
  label: SEXUAL_ORIENTATION_LABEL[value],
}));
export const CLEARANCE_LEVEL_OPTIONS = CLEARANCE_LEVELS.map((value) => ({ value, label: CLEARANCE_LEVEL_LABEL[value] }));
export const POLYGRAPH_OPTIONS = POLYGRAPH_KINDS.map((value) => ({ value, label: POLYGRAPH_LABEL[value] }));

export const DEGREE_LEVEL_OPTIONS = DEGREE_LEVELS.map((value) => ({ value, label: DEGREE_LEVEL_LABEL[value] }));
export const LANGUAGE_PROFICIENCY_OPTIONS = LANGUAGE_PROFICIENCIES.map((value) => ({
  value,
  label: LANGUAGE_PROFICIENCY_LABEL[value],
}));
export const WORK_ARRANGEMENT_OPTIONS = WORK_ARRANGEMENTS.map((value) => ({ value, label: WORK_ARRANGEMENT_LABEL[value] }));
export const RACE_OPTIONS = RACE_CATEGORIES.map((value) => ({ value, label: RACE_LABEL[value] }));
export const GENDER_OPTIONS = GENDER_IDENTITIES.map((value) => ({ value, label: GENDER_LABEL[value] }));
export const WORK_STATUS_OPTIONS = WORK_STATUSES.map((value) => ({ value, label: WORK_STATUS_LABEL[value] }));
export const SALARY_PERIOD_OPTIONS = EXPECTED_SALARY_PERIODS.map((value) => ({ value, label: SALARY_PERIOD_LABEL[value] }));

const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label);

/** The countries the location parser knows (shared COUNTRIES), by name. */
export const COUNTRY_OPTIONS = Object.entries(COUNTRIES)
  .map(([value, country]) => ({ value, label: country.name }))
  .sort(byLabel);

const REGIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = { US: US_STATES, CA: CA_PROVINCES };

/** A country's states or provinces, by name, when the profile stores them as codes (US and CA); else null. */
export function regionOptions(country: string | null): { value: string; label: string }[] | null {
  const regions = country && Object.hasOwn(REGIONS, country) ? REGIONS[country] : undefined;
  if (!regions) return null;
  return Object.entries(regions)
    .map(([value, label]) => ({ value, label }))
    .sort(byLabel);
}

/** The currencies TailorIT knows a country by, A to Z. */
export const CURRENCY_OPTIONS = [...new Set(Object.values(COUNTRY_CURRENCY))]
  .sort()
  .map((value) => ({ value, label: value }));

/** `options` with `value` added (as itself) when it is set but not among them, so a stored value always shows. */
export function withCurrent<V extends string>(
  options: readonly { value: V; label: string }[],
  value: V | null,
  label: (value: V) => string = (current) => current,
): { value: V; label: string }[] {
  if (value === null || value === '' || options.some((option) => option.value === value)) return [...options];
  return [{ value, label: label(value) }, ...options];
}
