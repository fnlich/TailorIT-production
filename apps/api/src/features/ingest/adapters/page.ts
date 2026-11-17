import { IngestError } from '../types';
import { defineAdapter } from './define';

// The job pages' source (autofill API version 5): the jobs POST /api/autofill/jobs/from-page added from the text a
// person saw on a page no ATS API reads (a LinkedIn job, an iCIMS, Taleo, SuccessFactors or Oracle posting, a
// company's careers page). TailorIT never reads such a page itself, so the source is never run, never checked by the
// daily liveness check and never closes its jobs. v30 ST4: its access is `file` (defineAdapter): like an upload, its
// text is given to TailorIT (by the extension), which reads no outside host for it.

export const pageAdapter = defineAdapter({
  kind: 'page',
  label: 'Job pages',
  access: 'file',
  hosts: [],
  fetch() {
    return Promise.reject(
      new IngestError(
        'The jobs added from job pages keep the text the person saw there: TailorIT never reads those pages, so this ' +
          'source cannot be run.',
      ),
    );
  },
});
