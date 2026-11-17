import { Router, type Request } from 'express';
import {
  AUTOFILL_ANYTHING_ELSE_MAX,
  AUTOFILL_API_VERSION,
  AutofillSeedQuerySchema,
  type AutofillProfileEnvelope,
  type AutofillSensitiveEnvelope,
} from '@tailorit/shared/autofill';
import { isResumeTemplateId, MINUTE_MS } from '@tailorit/shared';
import { userOf } from '../../../core/auth/guards';
import type { AppDeps, SessionUser } from '../../../core/context';
import { parseInput } from '../../../core/http/validate';
import { visibleTemplate } from '../../cover-letters/context';
import { profileFilterKey } from '../../prepare-filters/person';
import { touchFilterRevision } from '../../prepare-filters/settings';
import { allow, perAccountLimit } from '../auth';
import { readAutofillProfile, readSensitiveAnswers, saveAutofillProfile } from './repository';
import { flaggedNoteLines, noteWithoutSensitive } from './note-flags';
import { readEmail, seedAutofillProfile } from './seed';

// The autofill profile (work package AF), mounted at /api/autofill:
//   GET /profile            Settings or a token (profile:read) → AutofillProfileEnvelope, never the sensitive part
//   GET /profile/sensitive  Settings or a token (profile:sensitive) → AutofillSensitiveEnvelope
//   PUT /profile            Settings (session + Origin) or a token (profile:write, version 3: the side panel's
//                           "Autofill information") PutAutofillProfileBody → PutAutofillProfileResponse; the
//                           sensitive part sent and answered only for a caller that may read it (the session, or a
//                           token with profile:sensitive too)
//   GET /profile/seed       Settings ?resumeId= → AutofillSeed ("Fill from my resume"; writes nothing)
// The extension asks for the sensitive part only when a form asks such a question. Neither part is ever logged: the
// log names the account, the token and the revision only.

/** Whether the caller may read the sensitive part: the session, or a token with profile:sensitive. */
const mayReadSensitive = (req: Request) =>
  req.authVia !== 'token' || req.extensionToken?.scopes.includes('profile:sensitive') === true;

/**
 * GET /profile: an empty email is answered as the account's sign-in address when the contract's email rule takes it
 * (sign-in takes some it refuses, which stay empty), a resume since deleted as none. A caller that may not read the
 * sensitive part gets the note without the lines that state a sensitive answer, each one HIDDEN_NOTE_LINE, flagged
 * (audit A2).
 */
async function profileEnvelope(deps: AppDeps, user: SessionUser, sensitiveToo: boolean): Promise<AutofillProfileEnvelope> {
  const { revision, updatedAt, value: profile } = await readAutofillProfile(deps, user.id);
  if (!profile.contact.email) profile.contact.email = readEmail(user.email);
  const resumeId = profile.documents.resumeId;
  if (resumeId !== null && !(await deps.db.one('SELECT 1 FROM resumes WHERE id = ? AND user_id = ?', [resumeId, user.id]))) {
    profile.documents.resumeId = null;
  }
  // v1.4 D: a template since deleted (or one this TailorIT does not have) reads as none.
  if (profile.documents.resumeTemplateId !== null && !isResumeTemplateId(profile.documents.resumeTemplateId)) {
    profile.documents.resumeTemplateId = null;
  }
  const letterTemplate = profile.documents.coverLetterTemplateId;
  if (letterTemplate !== null && !await visibleTemplate(deps, user.id, letterTemplate)) {
    profile.documents.coverLetterTemplateId = null;
  }
  // end v1.4 D
  const view = sensitiveToo
    ? { note: profile.anythingElse, flagged: flaggedNoteLines(profile.anythingElse) }
    : noteWithoutSensitive(profile.anythingElse, AUTOFILL_ANYTHING_ELSE_MAX);
  return {
    apiVersion: AUTOFILL_API_VERSION,
    revision,
    updatedAt,
    profile: { ...profile, anythingElse: view.note },
    anythingElseFlaggedLines: view.flagged,
  };
}

export function createAutofillProfileRouter(deps: AppDeps): Router {
  const router = Router();
  // Both parts together: the page reads each once as it opens, the extension the profile once per form.
  const readLimit = perAccountLimit('autofill-profile-read', 120, MINUTE_MS);
  const saveLimit = perAccountLimit('autofill-profile-save', 30, MINUTE_MS);
  const seedLimit = perAccountLimit('autofill-profile-seed', 20, MINUTE_MS);

  router.get('/profile', allow('either', 'profile:read'), readLimit, async (req, res) => {
    res.json(await profileEnvelope(deps, userOf(req), mayReadSensitive(req)));
  });

  router.get('/profile/sensitive', allow('either', 'profile:sensitive'), readLimit, async (req, res) => {
    const { revision, updatedAt, value: sensitive } = await readSensitiveAnswers(deps, userOf(req).id);
    if (req.extensionToken) deps.log.debug(`[autofill] token ${req.extensionToken.id} read the sensitive answers`);
    const envelope: AutofillSensitiveEnvelope = { apiVersion: AUTOFILL_API_VERSION, revision, updatedAt, sensitive };
    res.json(envelope);
  });

  router.put('/profile', allow('either', 'profile:write'), saveLimit, async (req, res) => {
    const userId = userOf(req).id;
    const filterKey = await profileFilterKey(deps, userId);
    const saved = await saveAutofillProfile(deps, userId, req.body ?? {}, { mayReadSensitive: mayReadSensitive(req) });
    // v2.0 (INT): the prepare filters read the degree, the certifications, the citizenships, the clearance and the years
    // of experience from this profile; a save that changes one makes every stored verdict stale.
    if ((await profileFilterKey(deps, userId)) !== filterKey) await touchFilterRevision(deps, userId);
    const by = req.extensionToken ? ` from token ${req.extensionToken.id}` : '';
    deps.log.debug(`[autofill] account ${userId} saved its autofill profile${by} (revision ${saved.revision})`);
    res.json(saved);
  });

  router.get('/profile/seed', allow('session'), seedLimit, async (req, res) => {
    const user = userOf(req);
    const { resumeId } = parseInput(AutofillSeedQuerySchema, req.query, 'query');
    const seed = await seedAutofillProfile(deps, user, resumeId);
    const from = seed.source ? `resume ${seed.source.resumeId}` : 'the account alone';
    deps.log.debug(`[autofill] account ${user.id} seeded its autofill profile from ${from} (${seed.filled.length} fields)`);
    res.json(seed);
  });

  return router;
}
