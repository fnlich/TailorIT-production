import { JOB_ADDED_FROM_LABEL, type JobAddedFrom } from '@tailorit/shared';
import { Badge } from '@/components/ui/Badge';

// The job page's "Added from LinkedIn" / "Added from the job page" tag (autofill API version 5): a job the person added
// from the text of a page they had open (POST /api/autofill/jobs/from-page), whose Apply opens the employer's link it
// was saved with. Nothing for any other job.

/** The tag, drawn as the title's other tags are (the kit's outline Badge); null when the job came from a board, an import or the seed. */
export function AddedFromChip({ addedFrom }: { addedFrom: JobAddedFrom | null }) {
  if (!addedFrom) return null;
  return (
    <Badge tone="outline">
      <span data-added-from={addedFrom}>{JOB_ADDED_FROM_LABEL[addedFrom]}</span>
    </Badge>
  );
}
