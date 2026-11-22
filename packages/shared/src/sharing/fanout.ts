import { z } from 'zod';
import { AutofillAgentSettingsSchema } from '../autofill/agent';
import { PUBLIC_CONSTANT_SPECS } from '../constants/public/specs';
import { ERROR_CODES } from '../core/errors';
import { IsoDate } from '../core/list';
import { PrepareFiltersSchema, type PrepareFilters } from '../filters/schema';
import { AddJobBodySchema, AddJobResultSchema } from '../jobs/add';
import { SAVE_BATCH_CEILING, SaveAllPreviewSchema, SaveAllResponseSchema, SavedJobRefSchema } from '../jobs/dto';
import { PREPARE_OWNER_ONLY_SETTINGS, PrepareSettingsBodySchema, PrepareSettingsSchema, PrepareStartResponseSchema } from '../prepare/index';
import { ApplicationStatusSchema } from '../tracker/statuses';
import { ProfileChoiceSchema, ProfileKeySchema } from './profile';

// v34 FANOUT (PLAN G1, G2, G3; SP v34 REQUEST.md part 1): one action on several profiles at once. The person working on
// profiles shared with them (A, the grantee in v3.4's letters) saves jobs, copies saved jobs, moves, archives and
// Prepares cards, and changes the Prepare filters and settings on their own profile and every shared profile in ONE
// request to a route under /api/profiles (acting policy `self`: the request's X-TailorIT-Profile header is ignored, and
// `'me'` is ALWAYS the signed-in person, never the tab's profile: a tab working on Ana's profile names Ana's key). The
// server checks each target itself (a live grant with the box the action needs, read again just before that target's
// work), runs the single-profile service once per target (the target's owner is whose data; A acts, and pays where
// anything is charged), counts the call in each grant's activity when it changed something, and answers per profile:
//
//   { results: [{ profile: 'me' | key, name, ok: true, ...fields }
//             | { profile, name, ok: false, refused: code, message }],
//     left: [{ profile: key, name }] }
//
// A target A may not use for the action (a key that is unknown, someone else's, ended, or without the box; or a share
// that ends or loses the box before its turn) is refused with exactly the same answer whatever the case:
// `refused: 'profile_ended'`, MSG_FANOUT_PROFILE_UNUSABLE's words, `name: ''` (nothing says why). A usable profile whose
// own service refused (Save all already running there, the AI budget, the resume limit, its own check) answers that
// refusal's code and words with the owner's name. Targets: `'me'` and profile keys, or `'all'` = me + every live share
// whose boxes allow the action; `left` names (for `'all'`) the live shares left out because their boxes do not allow it
// (A sees every share's boxes on the Profiles page already: nothing new). A list holds at most
// 1 + SHARING_PROFILES_PER_GRANTEE profiles after repeats are dropped (11 at the default); `'all'` is never refused for
// its size. Results come A's own first, then in the order asked ('all': oldest share first).
//
// Routes (apps/api/src/features/sharing/fanout/router.ts; each `self`, each with a per-minute limit of A's):
//   POST  /api/profiles/jobs/save           FanoutSaveJobsBody    → FanoutSaveJobsAnswer        (tracker:edit each)
//   GET   /api/profiles/jobs/save-all/preview?targets=&search=  → FanoutSaveAllPreviewAnswer   (tracker:edit each, the
//                                                                   save's own box; the others in `left`)
//   POST  /api/profiles/jobs/save-all       FanoutSaveAllBody     → FanoutSaveAllAnswer         (tracker:edit each; one of
//                                                                   A's SAVE_ALL_RUNS_PER_HOUR when a profile ran)
//   POST  /api/profiles/jobs/add            FanoutAddJobBody      → FanoutAddJobAnswer          (tracker:edit each; one of
//                                                                   A's JOB_ADDS_PER_HOUR per link when a profile is usable)
//   GET   /api/profiles/jobs/saved-on?jobIds=1,2  FanoutSavedOnQuery → FanoutSavedOn          (me + tracker:view shares)
//   POST  /api/profiles/applications/copy   FanoutCopySavedBody   → FanoutCopySavedAnswer       (tracker:view on each
//                                                                   source, tracker:edit each target)
//   POST  /api/profiles/applications/bulk   FanoutBulkBody        → FanoutBulkAnswer            (each item's own profile:
//                                                                   tracker:edit, or prepare:run for `prepare`)
//   PATCH /api/profiles/prepare/filters     FanoutFiltersBody     → FanoutFiltersAnswer         (settings:edit each;
//                                                                   eligibility switches also sensitive:edit, else kept)
//   PATCH /api/profiles/prepare/settings    FanoutPrepareSettingsBody → FanoutPrepareSettingsAnswer (settings:edit each)
//   PATCH /api/profiles/auto-apply/rule     FanoutAutoSaveRuleBody → FanoutAutoSaveRuleAnswer   (settings:edit each)
//   GET   /api/profiles/settings?targets=&parts=  → FanoutSettingsSummary (per profile what its boxes let A see)
// And the PATCH form of the single-profile routes (the web's forms send only the fields changed; the fan-out applies
// the same merge to each target):
//   PATCH /api/prepare/filters              PrepareFiltersPatchBody → PrepareFiltersPatchResponse (settings:edit)
//   PATCH /api/prepare/settings             PrepareSettingsBody     → PrepareSettings             (settings:edit)
//   PATCH /api/autofill/agent/settings      AutoSaveRulePatch       → AutofillAgentSettings       (settings:edit)

// The targets ----------------------------------------------------------------------------------------------------------

/** Every profile the person may use for the action: their own and each live share whose boxes allow it. */
export const FANOUT_ALL = 'all';
/**
 * The most entries a target list may hold: A's own and SHARING_PROFILES_PER_GRANTEE's own bound (a technical ceiling);
 * the server checks 1 + the resolved constant once repeats are dropped (11 at the default).
 */
export const FANOUT_TARGETS_CEILING = 1 + PUBLIC_CONSTANT_SPECS.SHARING_PROFILES_PER_GRANTEE.max;
/** `'all'`, or a list of `'me'` and profile keys (repeats are dropped). */
export const FanoutTargetsSchema = z.union([z.literal(FANOUT_ALL), z.array(ProfileChoiceSchema).min(1).max(FANOUT_TARGETS_CEILING)]);
export type FanoutTargets = z.infer<typeof FanoutTargetsSchema>;

/** `1,2,3`, a repeated key, or both, as one list (anything else is left for the schema to refuse). */
const listParam = (value: unknown): unknown =>
  typeof value === 'string'
    ? value.split(',').filter((part) => part.trim() !== '')
    : Array.isArray(value)
      ? value.flatMap((part: unknown) => {
          const parts = listParam(part);
          return Array.isArray(parts) ? parts : [parts];
        })
      : value;

/** The targets in a query string: `targets=all`, or `targets=me,pAbc...` (or the key repeated). */
export const FanoutTargetsQuerySchema = z.preprocess(
  (value) => (value === FANOUT_ALL || (Array.isArray(value) && value.length === 1 && value[0] === FANOUT_ALL) ? FANOUT_ALL : listParam(value)),
  FanoutTargetsSchema,
);

// The answers ----------------------------------------------------------------------------------------------------------

/** A profile nothing was done on: why (an ErrorCode) and the words of that refusal. */
export const FanoutRefusedSchema = z.object({
  profile: ProfileChoiceSchema,
  /** The owner's name; '' for a profile that may not be used for the action (never named). */
  name: z.string(),
  ok: z.literal(false),
  refused: z.enum(ERROR_CODES),
  message: z.string(),
});
export type FanoutRefused = z.infer<typeof FanoutRefusedSchema>;

/** A live share `'all'` left out: its boxes do not allow the action (no reason given). */
export const FanoutLeftSchema = z.object({ profile: ProfileKeySchema, name: z.string() });
export type FanoutLeft = z.infer<typeof FanoutLeftSchema>;

/** One profile's result: `ok: true` with the action's own fields, or a refusal. */
function fanoutResult<T extends z.ZodRawShape>(fields: T) {
  return z.discriminatedUnion('ok', [
    z.object({
      profile: ProfileChoiceSchema,
      /** The owner's name (the person's own on `me`). */
      name: z.string(),
      ok: z.literal(true),
      ...fields,
    }),
    FanoutRefusedSchema,
  ]);
}

/** A fan-out's answer: each profile's result, and the shares `'all'` left out. */
function fanoutAnswer<T extends z.ZodTypeAny>(result: T) {
  return z.object({ results: z.array(result), left: z.array(FanoutLeftSchema) });
}

// Save jobs to profiles ------------------------------------------------------------------------------------------------

/** POST /api/profiles/jobs/save: these jobs saved at Saved on every target (at most SAVE_BATCH_MAX). */
export const FanoutSaveJobsBodySchema = z
  .object({
    targets: FanoutTargetsSchema,
    jobIds: z.array(z.number().int().positive()).min(1).max(SAVE_BATCH_CEILING),
    /** The browser's day (default today, UTC), as Save all's. */
    occurredOn: IsoDate.optional(),
  })
  .strict();
export type FanoutSaveJobsBody = z.infer<typeof FanoutSaveJobsBodySchema>;

/**
 * What a save did on one profile (each target picks its own best resume, as a Save there does). Each job asked counts
 * once, in one of saved, restored, alreadyTracked, notFound, notReached.
 */
export const FanoutSavedFields = {
  /** New Saved entries. */
  saved: z.number().int().nonnegative(),
  /** Entries un-saved earlier (archived while only Saved) brought back. */
  restored: z.number().int().nonnegative(),
  /** Jobs this profile tracks already (Saved, Applied or later): left as they are. */
  alreadyTracked: z.number().int().nonnegative(),
  /** Jobs this profile does not see (another person's own job, a job held for review that only others track, gone). */
  notFound: z.number().int().nonnegative(),
  notFoundIds: z.array(z.number().int().positive()),
  /** Jobs the save did not reach there (it stopped part-way: `incomplete`); try them again. */
  notReached: z.number().int().nonnegative(),
  /** What this request saved there (Undo: the bulk's `archive` with `onlySaved` over these application ids). */
  items: z.array(SavedJobRefSchema),
  /** Saved jobs whose best resume is still being chosen there. */
  pendingMatches: z.number().int().nonnegative(),
  /** The save stopped part-way there; `items` is what it saved. */
  incomplete: z.boolean(),
};
export const FanoutSaveJobsResultSchema = fanoutResult(FanoutSavedFields);
export type FanoutSaveJobsResult = z.infer<typeof FanoutSaveJobsResultSchema>;
export const FanoutSaveJobsAnswerSchema = fanoutAnswer(FanoutSaveJobsResultSchema);
export type FanoutSaveJobsAnswer = z.infer<typeof FanoutSaveJobsAnswerSchema>;

// Save all to profiles -------------------------------------------------------------------------------------------------

/** The longest list query string Save all to profiles takes (a technical cap; the Jobs page's URLs are far shorter). */
export const FANOUT_SEARCH_MAX_CHARS = 4_000;

/**
 * POST /api/profiles/jobs/save-all: Save all's current search on every target. `search` is the Jobs list's query string
 * as GET /api/jobs reads it (a cursor is ignored); each target's OWN list of it is saved there (that owner's jobs, marks
 * and tracker), at most SAVE_BATCH_MAX per profile (unlike Select → Save to, which saves exactly the jobs chosen). The
 * request is one of A's SAVE_ALL_RUNS_PER_HOUR when at least one profile ran.
 */
export const FanoutSaveAllBodySchema = z
  .object({
    targets: FanoutTargetsSchema,
    search: z.string().max(FANOUT_SEARCH_MAX_CHARS),
    occurredOn: IsoDate.optional(),
  })
  .strict();
export type FanoutSaveAllBody = z.infer<typeof FanoutSaveAllBodySchema>;
export const FanoutSaveAllResultSchema = fanoutResult(SaveAllResponseSchema.shape);
export type FanoutSaveAllResult = z.infer<typeof FanoutSaveAllResultSchema>;
export const FanoutSaveAllAnswerSchema = fanoutAnswer(FanoutSaveAllResultSchema);
export type FanoutSaveAllAnswer = z.infer<typeof FanoutSaveAllAnswerSchema>;

/** GET /api/profiles/jobs/save-all/preview?targets=...&search=...: the confirm's numbers per profile. */
export const FanoutSaveAllPreviewQuerySchema = z.object({
  targets: FanoutTargetsQuerySchema,
  search: z.string().max(FANOUT_SEARCH_MAX_CHARS).default(''),
});
export type FanoutSaveAllPreviewQuery = z.infer<typeof FanoutSaveAllPreviewQuerySchema>;
export const FanoutSaveAllPreviewResultSchema = fanoutResult(SaveAllPreviewSchema.shape);
export type FanoutSaveAllPreviewResult = z.infer<typeof FanoutSaveAllPreviewResultSchema>;
export const FanoutSaveAllPreviewAnswerSchema = fanoutAnswer(FanoutSaveAllPreviewResultSchema);
export type FanoutSaveAllPreviewAnswer = z.infer<typeof FanoutSaveAllPreviewAnswerSchema>;

// Add by link to profiles ----------------------------------------------------------------------------------------------

/**
 * POST /api/profiles/jobs/add: Add job's link on every target. The add runs on each (a job TailorIT reads once is
 * linked on the next ones; a link it cannot read is read once per request, and becomes each owner's own job from
 * `details`); it takes one of A's JOB_ADDS_PER_HOUR for the link when at least one target is usable.
 */
export const FanoutAddJobBodySchema = AddJobBodySchema.extend({ targets: FanoutTargetsSchema }).strict();
export type FanoutAddJobBody = z.infer<typeof FanoutAddJobBodySchema>;
/** Each profile's add, as POST /api/jobs/add answers it (`message`: what happened there, in words). */
export const FanoutAddJobResultSchema = fanoutResult(AddJobResultSchema.shape);
export type FanoutAddJobResult = z.infer<typeof FanoutAddJobResultSchema>;
export const FanoutAddJobAnswerSchema = fanoutAnswer(FanoutAddJobResultSchema);
export type FanoutAddJobAnswer = z.infer<typeof FanoutAddJobAnswerSchema>;

// Copy saved jobs ------------------------------------------------------------------------------------------------------

/** One Tracker entry of one profile (the All profiles view's selection; the bulk's item shape). */
export const FanoutItemSchema = z.object({ profile: ProfileChoiceSchema, applicationId: z.string().min(1).max(64) }).strict();
export type FanoutItem = z.infer<typeof FanoutItemSchema>;

/**
 * POST /api/profiles/applications/copy: Tracker entries of one or several profiles (each source needs its Job
 * Tracker's See) copied to the targets: each entry's job saved there at Saved. Only the job is copied: never the notes,
 * the status history, the documents or the resume (each target picks its own). At most SAVE_BATCH_MAX entries.
 */
export const FanoutCopySavedBodySchema = z
  .object({
    items: z.array(FanoutItemSchema).min(1).max(SAVE_BATCH_CEILING),
    targets: FanoutTargetsSchema,
    occurredOn: IsoDate.optional(),
  })
  .strict();
export type FanoutCopySavedBody = z.infer<typeof FanoutCopySavedBodySchema>;
/** Each source profile's read: its entries found, the distinct jobs they name, those without a job, and unknown ids. */
export const FanoutCopySourceSchema = fanoutResult({
  found: z.number().int().nonnegative(),
  jobs: z.number().int().nonnegative(),
  /** Entries added by hand without a job (nothing to copy). */
  noJob: z.number().int().nonnegative(),
  /** Ids that are no entry of this profile. */
  notFound: z.number().int().nonnegative(),
});
export type FanoutCopySource = z.infer<typeof FanoutCopySourceSchema>;
/** The sources (a source A may not read is refused there, as a target is), then each target's save of every job. */
export const FanoutCopySavedAnswerSchema = fanoutAnswer(FanoutSaveJobsResultSchema).extend({ sources: z.array(FanoutCopySourceSchema) });
export type FanoutCopySavedAnswer = z.infer<typeof FanoutCopySavedAnswerSchema>;

// Where a job is saved -------------------------------------------------------------------------------------------------

/** The most jobs one "where is it saved" read names (a Jobs page, the Tracker's page). */
export const FANOUT_SAVED_ON_MAX = 100;

/** GET /api/profiles/jobs/saved-on?jobIds=1,2,3 (or the key repeated). */
export const FanoutSavedOnQuerySchema = z.object({
  jobIds: z.preprocess(listParam, z.array(z.coerce.number().int().positive()).min(1).max(FANOUT_SAVED_ON_MAX)),
});
export type FanoutSavedOnQuery = z.infer<typeof FanoutSavedOnQuerySchema>;

/**
 * Which profiles have each job in their Job Tracker (an active entry, at any status): the person's own and every live
 * share with the Job Tracker's See (`profiles`, A's own first). The Jobs list, the job details and the Tracker show
 * "Saved on You · Ana" from it.
 */
export const FanoutSavedOnSchema = z.object({
  profiles: z.array(z.object({ profile: ProfileChoiceSchema, name: z.string() })),
  jobs: z.array(
    z.object({
      jobId: z.number().int().positive(),
      savedOn: z.array(z.object({ profile: ProfileChoiceSchema, applicationId: z.string(), status: ApplicationStatusSchema })),
    }),
  ),
});
export type FanoutSavedOn = z.infer<typeof FanoutSavedOnSchema>;

// Work on cards of every profile ---------------------------------------------------------------------------------------

/** The Tracker's All profiles view's bulk actions: never delete (a person who was shared a profile archives). */
export const FANOUT_BULK_ACTIONS = ['status', 'archive', 'unarchive', 'prepare'] as const;
export type FanoutBulkAction = (typeof FANOUT_BULK_ACTIONS)[number];
/** The most cards one request names (the Tracker's own bulk cap). */
export const FANOUT_BULK_ITEMS_MAX = 500;

/**
 * POST /api/profiles/applications/bulk: each item on its own profile, with that profile's box (`tracker:edit`; for
 * `prepare`, Prepare & queue's Change `prepare:run`, at most PREPARE_BATCH_MAX per profile). `status` takes `status`
 * (and `occurredOn`); `archive` takes `onlySaved` (an Undo of a Save to: entries moved past Saved are left alone).
 * Prepare & Queue keeps every rule of a Prepare on a shared profile: A pays, the owner's last queue and resume places
 * are kept, and what A prepares waits for the owner's OK unless the share has Apply without my OK.
 */
export const FanoutBulkBodySchema = z
  .object({
    action: z.enum(FANOUT_BULK_ACTIONS),
    status: ApplicationStatusSchema.optional(),
    occurredOn: IsoDate.optional(),
    onlySaved: z.boolean().optional(),
    items: z.array(FanoutItemSchema).min(1).max(FANOUT_BULK_ITEMS_MAX),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.action === 'status' && body.status === undefined) ctx.addIssue({ code: 'custom', path: ['status'], message: 'Choose a status' });
    if (body.action !== 'status' && body.status !== undefined) ctx.addIssue({ code: 'custom', path: ['status'], message: 'Only a move takes a status' });
    if (body.onlySaved && body.action !== 'archive') {
      ctx.addIssue({ code: 'custom', path: ['onlySaved'], message: 'Only archiving can be limited to Saved jobs' });
    }
  });
export type FanoutBulkBody = z.infer<typeof FanoutBulkBodySchema>;
export const FanoutBulkResultSchema = fanoutResult({
  /** Cards changed there (a move, an archive, a restore); for `prepare`, the jobs started or queued. */
  affected: z.number().int().nonnegative(),
  /** `prepare` only: each card's outcome, as POST /api/prepare answers it. */
  outcomes: PrepareStartResponseSchema.shape.results.optional(),
});
export type FanoutBulkResult = z.infer<typeof FanoutBulkResultSchema>;
export const FanoutBulkAnswerSchema = fanoutAnswer(FanoutBulkResultSchema);
export type FanoutBulkAnswer = z.infer<typeof FanoutBulkAnswerSchema>;

// The Prepare filters, partly ------------------------------------------------------------------------------------------

const FILTER_SHAPE = PrepareFiltersSchema.shape;

/**
 * Some of the Prepare filters (PATCH): only the fields given change; each field replaces the saved one whole (a list,
 * `industries`; `null` clears `industries` or `minSalaryUsd`), but `custom`, whose `enabled` and `prompt` change apart.
 * A field given with the value already saved is still applied (sent on purpose: "set every profile to this").
 * Unknown fields are refused: the location filter is the `locationMismatch` switch alone, compared with each owner's
 * own Where you live; no place is ever sent.
 */
export const PrepareFiltersPatchSchema = z
  .object({
    locationTypes: FILTER_SHAPE.locationTypes.unwrap().optional(),
    jobTypes: FILTER_SHAPE.jobTypes.unwrap().optional(),
    industries: FILTER_SHAPE.industries.unwrap().optional(),
    locationMismatch: FILTER_SHAPE.locationMismatch.unwrap().optional(),
    qualificationMismatch: FILTER_SHAPE.qualificationMismatch.unwrap().optional(),
    certificationMismatch: FILTER_SHAPE.certificationMismatch.unwrap().optional(),
    autoApplySupport: FILTER_SHAPE.autoApplySupport.unwrap().optional(),
    minSalaryUsd: FILTER_SHAPE.minSalaryUsd.unwrap().optional(),
    experienceLevels: FILTER_SHAPE.experienceLevels.unwrap().optional(),
    noSponsorship: FILTER_SHAPE.noSponsorship.unwrap().optional(),
    clearanceMismatch: FILTER_SHAPE.clearanceMismatch.unwrap().optional(),
    custom: FILTER_SHAPE.custom.unwrap().partial().strict().optional(),
  })
  .strict()
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), 'Change at least one filter');
export type PrepareFiltersPatch = z.infer<typeof PrepareFiltersPatchSchema>;

/** A filter's name (PrepareFilters' keys). */
export const PrepareFilterKeySchema = PrepareFiltersSchema.keyof();
export type PrepareFilterKey = z.infer<typeof PrepareFilterKeySchema>;

/**
 * The switches only someone who may change sensitive answers changes on a shared profile (Sensitive answers' Change,
 * `sensitive:edit`): the eligibility switches and the qualification filter (its citizenship part). Without the box a
 * change of one is not made and is reported as kept, whatever its saved value (so a kept report never tells it).
 */
export const FILTER_KEPT_SWITCHES = ['noSponsorship', 'clearanceMismatch', 'qualificationMismatch'] as const satisfies readonly PrepareFilterKey[];
export type FilterKeptSwitch = (typeof FILTER_KEPT_SWITCHES)[number];

/** PATCH /api/prepare/filters. */
export const PrepareFiltersPatchBodySchema = z.object({ filters: PrepareFiltersPatchSchema }).strict();
export type PrepareFiltersPatchBody = z.infer<typeof PrepareFiltersPatchBodySchema>;

/**
 * What a filters PATCH answers. `changed`: the fields given that were applied (every field given but the kept ones; never
 * compared with the saved values, which would tell them); `kept`: the kept switches given without Sensitive answers'
 * Change there. The filters as saved (as the GET reads them: the eligibility switches off without Sensitive answers'
 * See), their revision and the location facts only with Prepare & queue's See there (`prepare:view`); else null.
 */
export const PrepareFiltersPatchFields = {
  filters: PrepareFiltersSchema.nullable(),
  revision: z.number().int().nonnegative().nullable(),
  locationKnown: z.boolean().nullable(),
  timeZoneKnown: z.boolean().nullable(),
  changed: z.array(PrepareFilterKeySchema),
  kept: z.array(z.enum(FILTER_KEPT_SWITCHES)),
};
export const PrepareFiltersPatchResponseSchema = z.object(PrepareFiltersPatchFields);
export type PrepareFiltersPatchResponse = z.infer<typeof PrepareFiltersPatchResponseSchema>;

/** PATCH /api/profiles/prepare/filters: the same partial filters on every target. */
export const FanoutFiltersBodySchema = z.object({ targets: FanoutTargetsSchema, filters: PrepareFiltersPatchSchema }).strict();
export type FanoutFiltersBody = z.infer<typeof FanoutFiltersBodySchema>;
export const FanoutFiltersResultSchema = fanoutResult(PrepareFiltersPatchFields);
export type FanoutFiltersResult = z.infer<typeof FanoutFiltersResultSchema>;
export const FanoutFiltersAnswerSchema = fanoutAnswer(FanoutFiltersResultSchema);
export type FanoutFiltersAnswer = z.infer<typeof FanoutFiltersAnswerSchema>;

/**
 * The filters that are on, in PrepareFilters' order: a list that names some values, a switch that is on, a salary above 0, the
 * supported-only choice, a custom filter that is on. The Profiles page's one line per profile ("Remote, Full-time,
 * Location"), the same for every reader.
 */
export function filtersOn(filters: PrepareFilters): PrepareFilterKey[] {
  const on: PrepareFilterKey[] = [];
  for (const key of PrepareFilterKeySchema.options) {
    const value = filters[key];
    if (key === 'custom') {
      if (filters.custom.enabled) on.push(key);
    } else if (key === 'autoApplySupport') {
      if (value === 'supported') on.push(key);
    } else if (Array.isArray(value) ? value.length > 0 : value !== null && value !== false && value !== 0) {
      on.push(key);
    }
  }
  return on;
}

// Prepare settings and the auto-save rule, partly ----------------------------------------------------------------------

/** PATCH /api/profiles/prepare/settings: the letter mode, the resume mode and Ask before using AI, any of them. */
export const FanoutPrepareSettingsBodySchema = z.object({ targets: FanoutTargetsSchema, settings: PrepareSettingsBodySchema }).strict();
export type FanoutPrepareSettingsBody = z.infer<typeof FanoutPrepareSettingsBodySchema>;
// v34 FIX-API (the final sharing review, M1): on another person's profile "Ask before using AI" is kept (only its owner
// sets it): `kept` and `keptNote` say so on that profile.
export const FanoutPrepareSettingsResultSchema = fanoutResult({
  settings: PrepareSettingsSchema,
  kept: z.array(z.enum(PREPARE_OWNER_ONLY_SETTINGS)).optional(),
  keptNote: z.string().optional(),
});
export type FanoutPrepareSettingsResult = z.infer<typeof FanoutPrepareSettingsResultSchema>;
export const FanoutPrepareSettingsAnswerSchema = fanoutAnswer(FanoutPrepareSettingsResultSchema);
export type FanoutPrepareSettingsAnswer = z.infer<typeof FanoutPrepareSettingsAnswerSchema>;

/** PATCH /api/autofill/agent/settings: the Auto-save rule's switch or its lowest match, or both. */
export const AutoSaveRulePatchSchema = AutofillAgentSettingsSchema.partial()
  .strict()
  .refine((patch) => patch.ruleEnabled !== undefined || patch.minMatch !== undefined, 'Send ruleEnabled or minMatch');
export type AutoSaveRulePatch = z.infer<typeof AutoSaveRulePatchSchema>;

/** PATCH /api/profiles/auto-apply/rule: the same rule change on every target. */
export const FanoutAutoSaveRuleBodySchema = z.object({ targets: FanoutTargetsSchema, rule: AutoSaveRulePatchSchema }).strict();
export type FanoutAutoSaveRuleBody = z.infer<typeof FanoutAutoSaveRuleBodySchema>;
export const FanoutAutoSaveRuleResultSchema = fanoutResult({ rule: AutofillAgentSettingsSchema });
export type FanoutAutoSaveRuleResult = z.infer<typeof FanoutAutoSaveRuleResultSchema>;
export const FanoutAutoSaveRuleAnswerSchema = fanoutAnswer(FanoutAutoSaveRuleResultSchema);
export type FanoutAutoSaveRuleAnswer = z.infer<typeof FanoutAutoSaveRuleAnswerSchema>;

// The Profiles page's summary ------------------------------------------------------------------------------------------

/** The parts of a profile's settings the summary reads. */
export const FANOUT_SETTINGS_PARTS = ['filters', 'prepare', 'autoSave'] as const;
export type FanoutSettingsPart = (typeof FANOUT_SETTINGS_PARTS)[number];

/** GET /api/profiles/settings?targets=all|me,key&parts=filters,prepare,autoSave (default: every profile, every part). */
export const FanoutSettingsQuerySchema = z.object({
  targets: FanoutTargetsQuerySchema.default(FANOUT_ALL),
  parts: z.preprocess(listParam, z.array(z.enum(FANOUT_SETTINGS_PARTS)).min(1)).default([...FANOUT_SETTINGS_PARTS]),
});
export type FanoutSettingsQuery = z.infer<typeof FanoutSettingsQuerySchema>;

/** What a profile's boxes let A see and change of its settings. */
export const FanoutSettingsCanSchema = z.object({
  /** Prepare & queue's See: the filters show. */
  seeFilters: z.boolean(),
  /** Job settings' See: the Prepare settings and the auto-save rule show. */
  seeSettings: z.boolean(),
  /** Job settings' Change: the filters, the Prepare settings and the rule change. */
  changeSettings: z.boolean(),
  /** Sensitive answers' See: the eligibility switches read as saved (else as off). */
  seeEligibility: z.boolean(),
  /** Sensitive answers' Change: the kept switches (FILTER_KEPT_SWITCHES) change too. */
  changeEligibility: z.boolean(),
});

/**
 * GET /api/profiles/settings: per profile asked (default A's own first, then every live share), what its boxes let A
 * see and change. `filters` with Prepare & queue's See (the eligibility switches read as off without Sensitive answers'
 * See, as the filters' GET answers them), `prepare` and `autoSave` with Job settings' See; null without the box, or
 * when the part was not asked. A key that names no live share answers as a refused target.
 */
export const FanoutSettingsSummarySchema = z.object({
  profiles: z.array(
    fanoutResult({
      can: FanoutSettingsCanSchema,
      filters: z
        .object({ filters: PrepareFiltersSchema, revision: z.number().int().nonnegative(), locationKnown: z.boolean(), timeZoneKnown: z.boolean() })
        .nullable(),
      /** filtersOn(filters): the one line's filters; null without the filters. */
      filtersOn: z.array(PrepareFilterKeySchema).nullable(),
      prepare: PrepareSettingsSchema.nullable(),
      autoSave: AutofillAgentSettingsSchema.nullable(),
    }),
  ),
});
export type FanoutSettingsSummary = z.infer<typeof FanoutSettingsSummarySchema>;
