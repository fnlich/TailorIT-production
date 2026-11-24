import type { AutofillAgentSettings } from '@tailorit/shared/autofill';
import type { PrepareOwnerOnlySetting, PrepareSettings } from '@tailorit/shared'; // v34 FIX-API: PrepareOwnerOnlySetting
import {
  FANOUT_ALL,
  FANOUT_SETTINGS_PARTS,
  filtersOn,
  type FanoutAutoSaveRuleBody,
  type FanoutFiltersBody,
  type FanoutPrepareSettingsBody,
  type FanoutSettingsPart,
  type FanoutSettingsSummary,
  type FanoutTargets,
  type PrepareFiltersPatchResponse,
} from '@tailorit/shared/sharing';
import type { AppDeps } from '../../../core/context';
import { readAgentSettings } from '../../autofill/agent/queue';
import { patchAgentSettings } from '../../autofill/agent/rule-patch';
import { prepareSettingsOf, savePrepareSettings } from '../../prepare/settings';
import { serviceOf as prepareFilterService } from '../../prepare-filters/index';
import { assertFilterTextScreened, patchFilterSettings } from '../../prepare-filters/patch';
import { maskedFilters } from '../../prepare-filters/sensitive';
import {
  countOn,
  fanOut,
  isTarget,
  lockGrantIn,
  resolveTargets,
  runOn,
  targetHolds,
  type FanoutActor,
  type FanoutAnswer,
  type FanoutOptions,
  type FanoutTarget,
} from './targets';

// v34 FANOUT (PLAN G3): the Prepare filters, the Prepare settings and the Auto-save rule changed on several profiles at
// once, each with Job settings' Change there (`settings:edit`), through the single-profile PATCH's own write:
// - the filters (prepare-filters/patch.ts): only the fields given; the kept switches (the eligibility switches and the
//   qualification filter) need Sensitive answers' Change there and are otherwise kept and reported (`kept`); the
//   location filter is each owner's own (no place is part of the filters); the custom filter's text is screened once,
//   before any profile changes, when it goes to a share (400 for the whole request); the filters are answered only with
//   Prepare's See;
// - the Prepare settings (prepare/settings.ts savePrepareSettings: the letter mode, the resume mode, Ask before using
//   AI, any of them, each written in place) and the Auto-save rule (autofill/agent/rule-patch.ts).
// Each write locks the share FOR SHARE in its own transaction (lockGrantIn: still live, still holding the box), so a
// Stop waits for it, and a Stop made before it refuses it.
// And the summary: per profile asked what its boxes let A see (the filters with Prepare's See, the eligibility
// switches read as off without Sensitive answers' See; the settings and the rule with Job settings' See).

type Deps = AppDeps;

/** Sensitive answers' Change and See, and Prepare's See, on a target (always on A's own profile). */
const filterViewOf = (target: FanoutTarget) => ({
  changeEligibility: targetHolds(target, 'sensitive:edit'),
  seeEligibility: targetHolds(target, 'sensitive:view'),
  seeFilters: targetHolds(target, 'prepare:view'),
});

/** PATCH /api/profiles/prepare/filters: the same partial filters on every target. */
export async function filtersOnProfiles(
  deps: Deps,
  actor: FanoutActor,
  body: FanoutFiltersBody,
  options: FanoutOptions = {},
): Promise<FanoutAnswer<PrepareFiltersPatchResponse>> {
  const resolved = await resolveTargets(deps, actor, body.targets, ['settings:edit'], options);
  // One screen of the text for every target, before any of them changes, when it goes to someone else's profile.
  if (body.filters.custom?.prompt !== undefined && resolved.entries.some((entry) => isTarget(entry) && entry.grant !== null)) {
    await assertFilterTextScreened(deps, actor.id, body.filters.custom.prompt);
  }
  const service = prepareFilterService(deps);
  const perms = ['settings:edit', ...(options.extraPerms ?? [])] as const;
  return runOn(
    deps,
    actor,
    resolved,
    'settings:edit',
    (target) =>
      patchFilterSettings(deps, service, { ownerId: target.ownerId, actorId: actor.id, ...filterViewOf(target) }, body.filters, {
        screened: true,
        lock: (t) => lockGrantIn(deps, t, actor, target.grant, perms),
      }),
    { ...options, wrote: (value) => value.changed.length > 0 },
  );
}

/**
 * PATCH /api/profiles/prepare/settings: the same Prepare settings on every target. v34 FIX-API (the final sharing
 * review, M1): "Ask before using AI" (skipConfirm) only on A's own profile; on another person's it is kept and reported
 * per profile (`kept`, `keptNote`: only its owner sets this), and a profile where nothing else was asked is not counted.
 */
export async function prepareSettingsOnProfiles(
  deps: Deps,
  actor: FanoutActor,
  body: FanoutPrepareSettingsBody,
  options: FanoutOptions = {},
): Promise<FanoutAnswer<{ settings: PrepareSettings; kept?: PrepareOwnerOnlySetting[]; keptNote?: string }>> {
  const perms = ['settings:edit', ...(options.extraPerms ?? [])] as const;
  const keptOnly = new WeakSet<object>(); // v34 FIX-API: answers where nothing was written
  const onlyOwnerOnly = body.settings.letterMode === undefined && body.settings.resumeMode === undefined;
  return fanOut(
    deps,
    actor,
    body.targets,
    ['settings:edit'],
    async (target) => {
      const { kept, keptNote, ...settings } = await savePrepareSettings(deps, target.ownerId, body.settings, {
        lock: (t) => lockGrantIn(deps, t, actor, target.grant, perms),
        actorId: actor.id, // v34 FIX-API (M1)
      });
      const answer = { settings, ...(kept ? { kept, keptNote } : {}) };
      if (kept && onlyOwnerOnly) keptOnly.add(answer);
      return answer;
    },
    { ...options, wrote: (value) => !keptOnly.has(value) },
  );
}

/** PATCH /api/profiles/auto-apply/rule: the same Auto-save rule change on every target. */
export async function autoSaveRuleOnProfiles(
  deps: Deps,
  actor: FanoutActor,
  body: FanoutAutoSaveRuleBody,
  options: FanoutOptions = {},
): Promise<FanoutAnswer<{ rule: AutofillAgentSettings }>> {
  const perms = ['settings:edit', ...(options.extraPerms ?? [])] as const;
  return fanOut(
    deps,
    actor,
    body.targets,
    ['settings:edit'],
    async (target) => ({
      rule: await patchAgentSettings(deps, target.ownerId, body.rule, { lock: (t) => lockGrantIn(deps, t, actor, target.grant, perms) }),
    }),
    options,
  );
}

/** What the summary reads: which profiles (default every one) and which parts (default all). */
export interface SettingsSummaryOptions extends FanoutOptions {
  targets?: FanoutTargets;
  parts?: readonly FanoutSettingsPart[];
}

/**
 * GET /api/profiles/settings (and MCP's prepare_filters read): per profile asked (default A's own and every live share
 * with `options.extraPerms`), what its boxes let A see of the parts asked. A key that names no live share answers as a
 * refused target. Each share's read is counted in its activity, only for the profiles asked and the parts read (Prepare's
 * area for the filters, Job settings' for the settings).
 */
export async function settingsSummary(deps: Deps, actor: FanoutActor, options: SettingsSummaryOptions = {}): Promise<FanoutSettingsSummary> {
  const parts = new Set<FanoutSettingsPart>(options.parts ?? FANOUT_SETTINGS_PARTS);
  const service = prepareFilterService(deps);
  const read = { ...options, action: 'read' };
  const resolved = await resolveTargets(deps, actor, options.targets ?? FANOUT_ALL, [], options);
  const answer = await runOn(
    deps,
    actor,
    resolved,
    'prepare:view',
    async (target) => {
      const can = {
        seeFilters: targetHolds(target, 'prepare:view'),
        seeSettings: targetHolds(target, 'settings:view'),
        changeSettings: targetHolds(target, 'settings:edit'),
        seeEligibility: targetHolds(target, 'sensitive:view'),
        changeEligibility: targetHolds(target, 'sensitive:edit'),
      };
      const readFilters = can.seeFilters && parts.has('filters');
      const readSettings = can.seeSettings && (parts.has('prepare') || parts.has('autoSave'));
      const stored = readFilters ? await service.settingsOf(target.ownerId) : null;
      const filters = stored ? { ...stored, filters: maskedFilters(stored.filters, can.seeEligibility) } : null;
      const rule = can.seeSettings && parts.has('autoSave') ? await readAgentSettings(deps, target.ownerId) : null;
      if (target.grant && readFilters) countOn(deps, actor, target.grant, 'prepare:view', read);
      if (target.grant && readSettings) countOn(deps, actor, target.grant, 'settings:view', read);
      return {
        can,
        filters,
        filtersOn: filters ? filtersOn(filters.filters) : null,
        prepare: can.seeSettings && parts.has('prepare') ? await prepareSettingsOf(deps, target.ownerId) : null,
        autoSave: rule ? { ruleEnabled: rule.ruleEnabled, minMatch: rule.minMatch } : null,
      };
    },
    // Counted above, per part read (never a write).
    { ...options, wrote: () => false },
  );
  return { profiles: answer.results };
}
