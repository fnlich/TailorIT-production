import type { CoverLetterMode, PrepareResumeMode } from '@tailorit/shared/prepare';

// v2.0: the words of Settings › Prepare & Queue (docs/design/v2.0/08-ui.md). The resume modes' own labels are
// constants (LABEL_RESUME_MODE_*, A29/A30), read with usePublicConstants; these are the rest.

export const PREPARE_COPY = {
  title: 'Prepare & Queue',
  description: 'How a saved job is prepared before it joins your queue.',
  loadFailed: "These settings didn't load",
  tryAgain: 'Try again',

  resume: 'Resume',
  resumeHint: 'Letters and answers are written from this resume.',
  letters: 'Cover letters',
  saved: 'Saved',
  saveFailed: "The setting wasn't saved",

  askTitle: 'Ask before using AI',
  askHint: 'Confirm before Prepare & Queue uses AI.',
  /** v34 FIX-WEB (final review share M1): on a shared profile, the row is the person's own setting. */
  askOwnHint: 'Your own on every profile: confirm before Prepare & Queue uses your AI.',
  askOn: 'TailorIT asks before Prepare & Queue uses its AI',
  askOff: 'Prepare & Queue starts without asking',
} as const;

/** What each resume mode does, under its label (v32 COPY: a few words). */
export const RESUME_MODE_HINT: Record<PrepareResumeMode, string> = {
  default: 'Your default resume as it is. No AI.',
  similar: 'Your best match for each job. No AI.',
  tailor: 'AI tailors one per job; each counts as a resume.',
};

export const LETTER_MODE_LABEL: Record<CoverLetterMode, string> = {
  required: 'Only when the application requires it',
  always: 'Always',
};

export const LETTER_MODE_HINT: Record<CoverLetterMode, string | undefined> = {
  required: 'When the form or the posting asks for one',
  always: undefined,
};

export const FILTERS_COPY = {
  title: 'Prepare filters',
  note: 'unknown details never filter a job out.',
  // v2.0 fix (UX-7): what the filters do, first (Job preferences only rank Jobs). v32 COPY: the heading's "?".
  description: 'Prepare & Queue skips saved jobs that fail a filter;',
  locationType: 'Location type',
  anyHint: 'None picked: any.',
  jobType: 'Job type',
  industry: 'Industry',
  industryOnly: 'Only',
  industrySkip: 'Skip',
  industryModeLabel: 'Industry filter mode',
  locationMismatch: 'Location mismatch',
  locationMismatchHint: "Skip jobs that exclude where you live or your time zone (an office address doesn't count).",
  locationMissing: 'Add your location and time zone in Job preferences so this filter can work.',
  /** v32 COPY (E4): the passive state is a chip with a "?" (locationMissing), not a banner. */
  locationMissingChip: 'Location not set',
  locationMissingLink: 'Add them now',
  qualifications: 'Qualifications',
  qualificationsHint: 'Skip jobs needing a degree, years or citizenship your profile lacks.',
  /** v33 FIX-2: on a profile shared without Sensitive answers' Change (it checks citizenship). */
  qualificationsLocked: "It checks citizenship, so changing it needs Sensitive answers' Change.",
  certifications: 'Certifications',
  certificationsHint: 'Skip jobs needing a certification your profile lacks.',
  certificationsLink: 'Edit certifications',
  autoApply: 'Auto-apply support',
  autoApplyAll: 'All jobs',
  autoApplySupported: 'Only auto-apply supported',
  minPay: 'Minimum pay',
  minPayHint: 'Skips jobs that state lower pay, in dollars a year.',
  experience: 'Experience level',
  sponsorship: 'Visa sponsorship',
  sponsorshipSwitch: 'I need visa sponsorship',
  sponsorshipHint: "Skip jobs that say they don't sponsor.",
  clearance: 'Clearance',
  clearanceHint: "Skip jobs that require a security clearance you don't hold.",
  custom: 'Custom (AI)',
  customSwitch: 'Use a custom filter',
  customPrompt: 'Describe the jobs to skip or keep',
  customPlaceholder: 'For example: skip jobs at staffing agencies, and keep only roles that work with healthcare data.',
  customHint: 'AI judges each job against this, using your AI use.',
  previewChecking: 'Checking your saved jobs...',
  previewFailed: "The preview didn't load.",
  previewFix: 'Fix the highlighted fields to see the preview.',
  unsaved: 'You have unsaved filter changes',
  discard: 'Discard',
  save: 'Save filters',
  saving: 'Saving...',
  savedToast: 'Filters saved',
  saveFailed: "The filters weren't saved",
  onCount: (count: number) => (count === 0 ? 'No filters on' : count === 1 ? '1 filter on' : `${count} filters on`),
} as const;
