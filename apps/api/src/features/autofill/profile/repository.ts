import {
  AUTOFILL_ANYTHING_ELSE_MAX,
  AUTOFILL_PROFILE_VERSION,
  AutofillProfileSchema,
  AutofillSensitiveSchema,
  EMPTY_AUTOFILL_PROFILE,
  EMPTY_AUTOFILL_SENSITIVE,
  PutAutofillProfileBodySchema,
  type AutofillCoverLetterMode,
  type AutofillProfile,
  type AutofillSensitive,
  type PutAutofillProfileResponse,
} from '@tailorit/shared/autofill';
import { isResumeTemplateId } from '@tailorit/shared';
import { constantsOf } from '../../../core/constants/service';
import { nowIso, type AppDeps } from '../../../core/context';
import type { Dialect } from '../../../core/db/dialect';
import type { SqlParam } from '../../../core/db/types';
import { AppError, forbidden, validationFailed } from '../../../core/http/errors';
import { parseInput } from '../../../core/http/validate';
import { visibleTemplate } from '../../cover-letters/context';
import { readLeniently } from './lenient';
import { dropSensitiveLines, flaggedNoteLines, maskSensitiveLines, mergeHiddenNoteLines, noteWithoutSensitive } from './note-flags'; // v33 SHARE-6: maskSensitiveLines, dropSensitiveLines

// The autofill profile's row (autofill_profiles, one per account). Its two parts are separate columns, so code that
// needs only the profile never selects the sensitive part (work authorization, self-identification, age, pay). Only
// readSensitiveAnswers below reads that column, for four callers: GET /api/autofill/profile/sensitive, the value
// screen of the extension's AI steps (sensitive-screen.ts), which answers yes or no only, the save below, which
// keeps the answers a save without them would lose (the criminal record, snapshot round 2's: ADDED_PLACES), and
// (version 3) the whole part for a save without it, and (v2.0) the prepare filters' person facts
// (features/prepare-filters/person.ts: the citizenships and the clearance, compared on the server only, never sent to
// an AI or shown). No AI module imports this file. No other file touches this table.
//
// Reads are lenient (readLeniently: unknown keys dropped, missing or unreadable fields defaulted), so a row an older
// or newer TailorIT wrote still opens. profile_version 1 is the only stored shape so far: a later one upgrades older
// rows here, before the lenient read. Every write is strict: both parts pass the contract's save schemas.

const PROFILE_CONFLICT =
  'This autofill profile was saved from another tab or window since you opened it. Reload it to see the latest ' +
  'version, then make your changes again.';
const RESUME_GONE = 'That resume was not found. Choose another resume to attach, or the best match for each job.';
// v1.4 D: the templates tailoring writes on (documents.resumeTemplateId, documents.coverLetterTemplateId).
const RESUME_TEMPLATE_UNKNOWN = 'That resume template does not exist. Choose another template, or none.';
const LETTER_TEMPLATE_GONE = 'That cover letter template was not found. Choose another template, or none.';
// end v1.4 D
const SENSITIVE_NOT_IN_SCOPE =
  'This connection may not change work authorization or self-identification answers. Save the profile without them, ' +
  'or change them on the Settings › Autofill page in TailorIT.';

/** A part of the row as it reads: the revision it is at and when it was saved (0 and null before the first save). */
export interface StoredPart<T> {
  revision: number;
  updatedAt: string | null;
  value: T;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

type ConstantsDeps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/**
 * v20 FIX-A (REQ-5): a new profile's cover-letter mode, COVER_LETTER_MODE_DEFAULT as an admin set it: the empty profile
 * is served with it, and a first save that does not send documents.coverLetters stores it (the schema's own default,
 * 'required', would otherwise replace the admin's choice at the person's first save).
 */
export function newProfileLetterMode(deps: ConstantsDeps): AutofillCoverLetterMode {
  return constantsOf(deps).get('COVER_LETTER_MODE_DEFAULT') as AutofillCoverLetterMode;
}

/** Whether `deps` can read the constants (every caller's deps can at runtime; some only type the database). */
const readsConstants = (deps: Partial<ConstantsDeps>): deps is ConstantsDeps =>
  deps.config !== undefined && deps.services !== undefined && deps.log !== undefined && deps.now !== undefined;

/** The profile part's row. */
export const PROFILE_ROW_SQL = 'SELECT profile, revision, updated_at FROM autofill_profiles WHERE user_id = ?';
/** The sensitive part's row. */
export const SENSITIVE_ROW_SQL = 'SELECT sensitive, revision, updated_at FROM autofill_profiles WHERE user_id = ?';

type ProfileRow = { profile: string; revision: number; updated_at: string };
type SensitiveRow = { sensitive: string; revision: number; updated_at: string };

/** The profile a row holds (readAutofillProfile and its twin). */
export function profileOfRow(deps: Partial<ConstantsDeps>, row: ProfileRow | undefined): StoredPart<AutofillProfile> {
  if (!row) {
    const value = structuredClone(EMPTY_AUTOFILL_PROFILE);
    if (readsConstants(deps)) value.documents.coverLetters = newProfileLetterMode(deps);
    return { revision: 0, updatedAt: null, value };
  }
  const profile = readLeniently(AutofillProfileSchema, parseJson(row.profile), structuredClone(EMPTY_AUTOFILL_PROFILE));
  return { revision: row.revision, updatedAt: row.updated_at, value: profile };
}

/** The sensitive answers a row holds (readSensitiveAnswers and its twin). */
export function sensitiveOfRow(row: SensitiveRow | undefined): StoredPart<AutofillSensitive> {
  if (!row) return { revision: 0, updatedAt: null, value: structuredClone(EMPTY_AUTOFILL_SENSITIVE) };
  const answers = readLeniently(
    AutofillSensitiveSchema,
    parseJson(row.sensitive),
    structuredClone(EMPTY_AUTOFILL_SENSITIVE),
  );
  return { revision: row.revision, updatedAt: row.updated_at, value: answers };
}

/**
 * The account's profile, never its sensitive part: the empty profile at revision 0 before the first save, with the
 * cover-letter mode a new profile takes (REQ-5) when `deps` reads the constants.
 */
export async function readAutofillProfile(
  deps: Pick<AppDeps, 'db'> & Partial<ConstantsDeps>,
  userId: string,
): Promise<StoredPart<AutofillProfile>> {
  return profileOfRow(deps, await deps.db.one<ProfileRow>(PROFILE_ROW_SQL, [userId]));
}

/**
 * The account's sensitive answers, for GET /api/autofill/profile/sensitive, the AI steps' value screen
 * (sensitive-screen.ts, yes or no only), saveAutofillProfile and (v2.0) the prepare filters' person facts
 * (features/prepare-filters/person.ts, server only: the citizenships and the clearance) alone: every answer not
 * provided, at revision 0, before the first save. Never call it to decide anything else; never log what it returns.
 */
export async function readSensitiveAnswers(deps: Pick<AppDeps, 'db'>, userId: string): Promise<StoredPart<AutofillSensitive>> {
  return sensitiveOfRow(await deps.db.one<SensitiveRow>(SENSITIVE_ROW_SQL, [userId]));
}

/**
 * The places added after a part's first version, by part, as dotted paths: a save whose body leaves one out (a page or
 * an extension's copy older than it, which never knew it) keeps what is stored there, which the schema's default would
 * otherwise erase. `legal.criminalRecord` came with version 2; the rest with the extension's snapshot round 2
 * (2026-11-07). `anythingElse` (version 3) is kept on its own below, with the note's hidden lines.
 */
const ADDED_PLACES = {
  profile: [
    'contact.phone.type',
    'links.x',
    'links.telegram',
    'preferences.referralSourceCategory',
    'preferences.relocationPlaces',
    'certifications',
    // v1.4 D: the tailoring templates (decision 18); an extension or page older than them keeps the stored choice.
    'documents.resumeTemplateId',
    'documents.coverLetterTemplateId',
    // end v1.4 D
    // v2.0: Prepare & Queue's cover-letter mode (API 8's documents.coverLetters, 'required' or 'always', replacing
    // v1.5's documents.prebuildCoverLetters); an extension or page older than it keeps the stored choice.
    'documents.coverLetters',
    // end v2.0
  ],
  sensitive: [
    'legal.criminalRecord',
    'eeo.raceSubgroups',
    'eeo.raceSelfDescribed',
    'eeo.sexualOrientation',
    'eeo.transgender',
    'legal.restrictiveAgreement',
    'legal.governmentService',
    'legal.relativesAt',
    'legal.essentialFunctions',
    'legal.clearance',
    'legal.citizenships',
  ],
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** True when a save's body holds the key at `path` (dotted) under `part` at all, before the schema gives it a default. */
function sends(input: unknown, part: 'profile' | 'sensitive', path: string): boolean {
  let node: unknown = isRecord(input) ? input[part] : undefined;
  for (const key of path.split('.')) {
    if (!isRecord(node) || !Object.hasOwn(node, key)) return false;
    node = node[key];
  }
  return true;
}

/** `target` (a parsed save, changed in place) with the value at `path` taken from `stored`. */
function keepStored(target: object, stored: object, path: string): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  let into: unknown = target;
  let from: unknown = stored;
  for (const key of keys) {
    if (!isRecord(into) || !isRecord(from)) return;
    into = into[key];
    from = from[key];
  }
  if (isRecord(into) && isRecord(from) && Object.hasOwn(from, last)) into[last] = structuredClone(from[last]);
}

/** The places of `part` this save's body leaves out (see ADDED_PLACES). */
const unsent = (input: unknown, part: 'profile' | 'sensitive') =>
  ADDED_PLACES[part].filter((path) => !sends(input, part, path));

/**
 * The review fix P3: a sensitive part whose omitted places were kept from the stored row (ADDED_PLACES) holds what
 * the save's own answers may no longer agree with: the Asian subgroups go when the races sent no longer hold Asian (an
 * older page changed the races without knowing the subgroups), and the whole part passes the save's cross-field checks
 * again (400 `validation_failed`, keyed "sensitive.…", should anything else disagree), so no stored row ever breaks them.
 */
function agreeWithSent(sensitive: AutofillSensitive): void {
  const { races } = sensitive.eeo;
  if (!(races.state === 'value' && races.value.includes('asian'))) sensitive.eeo.raceSubgroups = [];
  parseInput(SENSITIVE_PART, { sensitive }, 'autofill profile');
}

/** The sensitive part as a save carries it, for agreeWithSent's check. */
const SENSITIVE_PART = PutAutofillProfileBodySchema.pick({ sensitive: true });

/**
 * A veteran answer sent as a value without `isActiveDuty` (older than snapshot round 2) keeps the stored one's, when
 * that is a value too.
 */
function keepActiveDuty(input: unknown, sensitive: AutofillSensitive, stored: AutofillSensitive): void {
  const sent = sensitive.eeo.veteran;
  if (sent.state !== 'value' || stored.eeo.veteran.state !== 'value') return;
  if (sends(input, 'sensitive', 'eeo.veteran.value.isActiveDuty')) return;
  sent.value.isActiveDuty = stored.eeo.veteran.value.isActiveDuty;
}

/** True when a save's body holds `profile.anythingElse` at all, before the schema gives it a default (version 3). */
function sendsAnythingElse(input: unknown): boolean {
  const profile = (input as { profile?: unknown } | null)?.profile;
  return typeof profile === 'object' && profile !== null && Object.hasOwn(profile, 'anythingElse');
}

/** Who saves: the Settings session and a token that may read the sensitive part get it back; another token does not. */
export interface SaveOptions {
  /** The caller may read (and so send) the sensitive part. */
  mayReadSensitive: boolean;
  /**
   * v33 SHARE-6: the caller may change the sensitive answers (default: mayReadSensitive). A caller that reads them but
   * may not change them (Sensitive answers' See without its Change, on a shared profile) never sends the part (the route
   * leaves it out) and never changes a note line that states one (maskSensitiveLines).
   */
  mayWriteSensitive?: boolean;
  /**
   * v33 SHARE-6 (PLAN-sharing §3 "Autofill info", §4 "Where applications go"; the SHARE-6 review): a save made on a
   * profile shared with the signed-in person. It keeps the stored contact block and links whatever the body says
   * (employers reach the owner), and without `mayWriteSensitive` the note's sensitive lines as stored.
   */
  shared?: boolean;
}

/**
 * PUT /api/autofill/profile: checks `input` against the contract's save schemas (400 `validation_failed` with a
 * message per field, keyed "profile.name.first"), then writes both parts in one statement from the revision the page
 * or the side panel loaded: an insert at revision 0, else an update of exactly that revision, so a save from a stale
 * page is refused (409 `revision_conflict`). The resume to attach must be one of the account's. A save without the
 * sensitive part (version 3: the side panel, and any token without profile:sensitive, which may not send it: 403)
 * keeps the stored one as it is; a save without the criminal record answer (a page or a copy older than version 2,
 * which never knew it) keeps that answer, and so does a save without a place snapshot round 2 added to either part
 * (ADDED_PLACES: an X link, a clearance...); a save without the profile's `anythingElse` (older than version 3) keeps the
 * note. Each is read in the same transaction; a first save stores the empty ones. A caller that may not read the
 * sensitive part is answered the note without the lines that state a sensitive answer (noteWithoutSensitive), and its
 * save keeps those lines (mergeHiddenNoteLines; 400 when the note would then pass its cap): audit A2. Returns the row
 * as saved, the sensitive part only for a caller that may read it, and the note's lines that state a sensitive answer
 * (they never reach the AI; for such a caller, the hidden ones).
 */
export async function saveAutofillProfile(
  deps: AppDeps,
  userId: string,
  input: unknown,
  options: SaveOptions = { mayReadSensitive: true },
): Promise<PutAutofillProfileResponse> {
  const body = parseInput(PutAutofillProfileBodySchema, input, 'autofill profile');
  const { revision, profile } = body;
  if (body.sensitive !== undefined && !options.mayReadSensitive) throw forbidden(SENSITIVE_NOT_IN_SCOPE);
  const keepsSensitive = body.sensitive === undefined;
  const sensitiveUnsent = keepsSensitive ? [] : unsent(input, 'sensitive');
  const profileUnsent = unsent(input, 'profile');
  const keepsAnythingElse = !sendsAnythingElse(input);
  const resumeId = profile.documents.resumeId;
  if (resumeId !== null) {
    const own = await deps.db.one('SELECT 1 FROM resumes WHERE id = ? AND user_id = ?', [resumeId, userId]);
    if (!own) throw validationFailed(RESUME_GONE, { 'profile.documents.resumeId': RESUME_GONE });
  }
  // v1.4 D: a template named must exist (a resume template of the editor; a letter template the account may use).
  const { resumeTemplateId, coverLetterTemplateId } = profile.documents;
  if (resumeTemplateId !== null && !isResumeTemplateId(resumeTemplateId)) {
    throw validationFailed(RESUME_TEMPLATE_UNKNOWN, { 'profile.documents.resumeTemplateId': RESUME_TEMPLATE_UNKNOWN });
  }
  if (coverLetterTemplateId !== null && !(await visibleTemplate(deps, userId, coverLetterTemplateId))) {
    throw validationFailed(LETTER_TEMPLATE_GONE, { 'profile.documents.coverLetterTemplateId': LETTER_TEMPLATE_GONE });
  }
  // end v1.4 D
  const now = nowIso(deps);
  const saved = await deps.db.tx(async (t) => {
    // A sensitive part sent: its places left out keep what is stored (see ADDED_PLACES), as does its veteran answer's
    // active duty.
    const activeDutyUnsent =
      body.sensitive?.eeo.veteran.state === 'value' && !sends(input, 'sensitive', 'eeo.veteran.value.isActiveDuty');
    const needsStored = keepsSensitive || sensitiveUnsent.length > 0 || activeDutyUnsent;
    const stored = revision !== 0 && needsStored ? (await readSensitiveAnswers(deps, userId)).value : null;
    const sensitive = body.sensitive ?? stored ?? structuredClone(EMPTY_AUTOFILL_SENSITIVE);
    if (body.sensitive !== undefined && stored) {
      for (const path of sensitiveUnsent) keepStored(sensitive, stored, path);
      keepActiveDuty(input, sensitive, stored);
      // The review fix P3: what was kept must still agree with what was sent (agreeWithSent).
      agreeWithSent(sensitive);
    }
    if (revision !== 0 && profileUnsent.length > 0) {
      const kept = (await readAutofillProfile(deps, userId)).value;
      for (const path of profileUnsent) keepStored(profile, kept, path);
    }
    // v20 FIX-A (REQ-5): a first save that leaves the cover-letter mode out takes the admin's default for a new profile.
    if (revision === 0 && profileUnsent.includes('documents.coverLetters')) {
      profile.documents.coverLetters = newProfileLetterMode(deps);
    }
    // v33 SHARE-6 (PLAN-sharing §3 "Autofill info": the contact block is never editable by B; the SHARE-6 review): on a
    // shared profile the whole contact block (email, phone, address) and the links (LinkedIn, portfolio, the others) stay
    // the owner's, as the preferences' contact details do (me/router.ts): what employers reach and read on every form.
    // The first save keeps the empty ones (GET answers an empty email as the owner's sign-in address).
    if (options.shared) {
      const kept = (await readAutofillProfile(deps, userId)).value;
      profile.contact = kept.contact;
      profile.links = kept.links;
    }
    // v33 SHARE-6: a caller that may not change the sensitive answers never writes, rewrites or erases a note line that
    // states one (on a shared profile without Sensitive answers' Change, with its See or without).
    const mayWriteSensitive = options.mayWriteSensitive ?? options.mayReadSensitive;
    const noteLocked = options.shared === true ? !mayWriteSensitive : options.mayReadSensitive && !mayWriteSensitive;
    if ((revision !== 0 && (keepsAnythingElse || !options.mayReadSensitive)) || (noteLocked && !keepsAnythingElse)) {
      const note = revision === 0 ? '' : (await readAutofillProfile(deps, userId)).value.anythingElse;
      // A caller that may not read the sensitive part never saw the note's sensitive lines: they are kept (audit A2).
      // v33 SHARE-6: a locked caller who saw them sends them back as placeholders again (maskSensitiveLines); one who never
      // saw them adds none (dropSensitiveLines: a line of theirs that states a sensitive answer is left out).
      const sent = !noteLocked
        ? profile.anythingElse
        : options.mayReadSensitive
          ? maskSensitiveLines(profile.anythingElse)
          : dropSensitiveLines(profile.anythingElse);
      profile.anythingElse = keepsAnythingElse ? note : mergeHiddenNoteLines(note, sent);
      if (profile.anythingElse.length > AUTOFILL_ANYTHING_ELSE_MAX) {
        // v30 ST3: the words are the constant MSG_AUTOFILL_NOTE_TOO_LONG.
        const tooLong = constantsOf(deps).message('MSG_AUTOFILL_NOTE_TOO_LONG', { max: AUTOFILL_ANYTHING_ELSE_MAX });
        throw validationFailed(tooLong, { 'profile.anythingElse': tooLong });
      }
    }
    const profileJson = JSON.stringify(profile);
    const sensitiveJson = JSON.stringify(sensitive);
    const written =
      revision === 0
        ? await t.run(
            `INSERT INTO autofill_profiles(user_id, profile_version, profile, sensitive, revision, created_at, updated_at)
             VALUES (?, ?, ?, ?, 1, ?, ?) ON CONFLICT(user_id) DO NOTHING`,
            [userId, AUTOFILL_PROFILE_VERSION, profileJson, sensitiveJson, now, now],
          )
        : await t.run(
            `UPDATE autofill_profiles SET profile_version = ?, profile = ?, sensitive = ?, revision = revision + 1,
               updated_at = ?
             WHERE user_id = ? AND revision = ?`,
            [AUTOFILL_PROFILE_VERSION, profileJson, sensitiveJson, now, userId, revision],
          );
    if (written.changes === 0) throw new AppError('revision_conflict', PROFILE_CONFLICT);
    return { revision: revision + 1, sensitive };
  }, { label: 'saveAutofillProfile' });
  if (!options.mayReadSensitive) {
    const view = noteWithoutSensitive(profile.anythingElse, AUTOFILL_ANYTHING_ELSE_MAX);
    return {
      revision: saved.revision,
      updatedAt: now,
      profile: { ...profile, anythingElse: view.note },
      anythingElseFlaggedLines: view.flagged,
    };
  }
  return {
    revision: saved.revision,
    updatedAt: now,
    profile,
    sensitive: saved.sensitive,
    anythingElseFlaggedLines: flaggedNoteLines(profile.anythingElse),
  };
}

// v2.0 (docs/design/v2.0/05-prepare-flow.md): Prepare & Queue's cover-letter mode
/**
 * Sets the profile's documents.coverLetters ('required' or 'always', API 8) alone, in the stored profile (PUT
 * /api/prepare/settings {letterMode}, MCP prepare_settings), its revision going up: a page or an extension holding an
 * older copy reloads before it saves. A person with no profile yet gets one, empty but for it (revision 1, the empty
 * sensitive part). Nothing else of the profile changes.
 */
export async function setCoverLetterMode(
  deps: Pick<AppDeps, 'db' | 'now'>,
  userId: string,
  mode: AutofillCoverLetterMode,
): Promise<void> {
  const now = deps.now().toISOString();
  await deps.db.atomic(async (t) => {
    if ((await t.run(setLetterModeSql(t.dialect), [mode, now, userId])).changes > 0) return;
    const made = await t.run(INSERT_LETTER_MODE_PROFILE_SQL, letterModeProfileRow(userId, mode, now));
    // v3.0 D2-B (the concurrency audit): a profile another request made since the update (its first save, at the same
    // moment) takes the mode as any stored profile does. On SQLite this transaction runs alone: the insert lands.
    if (made.changes === 0) await t.run(setLetterModeSql(t.dialect), [mode, now, userId]);
  }, { label: 'setCoverLetterMode' });
}

/**
 * setCoverLetterMode's SQL: the mode set in place in one statement, so a save at the same moment is never lost.
 * v3.0 PG-B: through the dialect (SQLite's json_set, PostgreSQL's jsonb_set on the jsonb column). jsonb_set makes only
 * the last key, so `documents` is first kept as it is, or made when a profile lacks it (as SQLite's json_set does).
 */
export const setLetterModeSql = (d: Dialect) => {
  const documents = d.jsonSet('profile', '$.documents', `coalesce(${d.jsonText('profile', '$.documents')}, '{}')`);
  return `UPDATE autofill_profiles SET profile = ${d.jsonSetText(documents, '$.documents.coverLetters', '?')},
  revision = revision + 1, updated_at = ? WHERE user_id = ?`;
};
export const INSERT_LETTER_MODE_PROFILE_SQL = `INSERT INTO autofill_profiles(user_id, profile_version, profile, sensitive,
  revision, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?) ON CONFLICT(user_id) DO NOTHING`;

/** The row of a profile empty but for its cover-letter mode (revision 1, the empty sensitive part). */
export function letterModeProfileRow(userId: string, mode: AutofillCoverLetterMode, now: string): SqlParam[] {
  const profile = { ...structuredClone(EMPTY_AUTOFILL_PROFILE), documents: { ...EMPTY_AUTOFILL_PROFILE.documents, coverLetters: mode } };
  return [userId, AUTOFILL_PROFILE_VERSION, JSON.stringify(profile), JSON.stringify(EMPTY_AUTOFILL_SENSITIVE), now, now];
}
// end v2.0
