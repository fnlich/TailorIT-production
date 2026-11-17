import type { CoverLetterMode, PrepareResumeMode, PrepareSettings, PrepareSettingsBody } from '@tailorit/shared';
import type { AppDeps } from '../../core/context';
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

/** PUT /api/prepare/settings: any of the three; the rest stay as they are. Answers the settings as saved. */
export async function savePrepareSettings(deps: Deps, userId: string, body: PrepareSettingsBody): Promise<PrepareSettings> {
  const now = deps.now().toISOString();
  await deps.db.tx(async () => {
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
  return prepareSettingsOf(deps, userId);
}
