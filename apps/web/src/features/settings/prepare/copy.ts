import type { CoverLetterMode, PrepareResumeMode } from '@tailorit/shared/prepare';

// v2.0: the words of Settings › Prepare & Queue (docs/design/v2.0/08-ui.md). The resume modes' own labels are
// constants (LABEL_RESUME_MODE_*, A29/A30), read with usePublicConstants; these are the rest.

export const PREPARE_COPY = {
  title: 'Prepare & Queue',
  description: 'How TailorIT prepares a saved job before it joins your auto-apply queue.',
  loadFailed: 'These settings could not be loaded',
  tryAgain: 'Try again',

  resume: 'Resume',
  resumeHint: 'Your cover letter and answers are written from the resume each application uses.',
  letters: 'Cover letters',
  saved: 'Saved',
  saveFailed: 'The setting could not be saved',

  askTitle: 'Ask before using AI',
  askHint: "Show a confirmation before Prepare & Queue uses TailorIT's AI.",
  askOn: 'TailorIT asks before Prepare & Queue uses its AI',
  askOff: 'Prepare & Queue starts without asking',
} as const;

/** What each resume mode does, under its label. */
export const RESUME_MODE_HINT: Record<PrepareResumeMode, string> = {
  default: 'Every application uses your default resume as it is. No AI is used for the resume.',
  similar: 'TailorIT picks your resume that best matches each job, without AI, or your default resume when none fits.',
  tailor: "TailorIT's AI tailors a new resume for each job. Each one counts toward your resumes.",
};

export const LETTER_MODE_LABEL: Record<CoverLetterMode, string> = {
  required: 'Only when the application requires it',
  always: 'Always',
};

export const LETTER_MODE_HINT: Record<CoverLetterMode, string | undefined> = {
  required: "When the job's form asks for one, or the posting says it's required",
  always: undefined,
};

export const FILTERS_COPY = {
  title: 'Prepare filters',
  note: 'Unknown details never filter a job out.',
  // v2.0 fix (UX-7): what the filters do, first (Job preferences only rank Jobs).
  description: 'Prepare & Queue skips the saved jobs that fail a filter: they are labelled and stay in your Saved jobs.',
  locationType: 'Location type',
  anyHint: 'None picked: any.',
  jobType: 'Job type',
  industry: 'Industry',
  industryOnly: 'Only',
  industrySkip: 'Skip',
  industryModeLabel: 'Industry filter mode',
  locationMismatch: 'Location mismatch',
  locationMismatchHint:
    "Skip jobs whose candidate rules exclude where you live or your time zone (for example 'TX or CA only', 'PST only'). An office address doesn't count.",
  locationMissing: 'Add your location and time zone in Job preferences so this filter can work.',
  locationMissingLink: 'Add them now',
  qualifications: 'Qualifications',
  qualificationsHint:
    'Skip jobs that require a higher degree, more years of experience, or a citizenship than your autofill profile shows.',
  certifications: 'Certifications',
  certificationsHint: "Skip jobs that require a certification your autofill profile doesn't list.",
  certificationsLink: 'Edit certifications',
  autoApply: 'Auto-apply support',
  autoApplyAll: 'All jobs',
  autoApplySupported: 'Only auto-apply supported',
  minPay: 'Minimum pay',
  minPayHint: 'Jobs that state lower pay are skipped. Dollars a year.',
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
  customHint: "TailorIT's AI judges each job against this, using your AI usage. Through MCP, your own AI judges it.",
  previewChecking: 'Checking your saved jobs...',
  previewFailed: 'The preview could not be read.',
  previewFix: 'Fix the highlighted fields to see the preview.',
  unsaved: 'You have unsaved filter changes',
  discard: 'Discard',
  save: 'Save filters',
  saving: 'Saving...',
  savedToast: 'Filters saved',
  saveFailed: 'The filters could not be saved',
  onCount: (count: number) => (count === 0 ? 'No filters on' : count === 1 ? '1 filter on' : `${count} filters on`),
} as const;
