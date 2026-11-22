import { PrepareFiltersSchema, type PrepareFilters, type PrepareSettingsBody } from '@tailorit/shared';

// v34 DIRKIT (PLAN G8): the sample a directory reviewer's account holds (reviewer.ts). The person is made up: the
// name, the employers, the school and the phone number (555-01xx, a range kept for fiction) belong to no one. The
// resume's email is the account's own address, so what TailorIT writes from it never carries anyone else's.

/** The made-up person, as the account and the resume name them. */
export const SAMPLE_PERSON = { name: 'Riley Sample', title: 'Software Engineer', phone: '+1 512 555 0142', location: 'Austin, TX' } as const;

/** The sample resume's title in Documents (a refresh finds the resume by it). */
export const SAMPLE_RESUME_TITLE = 'Sample resume (made-up person)';

/** The sample resume's document for an account whose address is `email`. */
export function sampleResumeDocument(email: string): Record<string, unknown> {
  return {
    name: SAMPLE_PERSON.name,
    title: SAMPLE_PERSON.title,
    contact: { email, phone: SAMPLE_PERSON.phone, location: SAMPLE_PERSON.location },
    summary: 'Software engineer with six years of web, data and internal tools work, from first sketch to running in production.',
    experience: [
      {
        title: 'Software Engineer',
        company: 'Example Analytics',
        startDate: '03/2021',
        endDate: 'Present',
        location: 'Remote',
        description: 'Builds the reporting product and the services behind it.',
        achievements: ['Cut the nightly report build from 40 to 12 minutes', 'Moved 3 services to a managed database with no downtime'],
        skills: ['TypeScript', 'PostgreSQL'],
      },
      {
        title: 'Junior Developer',
        company: 'Sample Outdoor Supply',
        startDate: '06/2019',
        endDate: '02/2021',
        location: 'Austin, TX',
        description: 'Worked on the online store and its order tools.',
        achievements: ['Rebuilt the order search, used by 40 support staff every day', 'Wrote the first automated tests for checkout'],
        skills: ['Python', 'React'],
      },
    ],
    education: [{ degree: 'BS Computer Science', institution: 'Example State University', startDate: '2015', endDate: '2019', location: 'Austin, TX' }],
    skills: ['TypeScript', 'Python', 'SQL', 'React', 'AWS'],
  };
}

/**
 * The prepare filters the reviewer finds on: two job types and the Custom filter, which their AI judges through
 * custom_filter_verdicts (and TailorIT's AI on a Prepare that TailorIT's AI makes).
 */
export const SAMPLE_FILTERS: PrepareFilters = PrepareFiltersSchema.parse({
  jobTypes: ['full_time', 'contract'],
  custom: { enabled: true, prompt: 'Keep jobs where most of the work is building or improving software, data or internal tools.' },
});

/** Prepare & Queue's settings: TailorIT's AI tailors the resume and writes a letter for every job. */
export const SAMPLE_PREPARE_SETTINGS = { resumeMode: 'tailor', letterMode: 'always' } as const satisfies PrepareSettingsBody;

/** The Job Tracker the reviewer finds: jobs at Saved, and jobs moved on (one of them to an interview). */
export const SAMPLE_SAVED_JOBS = 6;
export const SAMPLE_MOVED_JOBS = 2;
/**
 * Remote jobs among the Saved ones when the job lake has them (open, of a job type the sample filters keep), so "Prepare
 * my saved remote jobs" finds work (docs/directory/LISTING.md, Example prompts).
 */
export const SAMPLE_REMOTE_JOBS = 2;
/** Fewer open lake jobs than this and the command changes nothing (the reviewer would have nothing to work with). */
export const SAMPLE_JOBS_MIN = 3;
/** The days before today the sample's jobs were saved. */
export const SAMPLE_SAVED_DAYS_AGO = 2;
/**
 * The Applied and interview days, inside the current week on every run (each run dates them again), so "How many jobs
 * did I apply to this week?" and "Interviews this month" count them: a job at Applied was applied to today; the one at
 * an interview was applied to yesterday and reached the interview today. On a Monday, yesterday is last week: today's
 * still counts.
 */
export const SAMPLE_APPLIED_DAYS_AGO = 0;
export const SAMPLE_INTERVIEW_APPLIED_DAYS_AGO = 1;
export const SAMPLE_INTERVIEW_DAYS_AGO = 0;
