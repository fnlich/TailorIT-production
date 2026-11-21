import { Router, type Request } from 'express';
import {
  GENERAL_FAMILY_ID,
  IdParam,
  RESUME_ANALYSIS_VERSION,
  SetResumeFieldBodySchema,
  asRoleFamilyId,
  type ResumeField,
  type RoleFamilyId,
  type RoleFieldSource,
} from '@tailorit/shared';
import { requireUser, userOf } from '../../core/auth/guards';
import type { AppDeps } from '../../core/context';
import { notFound } from '../../core/http/errors';
import { parseInput } from '../../core/http/validate';
import { storedResumeAnalysis } from './analysis/store';

// v33 ROLES (F4): the person's field ("role family") belongs to the resume in use. A resume's field is the person's
// choice (resumes.role_family, the Field select), else what TailorIT detected from its reading (resume_analyses.
// role_family, shared roles/detect.ts); a tailored resume with no choice of its own reads as its source. The person's
// field is their default resume's. No AI is involved.
//
// GET /api/resumes/:id/role-family  -> ResumeField
// PUT /api/resumes/:id/role-family  {roleFamily: <family id> | null}  -> ResumeField (null: detect it again)
//
// profileFamilyOf(deps, userId, resumeId?) is what Tailor, Prepare, the MCP step texts and the letters read (PROMPTS,
// wave 2): the given resume's field, else the default resume's; general without one.

interface FieldRow {
  id: string;
  role_family: string | null;
  made_by: string;
  source_resume_id: string | null;
}

const SELECT_FIELD_ROW = 'SELECT id, role_family, made_by, source_resume_id FROM resumes WHERE id = ? AND user_id = ?';
const SELECT_DEFAULT_RESUME = 'SELECT default_resume_id FROM users WHERE id = ?';
// Changing the field is no edit: updated_at and document_revision stay (the tailor signature carries the family).
const UPDATE_FIELD = 'UPDATE resumes SET role_family = ? WHERE id = ? AND user_id = ?';

// The stored readings' fields (resume_analyses.role_family): no document is read for them.
const SELECT_READING_FIELDS = `SELECT a.source, a.version, a.content_hash, a.role_family FROM resume_analyses a
  JOIN resumes r ON r.id = a.resume_id WHERE r.id = ? AND r.user_id = ?`;

interface ReadingFieldRow {
  source: 'deterministic' | 'ai';
  version: number;
  content_hash: string;
  role_family: string | null;
}

/**
 * What TailorIT read from one resume: the field its current reading stores (Claude's reading's when it has a current
 * one); a reading missing, stale or stored before v3.3 is read now. General when the resume cannot be read.
 */
async function detectedOf(deps: AppDeps, userId: string, resumeId: string): Promise<RoleFamilyId> {
  const rows = await deps.db.all<ReadingFieldRow>(SELECT_READING_FIELDS, [resumeId, userId]);
  const rules = rows.find((row) => row.source === 'deterministic' && Number(row.version) === RESUME_ANALYSIS_VERSION);
  const ai = rules
    ? rows.find((row) => row.source === 'ai' && Number(row.version) === RESUME_ANALYSIS_VERSION && row.content_hash === rules.content_hash)
    : undefined;
  const stored = asRoleFamilyId(ai?.role_family) ?? (ai ? null : asRoleFamilyId(rules?.role_family));
  if (stored) return stored;
  const read = await storedResumeAnalysis(deps, userId, resumeId);
  return read?.roleFamily ?? GENERAL_FAMILY_ID;
}

/** A resume's field, or null when it is not the account's. */
export async function resumeFieldOf(deps: AppDeps, userId: string, resumeId: string): Promise<ResumeField | null> {
  const row = await deps.db.one<FieldRow>(SELECT_FIELD_ROW, [resumeId, userId]);
  if (!row) return null;
  const chosen = asRoleFamilyId(row.role_family);
  let detected: RoleFamilyId | null = null;
  // A tailored resume with no choice of its own is its source's field (the same person, the same field).
  if (!chosen && row.made_by === 'tailor' && row.source_resume_id) {
    const source = await deps.db.one<FieldRow>(SELECT_FIELD_ROW, [row.source_resume_id, userId]);
    if (source) detected = asRoleFamilyId(source.role_family) ?? (await detectedOf(deps, userId, source.id));
  }
  detected ??= await detectedOf(deps, userId, row.id);
  return { resumeId: row.id, familyId: chosen ?? detected, chosen, detected };
}

/** A person's field, and where it comes from. */
export interface ProfileFamily {
  familyId: RoleFamilyId;
  source: RoleFieldSource;
  /** The resume it was read from; null without one. */
  resumeId: string | null;
}

/**
 * The person's field for a task: the given resume's (the profile's resume, Prepare's choice, a tailored resume's
 * source), else the default resume's; general ('none') when the account has no resume, or the given one is not theirs.
 */
export async function profileFamilyOf(deps: AppDeps, userId: string, resumeId?: string | null): Promise<ProfileFamily> {
  const id = resumeId ?? (await deps.db.one<{ default_resume_id: string | null }>(SELECT_DEFAULT_RESUME, [userId]))?.default_resume_id ?? null;
  const field = id ? await resumeFieldOf(deps, userId, id) : null;
  if (!field) return { familyId: GENERAL_FAMILY_ID, source: 'none', resumeId: null };
  return { familyId: field.familyId, source: field.chosen ? 'chosen' : 'detected', resumeId: field.resumeId };
}

function idOf(req: Request): string {
  return parseInput(IdParam, req.params.id, 'resume id');
}

/** The Field routes, mounted at /api/resumes before the resumes router (features/resumes/index.ts). */
export function createResumeRoleFamilyRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireUser);

  router.get('/:id/role-family', async (req, res) => {
    const field = await resumeFieldOf(deps, userOf(req).id, idOf(req));
    if (!field) throw notFound('That resume');
    res.json(field);
  });

  router.put('/:id/role-family', async (req, res) => {
    const userId = userOf(req).id;
    const id = idOf(req);
    const { roleFamily } = parseInput(SetResumeFieldBodySchema, req.body ?? {});
    const { changes } = await deps.db.run(UPDATE_FIELD, [roleFamily, id, userId]);
    if (changes === 0) throw notFound('That resume');
    res.json(await resumeFieldOf(deps, userId, id));
  });

  return router;
}
