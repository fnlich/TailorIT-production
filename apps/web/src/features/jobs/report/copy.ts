import { JobReportBodySchema, type JobReportReason } from '@tailorit/shared';
import { JOB_REVIEW_DETAILS_MAX } from '@tailorit/shared/reviews';

// v30 X1-WEB: the flag dialog's words and caps by reason (docs/design/part2/14-extension-reports.md §5.4). "The job is
// no longer open" files a closed report into Admin › Review's Closed links lane, beside the extension's reports, whose
// details hold at most JOB_REVIEW_DETAILS_MAX characters; the other reasons stay flags (the Flags lane) and keep the
// report body's own cap.

/** The details' cap of a flag that is not a closed report: JobReportBodySchema's own (read from the schema). */
export const FLAG_DETAILS_MAX: number = JobReportBodySchema.shape.details.unwrap().maxLength ?? JOB_REVIEW_DETAILS_MAX;

/** How many characters the details may hold for `reason` (none chosen yet: the flag's own cap). */
export function detailsMaxOf(reason: JobReportReason | null): number {
  return reason === 'inactive' ? JOB_REVIEW_DETAILS_MAX : FLAG_DETAILS_MAX;
}

/** The details' placeholder for `reason`. */
export function detailsPlaceholderOf(reason: JobReportReason | null): string {
  if (reason === 'inactive') return 'Where you saw that it closed, if you know';
  if (reason === 'company_info_wrong') return 'What is wrong about the company?';
  return 'Anything that helps us check it';
}

/** A line under the details for `reason`, or null. */
export function detailsHintOf(reason: JobReportReason | null): string | null {
  if (reason === 'inactive') return 'We check the posting before the job leaves the search.';
  if (reason === 'company_info_wrong') return 'An admin corrects the company for every job it has.';
  return null;
}

/** The thanks after a report, by its reason. */
export function reportThanksOf(reason: JobReportReason): string {
  return reason === 'inactive' ? 'We will check whether this job is still open.' : 'We will take a look at this job.';
}
