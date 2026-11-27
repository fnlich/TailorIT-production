import {
  EMPLOYMENT_TYPE_LABEL,
  EMPLOYMENT_TYPES,
  SALARY_PERIODS,
  WORK_ARRANGEMENT_LABEL,
  WORK_ARRANGEMENTS,
  type EmploymentType,
  type SalaryPeriod,
  type WorkArrangement,
} from '@tailorit/shared/jobs';
import {
  JOB_EDIT_FIELD_LABEL,
  JOB_EDIT_FIELDS,
  JOB_EDIT_LIMITS,
  type AdminJobRead,
  type JobEditDuplicate,
  type JobEditField,
  type JobEditMark,
  type JobEditValues,
  type JobEditVisibility,
} from '@tailorit/shared/reviews';
import { JOB_VERIFY_REASON_ADMIN_TEXT } from '@tailorit/shared/jobs';
import { defaultT, type MessageRenderer } from '@/lib/messages';

// v38 REVEDIT (SP v38 PLAN.md E1-E6): Edit job's words and its form's model, pure so the tests read them without a page.
// The form edits a draft (text fields as typed); `changesOf` sends only the fields that differ from the job's values,
// and `draftProblems` says what to fix before Save (the API checks the same again: ingest's caps, Add job's link rules).

/** The editor's words (brief control copy: v3.2's rules). */
export const EDIT_COPY = {
  button: 'Edit job',
  title: 'Edit job',
  help: "Your changes stay over later reads of the posting until you use the posting's text again.",
  save: 'Save changes',
  saving: 'Saving...',
  cancel: 'Cancel',
  read: 'Read this link',
  reading: 'Reading...',
  restore: "Use the posting's text again",
  saved: 'Changes saved',
  nothing: 'Nothing to save: the job already says this.',
  loadError: "The job didn't load.",
  saveError: 'The changes were not saved',
  readError: "TailorIT couldn't read the link",
  restoreError: "The posting's text was not put back",
  duplicateTitle: 'TailorIT already has this job',
  openDuplicate: 'Open that job',
  linkHelp: 'TailorIT reads this link, and reads a changed link at once.',
  applyHelp: 'Leave empty when Apply opens the job link.',
  placesHelp: 'One place on each line, such as "Austin, TX" or "Remote".',
  notStated: 'Not stated',
  // v38 FIX-APP (REVIEW38-ux M4): the conflict's words name what changed elsewhere (changedSinceText).
  changedSince: 'This job changed since you opened it. Your changes are still here: check them, then save again.',
  // v38 FIX-APP (REVIEW38-ux L15): a link kept in its clean form (no ?utm_source=, ?token=, ?email=, ...).
  linkCleaned: 'TailorIT keeps the link without its tracking and private parameters.',
} as const;

/**
 * v38 FIX-APP (REVIEW38-ux M4): the conflict's notice: "This job changed since you opened it (Title). Your changes are
 * still here: check them, then save again." (the fields another save or a read changed, in the editor's order).
 */
export function changedSinceText(elsewhere: readonly JobEditField[]): string {
  if (elsewhere.length === 0) return EDIT_COPY.changedSince;
  const names = elsewhere.map((field) => JOB_EDIT_FIELD_LABEL[field]).join(', ');
  return EDIT_COPY.changedSince.replace('opened it.', `opened it (${names}).`);
}

/** Who sees the job now, as the editor's line says it. */
export const VISIBILITY_TEXT: Record<JobEditVisibility, string> = {
  public: 'Everyone sees this job: your changes show at once.',
  waiting: 'This job waits for an admin. Your changes publish when it is approved.',
  private: 'Only the person who added it sees this job. It stays theirs until it is approved.',
  closed: 'This job is closed.',
};

/** The form's values as typed. */
export interface JobEditDraft {
  link: string;
  applyUrl: string;
  title: string;
  company: string;
  descriptionHtml: string;
  /** One place per line. */
  places: string;
  workArrangement: WorkArrangement | '';
  employmentType: EmploymentType | '';
  salaryMin: string;
  salaryMax: string;
  currency: string;
  period: SalaryPeriod | '';
  /** YYYY-MM-DD, or ''. */
  postedAt: string;
}

const amountText = (value: number | null) => (value === null ? '' : String(value));

/** The draft of a job's values (what the form shows first). */
export function draftOf(values: JobEditValues): JobEditDraft {
  return {
    link: values.link,
    applyUrl: values.applyUrl ?? '',
    title: values.title,
    company: values.company,
    descriptionHtml: values.descriptionHtml,
    places: values.locations.join('\n'),
    workArrangement: values.workArrangement ?? '',
    employmentType: values.employmentType ?? '',
    salaryMin: amountText(values.salary?.min ?? null),
    salaryMax: amountText(values.salary?.max ?? null),
    currency: values.salary?.currency ?? 'USD',
    period: values.salary?.period ?? '',
    postedAt: values.postedAt ?? '',
  };
}

/** An amount as typed ("120,000", "$95k" is not one): a number, null when empty, NaN when it is no amount. */
export function amountOf(text: string): number | null {
  const tidy = text.replace(/[,\s]/g, '');
  if (tidy === '') return null;
  return /^\d+(\.\d+)?$/.test(tidy) ? Number(tidy) : Number.NaN;
}

/** The places as the job keeps them: one per line, trimmed, empty lines dropped. */
export const placesOf = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

/** An empty rich-text document ("<p></p>") is no description. */
const tidyHtml = (html: string) => (/^(<p>\s*<\/p>|\s)*$/.test(html) ? '' : html);

/** The draft as the job's values (a field that does not parse keeps the job's value: draftProblems names it). */
export function valuesOfDraft(draft: JobEditDraft, base: JobEditValues): JobEditValues {
  const min = amountOf(draft.salaryMin);
  const max = amountOf(draft.salaryMax);
  const salaryValid = !Number.isNaN(min) && !Number.isNaN(max);
  return {
    link: draft.link.trim(),
    applyUrl: draft.applyUrl.trim() === '' ? null : draft.applyUrl.trim(),
    title: draft.title.trim(),
    company: draft.company.trim(),
    descriptionHtml: tidyHtml(draft.descriptionHtml),
    locations: placesOf(draft.places),
    workArrangement: draft.workArrangement === '' ? null : draft.workArrangement,
    employmentType: draft.employmentType === '' ? null : draft.employmentType,
    salary: !salaryValid
      ? base.salary
      : min === null && max === null
        ? null
        : { min, max, currency: draft.currency.trim().toUpperCase() || 'USD', period: draft.period === '' ? null : draft.period },
    postedAt: draft.postedAt === '' ? null : draft.postedAt,
  };
}

/** A value's stable text (keys sorted), so equal values compare equal. */
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

/** Which value of JobEditValues a field holds. */
export const valueKeyOf = (field: JobEditField): keyof JobEditValues => (field === 'description' ? 'descriptionHtml' : field);

/** The fields of `next` that differ from `base`, in the editor's order. */
export function changedFields(base: JobEditValues, next: JobEditValues, ownApplyLink: boolean): JobEditField[] {
  return JOB_EDIT_FIELDS.filter((field) => {
    if (field === 'applyUrl' && !ownApplyLink) return false;
    const key = valueKeyOf(field);
    // The editor's description is what the rich-text field made of it: compared without its spaces between tags.
    if (field === 'description') return htmlKey(base.descriptionHtml) !== htmlKey(next.descriptionHtml);
    return stable(base[key]) !== stable(next[key]);
  });
}

const htmlKey = (html: string) => html.replace(/>\s+</g, '><').trim();

/** v38 FIX-APP (REVIEW38-ux M4): the draft's own text of each field (the salary is four inputs). */
const DRAFT_KEYS: Record<JobEditField, ReadonlyArray<keyof JobEditDraft>> = {
  link: ['link'],
  applyUrl: ['applyUrl'],
  title: ['title'],
  company: ['company'],
  description: ['descriptionHtml'],
  locations: ['places'],
  workArrangement: ['workArrangement'],
  employmentType: ['employmentType'],
  salary: ['salaryMin', 'salaryMax', 'currency', 'period'],
  postedAt: ['postedAt'],
};

/**
 * v38 FIX-APP (REVIEW38-ux M4): Save met a newer version (409): the newest values, with the fields the admin changed
 * put back on top as they typed them (nothing they typed is lost), and the fields that changed elsewhere (another
 * admin's save, a read of the posting) named. `base`: the version the admin opened; `newest`: the one now.
 */
export function rebaseDraft(
  base: JobEditValues,
  draft: JobEditDraft,
  newest: JobEditValues,
  ownApplyLink: boolean,
): { draft: JobEditDraft; elsewhere: JobEditField[]; kept: JobEditField[] } {
  const kept = changedFields(base, valuesOfDraft(draft, base), ownApplyLink);
  const elsewhere = changedFields(base, newest, ownApplyLink);
  const next: JobEditDraft = { ...draftOf(newest) };
  for (const field of kept) for (const key of DRAFT_KEYS[field]) (next as unknown as Record<string, string>)[key] = draft[key];
  return { draft: next, elsewhere, kept };
}

/** The changed values (PATCH's `changes`): only the fields that differ. */
export function changesOf(base: JobEditValues, next: JobEditValues, ownApplyLink: boolean): Partial<JobEditValues> {
  const changes: Partial<JobEditValues> = {};
  for (const field of changedFields(base, next, ownApplyLink)) {
    const key = valueKeyOf(field);
    (changes as Record<string, unknown>)[key] = next[key];
  }
  return changes;
}

/** What to fix before Save, by field (the API says the same again); the caps' words are the message constants (`t`). */
export function draftProblems(draft: JobEditDraft, t: MessageRenderer = defaultT): Partial<Record<JobEditField, string>> {
  const problems: Partial<Record<JobEditField, string>> = {};
  const link = (text: string) => /^https?:\/\/\S+\.\S+/i.test(text.trim()) && text.trim().length <= JOB_EDIT_LIMITS.link;
  if (!draft.link.trim()) problems.link = 'Enter the job link.';
  else if (!link(draft.link)) problems.link = 'Enter a link that starts with https://.';
  if (draft.applyUrl.trim() && !link(draft.applyUrl)) problems.applyUrl = 'Enter a link that starts with https://, or leave it empty.';
  if (!draft.title.trim()) problems.title = 'Enter the title.';
  else if (draft.title.trim().length > JOB_EDIT_LIMITS.title) problems.title = t('MSG_TEXT_TOO_LONG', { max: JOB_EDIT_LIMITS.title });
  if (!draft.company.trim()) problems.company = 'Enter the company.';
  else if (draft.company.trim().length > JOB_EDIT_LIMITS.company) problems.company = t('MSG_TEXT_TOO_LONG', { max: JOB_EDIT_LIMITS.company });
  if (draft.descriptionHtml.length > JOB_EDIT_LIMITS.descriptionSent) problems.description = 'This description is too long to keep.';
  const places = placesOf(draft.places);
  if (places.length > JOB_EDIT_LIMITS.places) problems.locations = t('MSG_LIST_TOO_LONG', { max: JOB_EDIT_LIMITS.places });
  else if (places.some((place) => place.length > JOB_EDIT_LIMITS.place)) problems.locations = t('MSG_TEXT_TOO_LONG', { max: JOB_EDIT_LIMITS.place });
  const min = amountOf(draft.salaryMin);
  const max = amountOf(draft.salaryMax);
  if (Number.isNaN(min) || Number.isNaN(max)) problems.salary = 'Enter amounts as numbers, such as 120000.';
  else if ((min ?? 0) > JOB_EDIT_LIMITS.salary || (max ?? 0) > JOB_EDIT_LIMITS.salary) problems.salary = 'Enter a smaller amount.';
  else if ((min !== null || max !== null) && !/^[A-Za-z]{3}$/.test(draft.currency.trim())) problems.salary = 'Use a three-letter currency code, such as USD.';
  if (draft.postedAt && !/^\d{4}-\d{2}-\d{2}$/.test(draft.postedAt)) problems.postedAt = 'Pick a date.';
  return problems;
}

/** The API's field errors (`changes.title`, `link`) by the editor's field. */
export function serverProblems(fields: Record<string, string> | undefined): Partial<Record<JobEditField, string>> {
  const problems: Partial<Record<JobEditField, string>> = {};
  for (const [path, message] of Object.entries(fields ?? {})) {
    const key = path.replace(/^changes\./, '').split('.')[0] ?? '';
    const field = (JOB_EDIT_FIELDS as readonly string[]).includes(key) ? (key as JobEditField) : key === 'descriptionHtml' ? 'description' : null;
    if (field) problems[field] ??= message;
  }
  return problems;
}

/** "Edited by an admin" lines: "Title, Description" (the fields an admin edited), or null. */
export function editedFieldsText(marks: readonly JobEditMark[]): string | null {
  return marks.length > 0 ? marks.map((mark) => JOB_EDIT_FIELD_LABEL[mark.field]).join(', ') : null;
}

/** A saved edit's toast body: "Title and Description changed." */
export function savedText(changed: readonly JobEditField[]): string {
  const names = changed.map((field) => JOB_EDIT_FIELD_LABEL[field]);
  if (names.length === 0) return EDIT_COPY.nothing;
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${list} changed.`;
}

/** The duplicate notice's line, and where "Open that job" goes (a held job opens in Review's New jobs). */
export function duplicateText(duplicate: JobEditDuplicate): { body: string; href: string } {
  const what = `${duplicate.title} at ${duplicate.companyName}`;
  if (duplicate.held) {
    return { body: `${what} waits in Review › New jobs. Nothing was saved.`, href: '/settings/admin?tab=review&lane=new_job' };
  }
  return { body: `${what}${duplicate.active ? '' : ' (closed)'} has this link. Nothing was saved.`, href: `/jobs?jobId=${duplicate.jobId}` };
}

/** What "Read this link" came to, for the editor's notice and the live region. */
export function readOutcomeText(read: Pick<AdminJobRead, 'outcome' | 'reason'>): { tone: 'success' | 'info' | 'warning'; title: string; body: string } {
  switch (read.outcome) {
    case 'open':
      return { tone: 'success', title: 'Read: the job is open', body: "The posting's text filled the fields you did not change. Yours stay." };
    case 'waiting':
      return { tone: 'success', title: 'Read: waiting for approval', body: 'It waits in Review › New jobs. Your changes stay.' };
    case 'closed':
      return { tone: 'info', title: 'The posting has closed', body: 'TailorIT closed the job and settled what waited on it in Review.' };
    case 'try_later':
      return { tone: 'warning', title: "The site didn't answer", body: 'Your text stays and the job stays in Review. Read it again later.' };
    case 'cant_read':
      return {
        tone: 'warning',
        title: "TailorIT can't read this link",
        body: `${read.reason ? `${JOB_VERIFY_REASON_ADMIN_TEXT[read.reason]} ` : ''}Your text stays and the job stays in Review.`,
      };
  }
}

/** A select's "Not stated" (the draft's ''), as a value the select can hold. */
export const UNSET = 'unset' as const;

/** The work modes and employment types, with "Not stated" first. */
export const WORK_MODE_OPTIONS = [
  { value: UNSET, label: EDIT_COPY.notStated },
  ...WORK_ARRANGEMENTS.map((value) => ({ value, label: WORK_ARRANGEMENT_LABEL[value] })),
];
export const EMPLOYMENT_OPTIONS = [
  { value: UNSET, label: EDIT_COPY.notStated },
  ...EMPLOYMENT_TYPES.map((value) => ({ value, label: EMPLOYMENT_TYPE_LABEL[value] })),
];
/** The salary's periods ("per year"). */
export const PERIOD_OPTIONS = [
  { value: UNSET, label: EDIT_COPY.notStated },
  ...SALARY_PERIODS.map((value) => ({ value, label: `Per ${value}` })),
];
