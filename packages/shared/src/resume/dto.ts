import { z } from 'zod';
import { IsoDateTime, listResponse } from '../core/list';
import { queryBoolean, queryEnum } from '../format/params';
import { ResumeAnalysisBriefSchema } from './analysis';
import { ENTRY_BULLETS_KINDS, MAX_RESUME_SKILLS, MAX_SKILL_LENGTH } from './catalogue';
import { MAX_AI_BULLETS, MAX_BULLET_LENGTH, MAX_BULLETS_NOTE_LENGTH } from './display';
import { ResumeDocumentInputSchema, ResumeDocumentSchema } from './document';
import { RoleFamilyIdSchema } from '../roles/dto'; // v33 SKILLS: the skill picker's field

// Contracts of the resume endpoints (/api/resumes, /api/skills, /api/ai/resume-bullets). v33 LEGACY: the retired
// templates' list and previews (and the live preview route) went with their engine.
// Resume ids are strings. A resume is `built` (a document edited in TailorIT) or `uploaded` (a stored PDF/DOCX).

export const RESUME_KINDS = ['built', 'uploaded'] as const;
export type ResumeKind = (typeof RESUME_KINDS)[number];

/** The Resumes tab's source filter: All / Created / Uploaded. */
export const RESUME_SOURCES = ['all', 'built', 'uploaded'] as const;
export type ResumeSource = (typeof RESUME_SOURCES)[number];
export const RESUME_SOURCE_LABEL: Record<ResumeSource, string> = { all: 'All', built: 'Created', uploaded: 'Uploaded' };

// v1.5 W
/**
 * How a resume came to be (`resumes.made_by`, migration 0815), which decides its folder in Documents › Resumes:
 * `upload` (Uploaded resumes); `editor`, made in the editor, imported or duplicated, and `copy`, an upload's editable
 * copy (Edited resumes); `tailor`, made by tailoring for a job (Tailored resumes). The autofill contract's
 * AUTOFILL_RESUME_MADE_BY is the same list.
 */
export const RESUME_MADE_BY = ['upload', 'editor', 'copy', 'tailor'] as const;
export type ResumeMadeBy = (typeof RESUME_MADE_BY)[number];
// end v1.5 W

export const RESUME_FILE_KINDS = ['pdf', 'docx'] as const;
export type ResumeFileKind = (typeof RESUME_FILE_KINDS)[number];

/** A custom title (Rename): at most this long. */
export const MAX_RESUME_TITLE_LENGTH = 120;

// v2.0 (A15): how many resumes an account keeps is the plan's limit (FREE_/PAID_RESUME_LIMIT) and the technical
// RESUME_SAFETY_CAP for every account, central constants the server resolves (apps/api resumes/repository.ts).

/** GET /api/resumes?source= */
export const ResumeListQuerySchema = z.object({
  source: queryEnum(RESUME_SOURCES).transform((value) => value ?? 'all'),
});
export type ResumeListQuery = z.infer<typeof ResumeListQuerySchema>;

/** One row / card of the Resumes tab. `label` is already decided (`resumeLabel`). */
export const ResumeSummarySchema = z.object({
  id: z.string(),
  kind: z.enum(RESUME_KINDS),
  label: z.string(),
  /** The custom title, or null for the label rule. */
  title: z.string().nullable(),
  templateId: z.string().nullable(),
  templateName: z.string().nullable().optional(),
  isDefault: z.boolean(),
  /** Uploaded files only. */
  fileKind: z.enum(RESUME_FILE_KINDS).nullable(),
  /** "Name on resume" column; '' for uploads. */
  nameOnResume: z.string(),
  // v1.5 W
  /** How it came to be: its folder (RESUME_MADE_BY). */
  madeBy: z.enum(RESUME_MADE_BY),
  // end v1.5 W
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** The last content edit (null until one). */
  lastEditedAt: IsoDateTime.nullable(),
  /** What TailorIT read from it, for the list's line (GET /api/resumes only); null when it has not been read yet. */
  analysis: ResumeAnalysisBriefSchema.nullable().optional(),
  /** Kept by the on-page editor: it opens there, and its first page is drawn from its document. */
  onPageEditor: z.boolean().optional(),
});
export type ResumeSummary = z.infer<typeof ResumeSummarySchema>;

export const ResumeListResponseSchema = listResponse(ResumeSummarySchema);
export type ResumeListResponse = z.infer<typeof ResumeListResponseSchema>;

export const StoredFileInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  mime: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  pageCount: z.number().int().positive().nullable(),
});
export type StoredFileInfo = z.infer<typeof StoredFileInfoSchema>;

/** GET /api/resumes/:id. `document` is null for an uploaded resume. */
export const ResumeDetailSchema = ResumeSummarySchema.extend({
  document: ResumeDocumentSchema.nullable(),
  file: StoredFileInfoSchema.nullable(),
  /** An uploaded file whose text could be read (it can be matched and turned into an editable copy). */
  hasExtractedText: z.boolean(),
  /** Bumped by every save that changes the document (never by Rename or a reading); 0 for a new resume. */
  documentRevision: z.number().int().nonnegative(),
});
export type ResumeDetail = z.infer<typeof ResumeDetailSchema>;

const ResumeTitleField = z
  .string()
  .trim()
  .max(MAX_RESUME_TITLE_LENGTH)
  .transform((value) => value || null)
  .nullable();

/** POST /api/resumes. */
export const CreateResumeBodySchema = z.object({
  document: ResumeDocumentInputSchema,
  title: ResumeTitleField.optional(),
});
export type CreateResumeBody = z.infer<typeof CreateResumeBodySchema>;

/** PUT /api/resumes/:id: the document laid over the stored one (omitted fields keep their value). */
export const UpdateResumeBodySchema = z.object({
  document: ResumeDocumentInputSchema,
  title: ResumeTitleField.optional(),
  /**
   * The document revision the save was made from (the on-page editor's autosave sends it): a save from an older one
   * than is stored is refused (409 `revision_conflict`), and the reading of the resume waits until the typing stops.
   * Omitted: the save always applies and is read at once (the form editor).
   */
  baseRevision: z.number().int().nonnegative().optional(),
});
export type UpdateResumeBody = z.infer<typeof UpdateResumeBodySchema>;

/**
 * POST /api/resumes/:id/layout: the pages the editor drew for what prints (its Preview's plan), checked against the
 * PDF's before a download. The answer's page count is the PDF's; `matches` false means the two broke differently.
 */
/** How far (CSS px) a box's height may differ between the editor and the PDF before it counts as drift. */
export const LAYOUT_HEIGHT_TOLERANCE_PX = 0.25;

export const ResumeLayoutCheckBodySchema = z.object({
  pageCount: z.number().int().min(1).max(50),
  /** By column, the box that starts each page after the first. */
  breaks: z.object({
    main: z.array(z.string().max(200)).max(50),
    side: z.array(z.string().max(200)).max(50).optional(),
  }),
  /** Each box's height as the editor drew it (CSS px, unscaled), when it sends them. */
  heights: z
    .record(z.string().max(200), z.number().nonnegative().max(100_000))
    .refine((heights) => Object.keys(heights).length <= 500, 'At most 500 boxes.')
    .optional(),
});
export type ResumeLayoutCheckBody = z.infer<typeof ResumeLayoutCheckBodySchema>;
export const ResumeLayoutCheckResponseSchema = z.object({
  pageCount: z.number().int(),
  matches: z.boolean(),
  /** With `heights`: the largest difference (CSS px) between a box's height in the editor and in the PDF (absent when no box was in both). */
  heightDelta: z.number().optional(),
});
export type ResumeLayoutCheckResponse = z.infer<typeof ResumeLayoutCheckResponseSchema>;

/** PATCH /api/resumes/:id (Rename, "Change resume name"). '' or null goes back to the label rule. */
export const PatchResumeBodySchema = z.object({ title: ResumeTitleField });
export type PatchResumeBody = z.infer<typeof PatchResumeBodySchema>;

/** DELETE /api/resumes/:id. Deleting the default resume moves the default to the newest other resume (or none). */
export const ResumeDeleteResponseSchema = z.object({
  deleted: z.literal(true),
  defaultResumeId: z.string().nullable(),
});

/** POST /api/resumes/:id/duplicate. The title defaults to "{label} (Copy)". */
export const DuplicateResumeBodySchema = z.object({ title: ResumeTitleField.optional() });

/** POST /api/resumes/bulk-delete. The default resume is skipped ("1 default resume will be skipped"). */
export const ResumeBulkDeleteBodySchema = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(500) });
export const ResumeBulkDeleteResponseSchema = z.object({
  deleted: z.number().int().nonnegative(),
  skippedIds: z.array(z.string()),
});
export type ResumeBulkDeleteResponse = z.infer<typeof ResumeBulkDeleteResponseSchema>;

/**
 * POST /api/resumes/upload?parse=1: `parse` also asks for an AI import ("Make an editable copy"). The router also reads
 * `templateId`, `layout` and `batch` leniently: `batch` (ResumeCopyBatchIdSchema) marks one of several files of one
 * Upload dialog, whose copy waits in the copy line instead of starting at once.
 */
export const ResumeUploadQuerySchema = z.object({ parse: queryBoolean });
export const ResumeUploadResponseSchema = z.object({
  resume: ResumeSummarySchema,
  /**
   * The import task when `parse` was asked for (poll GET /api/ai/tasks/:id). Always null with `batch`: GET
   * /api/resumes/copies follows those copies.
   */
  taskId: z.string().nullable(),
  /**
   * Why the editable copy asked for could not start (AI busy or off, text that cannot be read), as a sentence to show.
   * The upload is kept either way. Null or absent when the copy started or was not asked for. With `batch`, a copy
   * refused when asked is a failed row of GET /api/resumes/copies instead: this is set only when the copy could not be
   * put in line at all.
   */
  copyError: z.string().nullable().optional(),
});
export type ResumeUploadResponse = z.infer<typeof ResumeUploadResponseSchema>;

// v1.5 W
/**
 * POST /api/resumes/:id/edit (decision 3, the web's /resumes/<id>/edit): what Edit opens. A built resume opens itself
 * (`resumeId` is its id). An upload opens its editable copy, the newest built resume made from it; with none, the copy
 * is started as "Make editable copy" starts it (one already being made, alone or in the copy line, is followed rather
 * than started twice): 202 with `taskId` (poll GET /api/ai/tasks/:id, whose result names the copy) and `resumeId` null.
 */
export const ResumeEditTargetSchema = z.object({
  /** The resume asked about. */
  kind: z.enum(RESUME_KINDS),
  /** Its label, for the progress page. */
  label: z.string(),
  /** The resume to open in the editor; null while its editable copy is being made. */
  resumeId: z.string().nullable(),
  /** The copy's task while it is being made; null otherwise. */
  taskId: z.string().nullable(),
});
export type ResumeEditTarget = z.infer<typeof ResumeEditTargetSchema>;
// end v1.5 W

/** One Upload dialog's id for its runs of several files (the browser makes it): their copies share one notice. */
export const ResumeCopyBatchIdSchema = z.string().regex(/^[A-Za-z0-9-]{8,64}$/);

/** An editable copy of one upload in the line of several: waiting, being made, made, not made, or stopped. */
export const RESUME_COPY_STATES = ['waiting', 'making', 'ready', 'failed', 'stopped'] as const;
export type ResumeCopyState = (typeof RESUME_COPY_STATES)[number];

export const ResumeCopySchema = z.object({
  id: z.string(),
  batchId: z.string(),
  /** The upload's label when the copy was asked for. */
  label: z.string(),
  state: z.enum(RESUME_COPY_STATES),
  /** The copy made (a built resume); null until ready, and once that resume is deleted. */
  resumeId: z.string().nullable(),
  /** Why it was not made (failed only), as a sentence to show. */
  error: z.string().nullable(),
  /** Try again may make it: stopped, or failed for any reason but unreadable text or a deleted upload. */
  retryable: z.boolean(),
});
export type ResumeCopy = z.infer<typeof ResumeCopySchema>;

/**
 * Why a person's copies in line wait. v2.0 (03-ai-usage.md, "Messages, and what people never see"): a person is never
 * told the server's state (AI off, an AI pause, the seat's usage limit or warning, the capacity block, or when any of
 * them ends), so there are two reasons only:
 * - `unavailable`: TailorIT's AI is not making copies now, with no time (`until` is null);
 * - `usage`: the person's own daily AI usage and extra credit are used up; the copies wait until the daily reset
 *   (`until`), MSG_AI_USAGE_EXHAUSTED's case.
 */
export const RESUME_COPY_PAUSES = ['unavailable', 'usage'] as const;
export const ResumeCopiesPauseSchema = z.object({ reason: z.enum(RESUME_COPY_PAUSES), until: IsoDateTime.nullable() });
export type ResumeCopiesPause = z.infer<typeof ResumeCopiesPauseSchema>;

/** GET /api/resumes/copies, and the answer of POST /api/resumes/copies/:batchId/{stop,retry,dismiss}. */
export const ResumeCopiesResponseSchema = z.object({
  items: z.array(ResumeCopySchema),
  paused: ResumeCopiesPauseSchema.nullable(),
});
export type ResumeCopiesResponse = z.infer<typeof ResumeCopiesResponseSchema>;

/** POST /api/resumes/import-json: a file downloaded from TailorIT (or free_tailor), already parsed by the browser. */
export const ResumeImportJsonBodySchema = z.object({
  data: z.unknown(),
  fileName: z.string().max(255).optional(),
});
export const ResumeImportJsonResponseSchema = z.object({
  resumes: z.array(ResumeSummarySchema),
  imported: z.number().int().nonnegative(),
});
export type ResumeImportJsonResponse = z.infer<typeof ResumeImportJsonResponseSchema>;

/** The result of a `resume_import` AI task (POST /api/resumes/:id/parse, or upload with parse=1). */
export const ResumeImportTaskResultSchema = z.object({ resumeId: z.string() });
export type ResumeImportTaskResult = z.infer<typeof ResumeImportTaskResultSchema>;

/**
 * GET /api/resumes/:id/thumbnail: an upload's first page as an image; a built resume as its document, which the page
 * draws with the editor's templates (an older one as the editor opens it).
 */
export const ResumeThumbnailSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('image'), url: z.string() }),
  z.object({ kind: z.literal('document'), templateId: z.string(), document: ResumeDocumentSchema }),
]);
export type ResumeThumbnail = z.infer<typeof ResumeThumbnailSchema>;

export const RESUME_EXPORT_FORMATS = ['pdf', 'docx', 'txt', 'json'] as const;
export type ResumeExportFormat = (typeof RESUME_EXPORT_FORMATS)[number];
/** GET /api/resumes/:id/export?format= */
export const ResumeExportQuerySchema = z.object({
  format: queryEnum(RESUME_EXPORT_FORMATS).transform((value) => value ?? 'pdf'),
  /** The file name the person chose in the Download dialog, without its extension (an editor resume's download). */
  name: z.string().max(200).optional(),
  // v33 LEGACY: `upgraded=1` is no longer read: every download prints as the editor shows the resume (an older one
  // upgraded as it is read). The JSON file is the stored document.
});

export const SKILL_TYPES = ['hard', 'soft'] as const;
export type SkillType = (typeof SKILL_TYPES)[number];

/**
 * GET /api/skills?type= : the library (skills.json) overlaid with the user's own. Hard skills are the main skills only;
 * `aliases` gives each one's other spellings ("ASP.NET Core" of ".NET"), so a picker can find a main skill by them. An
 * alias is still a known skill when typed (POST /api/skills answers it in its own spelling).
 * v33 SKILLS: `family` (a role family id: the open resume's field) lists that field's hard skills first, its own ones
 * leading; every other skill follows, so a skill of another field is still offered.
 */
export const SkillsQuerySchema = z.object({
  type: queryEnum(SKILL_TYPES).transform((value) => value ?? 'hard'),
  family: RoleFamilyIdSchema.optional(), // v33 SKILLS
});
export const SkillsResponseSchema = z.object({
  type: z.enum(SKILL_TYPES),
  skills: z.array(z.string()),
  aliases: z.record(z.string(), z.array(z.string())).optional(),
});
export type SkillsResponse = z.infer<typeof SkillsResponseSchema>;

/**
 * POST /api/skills: a skill the library lacks, kept for this user only. v33 SKILLS: `family` (the resume's field) files
 * a hard skill no rule places under that field's heading, not "Frameworks and Libraries".
 */
export const AddSkillBodySchema = z.object({
  type: z.enum(SKILL_TYPES),
  skill: z.string().trim().min(1).max(100),
  category: z.string().trim().max(100).optional(),
  family: RoleFamilyIdSchema.optional(), // v33 SKILLS
});
export const AddSkillResponseSchema = z.object({
  added: z.boolean(),
  skill: z.string(),
  type: z.enum(SKILL_TYPES),
  category: z.string().nullable(),
});
export type AddSkillResponse = z.infer<typeof AddSkillResponseSchema>;

/**
 * POST /api/skills/group (the editor's Group skills): the skills under the headings of the person's skill library, in
 * the library's heading order. Every skill is kept, as written; one the library does not know goes under the heading
 * worked out for it.
 */
export const GroupSkillsBodySchema = z.object({
  skills: z.array(z.string().trim().max(MAX_SKILL_LENGTH)).max(MAX_RESUME_SKILLS),
});
export const GroupSkillsResponseSchema = z.object({
  groups: z.array(z.object({ category: z.string(), skills: z.array(z.string()) })),
});
export type GroupSkillsResponse = z.infer<typeof GroupSkillsResponseSchema>;

export const BULLETS_TASKS = ['write', 'improve'] as const;
export type BulletsTask = (typeof BULLETS_TASKS)[number];

const shortText = z.string().max(500).optional();

/** The entry Write with AI works on: the fields that name it, its dates, location, description, bullets and skills. */
export const BulletsEntrySchema = z.object({
  title: shortText,
  company: shortText,
  name: shortText,
  role: shortText,
  organization: shortText,
  startDate: z.string().max(50).optional(),
  endDate: z.string().max(50).optional(),
  location: shortText,
  description: z.string().max(5000).optional(),
  achievements: z.array(z.string().max(1000)).max(50).optional(),
  skills: z.array(z.string().max(100)).max(100).optional(),
});

/** Five facts about the person (never contact details). */
export const BulletsResumeContextSchema = z.object({
  name: z.string().max(200).optional(),
  title: z.string().max(200).optional(),
  totalYearsExperience: z.number().nonnegative().max(80).optional(),
  summary: z.string().max(5000).optional(),
  skills: z.array(z.string().max(100)).max(200).optional(),
});

/** POST /api/ai/resume-bullets (202 { taskId }). */
export const BulletsRequestSchema = z.object({
  kind: z.enum(ENTRY_BULLETS_KINDS),
  entry: BulletsEntrySchema,
  resume: BulletsResumeContextSchema.optional(),
  task: z.enum(BULLETS_TASKS),
  instructions: z.string().trim().max(MAX_BULLETS_NOTE_LENGTH).optional(),
  /** 1: the description, the bullets and the summary hold inline markup (the on-page editor's). Absent: literal text. */
  markupVersion: z.literal(1).optional(),
  /**
   * v33 INT-1: the resume's field as the editor shows it (its Field select): the bullets are written in that field's
   * words. Absent (an older client, or the field not known yet): the server detects it from the headline and the entry.
   */
  roleFamily: RoleFamilyIdSchema.optional(),
});
export type BulletsRequest = z.infer<typeof BulletsRequestSchema>;

/** The `entry_bullets` task result: 1-8 one-line bullets of at most 300 characters. */
export const BulletsResultSchema = z.object({
  bullets: z.array(z.string().min(1).max(MAX_BULLET_LENGTH)).min(1).max(MAX_AI_BULLETS),
});
export type BulletsResult = z.infer<typeof BulletsResultSchema>;
