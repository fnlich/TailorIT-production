import { defineTextPrompt } from '../types';

// v30 ST2: moved word for word from features/tailor/prompts/index.ts. The note the resume call's second try adds to
// its message (features/tailor/pipeline.ts).

/**
 * tailor_builder0's note on the second try of the resume call (its RETRY_NOTE), with "starting with {." changed to the
 * markers, as tailor-resume's own sentence is.
 */
export const RETRY_NOTE =
  'Your last reply was not the resume JSON. The profile above is all there is, and it is enough: write the resume from its ' +
  'titles, employers and dates and from the job. Never ask for more information. Reply with the JSON object only, between ' +
  'the markers.';

export const retryNotePrompt = defineTextPrompt({
  area: 'tailor',
  name: 'retry-note',
  version: 1,
  description: "The note tailor-resume's second try adds when the first reply was not the resume JSON.",
  text: () => RETRY_NOTE,
});
