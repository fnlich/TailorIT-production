import { defineTextPrompt } from '../types';
import { fieldLines } from './variants';

// v33 PROMPTS (F5): the FIELDS guide of the job_analysis prompt (its cached system text): what a posting's keywords
// are in each role family, so a nurse's posting is read for clinical skills and a warehouse's for its equipment. The
// message names the job's field when TailorIT knows it ("Field: Healthcare").

export const FIELDS_GUIDE = `FIELDS (the message's "Field:" line, when it has one, names the field TailorIT filed the job under from its
source or its title; it may be wrong, and the posting decides). Read a posting's terms as people in its field use
them: the skills, tools, equipment, procedures and standards listed for its field are keywords there. Never add a term
the posting does not use.
${fieldLines().join('\n')}`;

export const fieldsGuidePrompt = defineTextPrompt({
  area: 'roles',
  name: 'fields-guide',
  version: 1,
  description: "The job_analysis prompt's FIELDS guide: what a posting's keywords are in each role family.",
  text: () => FIELDS_GUIDE,
});
