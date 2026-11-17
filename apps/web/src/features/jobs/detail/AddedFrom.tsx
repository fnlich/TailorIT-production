import { JOB_ADDED_FROM_LABEL, type JobAddedFrom } from '@tailorit/shared';

// The job page's "Added from LinkedIn" / "Added from the job page" chip (autofill API version 5): a job the person added
// from the text of a page they had open (POST /api/autofill/jobs/from-page), whose Apply opens the employer's link it
// was saved with. Nothing for any other job.

/** The chip, drawn as the panel's other neutral pills are; null when the job came from a board, an import or the seed. */
export function AddedFromChip({ addedFrom }: { addedFrom: JobAddedFrom | null }) {
  if (!addedFrom) return null;
  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-chip px-3 text-[13px] leading-none font-medium whitespace-nowrap text-foreground">
      <span data-added-from={addedFrom}>{JOB_ADDED_FROM_LABEL[addedFrom]}</span>
    </span>
  );
}
