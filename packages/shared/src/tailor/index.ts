import { z } from 'zod';
import {
  AUTOFILL_TAILOR_DEDUPE_HOURS,
  AUTOFILL_TAILOR_LIMITS,
  AutofillTailorAcceptedSchema,
  AutofillTailorRequestFields,
  AutofillTailorTaskSchema,
  refineTailorRequest,
} from '../autofill/tailor';

// v1.4 (work package D): the TailorIT web pages' side of tailoring, POST /api/tailor and GET /api/tailor/:taskId (the
// Jobs detail's "Tailor my resume" and the tracker's Documents tab). The shapes are the extension's
// (@tailorit/shared/autofill's tailor.ts), so both callers read one task view; the page may also name a tracker entry.

export {
  AUTOFILL_TAILOR_POLL_MS as TAILOR_POLL_MS,
  TAILOR_STEPS,
  TailorAtsReportSchema,
  TailorResultSchema,
  type TailorAtsReport,
  type TailorResult,
  type TailorStep,
} from '../autofill/tailor';

export const TAILOR_LIMITS = AUTOFILL_TAILOR_LIMITS;
export const TAILOR_DEDUPE_HOURS = AUTOFILL_TAILOR_DEDUPE_HOURS;

/**
 * POST /api/tailor: the extension's request, or a tracker entry instead of the job (`applicationId`: its job when it
 * has one, else its own title, company and text; the tailored documents are linked to that entry).
 */
export const TailorRequestSchema = AutofillTailorRequestFields.extend({
  applicationId: z.string().min(1).max(64).optional(),
}).superRefine((request, ctx) => {
  if (request.applicationId !== undefined) return;
  refineTailorRequest(request, ctx);
});
export type TailorRequest = z.infer<typeof TailorRequestSchema>;

/** POST /api/tailor's answer (202). */
export const TailorAcceptedSchema = AutofillTailorAcceptedSchema;
export type TailorAccepted = z.infer<typeof TailorAcceptedSchema>;

/** GET /api/tailor/:taskId. */
export const TailorTaskViewSchema = AutofillTailorTaskSchema;
export type TailorTaskView = z.infer<typeof TailorTaskViewSchema>;
