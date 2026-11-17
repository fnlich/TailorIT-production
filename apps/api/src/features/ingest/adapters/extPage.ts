import { IngestError } from '../types';
import { defineAdapter } from './define';

// v30 X1-API (docs/design/part2/14-extension-reports.md §5.3): the published page jobs' source (kind `ext_page`, "A page
// job an admin published"): the shared copies Admin › Review makes of a posting people saved from an employer's own
// page (features/job-reviews/decide.ts). TailorIT never reads those pages itself: the source is never run and never
// closes its jobs by a run (closed reports and the unverified sweep do, 14 §5.3 step 4). Like the job pages' source, its
// text was given to TailorIT, which reads no outside host for it.

export const extPageAdapter = defineAdapter({
  kind: 'ext_page',
  label: 'Published page jobs',
  access: 'file',
  hosts: [],
  fetch() {
    return Promise.reject(
      new IngestError(
        'The published page jobs keep the text people saw on the employer\'s page: TailorIT never reads those pages, so ' +
          'this source cannot be run.',
      ),
    );
  },
});
