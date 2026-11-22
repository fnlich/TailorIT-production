import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { EMPLOYMENT_TYPES_V2, EXPERIENCE_LEVELS, WORK_ARRANGEMENTS } from '@tailorit/shared';
import {
  FANOUT_ALL,
  filtersOn,
  PrepareFiltersPatchSchema,
  PROFILE_SELF,
  type FanoutTargets,
  type PrepareFilterKey,
  type PrepareFiltersPatch,
  type ProfileChoice,
} from '@tailorit/shared/sharing';
import { MCP_ARG_DESCRIPTIONS, MCP_TOOL_DESCRIPTIONS } from '../../ai/prompts/mcp/tool-descriptions';
import { constantsOf } from '../../core/constants/service';
import { AppError, validationFailed } from '../../core/http/errors';
import { serviceOf as prepareFilterService } from '../prepare-filters/index';
import { assertFilterTextScreened, patchFilterSettings } from '../prepare-filters/patch';
import { ELIGIBILITY_SWITCHES, maskedFilters } from '../prepare-filters/sensitive';
import {
  addByLinkOnProfiles,
  fanOut,
  isTarget,
  lockGrantIn,
  resolveTargets,
  runOn,
  saveJobsOnProfiles,
  targetHolds,
  type FanoutActor,
  type FanoutAnswer,
  type FanoutOptions,
  type SavedOnTarget,
} from '../sharing/fanout/index';
import { dayIn, zoneOf } from './dates';
import {
  filterTextFenced,
  firstNameOf,
  internalErrorMessage,
  manyProfiles,
  MCP_TOOL_ACCESS,
  McpRefusal,
  ProfileArg,
  profileRequired,
  profileRequiredMessage,
  type McpSession,
  type McpToolName,
} from './profiles';
import { loadResultSet, MAX_DIRECT_IDS, saveResultSet, setGrantOf, targetsOf } from './result-sets';
import { refuseFencedData, type SaveContext } from './save';
import { toolMeta } from './tool-meta';
import { archivableAmong, archiveSavedJobs, EXAMPLES_MAX, requireConfirm, type BulkInput } from './tools-apps';
import { refuseLinkLeak, refuseWrittenLeaks } from './written';

// v34 MCPFAN (PLAN G5; SP v34 REQUEST.md part 1, "These type of work should work on MCP server as well"): the person's
// own AI works on every profile as one, as the web does (FANWEB), on FANOUT's services (features/sharing/fanout):
// - save_jobs, unsave_jobs and add_job take several profiles in `profile` ("all", or keys joined by commas:
//   profiles.ts manyProfiles); each profile is checked there (a live share holding `mcp` and the tool's box: Job
//   Tracker's Change), its work counted in its activity there (via `mcp`), and the answer is per profile. A result set
//   stays bound to its profile: with several profiles a call takes `ids`, or a setId made on "me" (its jobs are checked
//   again on each profile: one an owner does not see is not_found there), never a set made on another profile. An
//   archive by set confirms the sum of the entries it archives on every profile (MCPDIR's requireConfirm);
// - prepare_filters (a read: Prepare & queue's See each) answers each profile's saved Prepare filters;
// - set_prepare_filters (a write: Job settings' Change each) changes only the fields given (FANOUT's PATCH merge); an
//   eligibility switch without Sensitive answers' Change there is kept and reported (`kept`);
// - a profile the call may not use is refused as naming it alone would be (session.refusalOf); `leftOut` names the
//   shares "all" left out (their boxes do not allow the tool), never why. The two filter tools answer per profile
//   whatever they name; given one profile, its refusal is the tool's error, as every one-profile tool answers.
// Nothing here is counted in session.run's activity (runMany): FANOUT's services count each profile themselves.
//
// The review round (SP v34 build MCPFAN-review-security.md, MCPFAN-review-spec.md; the coordinator's decisions,
// MCPFAN-FIXES.md):
// - decision 1 (security M1): the custom filter's text is written only on the caller's own profile; given for another
//   person's profile, that profile's `custom` is kept and reported (keptNote: the person changes it in TailorIT there).
//   Every read hands the text out fenced as the profile's data, the caller's own included (filterTextFenced);
// - decision 2 (security M2, spec L1): the eligibility switches (noSponsorship, clearanceMismatch) are never read to
//   an AI: null on every profile, named in `hidden` with where the person sees them; a write still sets them when the
//   person asks (Sensitive answers' Change on a share), and its answer names fields, never values;
// - decision 3 (spec M1): what each field means comes in prepare_filters' answer (`fields`) and in set_prepare_filters'
//   refusals (FILTER_FIELDS), never in the descriptions; an unknown field is named;
// - decision 4 (spec M2): `leftOut` (FANOUT's web answer keeps `left`);
// - decision 5 (spec M3): several profiles save SAVE_BATCH_MAX jobs a call: more ids are refused with how to page; a
//   larger set saves its first SAVE_BATCH_MAX and answers the rest as a new set made on "me" (`more`);
// - decision 7 (spec L3): on several profiles a change names at most FIELDS_ON_MANY fields (an echo of a read names
//   nine or more), so a whole read is never copied onto every profile;
// - security L1 / spec L7: the targets are resolved with the tool's box first; only their owners' contacts screen a
//   link or a text; security L2: an archive by set archives on each profile exactly the entries counted there (else
//   that profile is refused, nothing archived); security L3 / spec L6: a malformed `profile` is refused before any work
//   (manyProfiles), and a change's per-profile answer is cut, never refused, when too large (answer.ts).

/** MCP's fan-out options: the activity's channel, and the `mcp` box on every share (FANOUT.md "For MCPFAN"). */
const VIA_MCP: FanoutOptions = { via: 'mcp', extraPerms: ['mcp'] };

/** A set named on several profiles that was made on another one. */
export const MANY_SET_MESSAGE =
  'With several profiles, send "ids", or a setId made on "me" (TailorIT checks its jobs on each profile): a set made on ' +
  'another profile belongs to that profile only.';

/** The review round (spec M3): beside MSG_FANOUT_TOO_MANY_JOBS, how to save more ids on several profiles. */
export const MORE_IDS_HOW =
  'With several profiles, send the next ids in another call, page by page (on one profile, save_jobs takes ' +
  `${MAX_DIRECT_IDS} ids, or a whole setId).`;

/** The review round (spec M3): what the set of a save's remaining jobs is for. */
export const moreHow = (perCall: number) =>
  `These jobs of the set are not saved yet: call save_jobs again with this setId and the same "profile" (${perCall} jobs ` +
  'a call) until an answer holds no "more".';

/** The review round (security L2): a profile whose Saved entries changed between the count and the archive. */
export const CHANGED_SINCE_COUNT =
  "This profile's Saved entries changed after TailorIT counted them, so nothing was archived here. Call again without " +
  '"confirm" for the new total, and ask the person again.';

/** set_prepare_filters' word on kept switches. */
export const KEPT_NOTE =
  "kept: not changed there; on another person's profile the eligibility switches change only with their Sensitive " +
  'answers › Change box (its owner chooses what is shared).';

/** The review round (decision 1): the custom filter sent for other people's profiles, kept there. */
export function keptTextNote(names: readonly string[]): string {
  const where = names.length === 1 ? `${names[0]}'s profile` : `each of these profiles (${names.join(', ')})`;
  return (
    "custom: the custom filter's text is written only on the person's own profile, so it was kept on " +
    `${where}; the person changes it there in TailorIT (Settings › Prepare & Queue).`
  );
}

/**
 * v34 FIX-API (the final sharing review, L1): the custom filter turned off with its text cleared on several profiles:
 * switched off on each, the words cleared on the person's own only.
 */
export function offWordsKeptNote(names: readonly string[]): string {
  const where = names.length === 1 ? `${names[0]}'s profile` : `each of these profiles (${names.join(', ')})`;
  return `custom: switched off; their words kept on ${where} (the custom filter's text changes only on the person's own profile).`;
}

/** The review round (decision 2): what `hidden` means in prepare_filters' answer. */
export const HIDDEN_NOTE =
  'hidden: sensitive answers ("I need visa sponsorship", the clearance switch), null on every profile: TailorIT keeps ' +
  "them from every AI. The person sees them in TailorIT's Settings › Prepare & Queue; set_prepare_filters sets them " +
  'only when the person asks.';

const oneOf = (values: readonly string[]) => `[${values.join('|')}]`;

/** The review round (decision 3, spec M1): what each Prepare filter field means, in MCP's answers and refusals. */
export const FILTER_FIELDS: Readonly<Record<PrepareFilterKey, string>> = {
  locationTypes: `${oneOf(WORK_ARRANGEMENTS)}: only these work arrangements; [] any`,
  jobTypes: `${oneOf(EMPLOYMENT_TYPES_V2)}; [] any`,
  industries: '{mode: include|exclude, ids: industry ids}, or null for any',
  locationMismatch:
    "true: skips jobs that exclude where the profile's owner lives or their time zone (a switch: no place is set here; " +
    'each owner has their own)',
  qualificationMismatch: 'true: skips jobs needing a degree, years or citizenship the owner lacks',
  certificationMismatch: 'true: skips jobs needing a certification the owner lacks',
  autoApplySupport: 'all, or supported: only jobs auto-apply supports',
  minSalaryUsd: 'dollars a year: skips jobs that state lower pay; null: no minimum',
  experienceLevels: `${oneOf(EXPERIENCE_LEVELS)}; [] any`,
  noSponsorship: '"I need visa sponsorship": true skips jobs that say they do not sponsor (hidden)',
  clearanceMismatch: "true: skips jobs requiring a security clearance the owner doesn't hold (hidden)",
  custom: "{enabled, prompt}: a filter judged against its own words; its text is written only on the person's own profile",
};

/** The review round (decision 3, decision 7): what one field sent does. */
export const FIELDS_NOTE =
  'Each field sent replaces that filter on every profile named: send only the fields the person asked to change.';

/** The review round (decision 7): the most filter fields one change sends to several profiles. */
export const FIELDS_ON_MANY = 6;

/** The review round (decision 7): a change for several profiles that names more fields than a person asks for. */
export const TOO_MANY_FIELDS_MESSAGE =
  `With several profiles, set_prepare_filters takes at most ${FIELDS_ON_MANY} fields a call, and only those the person ` +
  'asked to change: each replaces that filter on every profile named. Send any other field in another call.';

/** The caller as FANOUT's services name the one who acts. */
const actorOf = (own: SaveContext): FanoutActor => ({ id: own.caller.id, name: own.caller.name });

/** One profile's line of a per-profile answer. */
type ProfileLine = { profile: ProfileChoice; name?: string } & ({ error: { code: string; message: string } } | Record<string, unknown>);

/** A per-profile answer: each profile's line, and the shares "all" left out (named, never explained). */
export interface PerProfile {
  results: ProfileLine[];
  leftOut?: Array<{ profile: string; name: string }>;
  /** set_prepare_filters: what `kept` means, when a profile kept a field. */
  keptNote?: string;
  /** prepare_filters: the switches never read to an AI, and what every field means. */
  hidden?: string[];
  hiddenNote?: string;
  fields?: Readonly<Record<string, string>>;
  fieldsNote?: string;
}

/** Whether a line is a profile's outcome (not its refusal). */
const isDone = (line: ProfileLine): boolean => !('error' in line);

/**
 * A fan-out's answer in MCP's words: first names only (an owner's name is text they wrote), each refusal as one call
 * naming that profile alone would answer it (session.refusalOf; a failure of TailorIT's own: internalErrorMessage).
 */
async function perProfile<T extends object>(
  session: McpSession,
  tool: McpToolName,
  answer: FanoutAnswer<T>,
  fields: (value: T) => Record<string, unknown>,
): Promise<PerProfile> {
  const nameOf = (profile: ProfileChoice, name: string) => (profile === PROFILE_SELF ? session.caller.name : firstNameOf(name, 'Owner'));
  const results: ProfileLine[] = [];
  for (const result of answer.results) {
    if (result.ok) {
      const { profile, name, ok: _ok, ...value } = result;
      results.push({ profile, name: nameOf(profile, name), ...fields(value as unknown as T) });
      continue;
    }
    const error = result.refused === 'internal' ? { code: 'internal', message: internalErrorMessage(tool) } : await session.refusalOf(result);
    results.push({ profile: result.profile, ...(result.name ? { name: nameOf(result.profile, result.name) } : {}), error });
  }
  const leftOut = answer.left.map((share) => ({ profile: share.profile, name: firstNameOf(share.name, 'Owner') }));
  return { results, ...(leftOut.length > 0 ? { leftOut } : {}) };
}

/** The job ids a call on several profiles names: its `ids`, or a set made on "me" (never one of another profile). */
async function jobIdsOnMe(own: SaveContext, input: BulkInput): Promise<{ ids: number[]; setId: string | null }> {
  if (input.setId !== undefined) {
    const grant = await setGrantOf(own.deps, own.caller.id, input.setId);
    if (grant !== null && grant !== undefined) throw validationFailed(MANY_SET_MESSAGE, { setId: 'Another profile' });
  }
  return targetsOf(own.deps, own.sets, input);
}

/**
 * Runs a tool of FANOUT_TOOLS: on several profiles (`many`, through runMany), or on one (`one`, the tool's own path).
 * A `profile` that is none of the forms is refused before any work (manyProfiles), as a refusal of the tool.
 */
export function onManyOrOne(
  session: McpSession,
  tool: McpToolName,
  args: { profile?: string } & Record<string, unknown>,
  many: (own: SaveContext, targets: FanoutTargets) => unknown,
  one: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  let targets: FanoutTargets | null;
  try {
    targets = manyProfiles(args.profile);
  } catch (error) {
    return session.runMany(tool, args, () => {
      throw error;
    });
  }
  const chosen = targets;
  return chosen ? session.runMany(tool, args, (own) => many(own, chosen)) : one();
}

// ------------------------------------------------------------------------------------------------- save, archive, add

/** What a save did on one profile, as save_jobs answers it on one (refused counts, up to EXAMPLES_MAX [id, reason]). */
function savedFields(value: SavedOnTarget): Record<string, unknown> {
  const refused = Object.fromEntries(
    Object.entries({ tracked: value.alreadyTracked, not_found: value.notFound, not_reached: value.notReached }).filter(([, n]) => n > 0),
  );
  return {
    saved: value.saved,
    restored: value.restored,
    ...(Object.keys(refused).length > 0 ? { refused } : {}),
    // The review round (spec L4): one profile's shape, [id, reason].
    ...(value.notFoundIds.length > 0 ? { examples: value.notFoundIds.slice(0, EXAMPLES_MAX).map((id) => [id, 'not_found']) } : {}),
    ...(value.pendingMatches > 0 ? { resumesPending: value.pendingMatches } : {}),
    ...(value.incomplete ? { incomplete: true } : {}),
  };
}

/**
 * save_jobs on several profiles: the same jobs saved on each (Job Tracker's Change there), dated as on one, at most
 * SAVE_BATCH_MAX a call: more ids are refused with how to page; a larger set saves its first ones and answers the rest
 * as a set made on "me" (`more`), which the next call saves.
 */
export async function saveJobsOnMany(
  session: McpSession,
  own: SaveContext,
  targets: FanoutTargets,
  input: BulkInput & { date?: string; tz?: string },
): Promise<PerProfile & { date: string; more?: { jobs: number; setId: string; how: string } }> {
  const { deps } = own;
  const { ids, setId } = await jobIdsOnMe(own, input);
  const max = constantsOf(deps).get('SAVE_BATCH_MAX');
  if (setId === null && ids.length > max) {
    throw validationFailed(`${constantsOf(deps).message('MSG_FANOUT_TOO_MANY_JOBS', { max })} ${MORE_IDS_HOW}`);
  }
  const date = input.date ?? dayIn(deps.now(), zoneOf(input.tz).tz);
  const answer = await saveJobsOnProfiles(deps, actorOf(own), { targets, jobIds: ids.slice(0, max), occurredOn: date }, VIA_MCP);
  const out = { date, ...(await perProfile(session, 'save_jobs', answer, savedFields)) };
  const rest = ids.slice(max);
  if (setId === null || rest.length === 0 || !out.results.some(isDone)) return out;
  // The rest, as a set made on "me" (the caller's own; each job checked again on each profile when it is saved).
  const next = await saveResultSet(deps, own.sets, (await loadResultSet(deps, own.sets, setId)).source, { rest: setId }, rest, rest.length);
  return { ...out, more: { jobs: rest.length, setId: next.id, how: moreHow(max) } };
}

/**
 * unsave_jobs on several profiles: the jobs' Saved entries archived on each (Job Tracker's Change there; an applied
 * entry never). By set, only with `confirm` equal to the entries it archives on all of them together, and each profile
 * archives exactly the entries counted there (security L2: one that changed meanwhile is refused, nothing archived).
 */
export async function unsaveJobsOnMany(session: McpSession, own: SaveContext, targets: FanoutTargets, input: BulkInput): Promise<PerProfile> {
  const { deps } = own;
  const actor = actorOf(own);
  const { ids, setId } = await jobIdsOnMe(own, input);
  const resolved = await resolveTargets(deps, actor, targets, ['tracker:edit'], VIA_MCP);
  const counted = new Map<ProfileChoice, number>();
  if (setId !== null) {
    for (const entry of resolved.entries) if (isTarget(entry)) counted.set(entry.profile, await archivableAmong(deps, entry.ownerId, ids));
    requireConfirm(input.confirm, [...counted.values()].reduce((sum, n) => sum + n, 0), 'archive {n} Saved entries on these profiles');
  }
  // Each profile's own count again, in its archive's transaction: exactly the entries counted, or nothing there.
  const sameCount = (profile: ProfileChoice) => (archives: number) => {
    if (archives !== counted.get(profile)) throw new AppError('conflict', CHANGED_SINCE_COUNT);
  };
  const answer = await runOn(
    deps,
    actor,
    resolved,
    'tracker:edit',
    (target) => archiveSavedJobs(deps, target.ownerId, ids, setId === null ? undefined : sameCount(target.profile)),
    { ...VIA_MCP, wrote: (value) => value.unsaved > 0 },
  );
  return perProfile(session, 'unsave_jobs', answer, (value) => ({ ...value }));
}

/**
 * add_job on several profiles: Add job's pipeline on each (one of the caller's adds an hour for the link, when a
 * profile may take it); the link refused first when it holds fenced data or the contacts of the caller or of an owner
 * it goes to (TailorIT's server fetches it as given). Only the profiles the call may add on are screened (security L1).
 */
export async function addJobOnMany(session: McpSession, own: SaveContext, targets: FanoutTargets, url: string): Promise<PerProfile> {
  const { deps } = own;
  refuseFencedData(own, url);
  const resolved = await resolveTargets(deps, actorOf(own), targets, ['tracker:edit'], VIA_MCP);
  for (const entry of resolved.entries) if (isTarget(entry)) await refuseLinkLeak({ deps, userId: entry.ownerId, caller: own.caller }, url);
  const answer = await addByLinkOnProfiles(deps, actorOf(own), { targets, url }, { ...VIA_MCP, origin: 'mcp' });
  return perProfile(session, 'add_job', answer, (value) => ({
    state: value.state,
    jobId: value.jobId,
    reason: value.reason,
    message: value.message,
  }));
}

// ------------------------------------------------------------------------------------------------- the Prepare filters

/** The eligibility switches as MCP reads them on every profile (decision 2). */
const HIDDEN_VALUES = Object.fromEntries(ELIGIBILITY_SWITCHES.map((key) => [key, null])) as Record<(typeof ELIGIBILITY_SWITCHES)[number], null>;

/** prepare_filters: each profile's saved filters (Prepare & queue's See there), with what each field means. */
async function readFilters(session: McpSession, own: SaveContext, targets: FanoutTargets): Promise<PerProfile> {
  const service = prepareFilterService(own.deps);
  const answer = await fanOut(
    own.deps,
    actorOf(own),
    targets,
    ['prepare:view'],
    async (target) => {
      // Decision 2: the eligibility switches never reach an AI (`on` reads them as off); decision 1: the custom filter's
      // text fenced as the profile's data, the caller's own included.
      const filters = maskedFilters((await service.settingsOf(target.ownerId)).filters, false);
      return {
        filters: { ...filters, ...HIDDEN_VALUES, custom: { ...filters.custom, prompt: filterTextFenced({ key: target.profile }, filters.custom.prompt) } },
        on: filtersOn(filters),
      };
    },
    { ...VIA_MCP, action: 'read' },
  );
  const out = await perProfile(session, 'prepare_filters', answer, (value) => ({ ...value }));
  if (!out.results.some(isDone)) return out;
  return { ...out, hidden: [...ELIGIBILITY_SWITCHES], hiddenNote: HIDDEN_NOTE, fields: FILTER_FIELDS, fieldsNote: FIELDS_NOTE };
}

/** The fields legend as one line (a refusal's second half). */
const fieldsLine = (): string =>
  `Fields: ${Object.entries(FILTER_FIELDS)
    .map(([key, meaning]) => `${key} = ${meaning}`)
    .join('; ')}. ${FIELDS_NOTE}`;

/** A name the AI sent, quoted short (never its whole text). */
const quoted = (key: string): string => JSON.stringify(key.length > 40 ? `${key.slice(0, 40)}...` : key);

/** A zod issue as patchProblem reads it. */
interface PatchIssue {
  code?: string;
  path: PropertyKey[];
  message: string;
  keys?: string[];
}

/**
 * zod's issues of a filters patch, as one refusal that says what to send (decision 3): an unknown field named (never
 * "Change at least one filter" beside it), a wrong value with its field, and what every field means.
 */
function patchProblem(issues: readonly PatchIssue[]): string {
  const unknown = issues.flatMap((issue) =>
    issue.code === 'unrecognized_keys' ? (issue.keys ?? []).map((key) => [...issue.path.map(String), key].join('.')) : [],
  );
  const wrong = issues.filter((issue) => issue.code !== 'unrecognized_keys' && issue.path.length > 0);
  const parts: string[] = [];
  if (unknown.length > 0) {
    parts.push(`${unknown.slice(0, 5).map(quoted).join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not a Prepare filter field.`);
  }
  for (const issue of wrong.slice(0, 3)) parts.push(`filters.${issue.path.map(String).join('.')}: ${issue.message}.`);
  if (parts.length === 0) parts.push('Send at least one filter to change.');
  return `${parts.join(' ')} ${fieldsLine()}`;
}

/** A change's patch, checked (decision 3's refusal when it is not one). */
function parsedPatch(raw: Record<string, unknown>): PrepareFiltersPatch {
  const parsed = PrepareFiltersPatchSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed(patchProblem(parsed.error.issues as unknown as PatchIssue[]));
  return parsed.data;
}

/** The fields a patch sends. */
const fieldsOf = (patch: PrepareFiltersPatch): PrepareFilterKey[] =>
  (Object.keys(patch) as PrepareFilterKey[]).filter((key) => patch[key] !== undefined);

/**
 * Decision 7 (spec L3): a change for several profiles names only what the person asked for: more than FIELDS_ON_MANY
 * fields is refused before anything (a read sent back whole names nine or more: the two hidden switches come back null
 * and are refused, the custom filter's fenced text is refused as fenced data).
 */
function refuseEcho(patch: PrepareFiltersPatch, targets: FanoutTargets): void {
  const several = targets === FANOUT_ALL || new Set(targets).size > 1;
  if (several && fieldsOf(patch).length > FIELDS_ON_MANY) throw validationFailed(TOO_MANY_FIELDS_MESSAGE);
}

/**
 * On another person's profile: the patch without `custom` when it carries a text (decision 1), and what is kept. v34
 * FIX-API (the final sharing review, L1): `custom` turned off with a text (a "turn it off and clear it") still turns it
 * off there, keeping that person's words (`wordsKept`); a text sent to turn it on, or alone, keeps the whole `custom`.
 */
function onTheirs(patch: PrepareFiltersPatch): { patch: PrepareFiltersPatch; kept: PrepareFilterKey[]; wordsKept: boolean } {
  if (patch.custom?.prompt === undefined) return { patch, kept: [], wordsKept: false };
  const { custom, ...rest } = patch;
  if (custom.enabled === false) return { patch: { ...rest, custom: { enabled: false } }, kept: [], wordsKept: true };
  return { patch: rest, kept: ['custom'], wordsKept: false };
}

/** set_prepare_filters' note on the fields kept anywhere (a switch without the box; the custom filter's text). */
function keptNotes(results: readonly ProfileLine[]): { keptNote?: string } {
  const keptOf = (line: ProfileLine): string[] => (line as { kept?: string[] }).kept ?? [];
  const notes: string[] = [];
  if (results.some((line) => keptOf(line).some((key) => key !== 'custom'))) notes.push(KEPT_NOTE);
  const text = results.filter((line) => keptOf(line).includes('custom')).map((line) => line.name ?? line.profile);
  if (text.length > 0) notes.push(keptTextNote(text));
  // v34 FIX-API (L1): switched off there, the words kept.
  const off = results.filter((line) => (line as { wordsKept?: boolean }).wordsKept === true).map((line) => line.name ?? line.profile);
  if (off.length > 0) notes.push(offWordsKeptNote(off));
  return notes.length > 0 ? { keptNote: notes.join(' ') } : {};
}

/**
 * set_prepare_filters: only the fields given, on each profile (Job settings' Change there; kept switches reported).
 * The custom filter's text goes only to the caller's own profile, screened there as the AI's writing (prompt markup and
 * fenced data, then a contact that is not the caller's or another profile's details); another person's `custom` is kept.
 */
async function setFilters(session: McpSession, own: SaveContext, targets: FanoutTargets, raw: Record<string, unknown>): Promise<PerProfile> {
  const patch = parsedPatch(raw);
  refuseFencedData(own, patch);
  refuseEcho(patch, targets);
  const { deps } = own;
  const actor = actorOf(own);
  // Security L1: the targets first (the tool's box), so nothing is screened against a profile the call never writes.
  const resolved = await resolveTargets(deps, actor, targets, ['settings:edit'], VIA_MCP);
  const text = patch.custom?.prompt;
  if (text !== undefined && text.trim() && resolved.entries.some((entry) => isTarget(entry) && entry.grant === null)) {
    await assertFilterTextScreened(deps, actor.id, text);
    await refuseWrittenLeaks({ deps, userId: own.caller.id, caller: own.caller }, text);
  }
  const service = prepareFilterService(deps);
  const answer = await runOn(
    deps,
    actor,
    resolved,
    'settings:edit',
    async (target) => {
      const here = target.grant === null ? { patch, kept: [] as PrepareFilterKey[], wordsKept: false } : onTheirs(patch);
      if (fieldsOf(here.patch).length === 0) return { changed: [] as PrepareFilterKey[], kept: here.kept, wordsKept: false };
      const who = {
        ownerId: target.ownerId,
        actorId: actor.id,
        changeEligibility: targetHolds(target, 'sensitive:edit'),
        seeEligibility: false,
        seeFilters: targetHolds(target, 'prepare:view'),
      };
      // FANOUT's one-profile merge, the share locked FOR SHARE in its transaction (still live, still holding the boxes).
      const done = await patchFilterSettings(deps, service, who, here.patch, {
        screened: true,
        lock: (t) => lockGrantIn(deps, t, actor, target.grant, resolved.perms),
      });
      return { changed: done.changed as PrepareFilterKey[], kept: [...(done.kept as PrepareFilterKey[]), ...here.kept], wordsKept: here.wordsKept };
    },
    { ...VIA_MCP, wrote: (value) => value.changed.length > 0 },
  );
  const out = await perProfile(session, 'set_prepare_filters', answer, (value) => ({
    changed: value.changed,
    ...(value.kept.length > 0 ? { kept: value.kept } : {}),
    ...(value.wordsKept ? { wordsKept: true } : {}), // v34 FIX-API (L1): switched off; their words kept
  }));
  return { ...out, ...keptNotes(out.results) };
}

/** The profiles a filters call names: several, one, or none ("me" for a read; a change needs one once others exist). */
async function filterTargets(session: McpSession, tool: McpToolName, profile: string | undefined): Promise<{ targets: FanoutTargets; single: boolean }> {
  const many = manyProfiles(profile);
  if (many !== null) return { targets: many, single: false };
  if (profile !== undefined) return { targets: [profile as ProfileChoice], single: true };
  if (MCP_TOOL_ACCESS[tool].write && (await session.grants()).length > 0) throw profileRequired(await session.items(), profileRequiredMessage(tool));
  return { targets: [PROFILE_SELF], single: true };
}

/**
 * Runs a filters tool on the profiles its `profile` names; given one profile, its refusal is the tool's error (as on
 * every one-profile tool), and a failure of TailorIT's own there the tool's internal error.
 */
function onProfiles(
  session: McpSession,
  tool: McpToolName,
  profile: string | undefined,
  work: (own: SaveContext, targets: FanoutTargets) => Promise<PerProfile>,
) {
  return session.runMany(tool, { profile }, async (own) => {
    const { targets, single } = await filterTargets(session, tool, profile);
    const answer = await work(own, targets);
    const only = answer.results[0];
    if (single && only && 'error' in only) {
      const { code, message } = only.error as { code: string; message: string };
      if (code === 'internal') throw new Error(`${tool} failed on its one profile`);
      throw new McpRefusal(code, code as AppError['code'], message);
    }
    return answer;
  });
}

/** The two filters tools (server.ts registers them with one marked line). */
export function registerFanoutTools(server: McpServer, session: McpSession): void {
  server.registerTool(
    'prepare_filters',
    {
      ...toolMeta('prepare_filters'),
      description: MCP_TOOL_DESCRIPTIONS.prepare_filters,
      inputSchema: { profile: ProfileArg },
    },
    ({ profile }) => onProfiles(session, 'prepare_filters', profile, (own, targets) => readFilters(session, own, targets)),
  );

  server.registerTool(
    'set_prepare_filters',
    {
      ...toolMeta('set_prepare_filters'),
      description: MCP_TOOL_DESCRIPTIONS.set_prepare_filters,
      // Checked in code with PrepareFiltersPatchSchema (only the fields given): the schema's enums would cost the AI tokens.
      inputSchema: { filters: z.record(z.string(), z.unknown()).describe(MCP_ARG_DESCRIPTIONS.filters), profile: ProfileArg },
    },
    ({ filters, profile }) => onProfiles(session, 'set_prepare_filters', profile, (own, targets) => setFilters(session, own, targets, filters)),
  );
}
