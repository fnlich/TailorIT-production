import { normalizePermissions } from '@tailorit/shared/sharing';
import { TASK_KIND_PERMISSION } from '../../ai/queue';
import type { ActingSpec } from '../../core/feature';

// v33 SHARE-6 (PLAN F9; SP v33 PLAN-sharing.md §4 "Mixed routes"; SHARE-3's exact edit 2 and review R2; the coordinator's
// SPECS-W4): reading, following and cancelling an AI task on a shared profile. One mount policy, Documents' See (every
// preset has it, and Prepare's Change and Exports imply it); the router then reads each task as the request may
// see it (ai.getTaskFor / watchFor / cancelFor with taskViewerOf(req)): a task of the owner's that B pays for or of a
// document kind, and only with the kind's own box (TASK_KIND_PERMISSION: autofill kinds Autofill info's See, the job
// search the Job Tracker's, a custom filter or a job analysis Prepare's); any other is the usual 404. Only a task
// B pays for is cancelled. The extension's token never names a profile.

// v33 INT-1 (SHARE-6's open item): Documents' See alone was too narrow: a custom grant without it could start a task of
// another area (an AI job search with the Job Tracker's See, Settings' Edit with AI with Autofill info's) and never read
// it. The mount now takes any box some kind is read with (TASK_KIND_PERMISSION's: the Job Tracker's, Documents', Prepare's
// and Autofill info's See), and the router reads each task with its own kind's box (getTaskFor), answering a
// task the grant may not read exactly as an unknown one (404).

/** /api/ai/tasks: GET /:id, GET /:id/stream, DELETE /:id. */
export const AI_TASKS_ACTING: ActingSpec = { anyOf: normalizePermissions(Object.values(TASK_KIND_PERMISSION)) };
