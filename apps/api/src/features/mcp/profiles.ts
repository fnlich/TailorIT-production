import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { customScopeLine } from '../../ai/prompts/mcp/instructions';
import { PREPARE_ACTIVE_STATES } from '@tailorit/shared/prepare';
import {
  FANOUT_ALL,
  isProfileKey,
  PROFILE_SELF,
  type FanoutRefused,
  type FanoutTargets,
  type ProfileChoice,
  type ProfileKey,
  type SharePermission,
} from '@tailorit/shared/sharing';
import { payerOfGrant, type PersonPayer } from '../../core/accounts/payer';
import { grantHolds, heldGrants, reachableProfiles, resolveGrant, type HeldGrant, type LiveGrant } from '../../core/auth/grants';
import type { AppDeps } from '../../core/context';
import { constantsOf } from '../../core/constants/service';
import { AppError } from '../../core/http/errors';
import { untrustedLines } from '../autofill/ai/untrusted'; // v33 SHARE-8 (review)
import { areaOfPermission, countActivity } from '../sharing/activity';
import { fittedAnswer, TIMED_OUT, tooSlowMessage, withinTime } from './answer'; // v34 MCPDIR
import type { PrepareAdapter } from './prepare';
import { dataFence, dataLabel } from './screen'; // v34 MCPDIR
import { setGrantOf, SET_GONE, type SetScope } from './result-sets';
import type { SaveContext } from './save';
import type { McpCaller } from './tokens';

// v33 SHARE-8 (PLAN F9 "MCP"; SP v33 PLAN-sharing.md §7): the MCP server for every profile its caller may work on.
// The token names the CALLER (B): whose plan admits MCP, whose settings, custom instructions, read mark, reports,
// own-AI limits and rate limits apply, and who pays (B's Payer: payerOfGrant(grant, 'mcp') on a shared profile, B's own
// on B's own profile; never ownPayer under features/mcp). Each tool call names a PROFILE (`profile`: "me" or a key):
// whose data it reads and writes (the Tracker, the Prepares and their kits, mcp_prepare_work, the chosen resume, the
// letter's person). Nothing about the profile is stored between calls: every call reads the grant again
// (core/auth/grants.ts resolveGrant: live, the caller's, sharing on), and a key that is unknown, someone else's or
// ended gets one answer (profile_ended, no name). The grant must hold `mcp` and the tool's permission (MCP_TOOL_ACCESS).
// - Reads default to "me". Once the caller has a live grant (with `mcp`), a write without `profile` is refused
//   (PROFILE_REQUIRED, with the keys) unless a handle fixes the profile (a setId, runId or cursor: result sets are bound
//   to their profile and grant, result-sets.ts); a per-job read (prepare_job_context, prepare_prompt) without `profile`
//   takes the one profile where the caller's own AI prepares that job, and names none when it is prepared on several.
// - Text the owner wrote, read on another person's profile, is wrapped `<untrusted source="profile:<key>">`, ending
//   with a data label (v34 MCPDIR: a fresh id per call, screen.ts dataLabel; it was the grant's tripwire line); every
//   save is screened for data labels and for every tripwire of the caller's grants handed out before v3.4
//   (profile_grants.canary, heldGrants), so fenced text copied into a save keeps nothing.
// - Every successful call on another person's profile is counted in the share's activity (countActivity, via `mcp`).
// v34 MCPFAN (PLAN G5): save_jobs, unsave_jobs, add_job, prepare_filters and set_prepare_filters also take several
// profiles in `profile` ("all", or keys joined by commas: profileTargets). Those calls run through runMany on FANOUT's
// services (features/sharing/fanout: each profile checked there, with `mcp`, and counted in its activity there) and
// answer per profile (tools-fanout.ts); any other tool given several profiles is refused (ONE_PROFILE_MESSAGE). The review
// round: on those five a `profile` in none of the forms is refused before any work (manyProfiles), and their
// PROFILE_REQUIRED names "all" too; a custom filter's text is fenced on every profile (filterTextFenced).

declare const CALLER: unique symbol;
declare const PROFILE: unique symbol;
/** The account the token acts for (B). */
export type CallerId = string & { readonly [CALLER]: true };
/** The account whose data a call touches (A on a shared profile, B on their own). */
export type ProfileId = string & { readonly [PROFILE]: true };

/** One MCP tool's access: the permission it needs on another person's profile (with `mcp`), and whether it writes. */
interface ToolAccess {
  /** null: the caller's own (instructions, report_unsupported, set_prepare_settings) or every profile (prepare_queue). */
  perm: SharePermission | null;
  write: boolean;
}

/** PLAN-sharing §7's table: every tool, its permission on another profile (plus `mcp`), and the write tools. */
export const MCP_TOOL_ACCESS = {
  prepare_queue: { perm: null, write: false },
  prepare_job_context: { perm: 'prepare:run', write: false },
  prepare_save_analysis: { perm: 'prepare:run', write: true },
  prepare_save_resume: { perm: 'prepare:run', write: true },
  prepare_save_cover_letter: { perm: 'prepare:run', write: true },
  prepare_save_answers: { perm: 'prepare:run', write: true },
  prepare_mark: { perm: 'prepare:run', write: true },
  prepare_prompt: { perm: 'prepare:run', write: false },
  // Read-only on another person's profile (q1-tools.ts refuses a change there). v33 SHARE-8 (review): it reads the
  // owner's Job settings there (the letter and resume modes): the web's GET /api/prepare/settings box, settings:view.
  prepare_settings: { perm: 'settings:view', write: false },
  // v34 MCPDIR (PLAN G8 addendum): the write half, the caller's own settings only (no `profile`).
  set_prepare_settings: { perm: null, write: true },
  search_jobs: { perm: 'tracker:view', write: false },
  job_details: { perm: 'tracker:view', write: false },
  save_jobs: { perm: 'tracker:edit', write: true },
  unsave_jobs: { perm: 'tracker:edit', write: true },
  queue_remove: { perm: 'queue:edit', write: true },
  queue_clear_finished: { perm: 'queue:edit', write: true },
  queue_list: { perm: 'prepare:view', write: false },
  list_applications: { perm: 'tracker:view', write: false },
  application_stats: { perm: 'tracker:view', write: false },
  application_timeline: { perm: 'tracker:view', write: false },
  report_unsupported: { perm: null, write: false },
  instructions: { perm: null, write: false },
  filter_jobs: { perm: 'prepare:run', write: false },
  custom_filter_verdicts: { perm: 'prepare:run', write: true },
  prepare_start: { perm: 'prepare:run', write: true },
  ai_search_jobs: { perm: 'tracker:view', write: false },
  own_ai_context: { perm: 'documents:edit', write: false },
  own_ai_save: { perm: 'documents:edit', write: true },
  add_job: { perm: 'tracker:edit', write: true },
  // v34 MCPFAN (PLAN G5 and its G8 addendum): the Prepare filters, read (Prepare & queue's See, as the web's GET) and
  // changed (Job settings' Change, as the web's PATCH; the eligibility switches also Sensitive answers' Change).
  prepare_filters: { perm: 'prepare:view', write: false },
  set_prepare_filters: { perm: 'settings:edit', write: true },
} as const satisfies Record<string, ToolAccess>;
export type McpToolName = keyof typeof MCP_TOOL_ACCESS;

/**
 * The `profile` argument of a tool: "me" or a key, checked in code (an unknown, foreign or ended key: PROFILE_GONE).
 * Plain, with no description (the instructions' PROFILES say what it takes): 28 characters of tools/list each.
 */
export const ProfileArg = z.string().optional();

/** The tools that take `profile` (27: all but instructions, report_unsupported, set_prepare_settings, prepare_queue). */
export const PROFILE_TOOLS = (Object.keys(MCP_TOOL_ACCESS) as McpToolName[]).filter((tool) => MCP_TOOL_ACCESS[tool].perm !== null);

// v34 MCPFAN (PLAN G5) -------------------------------------------------------------------------------------------------

/**
 * The profiles a `profile` argument names when it names several (save_jobs, unsave_jobs, add_job, prepare_filters and
 * set_prepare_filters take them: tools-fanout.ts): `'all'` (the word alone or among keys), or the keys
 * of a comma-separated list (`'me'` and grant keys; repeats are left for the fan-out to drop). Null for one profile (or
 * none): that call keeps the one-profile path.
 */
export function profileTargets(value: unknown): FanoutTargets | null {
  if (typeof value !== 'string') return null;
  const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.includes(FANOUT_ALL)) return FANOUT_ALL;
  if (!value.includes(',')) return null;
  // A malformed part is no key: the fan-out answers it as an unknown one (PROFILE_GONE here).
  return parts.length === 0 ? null : (parts as ProfileChoice[]);
}

/** The refusal of several profiles on a tool that works on one. */
export const ONE_PROFILE_MESSAGE = 'This tool works on one profile per call: send "me" or one key, and call it again for each profile.';

/** The tools that take several profiles in `profile` (tools-fanout.ts). */
export const FANOUT_TOOLS: ReadonlySet<McpToolName> = new Set<McpToolName>(['save_jobs', 'unsave_jobs', 'add_job', 'prepare_filters', 'set_prepare_filters']);

/**
 * The review round (security L3, spec L6): what `profile` takes on those tools, when a part is none of these forms
 * ("All", "all profiles", a name, a long text). Answered before any work, without echoing the part.
 */
export const PROFILE_FORMS_MESSAGE =
  'profile: send "me", a key from PROFILES, "all" (yours and every shared profile that allows this), or keys joined by commas.';

/**
 * The profiles `profile` names on a tool that takes several (FANOUT_TOOLS): null for one profile or none (the
 * one-profile path), else "all" or the list. A part that is neither "me", "all" nor shaped as a key refuses the whole
 * call before any work (PROFILE_FORMS_MESSAGE): no text put there comes back, and a near miss learns the forms.
 */
export function manyProfiles(value: string | undefined): FanoutTargets | null {
  if (value === undefined) return null;
  const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part !== PROFILE_SELF && part !== FANOUT_ALL && !isProfileKey(part))) {
    throw new AppError('validation_failed', PROFILE_FORMS_MESSAGE);
  }
  return profileTargets(value);
}
// end v34 MCPFAN

/** The caller as a tool call sees them. */
export interface McpCallerInfo {
  id: CallerId;
  /** Their first name as the instructions and the scope line say it (firstNameOf). */
  name: string;
  /** The caller's own payer (their own profile); on a shared profile McpProfile.payer is theirs under the grant. */
  payer: PersonPayer;
}

/** The profile one call works on. */
export interface McpProfile {
  /** "me", or the grant's key. */
  key: typeof PROFILE_SELF | ProfileKey;
  userId: ProfileId;
  /** The live grant (null: the caller's own profile). */
  grant: LiveGrant | null;
  /** Whose profile, by first name (the caller's own on "me"). */
  name: string;
  /** May see the owner's sensitive answers (eligibility reasons by name): always on one's own profile. */
  sensitive: boolean;
  /** Who pays for AI started there: the caller, under the grant on a shared profile. */
  payer: PersonPayer;
}

// ------------------------------------------------------------------------------------------------- names and texts

/** A name as the instructions may say it: its first word's letters only (an owner's name is text they wrote). */
export function firstNameOf(name: string, fallback: string): string {
  const word = name.normalize('NFKC').trim().split(/\s+/)[0] ?? '';
  const clean = word.replace(/[^\p{L}\p{M}'’.-]/gu, '').slice(0, 24);
  return /\p{L}/u.test(clean) ? clean : fallback;
}

/** The refusal of a profile the caller may not use: unknown, someone else's, the owner's own key, ended (one answer). */
export const PROFILE_GONE =
  'That profile is not shared with you (any more): use "me" or a key from PROFILES (call instructions for the current list).';
/** The refusal of a tool the share does not allow. */
export const PROFILE_NOT_ALLOWED =
  "That profile's share does not let your AI do this. Tell the person; its owner chooses what is shared.";
/** The refusal of a write that names no profile while the caller has more than one (PROFILE_REQUIRED). */
export const PROFILE_REQUIRED_MESSAGE =
  'Name the profile: send "profile": "me" (the person\'s own) or a key below. Each profile is a different person.';
/** v34 MCPFAN (the spec review, L5): PROFILE_REQUIRED on a tool of FANOUT_TOOLS also teaches "all" and lists (no tools/list cost). */
export const PROFILE_REQUIRED_MANY_MESSAGE =
  `${PROFILE_REQUIRED_MESSAGE} This tool also takes "all" (yours and every shared profile that allows it) or keys joined by commas.`;
/** The PROFILE_REQUIRED words for `tool`. */
export const profileRequiredMessage = (tool: McpToolName): string =>
  FANOUT_TOOLS.has(tool) ? PROFILE_REQUIRED_MANY_MESSAGE : PROFILE_REQUIRED_MESSAGE;
/** A per-job read whose job the caller's AI prepares on several profiles. */
export const PROFILE_AMBIGUOUS_MESSAGE =
  'This job is being prepared on more than one profile: send "profile" with the key of the one you work on.';

/** One profile as PROFILE_REQUIRED and the instructions list it. */
export interface ProfileItem {
  key: string;
  name: string;
}

/** A refusal with the answer code MCP clients read and extra fields (PROFILE_REQUIRED's keys). */
export class McpRefusal extends AppError {
  readonly answerCode: string;
  readonly extra: Record<string, unknown>;
  constructor(answerCode: string, code: AppError['code'], message: string, extra: Record<string, unknown> = {}) {
    super(code, message);
    this.answerCode = answerCode;
    this.extra = extra;
  }
}

/**
 * v34 FIX-API (the final directory review, D1): a removal's preview (MCPDIR's confirm handshake, tools-apps.ts
 * requireConfirm): nothing changed, and the count to send as `confirm`. execute() answers it as a success (the call was
 * valid: Claude's directory asks every tool to answer valid parameters with a success), never as a tool error.
 */
export class ConfirmPreview extends Error {
  readonly count: number;
  constructor(count: number, message: string) {
    super(message);
    this.name = 'ConfirmPreview';
    this.count = count;
  }
}

/** v34 FIX-API (D1): what a preview answers. `done: false`: nothing changed; `confirm.count`: what to send. */
export const confirmPreviewAnswer = (preview: ConfirmPreview) => ({ done: false, confirm: { count: preview.count }, message: preview.message });

const profileGone = () => new McpRefusal('profile_ended', 'profile_ended', PROFILE_GONE);
const notAllowed = () => new McpRefusal('profile_not_shared', 'profile_not_shared', PROFILE_NOT_ALLOWED);
export const profileRequired = (profiles: readonly ProfileItem[], message = PROFILE_REQUIRED_MESSAGE) =>
  new McpRefusal('profile_required', 'validation_failed', message, { profiles });

/** The most text one profile wrapper quotes: no bound of its own (each caller cuts its text to its prompt's limit). */
const WRAPPED_MAX = Number.MAX_SAFE_INTEGER;

/**
 * The wrapper of text an owner wrote, read on their profile by someone else's AI, ending with a data label (v34
 * MCPDIR: a fresh id per call; it was the grant's tripwire line, words addressed to an AI).
 * v33 SHARE-8 (review): the text is cleaned line by line as every other <untrusted> wrapper cleans what it quotes
 * (untrustedLines: NFKC, so a full-width "＜/untrusted＞" is caught; invisible characters out; wrapper tags, the JSON
 * sentinels and the fake CLI's scenario tag defused), so the owner's words can never close the wrapper early and
 * read as TailorIT's own text. A TailorIT wrapper inside (an upload's text) is defused too: pass its text plain.
 */
export function profileWrapped(profile: Pick<McpProfile, 'key'>, text: string): string {
  if (profile.key === PROFILE_SELF) return text;
  return dataFence(`profile:${profile.key}`, untrustedLines(text, WRAPPED_MAX));
}

/**
 * v34 MCPFAN (the security review, M1; the coordinator's decision 1): a custom filter's text, as every MCP read hands
 * it out (prepare_filters, filter_jobs), fenced as that profile's data with a fresh data label on EVERY profile, the
 * caller's own too: someone the profile is shared with may have written it (in TailorIT's Settings), so it never reads
 * as the person's own instruction. An empty text stays empty.
 */
export function filterTextFenced(profile: Pick<McpProfile, 'key'>, text: string): string {
  return text ? dataFence(`profile:${profile.key}`, untrustedLines(text, WRAPPED_MAX)) : text;
}

/** v34 MCPDIR: the data label of an owner's words on their profile (a fresh id per call). */
export const profileLabel = (key: string, id?: string): string => dataLabel(`profile:${key}`, id);

/** v33 SHARE-8 (review): profileWrapped on another person's profile, the text as it is on the caller's own. */
export const ownerWrap =
  (profile: Pick<McpProfile, 'key'>) =>
  (text: string): string =>
    profileWrapped(profile, text);

/**
 * v33 SHARE-8 (review): the most of a template's guidance the editor's letter prompt quotes (letter-rules.ts
 * GUIDANCE_LIMIT, which cuts the block there): the owner's guidance is wrapped within it, so that cut never takes the
 * wrapper's end. v33 INT-D (SHARE-8's exact edit 7): the one constant, re-exported.
 */
export { GUIDANCE_LIMIT as LETTER_GUIDANCE_MAX } from '../../ai/prompts/cover-letters/letter-rules';

/** `text` through `wrap`, cut first so the whole wrapped text is at most `max` characters. */
export function wrappedWithin(wrap: (text: string) => string, text: string, max: number): string {
  let kept = text;
  let out = wrap(kept);
  while (out.length > max && kept.length > 0) {
    kept = kept.slice(0, Math.max(0, kept.length - (out.length - max)));
    out = wrap(kept);
  }
  return out;
}

/**
 * The scope line (PLAN-sharing §7 "Instructions v3"): the caller's custom instructions are theirs; on another profile
 * they shape the writing only. In the instructions' fence, and in prepare_prompt and prepare_job_context on another
 * person's profile (the prompt catalogue's words).
 */
export const scopeLine = (callerName: string): string => customScopeLine(callerName);

/** Whose profile a call works on, for the context and the step prompts on another person's profile (R8, the scope line). */
export function profileNote(ctx: Pick<SaveContext, 'caller' | 'profile'>): string {
  const { caller, profile } = ctx;
  return (
    `This job is on ${profile.name}'s profile (${profile.key}): its application uses ${profile.name}'s facts only, ` +
    `never ${caller.name}'s. ${scopeLine(caller.name)}`
  );
}

/** Counts a call on another person's profile in the share's activity (ids and codes only; via `mcp`). */
export function countCall(deps: AppDeps, ctx: Pick<SaveContext, 'caller' | 'profile'>, perm: SharePermission, write: boolean): void {
  const grant = ctx.profile.grant;
  if (!grant) return;
  countActivity(deps, {
    grantId: grant.id,
    ownerId: grant.owner.id,
    actorId: ctx.caller.id,
    area: areaOfPermission(perm),
    action: write ? 'write' : 'read',
    via: 'mcp',
  });
}

// ------------------------------------------------------------------------------------------------- the session

/** The arguments a tool call may carry that decide its profile. */
interface ProfileArgs {
  profile?: unknown;
  setId?: unknown;
  runId?: unknown;
  cursor?: unknown;
  jobId?: unknown;
  jobIds?: unknown;
  jobs?: unknown;
}

/** One request's MCP session: the caller, and the profile of each tool call. */
export interface McpSession {
  readonly deps: AppDeps;
  readonly caller: McpCallerInfo;
  readonly prepare: PrepareAdapter;
  readonly tokenId: string | null;
  /** The caller's live grants that let their AI in (`mcp`), oldest accepted first (reachableProfiles). */
  grants(): Promise<LiveGrant[]>;
  /** Every grant the caller accepted, live or ended (their pre-v3.4 tripwires and changes: heldGrants). */
  held(): Promise<HeldGrant[]>;
  /** The caller's own profile's context. */
  own(): Promise<SaveContext>;
  /** The context of the profile `key` names, checked for `tool` (refused as PROFILE_GONE / PROFILE_NOT_ALLOWED). */
  named(tool: McpToolName, key: string): Promise<SaveContext>;
  /** The context of one of `grants()`, checked for `tool` as `named` checks it. */
  onGrant(tool: McpToolName, grant: LiveGrant): Promise<SaveContext>;
  /** The profiles a PROFILE_REQUIRED answer lists: "me", then each live grant with `mcp`. */
  items(): Promise<ProfileItem[]>;
  /** A per-job read's profile when the call names none (an MCP prompt): where the caller's AI prepares the jobs. */
  forJob(tool: McpToolName, jobIds: readonly number[]): Promise<SaveContext>;
  /** Runs `tool` on the profile its arguments decide; its answer as JSON, a refusal as a tool error. */
  run(tool: McpToolName, args: ProfileArgs, work: (ctx: SaveContext) => unknown): Promise<CallToolResult>;
  /**
   * v34 MCPFAN: runs `tool` on several profiles at once, within the same time and size limits: `work` gets the caller's
   * own context (their result sets, their pre-v3.4 tripwires) and acts through FANOUT's services, which check each
   * profile and count its activity themselves (nothing is counted here).
   */
  runMany(tool: McpToolName, args: Record<string, unknown>, work: (own: SaveContext) => unknown): Promise<CallToolResult>;
  /**
   * v34 MCPFAN: a profile a fan-out refused as one it may not use (FANOUT answers every such case alike), refused as a
   * call naming it alone would be: PROFILE_NOT_ALLOWED for a live share of the caller's whose boxes do not allow the
   * tool, else PROFILE_GONE. Any other refusal keeps its code and words.
   */
  refusalOf(refused: FanoutRefused): Promise<{ code: string; message: string }>;
}

const ACTIVE = `(${PREPARE_ACTIVE_STATES.map((state) => `'${state}'`).join(', ')})`;
const SET_ID = /^rs_[A-Za-z0-9_-]{6,30}$/;

// v1.5 Q1: an answer is a text answer (a prompt) as it is, anything else compact JSON (v34 MCPDIR: answer.ts
// fittedAnswer, within MCP_RESULT_MAX_CHARS).

/** A tool error: {"error": {code, message, ...extra}}. */
const refusal = (code: string, message: string, extra: Record<string, unknown> = {}): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify({ error: { code, message, ...extra } }) }],
  isError: true,
});

/** v34 MCPDIR: what a call that failed on TailorIT's side answers (no generic error: what happened, what to do). */
export const internalErrorMessage = (tool: string) =>
  `TailorIT hit an error of its own while running ${tool} (logged for the operator). Try the same call once more; if ` +
  'it fails again, tell the person and go on with other work.';

/** The setId a call's handle names (setId, runId, or a cursor "<setId>.<offset>"), when it is shaped like one. */
function handleOf(args: ProfileArgs): string | null {
  for (const value of [args.setId, args.runId]) if (typeof value === 'string' && SET_ID.test(value)) return value;
  if (typeof args.cursor === 'string') {
    const id = args.cursor.slice(0, Math.max(0, args.cursor.lastIndexOf('.')));
    if (SET_ID.test(id)) return id;
  }
  return null;
}

/** The job ids a per-job call names. */
function jobIdsOf(args: ProfileArgs): number[] {
  const ids: unknown[] = [args.jobId, ...(Array.isArray(args.jobIds) ? args.jobIds : [])];
  if (Array.isArray(args.jobs)) for (const job of args.jobs) ids.push((job as { jobId?: unknown } | null)?.jobId);
  return [...new Set(ids.filter((id): id is number => Number.isSafeInteger(id)))];
}

/** The per-job reads whose profile a job id decides when none is named. */
const PER_JOB_READS: ReadonlySet<McpToolName> = new Set(['prepare_job_context', 'prepare_prompt']);

export function createMcpSession(deps: AppDeps, mcpCaller: McpCaller, prepare: PrepareAdapter): McpSession {
  const caller: McpCallerInfo = {
    id: mcpCaller.id as CallerId,
    name: firstNameOf(mcpCaller.user.name, 'the person'),
    payer: mcpCaller.payer,
  };
  const tokenId = mcpCaller.tokenId;
  let grantsRead: Promise<LiveGrant[]> | null = null;
  let heldRead: Promise<HeldGrant[]> | null = null;
  const grants = () => (grantsRead ??= reachableProfiles(deps, caller.id, ['mcp']));
  const held = () => (heldRead ??= heldGrants(deps, caller.id));

  /** The answers' next calls name the profile once the caller has another one (null: they keep v3.2's words). */
  const hintFor = async (key: McpProfile['key']): Promise<string | null> => ((await grants()).length > 0 ? key : null);

  async function contextOf(profile: McpProfile): Promise<SaveContext> {
    const canaries = (await held()).map((grant) => grant.canary);
    const sets: SetScope = { callerId: caller.id, profileUserId: profile.userId, grantId: profile.grant?.id ?? null };
    return { deps, userId: profile.userId, prepare, tokenId, caller, profile, hint: await hintFor(profile.key), sets, canaries };
  }

  async function own(): Promise<SaveContext> {
    return contextOf({
      key: PROFILE_SELF,
      userId: caller.id as string as ProfileId,
      grant: null,
      name: caller.name,
      sensitive: true,
      payer: caller.payer,
    });
  }

  /** The context of a live grant of the caller's, for `tool` (it must hold `mcp` and the tool's permission). */
  async function ofGrant(tool: McpToolName, grant: LiveGrant | null): Promise<SaveContext> {
    if (!grant) throw profileGone();
    const perm = MCP_TOOL_ACCESS[tool].perm;
    if (!grantHolds(grant, perm === null ? ['mcp'] : ['mcp', perm])) throw notAllowed();
    return contextOf({
      key: grant.id,
      userId: grant.owner.id as ProfileId,
      grant,
      name: firstNameOf(grant.owner.name, 'Owner'),
      sensitive: grantHolds(grant, 'sensitive:view'),
      payer: payerOfGrant(grant, 'mcp'),
    });
  }

  async function named(tool: McpToolName, key: string): Promise<SaveContext> {
    if (key === PROFILE_SELF) return own();
    // Every call reads the grant again; an unknown, foreign or ended key is one answer.
    return ofGrant(tool, isProfileKey(key) ? await resolveGrant(deps, caller.id, key) : null);
  }

  async function items(): Promise<ProfileItem[]> {
    return [
      { key: PROFILE_SELF, name: caller.name },
      ...(await grants()).map((grant) => ({ key: grant.id, name: firstNameOf(grant.owner.name, 'Owner') })),
    ];
  }

  /** The profiles where the caller's own AI prepares one of `jobIds` now (an active MCP Prepare they started). */
  async function preparedOn(jobIds: readonly number[]): Promise<Array<LiveGrant | null>> {
    const owners = new Set([...(await profilesPreparing(deps, caller.id, jobIds)).values()].flatMap((set) => [...set]));
    const live = await grants();
    const out = new Map<string, LiveGrant | null>();
    for (const owner of owners) {
      if (owner === caller.id) out.set(PROFILE_SELF, null);
      else {
        const grant = live.find((one) => one.owner.id === owner);
        if (grant) out.set(grant.id, grant);
      }
    }
    return [...out.values()];
  }

  /** The profile of a call (PLAN-sharing §7 "The profile argument"). */
  async function resolve(tool: McpToolName, args: ProfileArgs): Promise<SaveContext> {
    const access: ToolAccess = MCP_TOOL_ACCESS[tool];
    if (access.perm === null) return own();
    // v34 MCPFAN: several profiles on a tool that works on one (the fan-out tools route them to runMany first).
    if (profileTargets(args.profile) !== null) throw new AppError('validation_failed', ONE_PROFILE_MESSAGE);
    if (args.profile !== undefined) return named(tool, typeof args.profile === 'string' ? args.profile : '');
    // A handle fixes its profile: the set's grant, read again (one that ended: the set is gone).
    const handle = handleOf(args);
    if (handle) {
      const set = await setGrantOf(deps, caller.id, handle);
      // A gone set: on one profile the tool answers it as before (its own checks first); with others, SET_GONE here.
      if (set === undefined) {
        if ((await grants()).length > 0) throw new AppError('not_found', SET_GONE);
        return own();
      }
      if (set === null) return own();
      const grant = await resolveGrant(deps, caller.id, set);
      if (!grant) throw new AppError('not_found', SET_GONE);
      return ofGrant(tool, grant);
    }
    if (PER_JOB_READS.has(tool)) {
      const on = await preparedOn(jobIdsOf(args));
      if (on.length > 1) throw profileRequired(await items(), PROFILE_AMBIGUOUS_MESSAGE);
      if (on.length === 1 && on[0]) return ofGrant(tool, on[0]);
      return own();
    }
    if (access.write && (await grants()).length > 0) throw profileRequired(await items(), profileRequiredMessage(tool)); // v34 MCPFAN: the words
    return own();
  }

  /** Counts a call on another person's profile in the share's activity (ids and codes only). */
  function counted(tool: McpToolName, ctx: SaveContext): void {
    const access: ToolAccess = MCP_TOOL_ACCESS[tool];
    if (access.perm !== null) countCall(deps, ctx, access.perm, access.write);
  }

  // v34 MCPDIR (answer.ts): every tool within MCP_TOOL_TIME_LIMIT_MS, its answer within MCP_RESULT_MAX_CHARS.
  const run = (tool: McpToolName, args: ProfileArgs, work: (ctx: SaveContext) => unknown): Promise<CallToolResult> =>
    execute(tool, args, () => resolve(tool, args), work, true);

  // v34 MCPFAN: several profiles: the caller's own context; FANOUT's services count each profile's activity.
  const runMany = (tool: McpToolName, args: Record<string, unknown>, work: (own: SaveContext) => unknown): Promise<CallToolResult> =>
    execute(tool, args, own, work, false);

  async function refusalOf(refused: FanoutRefused): Promise<{ code: string; message: string }> {
    if (refused.refused !== 'profile_ended') return { code: refused.refused, message: refused.message };
    const grant = refused.profile === PROFILE_SELF ? null : await resolveGrant(deps, caller.id, refused.profile);
    return grant ? { code: 'profile_not_shared', message: PROFILE_NOT_ALLOWED } : { code: 'profile_ended', message: PROFILE_GONE };
  }

  async function execute(
    tool: McpToolName,
    args: ProfileArgs,
    contextFor: () => Promise<SaveContext>,
    work: (ctx: SaveContext) => unknown,
    count: boolean,
  ): Promise<CallToolResult> {
    const constants = constantsOf(deps);
    const limit = constants.get('MCP_TOOL_TIME_LIMIT_MS');
    try {
      const outcome = await withinTime(
        async () => {
          const ctx = await contextFor();
          return { ctx, result: await work(ctx) };
        },
        limit,
        // v34 MCPDIR (the security review, finding 7): a call that finishes after the limit is still logged and counted.
        {
          done: ({ ctx }) => {
            if (count) counted(tool, ctx);
            deps.log.info(`[mcp] account ${caller.id}: ${tool} finished after the time limit`);
          },
          failed: (error) =>
            deps.log.error(`[mcp] account ${caller.id}: ${tool} failed after the time limit`, error instanceof Error ? error.name : 'unknown'),
        },
      );
      if (outcome === TIMED_OUT) {
        deps.log.warn(`[mcp] account ${caller.id}: ${tool} took longer than ${limit} ms`);
        return refusal('timeout', tooSlowMessage(deps, tool, limit));
      }
      const { ctx, result } = outcome;
      if (count) counted(tool, ctx);
      const max = constants.get('MCP_RESULT_MAX_CHARS');
      // v34 MCPDIR (the security review, findings 2, 3, 9): how this tool's answer may be cut (answer.ts).
      const answer = fittedAnswer(result, max, { tool, changes: MCP_TOOL_ACCESS[tool].write, args });
      if (answer.refused !== undefined) {
        deps.log.info(`[mcp] account ${caller.id}: ${tool} answer over the size limit, refused`);
        return refusal('too_large', answer.refused);
      }
      if (answer.cut) deps.log.info(`[mcp] account ${caller.id}: ${tool} answer cut to the size limit`);
      deps.log.debug(`[mcp] account ${caller.id}: ${tool} done${ctx.profile.grant ? ` (profile ${ctx.profile.grant.id})` : ''}`);
      return { content: [{ type: 'text', text: answer.text }] };
    } catch (error) {
      // v34 FIX-API (the final directory review, D1): a removal's preview is a success that changed nothing.
      if (error instanceof ConfirmPreview) {
        deps.log.debug(`[mcp] account ${caller.id}: ${tool} answered a preview (nothing changed)`);
        return { content: [{ type: 'text', text: JSON.stringify(confirmPreviewAnswer(error)) }] };
      }
      if (error instanceof AppError && error.status < 500) {
        deps.log.debug(`[mcp] account ${caller.id}: ${tool} refused (${error.code})`);
        const extra = error instanceof McpRefusal ? error.extra : {};
        const code = error instanceof McpRefusal ? error.answerCode : error.code;
        return refusal(code, error.message, extra);
      }
      deps.log.error(`[mcp] account ${caller.id}: ${tool} failed`, error instanceof Error ? error.name : 'unknown');
      // v34 MCPDIR (the directory review, finding 15): a server-side failure's own words are a person's ("try again"):
      // they come with what the AI does.
      return refusal('internal', error instanceof AppError ? `${error.message} ${internalErrorMessage(tool)}` : internalErrorMessage(tool));
    }
  }

  const forJob = (tool: McpToolName, jobIds: readonly number[]) => resolve(tool, { jobIds: [...jobIds] });

  return { deps, caller, prepare, tokenId, grants, held, own, named, onGrant: ofGrant, items, forJob, run, runMany, refusalOf };
}

/**
 * The profiles (their owners' ids) on which the caller's own AI prepares each of `jobIds` now: an active `mcp` Prepare
 * the caller started (prepare_jobs.started_by). A job prepared nowhere is left out.
 */
export async function profilesPreparing(
  deps: Pick<AppDeps, 'db'>,
  callerId: string,
  jobIds: readonly number[],
): Promise<Map<number, Set<string>>> {
  const out = new Map<number, Set<string>>();
  if (jobIds.length === 0) return out;
  const rows = await deps.db.all<{ user_id: string; job_id: number }>(
    `SELECT DISTINCT p.user_id, p.job_id FROM prepare_jobs p
      WHERE p.started_by = ? AND p.mode = 'mcp' AND p.state IN ${ACTIVE}
        AND p.job_id IN (SELECT CAST(value AS INTEGER) FROM ${deps.db.dialect.jsonEach('?')})`,
    [callerId, JSON.stringify([...new Set(jobIds)])],
  );
  for (const row of rows) {
    const jobId = Number(row.job_id);
    out.set(jobId, (out.get(jobId) ?? new Set()).add(row.user_id));
  }
  return out;
}
