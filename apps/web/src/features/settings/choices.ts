import {
  EMPLOYMENT_TYPES,
  EXPERIENCE_LEVELS,
  EXPERIENCE_LEVEL_LABEL,
  WORK_ARRANGEMENTS,
  type EmploymentType,
} from '@tailorit/shared/jobs';
import { JOB_TYPE_CHIPS, LOCATION_TYPE_LABEL } from './prepare/filters';

// v2.0 fix (UX-7): Settings has two groups each of experience level, job type and location type. They do different
// jobs: Job preferences rank the roles on Jobs; the Prepare filters make Prepare skip a saved job. Each section
// says which in its description; both use one vocabulary, the filters' words (which the "Filtered: on-site" labels use
// too), and the same group names.

/** Job preferences' description: what they do, and what they don't (UX-7). v32 COPY: one sentence, the "?". */
export const JOB_PREFERENCES_DESCRIPTION = "Jobs ranks roles by these; they don't skip any job.";

export const CHOICE_GROUP_LABEL = {
  experience: 'Experience level',
  jobType: 'Job type',
  locationType: 'Location type',
} as const;

export const EXPERIENCE_CHOICES = EXPERIENCE_LEVELS.map((value) => ({ value, label: EXPERIENCE_LEVEL_LABEL[value] }));

export const LOCATION_TYPE_CHOICES = WORK_ARRANGEMENTS.map((value) => ({ value, label: LOCATION_TYPE_LABEL[value] }));

const isEmploymentType = (value: string): value is EmploymentType => (EMPLOYMENT_TYPES as readonly string[]).includes(value);

/** Job preferences' job types (the four Jobs knows), in the filters' order and words. */
export const PREFERENCE_JOB_TYPE_CHOICES: ReadonlyArray<{ value: EmploymentType; label: string }> = JOB_TYPE_CHIPS.flatMap((chip) =>
  isEmploymentType(chip.value) ? [{ value: chip.value, label: chip.label }] : [],
);
