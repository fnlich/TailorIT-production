import { PrepareFiltersSchema, type PrepareFilters } from '@tailorit/shared';
import {
  FILTER_KEPT_SWITCHES,
  PrepareFilterKeySchema,
  type FilterKeptSwitch,
  type PrepareFilterKey,
  type PrepareFiltersPatch,
  type PrepareFiltersPatchResponse,
} from '@tailorit/shared/sharing';
import { heldGrants } from '../../core/auth/grants';
import type { AppDeps } from '../../core/context';
import type { DbTx } from '../../core/db/types';
import { validationFailed } from '../../core/http/errors'; // v34 MCPFAN
import { refuse } from '../../core/http/refuse';
import { holdsPromptMarkup } from '../autofill/ai/untrusted';
import { holdsFencedData } from '../mcp/screen'; // v34 INT-A
import { maskedFilters } from './sensitive';
import type { PrepareFilterServiceInternals } from './service';
import { checkFilters, ensureUserSettingsRow, filterSettingsOf, saveFilterSettings, type FilterSettingsRow } from './settings';

// v34 FANOUT (PLAN G3): some of the Prepare filters, changed on one profile. The one merge PATCH /api/prepare/filters and
// PATCH /api/profiles/prepare/filters (each target) run:
// - only the fields given change; each replaces the saved one whole (a list, `industries`), but `custom`, whose
//   `enabled` and `prompt` change apart. The location filter is the `locationMismatch` switch alone: it compares with
//   each owner's own Where you live, and no place is part of the filters, so none is ever copied;
// - without Sensitive answers' Change there (`changeEligibility`), a kept switch (FILTER_KEPT_SWITCHES: the eligibility
//   switches and the qualification filter) given in the patch is not changed and is reported as kept, whatever its saved
//   value (a report that depended on it would tell someone without Sensitive answers' See what it is);
// - `changed` is every field given and applied (never compared with the saved values: the FANOUT review's sharing 1);
//   the filters themselves are answered only with Prepare & queue's See there (`seeFilters`), as the GET is;
// - the custom filter's text written on SOMEONE ELSE's profile (the writer is not the owner) is screened as text
//   written for another person's AI is (assertFilterTextScreened: the one function INT points at MCPDIR's fenced-data
//   check); refused as a whole (validation_failed on the field). The owner's own words are theirs, as in v3.3: MCP's
//   wrapper defuses them when another person's AI reads them (v33-share8-review pins it);
// - the read, the merge and the write are one transaction with the owner's user_settings row locked (FOR UPDATE), so a
//   change made at the same moment (the owner's own, another tab's) is never written back over (the review's sharing 8,
//   spec 5); a caller's `lock` runs in it once the row is held (the fan-out locks the share FOR SHARE: a Stop waits);
// - the merged filters are checked as the PUT checks them (a custom filter that is on needs its text, of at most
//   CUSTOM_FILTER_PROMPT_MAX_CHARS); nothing is written, and the revision stays, when no saved value changes.
// v34 MCPFAN (the MCPFAN security review, L4): someone who may change the filters there but not read them (Job settings'
// Change without Prepare & queue's See) has the custom filter part judged on the patch alone (checkPatchAlone), before
// anything is read: a refusal that depended on the saved filters (the text there, the switch's state) would tell them.

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** Who changes whose filters, with what the share lets them do there (everything on their own profile). */
export interface FiltersPatchWho {
  /** Whose filters: the profile's owner. */
  ownerId: string;
  /** Who changes them: the signed-in person (their shares' tripwires screen the custom filter's text). */
  actorId: string;
  /** Sensitive answers' Change on that profile: the kept switches change too. */
  changeEligibility: boolean;
  /** Sensitive answers' See: the answer shows the eligibility switches as saved (else as off). */
  seeEligibility: boolean;
  /** Prepare & queue's See: the answer shows the filters at all (else null). */
  seeFilters: boolean;
}

/** How a change runs: inside a caller's lock, and whether the custom text was screened already. */
export interface FiltersWriteOptions {
  /** Run in the write's transaction once the row is held (the fan-out: the share locked FOR SHARE, still live and holding its box). */
  lock?: (t: DbTx) => Promise<void>;
  /** The custom filter's text was screened already (the fan-out screens once for every profile). */
  screened?: boolean;
}

/** The field a refusal of the custom filter's text names, in the form that sent it. */
export type FilterTextField = 'filters.custom.prompt';

/**
 * Refuses (validation_failed, MSG_FANOUT_FILTER_TEXT) a custom filter text holding prompt markup, or fenced data: a
 * TailorIT data label or its id (MCPDIR's passive marker, which replaced the planted tripwires), or a legacy tripwire
 * of one of `actorId`'s shares (stored before v3.4, never handed out now, still refused as MCP saves refuse it). The
 * one screen of a custom filter's text (the PUT, the PATCH, the fan-out). v34 INT-A (the FANOUT review's sharing 6):
 * MCPDIR's check (features/mcp/screen.ts holdsFencedData) beside the markup screen.
 */
export async function assertFilterTextScreened(deps: Deps, actorId: string, text: string): Promise<void> {
  const refusal = await filterTextRefusal(deps, actorId, text);
  if (refusal) throw refusal;
}

/** v34 FIX-API (the final sharing review, L2): assertFilterTextScreened's refusal, or null, without throwing. */
export async function filterTextRefusal(deps: Deps, actorId: string, text: string): Promise<Error | null> {
  if (!text.trim()) return null;
  const legacy = (await heldGrants(deps, actorId)).map((grant) => grant.canary);
  if (!holdsPromptMarkup(text) && !holdsFencedData([text], legacy)) return null;
  const field: FilterTextField = 'filters.custom.prompt';
  const words = deps.services.constants?.message('MSG_FANOUT_FILTER_TEXT') ?? '';
  return refuse(deps, 'validation_failed', 'MSG_FANOUT_FILTER_TEXT', undefined, { fields: { [field]: words } });
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** v34 MCPFAN: checkPatchAlone's words (one answer for every profile whose filters the writer may not read). */
export const MSG_FILTER_PATCH_ALONE =
  "This profile's filters are not shared with you, so a change of its custom filter has to stand on its own: turn the " +
  'filter on together with its text, and clear the text only while turning it off.';

/**
 * v34 MCPFAN (the MCPFAN security review, L4): the custom filter part of a patch judged without the saved filters, for
 * a writer who may not read them: "enabled": true needs a text in the same patch, and an empty text needs "enabled":
 * false. The same answer whatever is saved (the merged check below could then never refuse on what it read).
 */
export function checkPatchAlone(patch: PrepareFiltersPatch): void {
  const custom = patch.custom;
  if (!custom) return;
  const text = custom.prompt?.trim();
  const turnsOnWithoutText = custom.enabled === true && !text;
  const clearsWhileOn = custom.prompt !== undefined && !text && custom.enabled !== false;
  if (turnsOnWithoutText || clearsWhileOn) {
    throw validationFailed(MSG_FILTER_PATCH_ALONE, { 'filters.custom.prompt': 'Send the text with the switch on, or turn the switch off' });
  }
}

/**
 * The saved filters with `patch` laid over them (kept switches as saved when `changeEligibility` is false): `applied`,
 * the fields given and applied; `changed`, those whose saved value differs (whether to write); `kept`.
 */
export function mergeFilters(
  stored: PrepareFilters,
  patch: PrepareFiltersPatch,
  changeEligibility: boolean,
): { next: PrepareFilters; applied: PrepareFilterKey[]; changed: PrepareFilterKey[]; kept: FilterKeptSwitch[] } {
  const kept: FilterKeptSwitch[] = [];
  const applied: PrepareFilterKey[] = [];
  const merged: Record<string, unknown> = { ...stored };
  for (const key of PrepareFilterKeySchema.options) {
    const value = patch[key];
    if (value === undefined) continue;
    if (!changeEligibility && (FILTER_KEPT_SWITCHES as readonly string[]).includes(key)) {
      kept.push(key as FilterKeptSwitch);
      continue;
    }
    applied.push(key);
    merged[key] = key === 'custom' ? { ...stored.custom, ...(value as PrepareFiltersPatch['custom']) } : value;
  }
  const next = PrepareFiltersSchema.parse(merged);
  const changed = PrepareFilterKeySchema.options.filter((key) => !same(next[key], stored[key]));
  return { next, applied, changed, kept };
}

/**
 * The owner's filters, read with the user_settings row locked (FOR UPDATE) in `t`, then `decide` → the filters to save
 * (null: nothing), checked and saved in the same transaction. Answers what `decide` answered beside.
 */
async function writeLocked<R>(
  deps: Deps,
  ownerId: string,
  options: FiltersWriteOptions,
  decide: (stored: PrepareFilters) => { next: PrepareFilters | null; result: R },
): Promise<R> {
  return deps.db.tx(
    async (t) => {
      await ensureUserSettingsRow(deps, ownerId);
      const row = await t.one<FilterSettingsRow>('SELECT prepare_filters, filters_revision FROM user_settings WHERE user_id = ? FOR UPDATE', [ownerId]);
      // The caller's lock (the fan-out's share, FOR SHARE) once the row is held: nothing else writes it meanwhile.
      await options.lock?.(t);
      const { next, result } = decide(filterSettingsOf(deps, row).filters);
      if (next) {
        checkFilters(deps, next);
        await saveFilterSettings(deps, ownerId, next);
      }
      return result;
    },
    { label: 'writePrepareFilters' },
  );
}

/**
 * PATCH /api/prepare/filters's and the fan-out's change of `who.ownerId`'s filters: screened, merged in one locked
 * transaction, saved when a saved value changed (filters_revision + 1). Answers what was applied and kept, and the
 * filters as the GET reads them for `who` (null without Prepare & queue's See).
 */
export async function patchFilterSettings(
  deps: Deps,
  service: Pick<PrepareFilterServiceInternals, 'settingsOf'>,
  who: FiltersPatchWho,
  patch: PrepareFiltersPatch,
  options: FiltersWriteOptions = {},
): Promise<PrepareFiltersPatchResponse> {
  // v34 FIX-API (the final sharing review, L2): the PATCH checks only what it changes: words equal to the stored ones
  // (the owner's own, sent back with the switch turned on) are theirs and never screened, compared in the locked
  // transaction, as the PUT compares them. Without Prepare & queue's See the text is judged alone, whatever is stored
  // (a refusal that depended on the stored words would tell them: the MCPFAN security review's L4).
  const textRefusal =
    patch.custom?.prompt !== undefined && who.actorId !== who.ownerId && !options.screened
      ? await filterTextRefusal(deps, who.actorId, patch.custom.prompt)
      : null;
  if (textRefusal && !who.seeFilters) throw textRefusal;
  if (!who.seeFilters) checkPatchAlone(patch); // v34 MCPFAN (the MCPFAN security review, L4)
  const { applied, kept } = await writeLocked(deps, who.ownerId, options, (stored) => {
    if (textRefusal && patch.custom?.prompt !== stored.custom.prompt) throw textRefusal; // v34 FIX-API (L2)
    const merged = mergeFilters(stored, patch, who.changeEligibility);
    return { next: merged.changed.length > 0 ? merged.next : null, result: merged };
  });
  if (!who.seeFilters) return { filters: null, revision: null, locationKnown: null, timeZoneKnown: null, changed: applied, kept };
  const answer = await service.settingsOf(who.ownerId);
  return { ...answer, filters: maskedFilters(answer.filters, who.seeEligibility), changed: applied, kept };
}

/**
 * PUT /api/prepare/filters: the whole filters, the kept switches kept without Sensitive answers' Change, in the same
 * locked transaction as the PATCH; the custom text written on someone else's profile screened when it is not the saved
 * one (a text saved before the screen never stops an unrelated change).
 */
export async function replaceFilterSettings(
  deps: Deps,
  who: Pick<FiltersPatchWho, 'ownerId' | 'actorId' | 'changeEligibility'>,
  filters: PrepareFilters,
  keep: (next: PrepareFilters, stored: PrepareFilters) => PrepareFilters,
): Promise<void> {
  // Screened outside the transaction (it reads the writer's shares). A text already saved was screened, or saved before
  // the screen existed: it is never what stops an unrelated change.
  const before = await deps.db.one<FilterSettingsRow>('SELECT prepare_filters, filters_revision FROM user_settings WHERE user_id = ?', [who.ownerId]);
  if (who.actorId !== who.ownerId && filterSettingsOf(deps, before).filters.custom.prompt !== filters.custom.prompt) {
    await assertFilterTextScreened(deps, who.actorId, filters.custom.prompt);
  }
  await writeLocked(deps, who.ownerId, {}, (stored) => ({ next: who.changeEligibility ? filters : keep(filters, stored), result: undefined }));
}
