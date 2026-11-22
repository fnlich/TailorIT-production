import {
  PREPARE_OWNER_ONLY_NOTE,
  type CoverLetterMode,
  type PrepareResumeMode,
  type PrepareSettings,
  type PrepareSettingsBody,
  type PrepareSettingsSaved,
} from '@tailorit/shared';
import type { AppDeps } from '../../core/context';
import type { DbTx } from '../../core/db/types'; // v34 FANOUT
import { constantsOf } from '../../core/constants/service';
import { readAutofillProfile, setCoverLetterMode } from '../autofill/profile/repository';
import { prepareUserSettings, writePrepareUserSettings } from './store';

// Prepare & Queue's settings (GET and PUT /api/prepare/settings, docs/design/v2.0/05-prepare-flow.md):
// - the cover-letter mode (A6): the autofill profile's documents.coverLetters, where the extension reads its document
//   choices (00-overview.md, assumption 29: one source of truth); COVER_LETTER_MODE_DEFAULT before the person has a
//   profile;
// - the resume mode (DECISIONS A29): user_settings.prepare_resume_mode (0827); PREPARE_RESUME_MODE_DEFAULT before the
//   person has a settings row, and the value a row made here starts with;
// - "Don't show this again" of the Prepare & Queue confirm (A21): user_settings.skip_prepare_confirm.

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** The person's cover-letter mode: the stored profile's, else (no profile yet) COVER_LETTER_MODE_DEFAULT. */
export async function letterModeOf(deps: Deps, userId: string): Promise<CoverLetterMode> {
  const profile = await readAutofillProfile(deps, userId);
  if (profile.revision === 0) return constantsOf(deps).get('COVER_LETTER_MODE_DEFAULT') as CoverLetterMode;
  return profile.value.documents.coverLetters;
}

/** Sets the cover-letter mode alone in the profile (its revision goes up). */
export async function setLetterMode(deps: Deps, userId: string, mode: CoverLetterMode): Promise<void> {
  await setCoverLetterMode(deps, userId, mode);
}

/** The constant a new account's resume mode is. */
const defaultResumeMode = (deps: Deps) => constantsOf(deps).get('PREPARE_RESUME_MODE_DEFAULT') as PrepareResumeMode;

/** The person's resume mode (A29): their user_settings row's, else PREPARE_RESUME_MODE_DEFAULT. */
export async function resumeModeOf(deps: Deps, userId: string): Promise<PrepareResumeMode> {
  return (await prepareUserSettings(deps.db, userId))?.prepare_resume_mode ?? defaultResumeMode(deps);
}

/** GET /api/prepare/settings. */
export async function prepareSettingsOf(deps: Deps, userId: string): Promise<PrepareSettings> {
  const stored = await prepareUserSettings(deps.db, userId);
  return {
    letterMode: await letterModeOf(deps, userId),
    resumeMode: stored?.prepare_resume_mode ?? defaultResumeMode(deps),
    skipConfirm: deps.db.dialect.isTrue(stored?.skip_prepare_confirm),
  };
}

/**
 * PUT /api/prepare/settings: any of the three; the rest stay as they are. Answers the settings as saved. Each field is
 * written in place (one column, or the profile's one JSON key), never read, merged and written back, so a change of
 * another field at the same moment is never lost. v34 FANOUT: `options.lock` runs first in the transaction (the fan-out
 * locks the share FOR SHARE there: a Stop waits for the write).
 * v34 FIX-API (the final sharing review, M1): `options.actorId`, who changes them; someone else than `userId` (working
 * on a shared profile) never writes "Ask before using AI" (skipConfirm: the confirm of whoever pays, each person's own
 * setting): it is kept and answered as `kept` with PREPARE_OWNER_ONLY_NOTE. Nothing else to write: nothing is written.
 */
export async function savePrepareSettings(
  deps: Deps,
  userId: string,
  given: PrepareSettingsBody,
  options: { lock?: (t: DbTx) => Promise<void>; actorId?: string } = {}, // v34 FANOUT; v34 FIX-API: actorId
): Promise<PrepareSettingsSaved> {
  // v34 FIX-API (M1): only the profile's owner sets skipConfirm.
  const ownerOnly = options.actorId !== undefined && options.actorId !== userId && given.skipConfirm !== undefined;
  const body: Partial<PrepareSettingsBody> = ownerOnly ? { ...given, skipConfirm: undefined } : given;
  const kept = ownerOnly ? { kept: ['skipConfirm' as const], keptNote: PREPARE_OWNER_ONLY_NOTE } : {};
  if (body.letterMode === undefined && body.resumeMode === undefined && body.skipConfirm === undefined) {
    return { ...(await prepareSettingsOf(deps, userId)), ...kept };
  }
  const now = deps.now().toISOString();
  await deps.db.tx(async (t) => {
    await options.lock?.(t); // v34 FANOUT
    if (body.letterMode !== undefined) await setLetterMode(deps, userId, body.letterMode);
    if (body.resumeMode !== undefined || body.skipConfirm !== undefined) {
      await writePrepareUserSettings(
        deps.db,
        userId,
        {
          ...(body.resumeMode !== undefined ? { resumeMode: body.resumeMode } : {}),
          ...(body.skipConfirm !== undefined ? { skipConfirm: body.skipConfirm } : {}),
        },
        defaultResumeMode(deps),
        now,
      );
    }
  });
  deps.log.debug(
    `[prepare] account ${userId} saved its Prepare settings (${Object.keys(body)
      .filter((key) => body[key as keyof PrepareSettingsBody] !== undefined)
      .join(', ')})`,
  );
  return { ...(await prepareSettingsOf(deps, userId)), ...kept };
}
