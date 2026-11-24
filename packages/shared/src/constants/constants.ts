// v2.0: the central constants (docs/design/v2.0/02-constants.md). Every business number this release adds or touches,
// and every user-facing limit or status message, is defined here once: its kind, its default, its .env key, whether an
// admin may change it at runtime (Admin › Constants) and whether the web may read it (GET /api/constants/public). The
// API resolves each value in the order DB override, then .env, then the default below (apps/api/src/core/constants).
// This module is pure data and pure functions: it reads no environment and no database. Technical constants (parser
// caps, regexes, timeouts inside one module) stay beside their code, and the autofill contract keeps its own.

import { AUTOFILL_AGENT_QUEUE_MAX } from '../autofill/agent';
import { AUTOFILL_TAILOR_PER_HOUR } from '../autofill/tailor';
import { AI_BILLING_MODES } from '../ai/billing'; // v34 AIKEY

/** "Unlimited", the same value everywhere: a limit or budget that is UNLIMITED is never checked. */
export const UNLIMITED = null;
export type Unlimited = typeof UNLIMITED;
export type Limit = number | Unlimited;

/**
 * What a constant holds. `usd` and `usd_limit` are micro-dollars (integers, $1 = 1,000,000), written as a decimal
 * ("0.10") in .env and in the admin UI. `duration` is an ISO 8601 calendar length of one unit (P1M, P1W, P30D, P1Y).
 */
export const CONSTANT_KINDS = [
  'int', // integer within [min, max]
  'limit', // integer >= 0, or UNLIMITED
  'usd', // micro-dollars (integer >= 0)
  'usd_limit', // micro-dollars or UNLIMITED
  'ratio', // 0 < x <= 1
  'bool',
  'time_of_day', // "HH:MM", 24-hour
  'time_zone', // an IANA name Intl.DateTimeFormat accepts
  'duration', // PnY, PnM, PnW or PnD
  'date', // YYYY-MM-DD
  'email', // an address, or null for none
  'text', // a plain string within maxLength (and one of `choices` when it has them)
  'message', // a user-facing template with {placeholders}
  'prices', // the per-model price table (AiPrices)
] as const;
export type ConstantKind = (typeof CONSTANT_KINDS)[number];

/** Admin › Constants' sections. */
export const CONSTANT_GROUPS = [
  'accounts',
  'ai',
  'auto_apply',
  'resumes',
  'prepare',
  'jobs',
  'mcp',
  'time',
  'contact',
  'announcements',
  'retention',
  'messages',
] as const;
export type ConstantGroup = (typeof CONSTANT_GROUPS)[number];

/** Where a resolved value came from. */
export const CONSTANT_SOURCES = ['db', 'env', 'default'] as const;
export type ConstantSource = (typeof CONSTANT_SOURCES)[number];

/** USD per million tokens of one model, used only when a CLI result carries no cost (03-ai-usage.md). */
export interface AiPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
/** Prices by model id; `*` prices any other model (the dearest, so an unknown model is never under-charged). */
export type AiPrices = Readonly<Record<string, AiPrice>>;

/** The value type of each kind. */
export interface ConstantValueByKind {
  int: number;
  limit: Limit;
  usd: number;
  usd_limit: Limit;
  ratio: number;
  bool: boolean;
  time_of_day: string;
  time_zone: string;
  duration: string;
  date: string;
  email: string | null;
  text: string;
  message: string;
  prices: AiPrices;
}
export type ValueOf<K extends ConstantKind> = ConstantValueByKind[K];

export interface ConstantSpec<K extends ConstantKind = ConstantKind> {
  kind: K;
  default: ValueOf<K>;
  /** The .env key; default: the constant's own key. */
  env?: string;
  /** Older .env keys read when `env` is unset, in order (A3: PREBUILD_PER_HOUR). */
  envAliases?: readonly string[];
  /**
   * v32 FIX-PLAN (E12): this constant's earlier keys. An admin override stored under one (app_settings
   * `const:<former>`) still applies while this key has none of its own; setting or resetting this key removes it.
   */
  formerKeys?: readonly string[];
  /** Whether Admin › Constants may override it at runtime. */
  adminEditable: boolean;
  /** Whether GET /api/constants/public returns it (never a budget, a price or a server-capacity value). */
  public: boolean;
  group: ConstantGroup;
  /** Admin › Constants row title. */
  label: string;
  /** One sentence for the admin. */
  help: string;
  /** int, limit: the bounds of a number (UNLIMITED is not bounded). */
  min?: number;
  max?: number;
  /** text, message: the longest value. */
  maxLength?: number;
  /** message: the only placeholders allowed in an override. */
  placeholders?: readonly string[];
  /** text: the only values allowed. */
  choices?: readonly string[];
}

/** One spec per kind, so the table checks each default against its own kind. */
export type AnyConstantSpec = { [K in ConstantKind]: ConstantSpec<K> }[ConstantKind];

const MESSAGE_MAX = 400;
/** v30 INT-0: a count's words, {name|singular|plural} (./render.ts), in a message's default. */
const COUNT_WORDS = /\{[a-z][a-z0-9_]*\|/;
// v32 FIX-UX (UXREQ-8): a constant's help is the "?" beside it in Admin › Constants: one sentence of at most 140.
const COUNT_WORDS_HELP = ' ({name|one|other}: the first word for 1, else the second)';
const LABEL_MAX = 60;

/** A user-facing message: public, admin-editable, at most 400 characters unless said. */
// v20 FIX-A (SEC-5): the helpers are marked free of side effects, so a bundle that imports something else from this
// folder drops the table (a browser must never get its budgets, prices or capacity threshold).
/* @__NO_SIDE_EFFECTS__ */
function message<const P extends readonly string[] = readonly []>(
  label: string,
  text: string,
  placeholders?: P,
  maxLength: number = MESSAGE_MAX,
) {
  return {
    kind: 'message',
    default: text,
    adminEditable: true,
    public: true,
    group: 'messages',
    label,
    help: placeholders?.length
      ? `Shown as it is, with ${placeholders.map((name) => `{${name}}`).join(', ')} filled in${COUNT_WORDS.test(text) ? COUNT_WORDS_HELP : ''}.`
      : 'Shown to people as it is.',
    maxLength,
    placeholders: (placeholders ?? []) as P,
  } as const;
}

/** A filter reason's words, filling {reason} in MSG_FILTERED; {value} is a word from the filters' vocabulary. */
/* @__NO_SIDE_EFFECTS__ */
function filterLabel(label: string, text: string) {
  return {
    ...message(label, text, ['value'] as const, LABEL_MAX),
    help: 'Fills {reason} in "Filtered: {reason}", {value} being the filter\'s word for the job (on-site, TX, CA only).',
  } as const;
}

// v20 A29
/** The words of one choice of a setting (Settings › Prepare's resume mode). */
/* @__NO_SIDE_EFFECTS__ */
function choiceLabel(label: string, text: string) {
  return {
    ...message(label, text, [] as const, LABEL_MAX),
    help: "A choice's words in Settings › Prepare.",
  } as const;
}
// end v20 A29

/** A state or marker word of the Auto-Apply page (05-prepare-flow.md's state machine). */
/* @__NO_SIDE_EFFECTS__ */
function stateLabel(label: string, text: string) {
  return {
    ...message(label, text, [] as const, LABEL_MAX),
    help: "A status word on the Auto-apply page and the Tracker's cards.",
  } as const;
}

/** The fallback prices (USD per million tokens), list prices as of 2026-11. Cache writes: 1.25 x input. */
const AI_PRICES_DEFAULT = {
  'claude-opus-5-5': { input: 4.0, output: 20.0, cacheRead: 0.2, cacheWrite: 5.0 },
  'claude-sonnet-5-5': { input: 2.0, output: 10.0, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  '*': { input: 4.0, output: 20.0, cacheRead: 0.2, cacheWrite: 5.0 },
} as const;

/**
 * Every constant, by key. The key is also its .env key, in upper snake case, unless `env` says otherwise. Values of
 * `usd` kinds are micro-dollars: 100_000 is $0.10.
 */
export const CONSTANTS = {
  // Accounts and plans (§10): the two account types' limits, and the Paid term.
  FREE_AUTO_APPLY_PER_DAY: {
    kind: 'limit', default: 7, adminEditable: true, public: true, group: 'accounts', min: 0, max: 100_000,
    label: 'Free auto-applies per day',
    help: 'How many jobs the extension may auto-apply to for a Free account in each auto-apply window.',
  },
  PAID_AUTO_APPLY_PER_DAY: {
    kind: 'limit', default: UNLIMITED, adminEditable: true, public: true, group: 'accounts', min: 0, max: 100_000,
    label: 'Paid auto-applies per day',
    help: 'How many jobs the extension may auto-apply to for a Paid account in each auto-apply window.',
  },
  FREE_AI_DAILY_BUDGET_USD: {
    kind: 'usd_limit', default: 100_000, adminEditable: true, public: false, group: 'accounts',
    label: 'Free daily AI budget',
    // v31 NOTIFY (D9): the header shows each person their day's use against their own budget.
    help: "What TailorIT's AI may spend for a Free account each day before extra credit is used (people see their use as a percent).",
  },
  PAID_AI_DAILY_BUDGET_USD: {
    kind: 'usd_limit', default: 500_000, adminEditable: true, public: false, group: 'accounts',
    label: 'Paid daily AI budget',
    // v31 NOTIFY (D9): the header shows each person their day's use against their own budget.
    help: "What TailorIT's AI may spend for a Paid account each day before extra credit is used (people see their use as a percent).",
  },
  FREE_RESUME_LIMIT: {
    kind: 'limit', default: 30, adminEditable: true, public: true, group: 'accounts', min: 0, max: 100_000,
    label: 'Free resume limit',
    help: 'How many resumes of every kind a Free account may hold; at the limit, new resumes and edits are blocked.',
  },
  PAID_RESUME_LIMIT: {
    kind: 'limit', default: UNLIMITED, adminEditable: true, public: true, group: 'accounts', min: 0, max: 100_000,
    label: 'Paid resume limit',
    help: 'How many resumes of every kind a Paid account may hold (the safety cap applies as well).',
  },
  // v32 FIX-PLAN (E12, the owner: "Paid user is unlimited"): the hourly limits are plan limits. v2.0's TAILOR_PER_HOUR
  // and PREPARE_PER_HOUR are Free's now: their .env keys and an admin's stored override of them still apply to Free.
  // v20 FIX-A (REQ-10, A18): the Tailor's hourly limit, with the extension contract's number as Free's default.
  FREE_TAILOR_PER_HOUR: {
    kind: 'limit', default: AUTOFILL_TAILOR_PER_HOUR, envAliases: ['TAILOR_PER_HOUR'], formerKeys: ['TAILOR_PER_HOUR'],
    adminEditable: true, public: false, group: 'accounts', min: 1, max: 1000,
    label: 'Free tailorings per hour',
    // v31 FIX-WEB (REV-REQ REQ-3): the web's action is "Tailor a resume".
    help: "Tailorings a Free account may start in an hour (the web's Tailor a resume, the extension's tailor, an own-AI tailor).",
  },
  PAID_TAILOR_PER_HOUR: {
    kind: 'limit', default: UNLIMITED, adminEditable: true, public: false, group: 'accounts', min: 1, max: 1000,
    label: 'Paid tailorings per hour',
    help: "Tailorings a Paid account may start in an hour (the web's Tailor a resume, the extension's tailor, an own-AI tailor).",
  },
  FREE_PREPARE_PER_HOUR: {
    kind: 'limit', default: 30, envAliases: ['PREPARE_PER_HOUR', 'PREBUILD_PER_HOUR'], formerKeys: ['PREPARE_PER_HOUR'],
    adminEditable: true, public: false, group: 'accounts', min: 1, max: 1000,
    label: 'Free Prepares per hour',
    help: 'Server Prepares a Free account starts in an hour, which paces the runner and refuses nothing.',
  },
  PAID_PREPARE_PER_HOUR: {
    kind: 'limit', default: UNLIMITED, adminEditable: true, public: false, group: 'accounts', min: 1, max: 1000,
    label: 'Paid Prepares per hour',
    help: 'Server Prepares a Paid account starts in an hour, which paces the runner and refuses nothing.',
  },
  FREE_AI_JOB_SEARCH: {
    kind: 'bool', default: false, adminEditable: true, public: true, group: 'accounts',
    label: 'AI job search for Free',
    help: 'Whether a Free account may use AI job search (classic search is always there).',
  },
  PAID_AI_JOB_SEARCH: {
    kind: 'bool', default: true, adminEditable: true, public: true, group: 'accounts',
    label: 'AI job search for Paid',
    help: 'Whether a Paid account may use AI job search (classic search is always there).',
  },
  FREE_MCP: {
    kind: 'bool', default: true, adminEditable: true, public: true, group: 'accounts',
    label: 'MCP server for Free',
    help: "Whether a Free account's own AI may connect to TailorIT's MCP server.",
  },
  PAID_MCP: {
    kind: 'bool', default: true, adminEditable: true, public: true, group: 'accounts',
    label: 'MCP server for Paid',
    help: "Whether a Paid account's own AI may connect to TailorIT's MCP server.",
  },
  PAID_TERM: {
    kind: 'duration', default: 'P1M', adminEditable: true, public: false, group: 'accounts',
    label: 'Paid term',
    help: 'One Paid term; "Extend" adds one to the later of now and the current end.',
  },
  // v20 FIX-A (REQ-11): one source for Admin › Users' "Paid ending" filter and its warning colour.
  PAID_ENDING_DAYS: {
    kind: 'int', default: 7, adminEditable: true, public: true, group: 'accounts', min: 1, max: 90,
    label: 'Paid ending soon (days)',
    help: 'Admin › Users marks a Paid term that ends within this many days, and its "Paid ending" filter lists them.',
  },

  // The technical resume cap for every account (was MAX_RESUMES_PER_ACCOUNT, A15).
  // v30 DB-JOBS (CT edit C, 11 §4.3): above the heaviest account's 5,040 resumes; the count is user_counters' (D1d).
  RESUME_SAFETY_CAP: {
    kind: 'int', default: 5100, adminEditable: true, public: false, group: 'resumes', min: 1, max: 100_000,
    label: 'Resume safety cap',
    help: 'A technical cap on resumes for every account, Paid included, not a plan limit.',
  },

  // The auto-apply window and the queue (§4, §10).
  AUTO_APPLY_WINDOW_DAYS: {
    kind: 'int', default: 1, adminEditable: true, public: true, group: 'auto_apply', min: 1, max: 31,
    label: 'Auto-apply window (days)',
    help: 'The length of the window the auto-apply limits count in (1 counts per day).',
  },
  AUTO_APPLY_WINDOW_EPOCH: {
    kind: 'date', default: '2026-01-01', adminEditable: false, public: false, group: 'auto_apply',
    label: 'Auto-apply window start',
    help: 'The day windows of more than one day are counted from.',
  },
  // v30 CT (audit B1): the default is the autofill contract's number, which cannot read this table (the extension
  // copies the contract folder byte for byte), as FREE_TAILOR_PER_HOUR's is.
  QUEUE_SIZE_MAX: {
    kind: 'int', default: AUTOFILL_AGENT_QUEUE_MAX, adminEditable: true, public: true, group: 'auto_apply', min: 1, max: 5000,
    label: 'Queue size',
    help: "The most rows an account's auto-apply queue holds.",
  },

  // The day boundary (§2, §10). A change moves today's day key at once.
  DAY_RESET_TIME: {
    kind: 'time_of_day', default: '00:00', adminEditable: true, public: true, group: 'time',
    label: 'Daily reset time',
    help: "When the AI budget and the auto-apply counter reset each day; a change moves today's reset at once.",
  },
  DAY_RESET_TIME_ZONE: {
    kind: 'time_zone', default: 'America/Los_Angeles', adminEditable: true, public: true, group: 'time',
    label: 'Daily reset time zone',
    help: "The time zone of the daily reset; a change moves today's reset at once.",
  },
  DAY_RESET_ZONE_LABEL: {
    kind: 'text', default: 'Pacific Time', adminEditable: true, public: true, group: 'time', maxLength: 40,
    label: 'Time zone name',
    help: 'How messages name the reset time zone, as in "12:00 AM Pacific Time".',
  },

  // Server AI (§2): the capacity block and the fallback prices. Never public.
  SERVER_AI_BLOCK_THRESHOLD: {
    kind: 'ratio', default: 0.98, adminEditable: true, public: false, group: 'ai',
    label: 'Capacity block threshold',
    help: "The share of the server's Claude usage at which every server-AI action is refused.",
  },
  SERVER_AI_CAPACITY_USD_PER_WINDOW: {
    kind: 'usd_limit', default: UNLIMITED, adminEditable: true, public: false, group: 'ai',
    label: 'Fallback capacity per window',
    help: "What TailorIT's own spend estimate counts as full when the CLI reports no usage (unlimited: no fallback).",
  },
  SERVER_AI_CAPACITY_WINDOW_HOURS: {
    kind: 'int', default: 5, adminEditable: true, public: false, group: 'ai', min: 1, max: 336,
    label: 'Fallback capacity window (hours)',
    help: "The hours TailorIT's own spend estimate sums over.",
  },
  SERVER_AI_READING_TTL_MINUTES: {
    kind: 'int', default: 300, adminEditable: true, public: false, group: 'ai', min: 1, max: 10_080,
    label: 'Usage reading lifetime (minutes)',
    help: 'How long a usage reading with no reset time keeps counting.',
  },
  AI_PRICES: {
    kind: 'prices', default: AI_PRICES_DEFAULT, adminEditable: true, public: false, group: 'ai',
    label: 'AI prices',
    help: 'USD per million tokens by model, used only when the CLI reports no cost ("*" prices any other model).',
  },

  // Prepare (§1, §3).
  PREPARE_BATCH_MAX: {
    kind: 'int', default: 100, adminEditable: true, public: true, group: 'prepare', min: 1, max: 500,
    label: 'Prepare batch',
    help: 'The most saved jobs prepared in one request (Prepare All, or Prepare on several selected jobs).',
  },
  PREPARE_MCP_STALE_DAYS: {
    kind: 'int', default: 7, adminEditable: true, public: true /* v34 FIX-COPY: the guide says it */, group: 'prepare', min: 1, max: 90,
    label: 'Abandoned own-AI Prepare (days)',
    help: "A Prepare left waiting for the person's own AI this long is cancelled.",
  },
  COVER_LETTER_MODE_DEFAULT: {
    kind: 'text', default: 'required', choices: ['required', 'always'], adminEditable: true, public: true,
    group: 'prepare', maxLength: 10,
    label: 'Cover letters for a new profile',
    help: '"required" writes a letter only when the application requires one; "always" writes one for every job.',
  },
  CUSTOM_FILTER_PROMPT_MAX_CHARS: {
    kind: 'int', default: 1000, adminEditable: true, public: true, group: 'prepare', min: 50, max: 4000,
    label: 'Custom filter length',
    help: "The longest Custom filter prompt a person may save.",
  },
  CUSTOM_FILTER_BATCH: {
    kind: 'int', default: 10, adminEditable: true, public: false, group: 'prepare', min: 1, max: 25,
    label: 'Custom filter batch',
    help: 'Jobs one Custom filter AI call judges.',
  },
  QUALIFICATION_YEARS_GRACE: {
    kind: 'int', default: 1, adminEditable: true, public: true, group: 'prepare', min: 0, max: 5,
    label: 'Experience grace (years)',
    help: "Years of experience a posting may ask above the person's before the qualification filter fails.",
  },
  JOB_ANALYSIS_V2_REREAD: {
    kind: 'text', default: 'saved', choices: ['saved', 'all', 'off'], adminEditable: true, public: false,
    group: 'prepare', maxLength: 10,
    label: 'Read jobs again for analysis v2',
    help: '"saved" reads jobs in some Saved Jobs (oldest saved first), "all" every active job, "off" none.',
  },

  // Jobs and search (§10).
  SAVE_BATCH_MAX: {
    kind: 'int', default: 100, adminEditable: true, public: true, group: 'jobs', min: 1, max: 500,
    // v36 JOBS (PLAN J1): Save all is gone; the constant caps every save (and unsave) request.
    label: 'Jobs saved per request',
    help: 'The most jobs one save or unsave request takes (Select on the Jobs page, Copy to profiles, MCP save_jobs).',
  },
  AI_SEARCH_TEXT_MAX_CHARS: {
    kind: 'int', default: 300, adminEditable: true, public: true, group: 'jobs', min: 20, max: 1000,
    label: 'AI search length',
    help: 'The longest sentence AI job search takes.',
  },

  // MCP (§7).
  MCP_TOKENS_PER_ACCOUNT: {
    kind: 'int', default: 10, adminEditable: true, public: true, group: 'mcp', min: 1, max: 100,
    label: 'MCP tokens per account',
    help: 'Live MCP tokens one account may hold (was MAX_MCP_TOKENS).',
  },
  MCP_CALLS_PER_MINUTE: {
    kind: 'int', default: 120, adminEditable: true, public: false, group: 'mcp', min: 1, max: 10_000,
    label: 'MCP calls per minute',
    help: 'Calls one MCP token may make a minute.',
  },
  MCP_CALLS_PER_HOUR: {
    kind: 'int', default: 2000, adminEditable: true, public: false, group: 'mcp', min: 1, max: 100_000,
    label: 'MCP calls per hour',
    help: 'Calls one MCP token may make an hour.',
  },
  MCP_CUSTOM_INSTRUCTIONS_MAX_CHARS: {
    kind: 'int', default: 4000, adminEditable: false, public: true, group: 'mcp', min: 1, max: 4000,
    label: 'MCP custom instructions length',
    help: "The longest custom instructions text, set in .env only (the database column's check uses it).",
  },
  MCP_FILTER_PAGE_MAX: {
    kind: 'int', default: 500, adminEditable: true, public: false, group: 'mcp', min: 25, max: 5000,
    label: 'MCP filter page',
    help: 'Job ids one filter_jobs answer holds.',
  },

  // Contact and announcements.
  ADMIN_CONTACT_EMAIL: {
    kind: 'email', default: null, env: 'CONTACT_EMAIL', adminEditable: true, public: true, group: 'contact',
    label: 'Admin contact email',
    help: 'Where Subscribe, Buy extra credit and the sign-in page\'s "Contact admin" point.',
  },
  ANNOUNCEMENTS_SHOWN_MAX: {
    kind: 'int', default: 3, adminEditable: true, public: false, group: 'announcements', min: 1, max: 10,
    label: 'Announcements shown',
    help: 'Announcement banners shown at once, the most severe first.',
  },

  // Retention: what the daily housekeeping keeps.
  AI_SPEND_KEEP_DAYS: {
    kind: 'int', default: 400, adminEditable: true, public: false, group: 'retention', min: 35, max: 3650,
    label: 'AI spend history (days)',
    help: 'Days of per-person AI spend kept for the admin.',
  },
  PREPARE_KEEP_DAYS: {
    kind: 'int', default: 90, adminEditable: true, public: false, group: 'retention', min: 7, max: 3650,
    label: 'Finished Prepares (days)',
    help: "Days finished Prepares are kept; each application's newest is always kept.",
  },
  CUSTOM_FILTER_VERDICT_KEEP_DAYS: {
    kind: 'int', default: 30, adminEditable: true, public: false, group: 'retention', min: 1, max: 365,
    label: 'Custom filter verdicts (days)',
    help: 'Days a Custom filter verdict is kept before the job is judged again.',
  },
  RESERVATION_KEEP_DAYS: {
    kind: 'int', default: 35, adminEditable: true, public: false, group: 'retention', min: 7, max: 3650,
    label: 'Auto-apply reservations (days)',
    help: 'Days settled auto-apply reservations are kept; only the current window is counted.',
  },
  ANNOUNCEMENT_KEEP_DAYS: {
    kind: 'int', default: 90, adminEditable: true, public: false, group: 'retention', min: 1, max: 3650,
    label: 'Expired announcements (days)',
    help: 'Days after its expiry before an announcement is deleted.',
  },
  // v30 DB-JOBS (11 §8.2, application_draft_answers): "drafts of entries un-saved more than 90 days". Kept beside
  // v2.0's retention keys, so CT's v3.0 hunk stays the table's last.
  DRAFT_ANSWERS_KEEP_DAYS_UNSAVED: {
    kind: 'int', default: 90, adminEditable: true, public: false, group: 'retention', min: 1, max: 3650,
    label: 'Draft answers of un-saved jobs (days)',
    help: 'Days the prepared answers of a job taken out of Saved Jobs, and never applied to, are kept.',
  },

  // v20 P10 (A28): the batch resume download in Documents › Resumes, Paid only (feature batch_download).
  FREE_BATCH_DOWNLOAD: {
    kind: 'bool', default: false, adminEditable: true, public: true, group: 'accounts',
    label: 'Batch resume download for Free',
    help: 'Whether a Free account may download several resumes at once as a ZIP.',
  },
  PAID_BATCH_DOWNLOAD: {
    kind: 'bool', default: true, adminEditable: true, public: true, group: 'accounts',
    label: 'Batch resume download for Paid',
    help: 'Whether a Paid account may download several resumes at once as a ZIP.',
  },
  BATCH_DOWNLOAD_MAX_RESUMES: {
    kind: 'int', default: 100, adminEditable: true, public: true, group: 'resumes', min: 1, max: 500,
    label: 'Batch download size',
    help: 'The most resumes one batch download ZIP holds.',
  },
  MSG_BATCH_DOWNLOAD_PAID: message(
    'Batch download is Paid',
    'Downloading several resumes at once needs a Paid account.',
  ),
  // end v20 P10

  // v20 A29 (DECISIONS A29): the Prepare resume mode. 'default': the person's default resume as it is;
  // 'similar': their most similar existing resume (rule-based, no AI); 'tailor': a new tailored resume (v1.5's
  // behaviour). The letter and the answers are written from the resume the mode chose.
  PREPARE_RESUME_MODE_DEFAULT: {
    kind: 'text', default: 'tailor', choices: ['default', 'similar', 'tailor'], adminEditable: true, public: true,
    group: 'prepare', maxLength: 10,
    label: 'Resume mode for a new account',
    help: '"default" uses the default resume as it is, "similar" the most similar one, "tailor" a new tailored resume per job.',
  },
  MSG_PREPARE_NO_RESUME: message(
    'Prepare: no resume',
    'Add a resume first: Prepare needs one.',
  ),
  LABEL_RESUME_MODE_DEFAULT: choiceLabel('Resume mode: default', 'Only my default resume'),
  // v20 A30: the owner's words, best-matched.
  LABEL_RESUME_MODE_SIMILAR: choiceLabel('Resume mode: similar', 'Use my best-matched resume'),
  LABEL_RESUME_MODE_TAILOR: choiceLabel('Resume mode: tailor', 'Always tailor'),
  // end v20 A29

  // Messages. {reset_time} is "12:00 AM Pacific Time" (resetText); {contact_email} is ADMIN_CONTACT_EMAIL.
  MSG_AI_UNAVAILABLE: message(
    'AI unavailable',
    'AI is unavailable right now: contact the admin, or use your own AI via MCP.',
  ),
  MSG_AI_USAGE_EXHAUSTED: message(
    'AI usage used up',
    "Today's AI use is used up: get extra credit, or use your own AI via MCP.",
  ),
  MSG_LIMIT_AUTO_APPLY: message(
    'Auto-apply limit reached',
    "You've used today's {limit} Free auto-applies; they reset at {reset_time}.",
    ['limit', 'reset_time'],
  ),
  MSG_LIMIT_RESUMES: message(
    'Resume limit reached',
    "You've reached the Free limit of {limit} resumes: delete some, or subscribe.",
    ['limit'],
  ),
  // v32 JOBS2 (E4, E5): the reason of the Jobs page's Paid-only alert (and of the API's refusal), one short sentence.
  MSG_PAID_AI_SEARCH: message('AI search is Paid', 'AI job search comes with a Paid account.'),
  MSG_SUBSCRIBE_CONTACT: message('Subscribe', 'Please contact the admin to subscribe.'),
  MSG_CREDIT_CONTACT: message('Buy extra credit', 'Please contact the admin to purchase extra credit.'),
  MSG_CONTACT_EMAIL_MISSING: message('No contact email', 'The admin has not set a contact email yet.'),
  MSG_PREPARE_CONFIRM: message(
    'Prepare confirm',
    'This may use a lot of your AI. Continue?',
  ),
  MSG_PREPARE_CONFIRM_DONT_SHOW: message("Confirm's checkbox", "Don't show this again", [], LABEL_MAX),
  MSG_AUTO_APPLY_USAGE: message('Auto-apply usage', '{used} of {limit} used today', ['used', 'limit'], LABEL_MAX),
  MSG_WAITING_FOR_RESET: message(
    'Waiting for the daily reset',
    'Daily limit reached: these wait until {reset_time}.',
    ['reset_time'],
  ),
  MSG_FILTERED: message('Filtered', 'Filtered: {reason}', ['reason'], 200),
  MSG_PREPARE_NOT_SAVED: message(
    'Prepare: not saved',
    "This job is no longer at Saved, so it wasn't prepared.",
  ),
  MSG_PREPARE_NO_JOB: message(
    'Prepare: no job',
    "This entry has no job posting, so it can't be prepared.",
  ),
  MSG_PREPARE_ACTIVE: message('Prepare: already preparing', 'This job is being prepared already.'),
  MSG_PREPARE_ALREADY_QUEUED: message('Prepare: already queued', 'This job is in your auto-apply queue already.'),
  MSG_PREPARE_QUEUE_FULL: message(
    'Prepare: queue full',
    'Your queue is full ({limit} jobs): clear finished jobs first.',
    ['limit'],
  ),
  MSG_PREPARE_INTERRUPTED: message(
    'Prepare: interrupted by the update',
    'An update stopped this: prepare it again.',
  ),
  MSG_PREPARE_NEEDS_COPY: message(
    'Prepare: needs an editable copy',
    'Make an editable copy of your uploaded resume in Documents first.',
  ),
  MSG_PREPARE_RESUME_FAILED: message('Prepare: resume failed', 'The tailored resume could not be made.'),
  MSG_PREPARE_LETTER_FAILED: message('Prepare: letter failed', 'The cover letter could not be written.'),
  MSG_PREPARE_ANSWERS_FAILED: message(
    'Prepare: answers failed',
    'Some answers will be made during the application.',
  ),
  MSG_PREPARE_TOOK_TOO_LONG: message('Prepare: too slow', 'The AI took too long to answer.'),
  MSG_PREPARE_FAILED: message('Prepare: failed', 'Something went wrong while this job was prepared.'),
  MSG_DIRECT_QUEUE_REMOVED: message(
    'Direct queueing removed',
    'Save the job, then prepare it on Auto-apply.',
  ),
  MSG_CUSTOM_FILTER_PENDING: message(
    'Custom filter pending',
    'The custom filter has not judged this job yet.',
  ),
  MSG_MANUAL_ONLY: message(
    'Applied to by hand',
    'Apply to this job by hand from Auto-apply.',
  ),

  // v20 FIX-A (REQ-3, A18): the limit and status messages the code still wrote itself, in the code's words.
  MSG_LIMIT_AUTO_APPLY_ACCOUNT: message(
    'Auto-apply limit reached (not Free)',
    "You've used today's {limit} auto-applies; they reset at {reset_time}.",
    ['limit', 'reset_time'],
  ),
  MSG_LIMIT_RESUMES_ACCOUNT: message(
    'Resume limit reached (not Free)',
    "You've reached your limit of {limit} resumes: delete some to add more.",
    ['limit'],
  ),
  MSG_PREPARE_BATCH_MAX: message('Prepare: too many jobs', 'Choose at most {max} saved jobs.', ['max']),
  MSG_BATCH_DOWNLOAD_MAX: message(
    'Batch download: too many resumes',
    'One download holds up to {max} resumes: select fewer.',
    ['max'],
  ),
  MSG_TEXT_TOO_LONG: message('Text too long', 'Use at most {max} characters.', ['max']),
  MSG_AI_SEARCH_TIMEOUT: message(
    'AI search: too slow',
    'AI search took too long: try again or use classic search.',
  ),
  MSG_AI_SEARCH_FAILED: message(
    'AI search: failed',
    "AI search didn't finish: try again or use classic search.",
  ),
  MSG_CUSTOM_FILTER_FAILED: message('Custom filter failed', 'The custom filter could not judge these jobs.'),
  MSG_TAILOR_PER_HOUR: message(
    'Tailor limit reached',
    'You tailored {max} {max|resume|resumes} this hour, the most allowed: try again in {minutes} {minutes|minute|minutes}.',
    ['max', 'minutes'],
  ),
  MSG_MCP_OFF: message('MCP off', "Your own AI via MCP isn't available on your account."),
  MSG_MCP_TOKENS_MAX: message(
    'MCP tokens: at the limit',
    'You have {max} MCP tokens, the most allowed: revoke one first.',
    ['max'],
  ),
  MSG_MCP_RATE_LIMIT: message('MCP: too many requests', 'This MCP token has made too many requests.'),
  // end v20 FIX-A

  // Filter reason labels (06-filters-analysis.md, in FILTER_REASONS' order).
  FILTER_LABEL_AUTO_APPLY: filterLabel('Filter: auto-apply support', 'auto-apply not supported'),
  FILTER_LABEL_LOCATION_TYPE: filterLabel('Filter: location type', '{value}'),
  FILTER_LABEL_JOB_TYPE: filterLabel('Filter: job type', '{value}'),
  FILTER_LABEL_INDUSTRY: filterLabel('Filter: industry', '{value} industry'),
  FILTER_LABEL_LOCATION_MISMATCH: filterLabel('Filter: location', 'location ({value})'),
  FILTER_LABEL_QUALIFICATION: filterLabel('Filter: qualifications', 'qualifications ({value})'),
  FILTER_LABEL_CERTIFICATION: filterLabel('Filter: certification', 'certification ({value})'),
  FILTER_LABEL_SALARY: filterLabel('Filter: salary', 'pay below {value}'),
  FILTER_LABEL_EXPERIENCE: filterLabel('Filter: experience', '{value} level'),
  FILTER_LABEL_SPONSORSHIP: filterLabel('Filter: sponsorship', 'no visa sponsorship'),
  FILTER_LABEL_CLEARANCE: filterLabel('Filter: clearance', 'clearance required'),
  FILTER_LABEL_CUSTOM: filterLabel('Filter: custom', 'custom filter'),

  // The Auto-Apply page's state words (05-prepare-flow.md, "The state machine").
  STATE_PREPARING: stateLabel('State: preparing', 'Preparing'),
  STATE_PREPARING_OWN_AI: stateLabel('State: preparing with own AI', 'Preparing with your AI'),
  STATE_READY: stateLabel('State: ready', 'Ready'),
  STATE_APPLYING: stateLabel('State: applying', 'Applying'),
  STATE_APPLIED: stateLabel('State: applied', 'Applied'),
  STATE_FAILED: stateLabel('State: failed', 'Failed'),
  STATE_NEEDS_YOU: stateLabel('State: needs you', 'Needs you'),
  STATE_PREPARE_FAILED: stateLabel('State: preparation failed', 'Preparation failed'),
  // v2.0 build: row 6 of the state machine ("Prepared, not queued" in the Queue pane, "Prepared" on the Saved row) had
  // no constant in 02-constants.md; these two complete the set.
  STATE_PREPARED: stateLabel('State: prepared, not queued', 'Prepared, not queued'),
  STATE_WAITING_RESET: stateLabel('State: waiting for the reset', 'Waiting for daily reset'),
  STATE_MANUAL: stateLabel('State: apply manually', 'Apply manually'),
  // v20 A30: a Saved entry with a live queue row shows Draft; it replaces the marker Queued. v33 TRACKER (F1): a mark
  // only (the Tracker's card, row and detail badge, the Saved pane's marker and its filter tab), no longer a status.
  STATUS_DRAFT_LABEL: stateLabel('Status: draft', 'Draft'),
  // end v20 A30
  MARKER_PREPARING: stateLabel('Marker: preparing', 'Preparing'),
  MARKER_PREPARED: stateLabel('Marker: prepared', 'Prepared'),
  MARKER_APPLY_FAILED: stateLabel('Marker: not applied', 'Not applied'),

  // v31 FIX-DOCS: the Documents page's, the Job Tracker's and the letter editors' words (REV-UX UX-1, REV-REQ REQ-3):
  // TailorIT's own voice in one place, so an admin's edit reaches every screen. LABEL_ keys (at most 60 characters)
  // name a control, a column or a state; MSG_ keys are titles and sentences.
  MSG_DOCS_PAGE_DESCRIPTION: message('Documents: the page line', 'Your resumes, cover letters and templates.'),
  LABEL_DOCS_NEW: message('Documents: the New button', 'New', [] as const, LABEL_MAX),
  LABEL_DOCS_NEW_RESUME: message('Documents: New › resume', 'Resume', [] as const, LABEL_MAX),
  LABEL_DOCS_NEW_RESUME_HINT: message('Documents: New › resume, its hint', 'Build one from a template', [] as const, LABEL_MAX),
  LABEL_DOCS_NEW_LETTER: message('Documents: New › cover letter', 'Cover letter', [] as const, LABEL_MAX),
  LABEL_DOCS_NEW_LETTER_HINT: message('Documents: New › cover letter, its hint', 'Draft one for a job with AI', [] as const, LABEL_MAX),
  LABEL_DOCS_NEW_TEMPLATE: message('Documents: New › template', 'Letter template', [] as const, LABEL_MAX),
  LABEL_DOCS_NEW_TEMPLATE_HINT: message('Documents: New › template, its hint', 'Write it once, reuse it for every job', [] as const, LABEL_MAX),
  LABEL_DOCS_LIBRARY: message('Documents: the section list', 'Library', [] as const, LABEL_MAX),
  LABEL_DOCS_RESUMES: message('Documents: the resumes section', 'Resumes', [] as const, LABEL_MAX),
  LABEL_DOCS_LETTERS: message('Documents: the cover letters section', 'Cover letters', [] as const, LABEL_MAX),
  LABEL_DOCS_TEMPLATES: message('Documents: the templates section', 'Templates', [] as const, LABEL_MAX),
  MSG_DOCS_RESUMES_INTRO: message(
    'Documents: the resumes section line',
    'Your uploads, built resumes and tailored copies.',
  ),
  MSG_DOCS_LETTERS_INTRO: message('Documents: the cover letters section line', 'Letters you wrote, uploaded or drafted with AI.'),
  MSG_DOCS_TEMPLATES_INTRO: message(
    'Documents: the templates section line',
    'Reusable letters with placeholders for each job.',
  ),
  MSG_DOCS_RESUMES_EMPTY_TITLE: message('Documents: no resumes, the title', 'No resumes here yet', [] as const, LABEL_MAX),
  MSG_DOCS_RESUMES_EMPTY_TEXT: message(
    'Documents: no resumes, the line',
    'Upload your resume, or build one from a template.',
  ),
  MSG_DOCS_LETTERS_EMPTY_TITLE: message('Documents: no cover letters, the title', 'No cover letters yet', [] as const, LABEL_MAX),
  MSG_DOCS_LETTERS_EMPTY_TEXT: message(
    'Documents: no cover letters, the line',
    'Draft one from a tracked job, or upload one.',
  ),
  MSG_DOCS_TEMPLATES_EMPTY_TITLE: message('Documents: no templates, the title', 'No templates yet', [] as const, LABEL_MAX),
  MSG_DOCS_TEMPLATES_EMPTY_TEXT: message(
    'Documents: no templates, the line',
    'Write a letter once and reuse it for every job.',
  ),
  MSG_DOCS_NO_MATCH_TITLE: message('Documents: a search finds nothing, the title', 'Your search finds no {noun}', ['noun'] as const, LABEL_MAX),
  MSG_DOCS_NO_MATCH_TEXT: message('Documents: a search finds nothing, the line', 'Try other words, or clear the search to see them all.'),
  MSG_DOCS_DELETE_ONE_TITLE: message('Documents: delete one, the title', 'Delete this {noun}?', ['noun'] as const, LABEL_MAX),
  MSG_DOCS_DELETE_ONE_TEXT: message(
    'Documents: delete one, the line',
    '“{name}” is deleted for good.',
    ['name'] as const,
  ),
  MSG_DOCS_DELETE_MANY_TITLE: message('Documents: delete several, the title', 'Delete {count} {noun}?', ['count', 'noun'] as const, LABEL_MAX),
  MSG_DOCS_DELETE_MANY_TEXT: message('Documents: delete several, the line', "They're deleted for good."),
  LABEL_DOCS_DELETE_MANY_BUTTON: message('Documents: delete several, the button', 'Delete {count}', ['count'] as const, LABEL_MAX),
  LABEL_DOCS_RENAME_TITLE: message('Documents: rename, the title', 'Rename this {noun}', ['noun'] as const, LABEL_MAX),
  LABEL_DOCS_RENAME_SAVE: message('Documents: rename, the button', 'Save name', [] as const, LABEL_MAX),
  LABEL_DOCS_TEMPLATE_BUILT_IN: message('Documents: a built-in template', 'Built in', [] as const, LABEL_MAX),
  MSG_DOCS_TEMPLATE_BUILT_IN_KEPT: message(
    'Documents: a built-in template cannot be deleted',
    'Built-in templates stay: duplicate one to make it yours.',
  ),
  MSG_DOCS_TEMPLATES_SKIPPED: message(
    'Documents: built-in templates left out of a delete',
    '{count} built-in {count|template stays|templates stay}.',
    ['count'] as const,
  ),
  LABEL_DOCS_UPLOAD_RESUMES: message('Documents: the resume upload, the title', 'Upload resumes', [] as const, LABEL_MAX),

  MSG_TRACKER_PAGE_DESCRIPTION: message('Tracker: the page line', "Where each application stands and what's next."),
  LABEL_TRACKER_SEARCH: message('Tracker: the search field', 'Search by role or company', [] as const, LABEL_MAX),
  LABEL_TRACKER_FILTER: message('Tracker: the filter and sort menu', 'Filter and sort', [] as const, LABEL_MAX),
  LABEL_TRACKER_MORE: message('Tracker: the actions menu', 'Tracker actions', [] as const, LABEL_MAX),
  LABEL_TRACKER_LANES: message('Tracker: the lanes shown on the board', 'Lanes shown', [] as const, LABEL_MAX),
  LABEL_TRACKER_HIDE_LANE: message("Tracker: a lane's hide button", 'Hide lane', [] as const, LABEL_MAX),
  LABEL_TRACKER_SELECT: message('Tracker: choose applications for a bulk action', 'Select applications', [] as const, LABEL_MAX),
  MSG_TRACKER_SELECTED: message('Tracker: how many are selected', '{count} selected', ['count'] as const, LABEL_MAX),
  LABEL_TRACKER_MOVE_TO_STAGE: message('Tracker: move the selected to a stage', 'Move to stage', [] as const, LABEL_MAX),
  LABEL_TRACKER_IMPORT: message('Tracker: import', 'Import from CSV', [] as const, LABEL_MAX),
  LABEL_TRACKER_EXPORT: message('Tracker: export', 'Export to CSV', [] as const, LABEL_MAX),
  MSG_TRACKER_IMPORT_TITLE: message('Tracker: the import, the title', 'Import applications from a spreadsheet', [] as const, LABEL_MAX),
  MSG_TRACKER_DELETE_MANY_TITLE: message(
    'Tracker: delete several, the title',
    'Delete {count} {count|application|applications}?',
    ['count'] as const,
    LABEL_MAX,
  ),
  MSG_TRACKER_DELETE_MANY_TEXT: message(
    'Tracker: delete several, the line',
    'Their notes and dates are deleted for good too.',
  ),
  MSG_TRACKER_ARCHIVE_MANY_TITLE: message(
    'Tracker: archive several, the title',
    'Archive {count} {count|application|applications}?',
    ['count'] as const,
    LABEL_MAX,
  ),
  MSG_TRACKER_ARCHIVE_MANY_TEXT: message('Tracker: archive several, the line', 'You can restore them from Archived.'),
  MSG_TRACKER_RESTORE_MANY_TITLE: message(
    'Tracker: restore several, the title',
    'Restore {count} {count|application|applications}?',
    ['count'] as const,
    LABEL_MAX,
  ),
  MSG_TRACKER_RESTORE_MANY_TEXT: message('Tracker: restore several, the line', 'They move back to your active applications.'),
  MSG_TRACKER_MOVE_MANY_TITLE: message(
    'Tracker: move several, the title',
    'Move {count} {count|application|applications} to {stage}?',
    ['count', 'stage'] as const,
    LABEL_MAX,
  ),
  MSG_TRACKER_MOVE_MANY_TEXT: message('Tracker: move several, the line', 'Each one is dated today in {stage}.', ['stage'] as const),
  MSG_TRACKER_ARCHIVE_ALL_TITLE: message('Tracker: archive all, the title', 'Archive every active application?', [] as const, LABEL_MAX),
  MSG_TRACKER_ARCHIVE_ALL_TEXT: message('Tracker: archive all, the line', 'You can restore them from Archived.'),
  MSG_TRACKER_DELETE_ONE_TITLE: message('Tracker: delete one, the title', 'Delete this application?', [] as const, LABEL_MAX),
  MSG_TRACKER_DELETE_ONE_TEXT: message(
    'Tracker: delete one, the line',
    '{title} at {company} and its notes are deleted for good.',
    ['title', 'company'] as const,
  ),
  MSG_TRACKER_EMPTY_TITLE: message('Tracker: nothing tracked, the title', 'Nothing tracked yet', [] as const, LABEL_MAX),
  MSG_TRACKER_EMPTY_TEXT: message(
    'Tracker: nothing tracked, the line',
    'Add one by its link, or save a job on Jobs.',
  ),
  MSG_TRACKER_NO_MATCH_TITLE: message('Tracker: a search finds nothing, the title', 'No applications match', [] as const, LABEL_MAX),
  MSG_TRACKER_NO_MATCH_TEXT: message('Tracker: a search finds nothing, the line', 'Try other words or fewer filters, or clear them.'),
  MSG_TRACKER_LANE_EMPTY_TITLE: message('Tracker: an empty lane, the title', 'Nothing here yet', [] as const, LABEL_MAX),
  MSG_TRACKER_LANE_EMPTY_TEXT: message('Tracker: an empty lane, the line', 'Drag a card here when it reaches {stage}.', ['stage'] as const),
  MSG_TRACKER_LANE_DROP: message('Tracker: a lane under a dragged card', 'Drop to move it here', [] as const, LABEL_MAX),
  MSG_TRACKER_ARCHIVED_LANE_EMPTY: message('Tracker: the empty Archived lane', 'Drag a card here to archive it.'),
  MSG_TRACKER_NEXT_STEP: message("Tracker: a card's next step", 'Next: {step}', ['step'] as const, LABEL_MAX),
  LABEL_TRACKER_STEP_SAVED: message('Tracker: the next step at Saved', 'apply', [] as const, LABEL_MAX),
  // v33 TRACKER (F1): LABEL_TRACKER_STEP_DRAFT is gone with the Draft lane; a Draft entry's next step is Saved's.
  LABEL_TRACKER_STEP_APPLIED: message('Tracker: the next step at Applied', 'follow up', [] as const, LABEL_MAX),
  LABEL_TRACKER_STEP_SCREEN: message('Tracker: the next step at Screen', 'prep the call', [] as const, LABEL_MAX),
  LABEL_TRACKER_STEP_INTERVIEWING: message('Tracker: the next step at Interviewing', 'prep the interview', [] as const, LABEL_MAX),
  LABEL_TRACKER_STEP_OFFER: message('Tracker: the next step at Offer', 'weigh the offer', [] as const, LABEL_MAX),
  LABEL_TRACKER_STEP_DONE: message('Tracker: an accepted application', 'Done', [] as const, LABEL_MAX),
  LABEL_TRACKER_STEP_CLOSED: message('Tracker: a rejected, withdrawn or ghosted application', 'Closed', [] as const, LABEL_MAX),
  MSG_TRACKER_DAYS_IN_STAGE: message('Tracker: time in the stage', 'In {stage} for {days} {days|day|days}', ['days', 'stage'] as const, LABEL_MAX),
  MSG_TRACKER_IN_STAGE_TODAY: message('Tracker: in the stage since today', 'In {stage} since today', ['stage'] as const, LABEL_MAX),
  LABEL_TRACKER_DAYS_SHORT: message('Tracker: time in the stage, short', '{days}d', ['days'] as const, LABEL_MAX),
  LABEL_TRACKER_TODAY_SHORT: message('Tracker: in the stage since today, short', 'Today', [] as const, LABEL_MAX),
  MSG_TRACKER_STAGE_PROGRESS: message(
    "Tracker: a row's stage meter",
    '{stage}, stage {step} of {steps}',
    ['stage', 'step', 'steps'] as const,
    LABEL_MAX,
  ),
  LABEL_TRACKER_STAGE_MENU: message("Tracker: a row's stage button", 'Stage: {stage}', ['stage'] as const, LABEL_MAX),
  LABEL_TRACKER_COL_ROLE: message('Tracker list: the role column', 'Role', [] as const, LABEL_MAX),
  LABEL_TRACKER_COL_PROGRESS: message('Tracker list: the progress column', 'Progress', [] as const, LABEL_MAX),
  LABEL_TRACKER_COL_TIME: message('Tracker list: the time in stage column', 'In stage', [] as const, LABEL_MAX),
  LABEL_TRACKER_COL_STAGE: message('Tracker list: the stage column', 'Stage', [] as const, LABEL_MAX),
  MSG_TRACKER_ADD_TITLE: message('Tracker: add an application, the title', 'Track an application', [] as const, LABEL_MAX),
  LABEL_TRACKER_FIELD_TITLE: message('Tracker: the job title field', 'Job title', [] as const, LABEL_MAX),
  LABEL_TRACKER_EDIT_POSTING: message("Tracker: edit an application's job, the title", 'Edit job details', [] as const, LABEL_MAX),
  LABEL_TRACKER_MATCH: message("Tracker: an application's keyword match, the tab", 'Your match', [] as const, LABEL_MAX),
  MSG_TRACKER_MATCH_COUNT: message(
    "Tracker: an application's keyword match, the count",
    '{matched} of {total} {total|keyword is|keywords are} on your resume',
    ['matched', 'total'] as const,
  ),

  MSG_LETTER_BLANKS_TITLE: message('Letter editor: placeholders left, the title', 'A few blanks left to fill', [] as const, LABEL_MAX),
  MSG_LETTER_BLANKS_TEXT: message('Letter editor: placeholders left, the line', 'Pick a tag and type its text; every copy changes.'),
  MSG_LETTER_GENERATE_TITLE: message('Letter editor: draft with AI, the title', 'Draft this letter with AI', [] as const, LABEL_MAX),
  MSG_LETTER_GENERATE_TEXT: message(
    'Letter editor: draft with AI, the line',
    'Describe the job; TailorIT writes a letter from your resume.',
  ),
  LABEL_LETTER_TAB_JOB: message('Letter editor: draft with AI, the job tab', 'The job', [] as const, LABEL_MAX),
  LABEL_LETTER_TAB_NOTES: message('Letter editor: draft with AI, the notes tab', 'Your notes', [] as const, LABEL_MAX),
  MSG_LETTER_JOB_INTRO: message('Letter editor: draft with AI, the job line', 'Pick a tracked job, or type one in.'),
  LABEL_LETTER_PICK_JOB: message('Letter editor: draft with AI, the job picker', 'Pick an application', [] as const, LABEL_MAX),
  MSG_LETTER_TEMPLATE_INTRO: message('Letter editor: draft with AI, the template line', 'Start from one of your templates, or from nothing.'),
  LABEL_LETTER_NO_TEMPLATE: message('Letter editor: draft with AI, no template', 'No template', [] as const, LABEL_MAX),
  MSG_LETTER_NOTES_INTRO: message('Letter editor: draft with AI, the notes line', 'What to stress, leave out or build on.'),
  MSG_LETTER_NOTES_PLACEHOLDER: message(
    'Letter editor: draft with AI, the notes hint',
    'Paste a letter or a few notes to start from...',
  ),
  LABEL_LETTER_DOWNLOAD: message('Letter editor: the download menu', 'Download', [] as const, LABEL_MAX),
  LABEL_LETTER_AI_NOTES: message('Template editor: the AI notes button', 'AI notes', [] as const, LABEL_MAX),
  LABEL_LETTER_INSERT_PLACEHOLDER: message('Template editor: insert a placeholder', 'Insert a placeholder...', [] as const, LABEL_MAX),
  LABEL_LETTER_START_FROM_TEMPLATE: message('Template editor: copy another template in', 'Start from a template...', [] as const, LABEL_MAX),
  // end v31 FIX-DOCS

  // v30 ST0: the constants audit's keys (SP\p2\build\ST0.md, "The constants audit"): business numbers and limit or
  // status sentences the code still holds beside itself, each in today's value or words. The area packages of wave 0
  // read them (constantsOf(deps).get / .message, the web's t) and remove the copies; the scans list who still holds
  // one (apps/api/test/structure/allowlist.*.ts).
  AI_TASK_KEEP_DAYS: {
    kind: 'int', default: 30, adminEditable: true, public: true /* v34 PUBLIC: the Privacy page says it */, group: 'retention', min: 1, max: 3650,
    label: 'Finished AI tasks (days)',
    help: 'Days a finished AI task (its input and result) is kept before it is pruned.',
  },
  AI_USAGE_KEEP_DAYS: {
    kind: 'int', default: 35, adminEditable: true, public: false, group: 'retention', min: 31, max: 3650,
    label: 'AI usage ledger (days)',
    help: 'Days of the AI usage ledger kept for Admin › AI usage (its longest window, 30 days, and more).',
  },
  EXTENSION_TOKENS_PER_ACCOUNT: {
    kind: 'int', default: 10, adminEditable: true, public: true, group: 'auto_apply', min: 1, max: 100,
    label: 'Connected browsers per account',
    help: 'Live extension connections (browsers) one account may hold.',
  },
  EXTENSION_TOKEN_KEEP_DAYS: {
    kind: 'int', default: 30, adminEditable: true, public: true /* v34 PUBLIC: the Privacy page says it */, group: 'retention', min: 1, max: 3650,
    label: 'Ended extension connections (days)',
    help: 'Days a revoked or expired extension connection is kept (with why it ended) before it is pruned.',
  },
  MCP_REPORTS_KEPT: {
    kind: 'int', default: 200, adminEditable: true, public: false, group: 'retention', min: 1, max: 100_000,
    label: 'MCP reports kept per account',
    help: "The newest reports from a person's AI kept per account; older ones are pruned.",
  },
  JOB_ANALYSIS_PER_ACCOUNT_PER_HOUR: {
    kind: 'int', default: 20, adminEditable: true, public: false, group: 'ai', min: 1, max: 1000,
    label: 'Job analyses per account per hour',
    help: 'New AI job analyses one account starts by opening jobs, in any sliding hour.',
  },
  QUEUE_TOMBSTONE_KEEP_DAYS: {
    kind: 'int', default: 30, adminEditable: true, public: false, group: 'retention', min: 1, max: 3650,
    label: 'Removed queue rows (days)',
    help: 'Days the mark of a removed or cleared auto-apply queue row is kept, so a late extension report finds it.',
  },
  AUTOFILL_AI_PER_HOUR: {
    kind: 'int', default: 200, adminEditable: true, public: false, group: 'ai', min: 1, max: 10_000,
    label: 'Autofill AI requests per hour',
    help: "The extension's AI requests of one kind one account may make in any sliding hour.",
  },
  AUTOFILL_DRAFTS_PER_DAY: {
    kind: 'int', default: 300, adminEditable: true, public: false, group: 'ai', min: 1, max: 10_000,
    label: 'Autofill drafts per day',
    help: "The extension's AI drafts one account may ask for in any sliding 24 hours.",
  },
  AUTOFILL_COVER_LETTERS_PER_HOUR: {
    kind: 'int', default: 60, adminEditable: true, public: false, group: 'ai', min: 1, max: 1000,
    label: 'Autofill cover letters per hour',
    help: 'Cover letters the extension may have written for one account in any sliding hour.',
  },
  SAVED_SEARCHES_MAX: {
    kind: 'int', default: 50, adminEditable: true, public: true, group: 'jobs', min: 1, max: 1000,
    label: 'Saved searches per account',
    help: 'Saved searches (the Jobs toolbar bookmark) one account may keep.',
  },
  // v36 JOBS (PLAN J1): SAVE_ALL_RUNS_PER_HOUR is gone with Save all (a stored override of it is ignored, with a warning).
  JOB_SOURCE_RUN_KEEP_DAYS: {
    kind: 'int', default: 90, adminEditable: true, public: false, group: 'retention', min: 1, max: 3650,
    label: 'Ingest run history (days)', // v30 FIX-A (REQ-6): the runs themselves, not only their logs
    help: 'Days an ingest run (its counts and log) is kept before the daily housekeeping deletes it; each source keeps its newest.',
  },
  UPLOAD_MAX_MB: {
    kind: 'int', default: 5, adminEditable: false, public: true, group: 'resumes', min: 1, max: 10_000,
    label: 'Upload size (MB)',
    help: 'The largest file one upload takes (a resume, a letter, an import), in MB, read at start from .env only.',
  },
  UPLOAD_BATCH_MAX_FILES: {
    kind: 'int', default: 50, adminEditable: true, public: true, group: 'resumes', min: 1, max: 500,
    label: 'Files per upload',
    help: 'Files one resume upload takes at a time.',
  },
  MSG_EXTENSION_TOKENS_MAX: message(
    'Connected browsers: at the limit',
    'You have {max} connected browsers, the most allowed: disconnect one in Settings › Autofill.',
    ['max'],
  ),
  MSG_PHOTO_TOO_LARGE: message('Photo too large', 'That photo is over {max_mb} MB: choose a smaller one.', ['max_mb']),
  MSG_AI_BUSY: message(
    'AI request already running',
    'This AI task is already running: try again when it finishes.',
  ),
  MSG_AI_CANCELLED: message('AI request cancelled', 'This AI request was cancelled.'),
  MSG_AI_INTERRUPTED: message(
    'AI request interrupted',
    'The server restarted during this AI task: please try again.',
  ),
  MSG_RESUME_IMPORT_MAX: message('Resume import: too many', 'A file can hold at most {max} resumes.', ['max']),
  MSG_UPLOAD_BATCH_MAX: message(
    'Upload: too many files',
    'Up to {max} files at a time: {left_out} {left_out|file was|files were} left out.',
    ['max', 'left_out'],
  ),
  MSG_LETTER_BEING_WRITTEN: message(
    'Cover letter being written',
    "This cover letter is still being written: try again when it's done.",
  ),
  MSG_SAVED_SEARCHES_MAX: message(
    'Saved searches: at the limit',
    'You can keep {max} saved searches: delete one first.',
    ['max'],
  ),
  MSG_SIGN_INS_MAX: message(
    'Job-site sign-ins: at the limit',
    'You can save {max} job-site sign-ins: delete one first.',
    ['max'],
  ),
  MSG_SAVED_ANSWERS_MAX: message(
    'Saved answers: at the limit',
    'You have {max} saved answers, the most kept: delete some in Settings › Autofill.',
    ['max'],
  ),
  MSG_AUTOFILL_RESUME_TOO_LARGE: message(
    'Autofill: resume file too large',
    "This resume's file is over {max_mb} MB, too large to attach: choose another.",
    ['max_mb'],
  ),
  MSG_SIGN_IN_CODE_COOLDOWN: message(
    'Sign-in code: just sent',
    'A code was just sent: check spam, or ask again in {seconds} {seconds|second|seconds}.',
    ['seconds'],
  ),
  MSG_SIGN_IN_CODE_EXPIRED: message('Sign-in code: expired', 'That code expired: ask for a new one.'),
  MSG_SIGN_IN_CODE_ATTEMPTS: message(
    'Sign-in code: too many tries',
    'Too many wrong tries ({max}): ask for a new code.',
    ['max'],
  ),
  MSG_CONNECT_CODE_EXPIRED: message(
    'Connect code: expired',
    'That code expired or was used: get a new one in Settings › Autofill.',
  ),
  MSG_INGEST_IMPORT_RUNNING: message('Import running', 'This import is still running.'),
  MSG_INGEST_SOURCE_RUNNING: message('Source running', 'This source is already running.'),
  MSG_INGEST_SOURCE_RUNNING_DELETE: message(
    'Source running: no delete',
    'This source is running: delete it once the run ends.',
  ),
  MSG_SHEET_ROWS_MAX: message(
    'Sheet import: too many rows',
    'This tab has over {max} rows: split it into tabs of {max} rows or fewer.',
    ['max'],
  ),
  MSG_SHEET_TOO_LARGE: message(
    'Sheet import: too large',
    'This tab holds over {max_mb} MB of text: split it into smaller tabs.',
    ['max_mb'],
  ),
  LABEL_JOB_CLOSED: stateLabel('Job: closed', 'No longer accepting applications'),
  LABEL_JOB_LIVE: stateLabel('Job: confirmed live', 'Confirmed live in the last 24 hours'),
  // end v30 ST0
  // v30 ST4: the Google Sheet import's words for an answer from Google over the read's cap (ingest/sheets/client.ts),
  // which said the second sentence of MSG_SHEET_TOO_LARGE beside the code.
  MSG_SHEET_ANSWER_TOO_LARGE: message(
    'Sheet import: answer too large',
    'This tab is too large (over {size}): split it into smaller tabs.',
    ['size'],
  ),
  // end v30 ST4
  // v30 ST1: the resume ZIP's statuses (SP\p2\build\ST0-deferred-keys.txt), in today's words, which
  // features/resume-zip reads; MSG_ZIP_NOT_MADE too, since its second sentence is MSG_ZIP_GONE's; and the template
  // editor's cap on its AI prompt (cover-letter-templates/router.ts), its number written as the editor writes it.
  MSG_ZIP_ALREADY_BUILDING: message(
    'Resumes ZIP: already building',
    'Your resumes are already being built: wait for that download.',
  ),
  MSG_ZIP_STILL_BUILDING: message(
    'Resumes ZIP: still building',
    'Your resumes are still being built.',
  ),
  MSG_ZIP_STOPPED: message(
    'Resumes ZIP: stopped',
    'The server restarted while building: please try again.',
  ),
  MSG_ZIP_GONE: message('Resumes ZIP: gone', 'That zip is gone: build your resumes again.'),
  MSG_ZIP_NOT_MADE: message('Resumes ZIP: not made', "That zip couldn't be made: build your resumes again."),
  MSG_ZIP_SERVER_BUSY: message(
    'Resumes ZIP: server busy',
    'Another zip is being built: try again in {seconds} {seconds|second|seconds}.',
    ['seconds'],
  ),
  MSG_ZIP_TOO_LARGE: message(
    'Resumes ZIP: too large',
    'These are over {max_mb} MB together: select fewer {items}.',
    ['max_mb', 'items'],
  ),
  MSG_TEMPLATE_AI_PROMPT_TOO_LONG: message(
    'Letter template: AI prompt too long',
    'The AI prompt can be at most {max} characters.',
    ['max'],
  ),
  // end v30 ST1
  // v30 ST3: the constants audit's keys deferred to their adoption (the auto-apply queue's job states, two autofill
  // refusals), read by the autofill and jobs features, and the sign-in refusal that shares their words
  // (MSG_SIGN_IN_CODE_USED). v36 JOBS (PLAN J1): MSG_SAVE_ALL_PER_HOUR and MSG_SAVE_ALL_BUSY are gone with Save all.
  MSG_AUTOFILL_LETTER_TOO_LARGE: message(
    'Autofill: letter PDF too large',
    "This cover letter's PDF is over {max_mb} MB, too large to attach.",
    ['max_mb'],
  ),
  MSG_AUTOFILL_NOTE_TOO_LONG: message(
    'Autofill: note too long',
    'With its hidden lines the note is over {max} characters: shorten it in Settings › Autofill.',
    ['max'],
  ),
  MSG_QUEUE_JOB_NOT_RUNNING: message(
    'Auto-apply job: not running',
    "This job isn't running any more: ask for the next one.",
  ),
  MSG_QUEUE_JOB_NOT_YOURS: message(
    'Auto-apply job: another browser',
    'Another browser is running this job.',
  ),
  MSG_QUEUE_JOB_APPLYING: message(
    'Auto-apply job: applying',
    'The extension is applying to this job: wait, or stop auto-apply first.',
  ),
  MSG_QUEUE_JOB_TAKEN: message(
    'Auto-apply job: taken',
    'Another run has this job: open the next queued one.',
  ),
  MSG_QUEUE_JOB_FINISHED: message(
    'Auto-apply job: finished',
    'This job is finished: open the next queued one.',
  ),
  MSG_SIGN_IN_CODE_USED: message(
    'Sign-in code: used or never sent',
    'That code was used or never sent: ask for a new one.',
  ),
  // end v30 ST3
  // v30 ST5: the web's limit and status sentences (SP\p2\build\ST0-deferred-keys.txt, ST5's block, and the ones
  // ST5's allowlisted literals needed), each in today's words. The web reads them through usePublicConstants().t, or
  // their defaults where no session reads the server's values (the sign-in page) and in the pure helpers' defaults.
  // v30 INT-0: the words for one (a file, a second) come from the count's words ({left_out|file was|files were},
  // {seconds|second|seconds}: ./render.ts), so ST5's two *_ONE keys are gone.
  MSG_WRITE_WITH_AI_FAILED: message('Write with AI failed', "Write with AI didn't finish: please try again."),
  MSG_AI_READING_WAITING: message(
    'AI reading waiting',
    'Waiting for the AI reading (one upload at a time).',
  ),
  LABEL_AI_READING_WAITING: message('AI reading waiting: list line', 'Waiting for the AI reading', [] as const, LABEL_MAX),
  MSG_UPLOAD_HINT: message('Upload hint', 'PDF, DOC or DOCX, up to {max_mb} MB, {max} files at a time.', ['max_mb', 'max']),
  MSG_UPLOAD_SIZE_HINT: message('Upload hint: size', 'Up to {max_mb} MB.', ['max_mb']),
  MSG_UPLOAD_TILE_HINT: message('Upload hint: resume tile', 'PDF or Word, up to {max_mb} MB', ['max_mb']),
  MSG_SECTION_ENTRIES_MAX: message('Resume section: too many entries', 'A section holds {max} entries at most', ['max']),
  MSG_CUSTOM_SECTIONS_MAX: message('Resume: too many custom sections', 'A resume can have at most {max} custom sections.', ['max']),
  MSG_ENTRY_BULLETS_MAX: message('Resume entry: too many bullets', 'An entry holds {max} bullets at most', ['max']),
  MSG_SIGN_IN_CODE_SENT: message(
    'Sign-in code: already sent',
    'A code was sent to {email}: enter it, or ask again in {seconds} {seconds|second|seconds}.',
    ['email', 'seconds'],
  ),
  MSG_CSV_ROWS_MAX: message(
    'CSV import: too many rows',
    'That file has over {max} rows: split it and import each part.',
    ['max'],
  ),
  MSG_JOB_GONE: message('Job no longer available', 'This job is no longer available'),
  MSG_JOB_GONE_DETAIL: message('Job no longer available: why', 'It may have been taken down, or the link is out of date.'),
  MSG_LIST_TOO_LONG: message('Profile list: too long', 'List at most {max}', ['max']),
  MSG_LIST_FULL: message('Profile list: full', 'At most {max}', ['max']),
  // end v30 ST5
  // v30 INT-0: the words the integration of the structure wave found left beside their code (SPp2uildINT-0.md).
  // The extension shows this one as it is (autofill/cover-letters.ts, a letter still being written): its own key, so
  // its words never change with MSG_LETTER_BEING_WRITTEN's (the coordinator's decision).
  MSG_AUTOFILL_LETTER_BEING_WRITTEN: message(
    'Autofill: cover letter being written',
    'This cover letter is still being written: ask again in a moment.',
  ),
  // The letter and template rename rules' caps (packages/shared/src/letters/constants.ts), in today's words.
  MSG_TEMPLATE_NAME_TOO_LONG: message(
    'Letter template: name too long',
    'Template name must be at most {max} characters long',
    ['max'],
  ),
  MSG_LETTER_TITLE_TOO_LONG: message(
    'Cover letter: name too long',
    'Cover letter name must be at most {max} characters long',
    ['max'],
  ),
  // A file over the upload cap (core/files/upload.ts), in today's words; {name} is "That file" when the name is not known.
  MSG_FILE_TOO_LARGE: message('File too large', '{name} is over {max_mb} MB: choose a smaller file.', ['name', 'max_mb']),
  // The web's own size checks before a file is sent, in today's words: a resume upload or PDF import (UPLOAD_MAX_MB,
  // resume-editor/files.ts) and the header photo's pick before cropping (resume-editor/photo/crop.ts).
  MSG_UPLOAD_FILE_TOO_LARGE: message(
    'Upload: file too large (before sending)',
    '{name} is {max_mb} MB or larger: choose a smaller file.',
    ['name', 'max_mb'],
  ),
  MSG_PHOTO_FILE_TOO_LARGE: message(
    'Photo: file too large (before cropping)',
    'That image is over {max_mb} MB: choose a smaller one.',
    ['max_mb'],
  ),
  // end v30 INT-0
  // v30 S3: a Workday career site's run (12 §3.2, §8.3): its sitemap finds postings, each posting is read on its own
  // (new ones, then the ones the sitemap no longer lists, then the ones not read for a while), and a posting closes
  // only when its own read says it is gone. Placed before CT's block, which constants-v30.test.ts keeps last.
  WORKDAY_SITE_READS_PER_RUN: {
    kind: 'int', default: 200, adminEditable: true, public: false, group: 'jobs', min: 1, max: 5000,
    label: 'Workday postings read per run',
    help: "Postings one run of a Workday career site reads on their own (one request each, at the host's pace).",
  },
  WORKDAY_SITE_RECHECK_DAYS: {
    kind: 'int', default: 7, adminEditable: true, public: false, group: 'jobs', min: 1, max: 29,
    label: 'Workday postings read again (days)',
    help: "A Workday posting its site's sitemap still lists is read again after this many days (under the unverified jobs' 30).",
  },
  WORKDAY_SITE_UNLISTED_RECHECK_HOURS: {
    kind: 'int', default: 24, adminEditable: true, public: false, group: 'jobs', min: 1, max: 720,
    label: 'Unlisted Workday postings read again (hours)',
    help: "A Workday posting its site's sitemap no longer lists is read again after this many hours, to see whether it closed.",
  },
  // end v30 S3
  // v30 S4: Himalayas' daily request limit (12 §3.7: 60 a minute, 10,000 a day), shared by every Himalayas source's
  // runs (ingest/adapters/himalayas.ts), a little under the terms' number. Before CT's block, which stays last.
  HIMALAYAS_REQUESTS_PER_DAY: {
    kind: 'int', default: 9000, adminEditable: true, public: false, group: 'jobs', min: 0, max: 10_000,
    label: 'Himalayas requests per day',
    help: "Requests a day to Himalayas' jobs API, shared by every Himalayas source (Himalayas allows 10,000 a day; 0 reads nothing).",
  },
  // end v30 S4
  // v30 FIX-A: the W6 review's ingest fixes. Before CT's block, which stays last.
  // DECISIONS P6.1: discovery validates boards of the four v2.0 public-API kinds (Greenhouse, Lever, Ashby, Workable)
  // with today's identity (INGEST_USER_AGENT), as v2.0's ingest reads them; every new kind still waits for
  // BOT_USER_AGENT. The owner can turn it off.
  DISCOVERY_VALIDATE_V2_KINDS_TODAY: {
    kind: 'bool', default: true, adminEditable: true, public: false, group: 'jobs',
    label: "Validate v2.0 boards with today's identity",
    // v36 SOURCES: a validated board becomes a source that waits, off, for an admin.
    help: "Whether found Greenhouse, Lever, Ashby and Workable boards are checked before BOT_USER_AGENT is set; one that answers waits for an admin.",
  },
  // REV-SEC SEC-2, REV-BEH BEH-3: a company's opt-out is a gate on its sources.
  MSG_INGEST_SOURCE_OPTED_OUT: message(
    'Source of an opted-out company',
    'This company opted out, so the source stays off: remove the opt-out in Admin › Companies first.',
  ),
  // end v30 FIX-A
  // v30 FIX-C (W5 review SEC-5, DECISIONS P6.2): E1's live Wikidata lookups read two Wikimedia API addresses that
  // robots.txt does not cover for crawlers (the robots exemption list, core/http/robots-exemptions.ts). Their own
  // switch, off: setting BOT_USER_AGENT for the other new reads does not turn them on (the owner decides the exception).
  // Before CT's block, which constants-v30.test.ts keeps last.
  REFDATA_LIVE_LOOKUPS: {
    kind: 'bool', default: false, adminEditable: true, public: false, group: 'jobs',
    label: 'Live Wikidata lookups',
    help: "Whether enrichment asks Wikidata's APIs about companies the dumps lack (needs BOT_USER_AGENT and the owner's robots.txt yes).",
  },
  // end v30 FIX-C
  // v30 FIX-B (REV-UX UX-15): the held job's title on its badge and notice (14 §4.3), beside MSG_EXT_JOB_HELD's sentence,
  // so an admin's edit reaches both. Before CT's block, which stays last.
  MSG_JOB_HELD_TITLE: message('Job held for review: title', 'Waiting for approval', [] as const, LABEL_MAX),
  // end v30 FIX-B
  // v30 FIX-WEB (REV-REQ REQ-7): numbers the admin pages say in words, moved here from beside their code so the words
  // follow them (the one-source rule): USAJOBS' own cap on one search's rows and Jobicy's "one sync an hour" (both the
  // services' rules, so .env only), and the window of the reporters' trust rule (14 §7). Public: Admin › Sources and
  // Admin › Review say them.
  USAJOBS_MAX_ROWS: {
    kind: 'int', default: 10_000, adminEditable: false, public: true, group: 'jobs', min: 500, max: 10_000,
    label: 'USAJOBS rows per search',
    help: 'The most announcements one USAJOBS search answers, so a larger search is read in part (set in .env only).',
  },
  JOBICY_READ_GAP_MINUTES: {
    kind: 'int', default: 60, adminEditable: false, public: true, group: 'jobs', min: 60, max: 1440,
    label: 'Gap between Jobicy reads (minutes)',
    help: "The least time between two reads of Jobicy's API by any Jobicy source, its terms' hour (set in .env only).",
  },
  TRUST_REJECT_WINDOW_DAYS: {
    kind: 'int', default: 30, adminEditable: true, public: true, group: 'jobs', min: 1, max: 365,
    label: 'Reporter trust window (days)',
    help: 'Days a rejected (or source-reopened) report counts against its account for the trust rule of automatic decisions.',
  },
  // REV-UX UX-10: the mark of a saved or tracked job that closed (LABEL_JOB_CLOSED is its sentence).
  LABEL_JOB_CLOSED_MARK: stateLabel('Job: closed mark', 'Closed'),
  // REQ-7: Admin › Sources › Add source's notes on what keeps a feed (or a career site added by hand) off, the numbers
  // filled from the constants above ({max}: USAJOBS_MAX_ROWS; {gap}: JOBICY_READ_GAP_MINUTES in words, "once an hour").
  MSG_SOURCE_NOTE_USAJOBS: message(
    'Add source: the USAJOBS note',
    'Every open USAJOBS announcement (up to {max} a source); needs BOT_USER_AGENT and USAJOBS_API_KEY.',
    ['max'],
  ),
  MSG_SOURCE_NOTE_JOBICY: message(
    'Add source: the Jobicy note',
    'The newest remote jobs in one region, read at most {gap}; needs BOT_USER_AGENT.',
    ['gap'],
  ),
  MSG_SOURCE_NOTE_HIMALAYAS: message('Add source: the Himalayas note', 'Remote jobs open to one country; needs BOT_USER_AGENT and HIMALAYAS_API_KEY.'),
  MSG_SOURCE_NOTE_CAREER_SITE: message(
    'Add source: the career site note',
    'Read politely (robots.txt and pace); needs Read career pages on and BOT_USER_AGENT set.',
  ),
  // end v30 FIX-WEB
  // v30 FIX-PG (PG-LOAD PGL-5, docs/design/part2/measurements.md §6): the Jobs page's filter lists (the facets summary:
  // which filters the data can answer, the categories and "Remote in" countries with their counts) read every shared
  // search row three times a request: 2-3 s at mix B. Kept once for everyone instead, with the viewer's own page jobs
  // added at each request (features/jobs/facet-counts.ts). Before CT's block, which constants-v30.test.ts keeps last.
  JOB_FACETS_REFRESH_MINUTES: {
    kind: 'int', default: 10, adminEditable: true, public: false, group: 'jobs', min: 0, max: 1440,
    label: 'Filter counts refresh (minutes)',
    help: "How old the Jobs page's filter counts may get before they are counted again in the background (0: at every request).",
  },
  JOB_FACETS_CACHE_MIN_JOBS: {
    kind: 'int', default: 20_000, adminEditable: true, public: false, group: 'jobs', min: 0, max: 100_000_000,
    label: 'Filter counts kept from (open jobs)',
    help: 'Below this many open shared jobs the filter counts are counted at every request; from it on, every refresh period.',
  },
  // end v30 FIX-PG
  // v30 CT: the v3.0 constants (docs/design/part2/00-overview.md §4 and 14-extension-reports.md §12), each at the
  // design's default, and the owner-blocked switches of SP\p2\DECISIONS.md P1 (PLAN §5), off: name probes at 0, the
  // site reader's two switches false, the extension reports' automatic approvals false. The .env-only keys of §4
  // (BOT_USER_AGENT, DATABASE_URL, PG_*, the sign-up keys) are the API's configuration, not constants.
  // RESUME_SAFETY_CAP's new default (5,100) lands with the resume counter (D1d), so a count of thousands never runs
  // as count(*). The groups are today's (sourcing, companies and the reports sit under Jobs and Server AI).
  // Search (11 §7).
  JOB_SEARCH_COUNT_CAP: {
    kind: 'int', default: 10_000, adminEditable: true, public: true, group: 'jobs', min: 100, max: 1_000_000,
    label: 'Search count cap',
    help: '"Found N jobs" counts the matches up to this number, then says "N+".',
  },
  SEARCH_RELEVANCE_WINDOW: {
    // v30 WEB-JOBS: public, so the Jobs page's sort menu says "among the newest 2,000 matches" with the admin's number.
    kind: 'int', default: 2000, adminEditable: true, public: true, group: 'jobs', min: 100, max: 100_000,
    label: 'Most relevant window',
    help: '"Most relevant" ranks the newest this many matches by how well they match the words.',
  },
  SEARCH_STATEMENT_TIMEOUT_MS: {
    kind: 'int', default: 3000, adminEditable: true, public: false, group: 'jobs', min: 100, max: 60_000,
    label: 'Search facets time (ms)',
    help: 'Milliseconds the MCP search facets may take; past it, the tool answers the capped count without facets.',
  },
  // Retention (11 §8.2, 14 §9).
  JOB_RAW_KEEP_DAYS: {
    kind: 'int', default: 30, adminEditable: true, public: false, group: 'retention', min: 1, max: 365,
    label: 'Raw source answers (days)',
    help: "Days a source's raw posting payloads are kept at the longest (a source kind may keep fewer).",
  },
  AI_TASK_PAYLOAD_KEEP_DAYS: {
    kind: 'int', default: 3, adminEditable: true, public: false, group: 'retention', min: 1, max: 365,
    label: 'AI task inputs and results (days)',
    help: "Days an AI task's input and result are kept; the task's own row is kept as long as finished AI tasks are.",
  },
  USER_JOB_VIEW_KEEP_DAYS: {
    kind: 'int', default: 90, adminEditable: true, public: false, group: 'retention', min: 1, max: 3650,
    label: 'Viewed marks (days)',
    help: 'Days the mark of a job a person viewed is kept (hidden jobs stay hidden).',
  },
  DRAFT_ANSWERS_KEEP_DAYS_AFTER_APPLY: {
    kind: 'int', default: 30, adminEditable: true, public: false, group: 'retention', min: 1, max: 3650,
    label: 'Draft answers after applying (days)',
    help: "Days prepared draft answers are kept after applying, once the application's record holds the answers sent.",
  },
  JOB_ANALYSIS_CLOSED_KEEP_DAYS: {
    kind: 'int', default: 90, adminEditable: true, public: false, group: 'retention', min: 1, max: 3650,
    label: 'Analyses of closed jobs (days)',
    help: 'Days the analyses and facts of a closed job nobody tracks are kept.',
  },
  EXT_REVIEW_KEEP_DAYS: {
    kind: 'int', default: 180, adminEditable: true, public: false, group: 'retention', min: 1, max: 3650,
    label: 'Decided reviews (days)',
    help: "Days a decided Admin › Review item and its report rows are kept for the review's history.",
  },
  // Job sourcing: the scheduler, pacing and closing (12 §13).
  INGEST_HOSTS_IN_FLIGHT: {
    kind: 'int', default: 16, adminEditable: true, public: false, group: 'jobs', min: 1, max: 256,
    label: 'Hosts read at once',
    help: 'Outside hosts the ingest worker reads at the same time, one request in flight per host.',
  },
  INGEST_HOST_MIN_INTERVAL_MS: {
    kind: 'int', default: 1000, adminEditable: true, public: false, group: 'jobs', min: 1000, max: 600_000,
    label: 'Gap between API requests (ms)',
    help: "The least time between two requests to one API or feed host, or the host's Crawl-delay when it is longer.",
  },
  INGEST_CADENCE_HOT_HOURS: {
    kind: 'int', default: 6, adminEditable: true, public: false, group: 'jobs', min: 1, max: 168,
    label: 'Hot board cadence (hours)',
    help: "How often a hot board is read: one that changes often, has many open jobs, or holds a job in someone's Saved Jobs.",
  },
  INGEST_CADENCE_NORMAL_HOURS: {
    kind: 'int', default: 24, adminEditable: true, public: false, group: 'jobs', min: 1, max: 336,
    label: 'Normal board cadence (hours)',
    help: 'How often a board that changed in the last two weeks is read.',
  },
  INGEST_CADENCE_QUIET_DAYS: {
    kind: 'int', default: 3, adminEditable: true, public: false, group: 'jobs', min: 1, max: 60,
    label: 'Quiet board cadence (days)',
    help: 'How often a board with no change for two weeks is read.',
  },
  INGEST_CADENCE_EMPTY_DAYS: {
    kind: 'int', default: 7, adminEditable: true, public: false, group: 'jobs', min: 1, max: 90,
    label: 'Empty board cadence (days)',
    help: 'How often a board with no open jobs is read.',
  },
  INGEST_HOT_OPEN_JOBS: {
    kind: 'int', default: 200, adminEditable: true, public: false, group: 'jobs', min: 1, max: 100_000,
    label: 'Open jobs that make a board hot',
    help: 'A board with at least this many open jobs is read on the hot cadence.',
  },
  INGEST_CLOSE_AFTER_MISSES: {
    kind: 'int', default: 2, adminEditable: true, public: false, group: 'jobs', min: 1, max: 10,
    label: 'Listings missed before closing',
    help: "Complete listings in a row without a posting before its link closes (and its job, once no live link is left).",
  },
  INGEST_SUSPECT_DROP_SHARE: {
    kind: 'ratio', default: 0.5, adminEditable: true, public: false, group: 'jobs',
    label: 'Suspect listing drop',
    help: "A listing that drops more than this share of a board's open postings is read again instead of trusted.",
  },
  INGEST_SOURCE_DISABLE_AFTER_FAILURES: {
    kind: 'int', default: 10, adminEditable: true, public: false, group: 'jobs', min: 1, max: 1000,
    label: 'Failures before a source is disabled',
    help: 'Failed runs in a row before a source is disabled and flagged for an admin.',
  },
  INGEST_HOST_BREAKER_FAILURES: {
    kind: 'int', default: 5, adminEditable: true, public: false, group: 'jobs', min: 1, max: 100,
    label: 'Failures that hold a host',
    help: 'Failed requests in a row to one host before the circuit breaker holds it.',
  },
  INGEST_HOST_BREAKER_HOLD_MINUTES: {
    kind: 'int', default: 60, adminEditable: true, public: false, group: 'jobs', min: 1, max: 10_080,
    label: 'Host hold after failures (minutes)',
    help: 'How long the circuit breaker holds a host before one probe request decides.',
  },
  INGEST_BOT_CHECK_HOLD_HOURS: {
    kind: 'int', default: 24, adminEditable: true, public: false, group: 'jobs', min: 1, max: 720,
    label: 'Host hold after a bot check (hours)',
    help: 'How long a host that answered a bot check or a 403 is held; it is flagged for an admin too.',
  },
  INGEST_BACKOFF_MAX_HOURS: {
    kind: 'int', default: 6, adminEditable: false, public: false, group: 'jobs', min: 1, max: 168,
    label: 'Longest host backoff (hours)',
    help: 'The longest wait between retries of a failing host (set in .env only).',
  },
  INGEST_ANSWER_MAX_BYTES: {
    kind: 'int', default: 67_108_864, adminEditable: false, public: false, group: 'jobs', min: 1_048_576,
    max: 1_073_741_824,
    label: 'Largest listing (bytes)',
    help: 'The largest listing a source may answer with, in bytes, 64 MB (set in .env only).',
  },
  INGEST_LEASE_MINUTES: {
    kind: 'int', default: 30, adminEditable: false, public: false, group: 'jobs', min: 1, max: 1440,
    label: 'Run lease (minutes)',
    help: "How long a worker holds a source's run, so a crashed worker's lease runs out (set in .env only).",
  },
  // Discovery, unverified jobs, dedup and AI at scale (12 §4, §7, §8.3, §9.7).
  DISCOVERY_VALIDATIONS_PER_DAY: {
    kind: 'int', default: 20_000, adminEditable: true, public: false, group: 'jobs', min: 0, max: 1_000_000,
    label: 'Board validations per day',
    // v36 SOURCES: a validated board becomes a source that waits, off, for an admin.
    help: 'Found boards and career sites checked a day; a board that answers becomes a source that stays off until an admin turns it on.',
  },
  DISCOVERY_PROBES_PER_HOST_PER_DAY: {
    kind: 'int', default: 0, adminEditable: true, public: false, group: 'jobs', min: 0, max: 100_000,
    label: 'Name probes per host per day',
    help: "Requests a day to each ATS host guessing a known company's board name (0 keeps probes off, owner question 17).",
  },
  JOB_UNVERIFIED_HIDE_DAYS: {
    kind: 'int', default: 30, adminEditable: true, public: false, group: 'jobs', min: 1, max: 365,
    label: 'Unverified jobs leave search (days)',
    help: 'An open job no source has verified for this many days leaves search, still open, until it is verified again.',
  },
  JOB_FUZZY_SIMHASH_BITS: {
    kind: 'int', default: 3, adminEditable: true, public: false, group: 'jobs', min: 0, max: 16,
    label: 'Fuzzy match threshold (bits)',
    help: "Two postings of one company and title are one job when their text fingerprints differ in this many bits or fewer.",
  },
  AI_JOB_ANALYSIS_INGEST_MAX_PER_DAY: {
    kind: 'int', default: 2000, adminEditable: true, public: false, group: 'ai', min: 0, max: 1_000_000,
    label: 'AI analyses of new jobs per day',
    help: 'New jobs Claude reads a day in the ingest mode; past it, only saved jobs are read that day.',
  },
  // The shared polite site reader (12 §3.4, 13 §4), and its two switches (owner question 8: off until the lawyer's view).
  SITE_READER_HOST_GAP_SECONDS: {
    kind: 'int', default: 10, adminEditable: true, public: false, group: 'jobs', min: 10, max: 3600,
    label: 'Gap between page requests (seconds)',
    help: 'The least time between two page requests to one host (career pages, company websites).',
  },
  SITE_READER_MAX_BYTES: {
    kind: 'int', default: 1_000_000, adminEditable: true, public: false, group: 'jobs', min: 10_000, max: 10_000_000,
    label: 'Largest page (bytes)',
    help: 'The largest page the site reader reads, in bytes.',
  },
  SITE_READER_TIMEOUT_MS: {
    kind: 'int', default: 10_000, adminEditable: true, public: false, group: 'jobs', min: 1000, max: 60_000,
    label: 'Page read time (ms)',
    help: 'Milliseconds one page read may take.',
  },
  SITE_READER_COMPANY_SITES: {
    kind: 'bool', default: false, adminEditable: true, public: false, group: 'jobs',
    label: 'Read company websites',
    help: "Whether the site reader reads companies' own websites (off until the lawyer's view, owner question 8).",
  },
  SITE_READER_CAREER_PAGES: {
    kind: 'bool', default: false, adminEditable: true, public: false, group: 'jobs',
    label: 'Read career pages',
    help: "Whether the site reader reads employers' career pages and discovery finds career sites (off until the lawyer's view).",
  },
  // Company enrichment (13 §4-§8, §10).
  COMPANY_SITE_FETCH_PER_MINUTE: {
    kind: 'int', default: 30, adminEditable: true, public: false, group: 'jobs', min: 1, max: 600,
    label: 'Company site reads per minute',
    help: "Pages of companies' websites the enrichment reads a minute, across every host.",
  },
  COMPANY_FIELD_MIN_CONFIDENCE: {
    kind: 'int', default: 70, adminEditable: true, public: false, group: 'jobs', min: 0, max: 100,
    label: 'Company field confidence to show',
    help: 'A company field is shown from this confidence (0 to 100); it is stored either way.',
  },
  COMPANY_REFRESH_DAYS_OPEN: {
    kind: 'int', default: 90, adminEditable: true, public: false, group: 'jobs', min: 1, max: 3650,
    label: 'Company refresh, open jobs (days)',
    help: "Days between reads of a company's website while it has open jobs.",
  },
  COMPANY_REFRESH_DAYS_CLOSED: {
    kind: 'int', default: 365, adminEditable: true, public: false, group: 'jobs', min: 1, max: 3650,
    label: 'Company refresh, no open jobs (days)',
    help: "Days between reads of a company's website while it has no open jobs.",
  },
  COMPANY_LOGO_MAX_BYTES: {
    kind: 'int', default: 500_000, adminEditable: true, public: false, group: 'jobs', min: 10_000, max: 10_000_000,
    label: 'Largest logo file (bytes)',
    help: 'The largest logo file the enrichment reads, in bytes.',
  },
  COMPANY_AI_MODEL: {
    kind: 'text', default: 'claude-haiku-5-5', adminEditable: true, public: false, group: 'ai', maxLength: 80,
    label: 'Company summaries model',
    help: 'The model that writes company summaries and taglines (owner question 14).',
  },
  COMPANY_AI_DAILY_BUDGET_USD: {
    kind: 'usd', default: 2_000_000, adminEditable: true, public: false, group: 'ai',
    label: 'Company summaries daily budget',
    help: "What TailorIT's AI may spend on company summaries a day: platform spend, never a person's budget.",
  },
  COMPANY_AI_BATCH: {
    kind: 'int', default: 10, adminEditable: true, public: false, group: 'ai', min: 1, max: 50,
    label: 'Companies per summary batch',
    help: 'Companies one batch of AI summaries takes at a time (each company is its own AI call).',
  },
  // v30 E3: when a company's summary is written again (13 §7), and how much of its own words it needs first (13 §8).
  COMPANY_AI_REFRESH_DAYS: {
    kind: 'int', default: 30, adminEditable: true, public: false, group: 'ai', min: 1, max: 3650,
    label: 'Company summary refresh (days)',
    help: "A company's summary is written again only when its texts or facts changed, and at most once in this many days.",
  },
  COMPANY_AI_MIN_INPUT_CHARS: {
    kind: 'int', default: 200, adminEditable: true, public: false, group: 'ai', min: 1, max: 6000,
    label: 'Company text for a summary (characters)',
    help: "The company's own words a summary needs: with fewer, no summary is written and its own words are shown.",
  },
  // end v30 E3
  WIKIMEDIA_REQUESTS_PER_MINUTE: {
    kind: 'int', default: 150, adminEditable: true, public: false, group: 'jobs', min: 1, max: 200,
    label: 'Wikidata requests per minute',
    help: "Live Wikidata lookups a minute, under Wikimedia's 200 for a named bot.",
  },
  COMPANY_MATCH_AUTO_MIN: {
    kind: 'int', default: 90, adminEditable: true, public: false, group: 'jobs', min: 50, max: 100,
    label: 'Automatic company match score',
    help: 'The score (0 to 100) from which two company records merge, or a record matches a company, without an admin.',
  },
  // The extension's reports and new jobs: Admin › Review (14 §7, §12).
  EXT_AUTO_APPROVE_CLOSED: {
    kind: 'bool', default: false, adminEditable: true, public: false, group: 'jobs',
    label: 'Approve closed links automatically',
    help: "Approve the extension's closed-link reports automatically: TailorIT's own re-check decides, else enough trusted reporters.",
  },
  EXT_AUTO_APPROVE_NEW_ATS: {
    kind: 'bool', default: false, adminEditable: true, public: false, group: 'jobs',
    label: 'Approve new ATS jobs automatically',
    // v31 LINK: only once TailorIT read the posting again (the re-check queue's `live`).
    help: 'Publish held new ATS jobs once TailorIT read the posting again and their company and duplicate checks pass.',
  },
  EXT_AUTO_APPROVE_NEW_PAGE: {
    kind: 'bool', default: false, adminEditable: true, public: false, group: 'jobs',
    label: 'Approve page jobs automatically (no effect since v3.1)',
    // v30 FIX-B (SEC-10, DECISIONS P6.8): job-reviews/auto.ts refuses it while SITE_READER_CAREER_PAGES is off.
    // v31 LINK (D2): a browser's text is never published; an admin's approval reads the page itself.
    help: 'No longer approves anything since v3.1: PAGE_JOBS_AUTO_PUBLISH publishes page reads without an admin.',
  },
  EXT_NEW_PAGE_JOBS_REVIEW: {
    kind: 'bool', default: true, adminEditable: true, public: false, group: 'jobs',
    // v31 INT-2: the label says what the switch does since LINK (it was "Queue page jobs for review").
    label: "List links TailorIT couldn't verify",
    // v31 LINK (D2): the "Couldn't verify" list (jobs/add/verification.ts).
    help: "List the jobs TailorIT could not read from their link in Admin › Review (Couldn't verify), to approve, read again or reject.",
  },
  EXT_AUTO_CLOSE_MIN_REPORTERS: {
    // v30 FIX-B (SEC-10, DECISIONS P6.8): at least 2, so no one account closes a job TailorIT cannot read.
    kind: 'int', default: 2, adminEditable: true, public: false, group: 'jobs', min: 2, max: 100,
    label: 'Reporters to close an unreadable job',
    help: 'Distinct trusted accounts a posting TailorIT cannot read needs before automatic approval closes it.',
  },
  EXT_AUTO_NEW_PAGE_MIN_ACCOUNTS: {
    kind: 'int', default: 2, adminEditable: true, public: false, group: 'jobs', min: 2, max: 100,
    label: 'Accounts to publish a page job',
    help: 'Distinct trusted accounts with the same captured text a page job needs for automatic approval (at least 2).',
  },
  EXT_REPORT_WINDOW_DAYS: {
    kind: 'int', default: 14, adminEditable: true, public: false, group: 'jobs', min: 1, max: 365,
    label: 'Report window (days)',
    help: "Reports older than this many days do not count toward a review's reporters.",
  },
  EXT_REVIEW_EXPIRE_DAYS: {
    kind: 'int', default: 30, adminEditable: true, public: false, group: 'jobs', min: 1, max: 3650,
    label: 'Quiet review expiry (days)',
    help: 'A pending review with no new report for this many days expires.',
  },
  EXT_REPORTS_PER_ACCOUNT_PER_DAY: {
    kind: 'int', default: 50, adminEditable: true, public: false, group: 'jobs', min: 1, max: 10_000,
    label: 'Closed reports per account per day',
    help: 'Closed-job reports one account may send a day.',
  },
  EXT_REPORTER_MIN_ACCOUNT_DAYS: {
    // v30 FIX-B (SEC-10, DECISIONS P6.8): at least 1, so an account made today never counts.
    kind: 'int', default: 3, adminEditable: true, public: false, group: 'jobs', min: 1, max: 365,
    label: 'Reporter account age (days)',
    help: 'An account younger than this many days does not count toward automatic decisions.',
  },
  EXT_REPORTER_REJECTS_TO_IGNORE: {
    kind: 'int', default: 5, adminEditable: true, public: false, group: 'jobs', min: 1, max: 1000,
    label: 'Rejected reports before ignoring',
    // v30 FIX-WEB (REQ-7): the window is TRUST_REJECT_WINDOW_DAYS's (Reporter trust window), not a number typed here.
    help: 'Rejected (or source-reopened) reports within the reporter trust window after which an account does not count toward automatic decisions.',
  },
  EXT_RECHECKS_PER_DAY: {
    kind: 'int', default: 2000, adminEditable: true, public: false, group: 'jobs', min: 0, max: 1_000_000,
    label: 'Re-checks of reported postings per day',
    help: "TailorIT's own reads of reported postings a day.",
  },
  MSG_EXT_REPORT_LIMIT: message(
    'Closed reports: daily limit',
    'You can report {max} closed {max|job|jobs} a day; more after {reset_time}.',
    ['max', 'reset_time'],
  ),
  MSG_EXT_JOB_HELD: message('Job held for review', 'Only you see this job in TailorIT until it is approved.'),
  // end v30 CT
  // v30 E1: the company enrichment queue's worker and the monthly refdata build (13 §7, §11 phase 1).
  COMPANY_ENRICH_BATCH: {
    kind: 'int', default: 20, adminEditable: true, public: false, group: 'jobs', min: 1, max: 500,
    label: 'Companies enriched at a time',
    help: 'Companies the enrichment worker takes from its queue at a time.',
  },
  COMPANY_ENRICH_LEASE_MINUTES: {
    kind: 'int', default: 15, adminEditable: false, public: false, group: 'jobs', min: 1, max: 1440,
    label: 'Enrichment lease (minutes)',
    help: 'How long the enrichment worker holds the companies it took before another may take them (set in .env only).',
  },
  COMPANY_ENRICH_MAX_ATTEMPTS: {
    kind: 'int', default: 5, adminEditable: true, public: false, group: 'jobs', min: 1, max: 50,
    label: 'Enrichment tries',
    help: "Failed tries in a row after which the enrichment worker gives up a company's step until it is queued again.",
  },
  COMPANY_ENRICH_BACKOFF_MINUTES: {
    kind: 'int', default: 30, adminEditable: true, public: false, group: 'jobs', min: 1, max: 10_080,
    label: 'Enrichment retry wait (minutes)',
    help: 'The wait after a failed enrichment try; it doubles with each failure in a row.',
  },
  COMPANY_ENRICH_BACKOFF_MAX_HOURS: {
    kind: 'int', default: 48, adminEditable: true, public: false, group: 'jobs', min: 1, max: 720,
    label: 'Longest enrichment retry wait (hours)',
    help: 'The longest wait between two tries of a failing enrichment step.',
  },
  REFDATA_NAME_REVIEWS_PER_BUILD: {
    kind: 'int', default: 200, adminEditable: true, public: false, group: 'jobs', min: 0, max: 100_000,
    label: 'Name matches to review per build',
    help: 'Companies with the most open jobs and no website or key whose one Wikidata name match goes to Reviews each build.',
  },
  // end v30 E1
  // v30 INT-4: wave 4's limits that its handoffs kept beside their code, moved here (the owner's one-source rule; E2's
  // open item 7, and S5's run budgets beside S3's WORKDAY_SITE_* ones). The .env-only ones are design rules an admin
  // should not change at run time.
  SITE_READER_MAX_REDIRECTS: {
    kind: 'int', default: 3, adminEditable: false, public: false, group: 'jobs', min: 0, max: 3,
    label: 'Site reader redirects',
    help: "Redirects one site read follows at most, each on the first address's registrable domain (set in .env only).",
  },
  SITE_READER_TURN_WAIT_GAPS: {
    kind: 'int', default: 3, adminEditable: false, public: false, group: 'jobs', min: 1, max: 20,
    label: 'Site reader wait (host gaps)',
    help: "How many of a host's gaps a site read waits for its turn before it is held for later (set in .env only).",
  },
  COMPANY_SITE_PAGES_PER_PASS: {
    kind: 'int', default: 3, adminEditable: true, public: false, group: 'jobs', min: 1, max: 3,
    label: 'Company website pages per pass',
    help: "Pages of a company's website one enrichment pass reads at most: its homepage, its about page and its logo.",
  },
  COMPANY_SITE_REFRESH_BATCH: {
    kind: 'int', default: 5000, adminEditable: true, public: false, group: 'jobs', min: 100, max: 100_000,
    label: 'Company websites queued per day',
    help: 'Companies the daily refresh puts on the enrichment queue at most, for their website and for logo.dev each.',
  },
  COMPANY_LOGO_MIN_PX: {
    kind: 'int', default: 64, adminEditable: false, public: false, group: 'jobs', min: 16, max: 512,
    label: 'Least logo size (px)',
    help: 'A picture smaller than this on its shorter side (a wordmark: its longer side) is no logo (set in .env only).',
  },
  COMPANY_LOGO_SMALL_PX: {
    kind: 'int', default: 64, adminEditable: false, public: false, group: 'jobs', min: 16, max: 256,
    label: 'Small logo size (px)',
    help: "The smaller of the two sizes a company's logo is stored at (set in .env only).",
  },
  COMPANY_LOGO_LARGE_PX: {
    kind: 'int', default: 128, adminEditable: false, public: false, group: 'jobs', min: 32, max: 512,
    label: 'Large logo size (px)',
    help: "The larger of the two sizes a company's logo is stored at, shown when the source is that large (set in .env only).",
  },
  CAREER_PAGE_READS_PER_RUN: {
    kind: 'int', default: 200, adminEditable: true, public: false, group: 'jobs', min: 1, max: 5000,
    label: 'Career site pages read per run',
    help: "Posting pages one run of a career site reads (one request each, at the host's pace).",
  },
  CAREER_SITEMAPS_PER_RUN: {
    kind: 'int', default: 10, adminEditable: true, public: false, group: 'jobs', min: 1, max: 25,
    label: 'Career site sitemaps per run',
    help: "Sitemap files one run of a career site reads, an index's sitemaps included.",
  },
  CAREER_RECHECK_AFTER_DAYS: {
    kind: 'int', default: 7, adminEditable: true, public: false, group: 'jobs', min: 1, max: 29,
    label: 'Career pages read again (days)',
    help: "A live career page is read again after this many days (under the unverified jobs' 30).",
  },
  // end v30 INT-4
  // v31 NOTIFY: in-app notifications (docs/design/v3.1/24-notifications-usage.md, D8): how long they are kept, when
  // extra credit counts as low, and the words of each kind (a title, a body; rendered when the notification is written).
  NOTIFICATIONS_KEEP_DAYS: {
    kind: 'int', default: 90, adminEditable: true, public: true /* v34 PUBLIC: the Privacy page says it */, group: 'retention', min: 7, max: 3650,
    label: 'Notifications kept (days)',
    help: 'How long a notification is kept, read or not, before the daily housekeeping deletes it.',
  },
  CREDIT_LOW_USD: {
    kind: 'usd', default: 1_000_000, adminEditable: true, public: false, group: 'accounts',
    label: 'Extra credit low',
    help: 'A person gets one notification when their extra credit drops below this amount, and one when it is used up.',
  },
  MSG_NOTIFY_PREPARE_FINISHED_TITLE: message(
    'Notification: applications prepared (title)',
    '{ready} {ready|application|applications} ready to review',
    ['ready'] as const,
  ),
  MSG_NOTIFY_PREPARE_FINISHED_BODY: message(
    'Notification: applications prepared',
    'Check {ready|it|them} in your queue on Auto-apply.',
    ['ready'] as const,
  ),
  MSG_NOTIFY_PREPARE_SOME_FAILED: message(
    'Notification: applications prepared, some failed',
    "{failed} more couldn't be prepared: try again on Auto-apply.",
    ['failed'] as const,
  ),
  MSG_NOTIFY_PREPARE_FAILED_TITLE: message(
    'Notification: Prepare failed (title)',
    "TailorIT couldn't prepare {failed} {failed|application|applications}",
    ['failed'] as const,
  ),
  MSG_NOTIFY_PREPARE_FAILED_BODY: message('Notification: Prepare failed', 'Open Auto-apply to see what went wrong and try again.'),
  MSG_NOTIFY_AUTO_APPLY_SUBMITTED_TITLE: message(
    'Notification: auto-apply sent (title)',
    'Applied: {title} at {company}',
    ['title', 'company'] as const,
  ),
  MSG_NOTIFY_AUTO_APPLY_SUBMITTED_BODY: message('Notification: auto-apply sent', 'Your browser extension sent this application.'),
  MSG_NOTIFY_AUTO_APPLY_NEEDS_YOU_TITLE: message(
    'Notification: auto-apply needs you (title)',
    '{title} at {company} needs you',
    ['title', 'company'] as const,
  ),
  MSG_NOTIFY_AUTO_APPLY_NEEDS_YOU_BODY: message(
    'Notification: auto-apply needs you',
    'The extension stopped before sending it: finish it on Auto-apply.',
  ),
  MSG_NOTIFY_AUTO_APPLY_FAILED_TITLE: message(
    'Notification: auto-apply failed (title)',
    "Couldn't apply to {title} at {company}",
    ['title', 'company'] as const,
  ),
  MSG_NOTIFY_AUTO_APPLY_FAILED_BODY: message(
    'Notification: auto-apply failed',
    'Open Auto-apply to see what happened, then apply another way.',
  ),
  MSG_NOTIFY_JOB_VERIFIED_TITLE: message(
    'Notification: job verified (title)',
    'Job verified: {title} at {company}',
    ['title', 'company'] as const,
  ),
  MSG_NOTIFY_JOB_VERIFIED_BODY: message(
    'Notification: job verified',
    "It's open, and everyone can find it now.",
  ),
  MSG_NOTIFY_JOB_WAITING_TITLE: message(
    'Notification: job waits for approval (title)',
    'Waiting for approval: {title} at {company}',
    ['title', 'company'] as const,
  ),
  MSG_NOTIFY_JOB_WAITING_BODY: message(
    'Notification: job waits for approval',
    'Only you see it until an admin approves it.',
  ),
  MSG_NOTIFY_JOB_UNVERIFIED_TITLE: message(
    "Notification: job couldn't be verified (title)",
    "Couldn't verify {title} at {company}",
    ['title', 'company'] as const,
  ),
  MSG_NOTIFY_JOB_UNVERIFIED_BODY: message(
    "Notification: job couldn't be verified",
    'Only you see this job: open it and choose Retry read.',
  ),
  MSG_NOTIFY_JOB_REFUSED_TITLE: message(
    'Notification: job not added (title)',
    'Not added: {title} at {company}',
    ['title', 'company'] as const,
  ),
  MSG_NOTIFY_JOB_REFUSED_UNNAMED_TITLE: message(
    'Notification: job not added, none kept (title)',
    "TailorIT didn't add the job you linked",
  ),
  MSG_NOTIFY_JOB_REFUSED_BODY: message('Notification: job not added', "TailorIT won't list this posting."),
  MSG_NOTIFY_AI_DAY_USED_TITLE: message("Notification: today's AI budget used (title)", "You've used today's AI budget"),
  MSG_NOTIFY_AI_DAY_USED_BODY: message(
    "Notification: today's AI budget used, extra credit left",
    'Extra credit ({credit} left) is in use until {reset_time}.',
    ['credit', 'reset_time'] as const,
  ),
  MSG_NOTIFY_AI_DAY_USED_NO_CREDIT: message(
    "Notification: today's AI budget used, no extra credit",
    'New AI work waits until {reset_time}, or buy extra credit.',
    ['reset_time'] as const,
  ),
  MSG_NOTIFY_CREDIT_LOW_TITLE: message('Notification: extra credit low (title)', 'Your extra credit is low'),
  MSG_NOTIFY_CREDIT_LOW_BODY: message(
    'Notification: extra credit low',
    '{credit} left: buy more in Settings › Account.',
    ['credit'] as const,
  ),
  MSG_NOTIFY_CREDIT_USED_UP_TITLE: message('Notification: extra credit used up (title)', "You've used all your extra credit"),
  MSG_NOTIFY_CREDIT_USED_UP_BODY: message(
    'Notification: extra credit used up',
    'New AI work waits until {reset_time}: buy credit in Settings › Account.',
    ['reset_time'] as const,
  ),
  MSG_NOTIFY_PAID_ENDING_TITLE: message(
    'Notification: Paid plan ends soon (title)',
    'Your Paid plan ends in {days} {days|day|days}',
    ['days'] as const,
  ),
  MSG_NOTIFY_PAID_ENDING_BODY: message(
    'Notification: Paid plan ends soon',
    'It ends on {date}; then your account moves to Free.',
    ['date'] as const,
  ),
  MSG_NOTIFY_EXTENSION_DISCONNECTED_TITLE: message(
    'Notification: extension disconnected (title)',
    'Your browser extension is disconnected',
  ),
  MSG_NOTIFY_EXTENSION_DISCONNECTED_BODY: message(
    'Notification: extension disconnected',
    '{browser} is disconnected: connect it again in Settings › Autofill.',
    ['browser'] as const,
  ),
  MSG_NOTIFY_EXTENSION_EXPIRED_BODY: message(
    'Notification: extension connection ran out',
    "{browser}'s connection expired: connect it again in Settings › Autofill.",
    ['browser'] as const,
  ),
  MSG_NOTIFY_EXTENSION_UNNAMED: message('Notification: a browser with no name', 'Your browser', [] as const, LABEL_MAX),
  MSG_NOTIFY_ADMIN_REVIEW_TITLE: message(
    'Admin notification: new Review items (title)',
    '{count} new {count|item|items} in Review',
    ['count'] as const,
  ),
  MSG_NOTIFY_ADMIN_REVIEW_BODY: message(
    'Admin notification: new Review items',
    '{pending} {pending|item waits|items wait} in Admin › Review.',
    ['pending'] as const,
  ),
  MSG_NOTIFY_ADMIN_RUN_FAILED_TITLE: message('Admin notification: a run failed (title)', 'A run of {source} failed', ['source'] as const),
  MSG_NOTIFY_ADMIN_RUN_FAILED_BODY: message(
    'Admin notification: a run failed',
    'See its log in Admin › Runs (one alert an hour at most).',
  ),
  MSG_NOTIFY_ADMIN_SOURCE_DISABLED_TITLE: message(
    'Admin notification: source turned off (title)',
    'TailorIT turned off {source}',
    ['source'] as const,
  ),
  MSG_NOTIFY_ADMIN_SOURCE_DISABLED_BODY: message(
    'Admin notification: source turned off',
    'It failed {failures} {failures|time|times} in a row: check it in Admin › Sources.',
    ['failures'] as const,
  ),
  MSG_NOTIFY_ADMIN_RUNS_PAUSED_TITLE: message(
    'Admin notification: runs paused (title)',
    '{admin} paused {what}',
    ['admin', 'what'] as const,
  ),
  MSG_NOTIFY_ADMIN_RUNS_CONTINUED_TITLE: message(
    'Admin notification: runs continued (title)',
    '{admin} continued {what}',
    ['admin', 'what'] as const,
  ),
  MSG_NOTIFY_ADMIN_RUNS_BODY: message('Admin notification: runs paused or continued', 'See Admin › Runs for what runs now.'),
  MSG_NOTIFY_ADMIN_RUNS_ALL: message('Admin notification: every run', 'every run', [] as const, LABEL_MAX),
  MSG_NOTIFY_ADMIN_RUNS_SOURCE: message('Admin notification: one source', "{source}'s runs", ['source'] as const),
  MSG_NOTIFY_ADMIN_SOMEONE: message('Admin notification: an admin with no name', 'An admin', [] as const, LABEL_MAX),
  // end v31 NOTIFY
  // v31 RUNS: admins pause and continue job-source runs (docs/design/v3.1/22-runs-pause.md). A pause asked in one
  // process (the API) reaches a run in another (the ingest worker) through the database: each process looks for stop
  // requests on its own runs this often.
  RUN_STOP_POLL_MS: {
    kind: 'int', default: 5000, adminEditable: false, public: false, group: 'jobs', min: 100, max: 60_000,
    label: 'Pause check (ms)',
    help: 'How often a process looks whether an admin paused one of its runs, so a paused run stops within it (set in .env only).',
  },
  MSG_INGEST_RUNS_PAUSED: message(
    'Runs paused: no run starts',
    'Runs are paused: continue them in Admin › Runs first.',
  ),
  MSG_INGEST_SOURCE_PAUSED: message('Source paused: no run starts', 'This source is paused: continue it first.'),
  MSG_INGEST_SOURCE_NEVER_PAUSED: message(
    'Source never run: no pause',
    'This kind of source is never run, so there is nothing to pause.',
  ),
  MSG_INGEST_RUN_NOT_RUNNING: message(
    'Run finished: no pause',
    'This run already finished: refresh to see how it ended.',
  ),
  MSG_INGEST_RUN_NOT_PAUSED: message(
    'Run not paused: no continue',
    'Only a paused run can continue: use Run now in Admin › Sources.',
  ),
  // end v31 RUNS
  // v31 OAUTH: TailorIT's OAuth 2.1 server for Claude and ChatGPT (docs/design/v3.1/23-mcp-oauth.md; decision D7).
  OAUTH_ACCESS_TOKEN_MINUTES: {
    kind: 'int', default: 60, adminEditable: true, public: false, group: 'mcp', min: 5, max: 1440,
    label: 'Connected AI: access token (minutes)',
    help: 'How long one access token a connected AI app (Claude, ChatGPT) gets works; it then asks for a new one with its refresh token.',
  },
  OAUTH_REFRESH_IDLE_DAYS: {
    kind: 'int', default: 30, adminEditable: true, public: true /* v34 PUBLIC: the Privacy page says it */, group: 'mcp', min: 1, max: 365,
    label: 'Connected AI: idle days',
    help: 'A connected AI app that asks for no new token in this many days is disconnected (its refresh token ends).',
  },
  OAUTH_CODE_SECONDS: {
    kind: 'int', default: 120, adminEditable: true, public: false, group: 'mcp', min: 30, max: 600,
    label: 'Connected AI: code (seconds)',
    help: 'How long the one-time code an AI app gets after Allow works; it is used once, within seconds.',
  },
  OAUTH_REQUEST_MINUTES: {
    kind: 'int', default: 10, adminEditable: true, public: true /* v34 PUBLIC: the Privacy page says it */, group: 'mcp', min: 1, max: 60,
    label: 'Connected AI: consent page (minutes)',
    help: 'How long a person has to answer the consent page (Allow or Cancel) after their AI app opened it.',
  },
  OAUTH_GRANTS_PER_ACCOUNT: {
    kind: 'int', default: 20, adminEditable: true, public: false, group: 'mcp', min: 1, max: 200,
    label: 'Connected AI apps per account',
    help: 'Connected AI apps one account may have at once (each app once, however often it reconnects).',
  },
  // v31 FIX-AUTH (SEC-6): per network address; OAUTH_REGISTRATIONS_PER_HOUR_ALL is the ceiling for all together.
  OAUTH_REGISTRATIONS_PER_HOUR: {
    kind: 'int', default: 100, adminEditable: true, public: false, group: 'mcp', min: 1, max: 100_000,
    label: 'Connected AI: registrations per hour, per address',
    help: 'New AI apps one network address may register an hour (Claude registers once per connection, from its own servers).',
  },
  OAUTH_CALLS_PER_MINUTE: {
    kind: 'int', default: 120, adminEditable: true, public: false, group: 'mcp', min: 1, max: 10_000,
    label: 'Connected AI: OAuth calls per minute',
    help: 'Calls to the OAuth pages (authorize, token, revoke, register, metadata) one network address may make a minute.',
  },
  OAUTH_TOKEN_CALLS_PER_MINUTE: {
    kind: 'int', default: 60, adminEditable: true, public: false, group: 'mcp', min: 1, max: 10_000,
    label: 'Connected AI: token calls per minute',
    help: 'Token requests (codes and refreshes) one AI app may make a minute.',
  },
  // v31 FIX-AUTH (SEC-6): per network address; OAUTH_CIMD_FETCHES_PER_MINUTE_ALL is the ceiling for all together.
  OAUTH_CIMD_FETCHES_PER_MINUTE: {
    kind: 'int', default: 10, adminEditable: true, public: false, group: 'mcp', min: 1, max: 1000,
    label: 'Connected AI: client documents read per minute, per address',
    help: "Client ID Metadata Documents (an AI app's own description at its https address) TailorIT reads a minute for one network address.",
  },
  OAUTH_CIMD_MAX_BYTES: {
    kind: 'int', default: 10_000, adminEditable: false, public: false, group: 'mcp', min: 1000, max: 100_000,
    label: 'Connected AI: client document size (bytes)',
    help: 'The largest Client ID Metadata Document TailorIT reads (set in .env only).',
  },
  OAUTH_CIMD_TIMEOUT_MS: {
    kind: 'int', default: 5000, adminEditable: false, public: false, group: 'mcp', min: 1000, max: 9000,
    label: 'Connected AI: client document read time (ms)',
    help: "Milliseconds one read of a Client ID Metadata Document may take, under Claude's 10 seconds (set in .env only).",
  },
  OAUTH_CIMD_CACHE_MINUTES: {
    kind: 'int', default: 60, adminEditable: true, public: false, group: 'mcp', min: 1, max: 1440,
    label: 'Connected AI: client document kept (minutes)',
    help: "How long TailorIT keeps an AI app's Client ID Metadata Document before reading it again (less when the app's own cache header says so).",
  },
  OAUTH_RECORD_KEEP_DAYS: {
    kind: 'int', default: 7, adminEditable: true, public: true /* v34 PUBLIC: the Privacy page says it */, group: 'retention', min: 1, max: 365,
    label: 'Connected AI records (days)',
    help: 'Days TailorIT keeps ended OAuth records (expired consent requests and tokens, disconnected apps, registrations never used).',
  },
  MSG_OAUTH_REQUEST_GONE: message(
    'Connect AI: request ended',
    'This request ended: connect TailorIT again from your AI app.',
  ),
  MSG_OAUTH_GRANTS_MAX: message(
    'Connect AI: at the limit',
    'You have {max} connected AI {max|app|apps}, the most allowed: disconnect one in Integrations.',
    ['max'],
  ),
  MSG_OAUTH_RATE_LIMIT: message('Connect AI: too many requests', 'There have been too many connection requests.'),
  // v31 FIX-AUTH: the budgets of all callers together (SEC-6), a failed client document's pause (SEC-6) and the refresh
  // reuse grace (decision D13).
  OAUTH_REGISTRATIONS_PER_HOUR_ALL: {
    kind: 'int', default: 2000, adminEditable: true, public: false, group: 'mcp', min: 1, max: 1_000_000,
    label: 'Connected AI: registrations per hour, all together',
    help: 'New AI apps that may register themselves an hour, all network addresses together: a ceiling far above one address\'s.',
  },
  OAUTH_CIMD_FETCHES_PER_MINUTE_ALL: {
    kind: 'int', default: 60, adminEditable: true, public: false, group: 'mcp', min: 1, max: 10_000,
    label: 'Connected AI: client documents read per minute, all together',
    help: "Client ID Metadata Documents TailorIT reads a minute, all addresses together (Claude's and ChatGPT's never wait).",
  },
  OAUTH_CIMD_FAILURE_MINUTES: {
    kind: 'int', default: 5, adminEditable: true, public: false, group: 'mcp', min: 1, max: 60,
    label: 'Connected AI: failed client document pause (minutes)',
    help: "Minutes before TailorIT reads again a Client ID Metadata Document it could not use (Claude's and ChatGPT's: at once).",
  },
  OAUTH_REFRESH_REUSE_GRACE_SECONDS: {
    kind: 'int', default: 60, adminEditable: true, public: false, group: 'mcp', min: 0, max: 300,
    label: 'Connected AI: refresh retry grace (seconds)',
    help: 'Seconds after a refresh in which a retried refresh token gets a new pair instead of disconnecting the app (0: never).',
  },
  // end v31 FIX-AUTH
  // end v31 OAUTH
  // v34 ORIGIN (PLAN G8 "Limits for Claude's shared identity"): every person who connects Claude comes with one client
  // document and from Claude's published egress range (160.79.104.0/21, read 2026-11-21), so one address there speaks
  // for many people: it gets higher limits per address on discovery, the OAuth endpoints and wrong MCP tokens.
  OAUTH_SHARED_EGRESS_RANGES: {
    kind: 'text', default: '160.79.104.0/21', adminEditable: false, public: false, group: 'mcp', maxLength: 1000,
    label: 'Connected AI: shared server ranges',
    help: "IP ranges many people's AI apps call from at once (Claude's servers), comma separated; they get the higher limits below (set in .env only).",
  },
  OAUTH_SHARED_EGRESS_CALLS_PER_MINUTE: {
    kind: 'int', default: 1200, adminEditable: true, public: false, group: 'mcp', min: 1, max: 100_000,
    label: 'Connected AI: OAuth calls per minute, shared servers',
    help: 'Calls to the OAuth pages and metadata one address in a shared server range may make a minute (others: the OAuth calls limit).',
  },
  MCP_FAILED_TOKENS_PER_MINUTE_SHARED: {
    kind: 'int', default: 600, adminEditable: true, public: false, group: 'mcp', min: 1, max: 100_000,
    label: 'MCP: unknown tokens per minute, shared servers',
    help: 'Requests with a token TailorIT does not know that one address in a shared server range may send a minute before it must wait.',
  },
  // end v34 ORIGIN
  // v33 SHARE-0: shared profiles (PLAN F9; SP v33 PLAN-sharing.md §2, §3, §5, §10, §11). A shares their profile with B
  // (a grant, its key `p` + 11 characters); B works on it and pays for every TailorIT AI use B starts there. The limits
  // and reserves below are read through core/auth/grants.ts's sharingSettings; the words through the shared contracts
  // (packages/shared/src/sharing) and the notifications' words.
  SHARING_ENABLED: {
    kind: 'bool', default: true, adminEditable: true, public: true, group: 'accounts',
    label: 'Shared profiles on',
    help: 'Whether people may share their profile with another account; off, every shared profile stops at the next request.',
  },
  SHARING_GRANTS_PER_OWNER: {
    kind: 'int', default: 5, adminEditable: true, public: true, group: 'accounts', min: 1, max: 50,
    label: 'People one profile is shared with',
    help: 'How many people one person may share their profile with (invites waiting count too).',
  },
  SHARING_PROFILES_PER_GRANTEE: {
    kind: 'int', default: 10, adminEditable: true, public: true, group: 'accounts', min: 1, max: 25,
    label: 'Shared profiles one person uses',
    help: 'How many shared profiles one person may accept.',
  },
  SHARING_INVITES_PER_DAY: {
    kind: 'int', default: 20, adminEditable: true, public: true, group: 'accounts', min: 1, max: 200,
    label: 'Sharing invites per day',
    help: 'How many sharing invites one person may send in 24 hours.',
  },
  SHARING_INVITE_DAYS: {
    kind: 'int', default: 14, adminEditable: true, public: true, group: 'accounts', min: 1, max: 90,
    label: 'Sharing invite lasts (days)',
    help: 'Days a sharing invite waits to be accepted before it expires.',
  },
  SHARING_MCP_STALE_HOURS: {
    kind: 'int', default: 24, adminEditable: true, public: true /* v34 FIX-COPY: the guide says it */, group: 'accounts', min: 1, max: 168,
    label: 'Shared profile: own-AI Prepare lasts (hours)',
    help: "Hours a Prepare started by someone's own AI on a profile shared with them waits before it expires.",
  },
  SHARING_WAITING_PER_GRANT: {
    kind: 'int', default: 100, adminEditable: true, public: false, group: 'accounts', min: 1, max: 1000,
    label: 'Shared profile: waiting Prepares',
    help: 'How many Prepares one person may have waiting on a profile shared with them.',
  },
  SHARING_RESUME_RESERVE: {
    kind: 'int', default: 3, adminEditable: true, public: true, group: 'accounts', min: 0, max: 100,
    label: "Shared profile: owner's resume places kept",
    help: 'Resume places on a shared profile that only its owner may fill.',
  },
  SHARING_QUEUE_RESERVE: {
    kind: 'int', default: 50, adminEditable: true, public: true, group: 'accounts', min: 0, max: 500,
    label: "Shared profile: owner's queue places kept",
    help: 'Auto-apply queue places on a shared profile that only its owner may fill.',
  },
  SHARING_ACTIVITY_KEEP_DAYS: {
    kind: 'int', default: 90, adminEditable: true, public: true /* v34 PUBLIC: the Privacy page says it */, group: 'retention', min: 7, max: 3650,
    label: 'Keep sharing activity (days)',
    help: 'Days the hourly counts of what was done on a shared profile are kept.',
  },
  // The permission grid (Settings › Sharing): each row's name and its "?".
  LABEL_SHARING_SEE: message('Sharing: the See column', 'See', [] as const, LABEL_MAX),
  LABEL_SHARING_CHANGE: message('Sharing: the Change column', 'Change', [] as const, LABEL_MAX),
  LABEL_SHARING_ROW_TRACKER: message('Sharing: row Job Tracker', 'Job Tracker', [] as const, LABEL_MAX),
  MSG_SHARING_ROW_TRACKER_TIP: message(
    'Sharing: row Job Tracker, what it covers',
    'Your applications and saved jobs; Change lets them save, add, move, note and archive jobs.',
  ),
  LABEL_SHARING_ROW_DOCUMENTS: message('Sharing: row Documents', 'Documents', [] as const, LABEL_MAX),
  MSG_SHARING_ROW_DOCUMENTS_TIP: message(
    'Sharing: row Documents, what it covers',
    'Your resumes, letters and templates; Change lets them edit, upload and tailor, never your email or phone.',
  ),
  LABEL_SHARING_ROW_PREPARE: message('Sharing: row Prepare', 'Prepare', [] as const, LABEL_MAX),
  MSG_SHARING_ROW_PREPARE_TIP: message(
    'Sharing: row Prepare, what it covers',
    'Your Auto-apply panes, kits and filters; Change lets them prepare jobs for your queue.',
  ),
  LABEL_SHARING_ROW_QUEUE: message('Sharing: row Queue changes', 'Queue changes', [] as const, LABEL_MAX),
  MSG_SHARING_ROW_QUEUE_TIP: message(
    'Sharing: row Queue changes, what it covers',
    'Lets them remove jobs from your queue, clear finished ones and mark jobs as applied.',
  ),
  LABEL_SHARING_ROW_APPLY: message('Sharing: row Apply without my OK', 'Apply without my OK', [] as const, LABEL_MAX),
  MSG_SHARING_ROW_APPLY_TIP: message(
    'Sharing: row Apply without my OK, what it covers',
    'When off, the jobs they prepare wait for your OK before your extension applies to them.',
  ),
  LABEL_SHARING_ROW_AUTOFILL: message('Sharing: row Autofill info', 'Autofill info', [] as const, LABEL_MAX),
  MSG_SHARING_ROW_AUTOFILL_TIP: message(
    'Sharing: row Autofill info, what it covers',
    'Your autofill profile and saved answers, never the sensitive ones; Change lets them edit them.',
  ),
  LABEL_SHARING_ROW_SETTINGS: message('Sharing: row Job settings', 'Job settings', [] as const, LABEL_MAX),
  MSG_SHARING_ROW_SETTINGS_TIP: message(
    'Sharing: row Job settings, what it covers',
    'Your job preferences, Prepare settings, auto-apply rule and default resume.',
  ),
  LABEL_SHARING_ROW_SENSITIVE: message('Sharing: row Sensitive answers', 'Sensitive answers', [] as const, LABEL_MAX),
  MSG_SHARING_ROW_SENSITIVE_TIP: message(
    'Sharing: row Sensitive answers, what it covers',
    'Your EEO, visa, disability, veteran and pay answers, and why eligibility filtered a job.',
  ),
  LABEL_SHARING_ROW_EXPORTS: message('Sharing: row Exports', 'Exports', [] as const, LABEL_MAX),
  MSG_SHARING_ROW_EXPORTS_TIP: message(
    'Sharing: row Exports, what it covers',
    'Tracker CSV and resume ZIP downloads; single downloads come with Documents.',
  ),
  LABEL_SHARING_ROW_MCP: message('Sharing: row Their own AI', 'Their own AI', [] as const, LABEL_MAX),
  MSG_SHARING_ROW_MCP_TIP: message(
    'Sharing: row Their own AI, what it covers',
    'Their AI app may read and prepare your profile, so your data reaches their AI provider.',
  ),
  MSG_SHARING_NEEDED_BY: message('Sharing: a box another box needs', 'Needed by {row}.', ['row'] as const),
  LABEL_SHARING_PRESET_SEE_ONLY: message('Sharing: preset See only', 'See only', [] as const, LABEL_MAX),
  LABEL_SHARING_PRESET_SEE_AND_PREPARE: message('Sharing: preset See and prepare', 'See and prepare', [] as const, LABEL_MAX),
  LABEL_SHARING_PRESET_CUSTOM: message('Sharing: preset Custom', 'Custom', [] as const, LABEL_MAX),
  // The refusals of a request that names a shared profile (error codes profile_ended, profile_not_shared,
  // own_profile_only; validation_failed for a malformed one).
  MSG_SHARING_PROFILE_ENDED: message(
    'Sharing: the shared profile ended',
    "That shared profile isn't available now, so you're back on yours.",
  ),
  MSG_SHARING_NOT_SHARED: message('Sharing: not shared with you', "The profile's owner hasn't shared this with you."),
  MSG_SHARING_OWN_PROFILE_ONLY: message('Sharing: only on your own profile', 'Switch back to your profile to do this.'),
  MSG_SHARING_BAD_PROFILE: message(
    'Sharing: a profile that is not valid',
    "That profile isn't valid. Choose it again from the account menu.",
  ),
  // The sharing routes' refusals and answers.
  MSG_SHARING_OFF: message('Sharing: turned off', 'Sharing is turned off. Ask your TailorIT admin to turn it on.'),
  MSG_SHARING_OWN_EMAIL: message(
    'Sharing: your own address',
    "That's your own email. Enter the email of the person you want to share with.",
  ),
  MSG_SHARING_ALREADY_SHARED: message(
    'Sharing: already shared',
    'You already share your profile with that email, or an invite to it is waiting.',
  ),
  MSG_SHARING_GRANTS_MAX: message(
    'Sharing: too many people',
    'You can share your profile with up to {max} {max|person|people}. Stop sharing with someone first.',
    ['max'] as const,
  ),
  MSG_SHARING_PROFILES_MAX: message(
    'Sharing: too many shared profiles',
    'You can use up to {max} shared {max|profile|profiles}. Leave one in Settings › Sharing first.',
    ['max'] as const,
  ),
  MSG_SHARING_INVITES_PER_DAY: message(
    'Sharing: too many invites today',
    'You can send up to {max} {max|invite|invites} a day. Try again tomorrow.',
    ['max'] as const,
  ),
  MSG_SHARING_INVITE_GONE: message(
    'Sharing: the invite is gone',
    "That invite isn't available any more. Ask them to send it again.",
  ),
  MSG_SHARING_NOT_CLOSED: message(
    'Sharing: boxes another box needs',
    'Tick these boxes too, as the ones you ticked need them: {missing}.',
    ['missing'] as const,
  ),
  MSG_SHARING_INVITE_SENT: message(
    'Sharing: invite saved',
    "Saved. They'll see your invite when they sign in to TailorIT with {email}.",
    ['email'] as const,
  ),
  // The `sharing` notifications ({name}: the other person's name, else their email).
  MSG_NOTIFY_SHARING_INVITED_TITLE: message(
    'Notification: a profile shared with you (title)',
    'New shared profile from {name}',
    ['name'] as const,
  ),
  MSG_NOTIFY_SHARING_INVITED_BODY: message('Notification: a profile shared with you', 'Accept or decline it in Settings › Sharing.'),
  MSG_NOTIFY_SHARING_CHANGED_TITLE: message(
    'Notification: a shared profile changed (title)',
    "Sharing changed on {name}'s profile",
    ['name'] as const,
  ),
  MSG_NOTIFY_SHARING_CHANGED_BODY: message('Notification: a shared profile changed', 'Settings › Sharing shows what they share now.'),
  MSG_NOTIFY_SHARING_ACCEPTED_TITLE: message(
    'Notification: your shared profile accepted (title)',
    'Sharing accepted: {name} can now use your profile',
    ['name'] as const,
  ),
  MSG_NOTIFY_SHARING_ACCEPTED_BODY: message(
    'Notification: your shared profile accepted',
    'They can now work on your profile as you allowed.',
  ),
  MSG_NOTIFY_SHARING_DECLINED_TITLE: message(
    'Notification: your shared profile declined (title)',
    'Sharing declined by {name}',
    ['name'] as const,
  ),
  MSG_NOTIFY_SHARING_DECLINED_BODY: message('Notification: your shared profile declined', 'Nothing of your profile is shared with them.'),
  MSG_NOTIFY_SHARING_PREPARED_TITLE: message(
    'Notification: jobs prepared on your profile (title)',
    'Prepared by {name}: {count} {count|job|jobs} on your profile',
    ['name', 'count'] as const,
  ),
  MSG_NOTIFY_SHARING_PREPARED_BODY: message('Notification: jobs prepared on your profile', 'See them on Auto-apply.'),
  MSG_NOTIFY_SHARING_ENDED_TITLE: message('Notification: sharing ended (title)', 'Sharing with {name} ended', ['name'] as const),
  MSG_NOTIFY_SHARING_ENDED_BODY: message('Notification: sharing ended', 'Settings › Sharing shows what is shared now.'),
  // Why a Prepare on a shared profile stopped (prepare_jobs.reason_code; shared/prepare's PREPARE_SHARING_REASONS).
  MSG_PREPARE_ACCESS_ENDED: message('Prepare: sharing ended', 'Sharing ended, so this stopped.'),
  MSG_PREPARE_OWNER_STARTED: message(
    "Prepare: the profile's owner prepares it",
    "The profile's owner started preparing this job, so this one stopped.",
  ),
  MSG_PREPARE_PAYER_LIMIT: message(
    "Prepare: the preparer's AI limit",
    'This stopped: the person who prepared it reached their AI limit.',
  ),
  // end v33 SHARE-0
  // v33 SHARE-2: the sharing routes' other refusals (features/sharing; @tailorit/shared/sharing SHARING_MESSAGES).
  MSG_SHARING_END_DATE_PAST: message(
    'Sharing: an end date that has passed',
    'Choose an end date that is still ahead, or leave it empty.',
  ),
  MSG_SHARING_GRANT_GONE: message(
    'Sharing: the share is gone',
    "That share isn't there any more. Reload Settings › Sharing to see what is shared now.",
  ),
  MSG_SHARING_ACTIVITY_STALE: message(
    'Sharing: the activity list is out of date',
    'This activity list is out of date. Reload it to see the newest.',
  ),
  // end v33 SHARE-2
  // v33 SHARE-3: money on shared profiles (PLAN F9 "Who pays"; SP v33 PLAN-sharing.md §5, §9 "Editors"). B pays for the
  // AI B starts on A's profile; a refusal of B's own limit reads as these words to anyone but B.
  MSG_AI_PAYER_LIMIT: message(
    "AI: the starter's AI limit",
    'This stopped: the person who started it reached their AI limit.',
  ),
  MSG_SHARING_RESUME_RESERVE: message(
    "Shared profile: the owner's last resume places",
    "This profile's last {reserve} resume {reserve|place is|places are} kept for its owner. Ask them to delete resumes they no longer need.",
    ['reserve'] as const,
  ),
  MSG_RESUME_COPY_PAYER_LIMIT: message(
    "Editable copies: the asker's AI limit",
    'This copy waits: the person who asked for it reached their AI limit for today.',
  ),
  // The review: the reserve as the profile's owner reads it (their extension tailoring a job someone else prepared and
  // pays for), and an upload made on someone else's profile whose contact details are not that person's.
  MSG_SHARING_RESUME_RESERVE_OWNER: message(
    "Shared profile: the owner's own last resume places",
    'This stopped: your last {reserve} resume {reserve|place is|places are} kept for your own work. Make room in Documents, then try again.',
    ['reserve'] as const,
  ),
  MSG_SHARING_UPLOAD_CONTACT: message(
    "Shared profile: an upload with other contact details",
    "This resume shows other contact details than {name}'s. Upload a resume with the email and phone in their profile.",
    ['name'] as const,
  ),
  // A letter or template saved from an older version than the one stored (409 revision_conflict; the editors send the
  // version they loaded): someone else, or another tab, saved it meanwhile.
  MSG_LETTER_CHANGED: message(
    'Cover letter: saved elsewhere meanwhile',
    'This cover letter was saved somewhere else since you opened it. Reload it to see the latest version.',
  ),
  MSG_LETTER_TEMPLATE_CHANGED: message(
    'Letter template: saved elsewhere meanwhile',
    'This template was saved somewhere else since you opened it. Reload it to see the latest version.',
  ),
  MSG_LETTER_CHANGED_SHARED: message('Cover letter editor: changed by someone else (a shared profile)', 'Someone else changed this letter.'),
  MSG_LETTER_TEMPLATE_CHANGED_SHARED: message(
    'Template editor: changed by someone else (a shared profile)',
    'Someone else changed this template.',
  ),
  // end v33 SHARE-3
  // v33 SHARE-5: Prepare and the queue on a shared profile (PLAN F9; SP v33 PLAN-sharing.md §4, §6). B prepares jobs on
  // A's profile within B's room there (A's last places are kept: SHARING_QUEUE_RESERVE, SHARING_RESUME_RESERVE; at most
  // SHARING_WAITING_PER_GRANT waiting); the jobs B prepared wait for A's OK; an eligibility filter reason shows as one
  // word to someone without the Sensitive answers permission.
  FILTER_LABEL_ELIGIBILITY: filterLabel('Filter: eligibility (shared profile)', 'eligibility'),
  MSG_PREPARE_WAITING_FULL: message(
    'Prepare: too many waiting on a shared profile',
    'You have {max} {max|job|jobs} waiting to be prepared on this profile, the most allowed. Try again when some are done.',
    ['max'] as const,
  ),
  MSG_PREPARE_SHARED_QUEUE_FULL: message(
    "Prepare: no queue room left on a shared profile",
    "This profile's queue has no room left for jobs you prepare: its last {reserve} places are kept for its owner.",
    ['reserve'] as const,
  ),
  STATE_AWAITING_YOUR_OK: stateLabel('State: waiting for your OK (a job someone you share with prepared)', 'Waiting for your OK'),
  STATE_AWAITING_OWNER_OK: message(
    "State: waiting for the profile owner's OK",
    "Waiting for {name}'s OK",
    ['name'] as const,
    LABEL_MAX,
  ),
  // end v33 SHARE-5
  // v31 LINK: every job comes from its link (docs/design/v3.1/21-jobs-from-links.md): the add pipeline's switches and
  // limits, and the words of its states and reasons.
  ADD_JOB_PAGE_READ: {
    kind: 'bool', default: true, adminEditable: true, public: false, group: 'jobs',
    label: 'Read job pages on add',
    help: "Read an added job's own page (its schema.org JobPosting) when no ATS API reads it; an unread page stays its adder's.",
  },
  NEW_JOBS_ADMIN_APPROVAL: {
    kind: 'bool', default: false, adminEditable: true, public: false, group: 'jobs',
    label: 'Approve new jobs by hand',
    help: 'Hold every new job TailorIT read from its link in Admin › Review until an admin approves it (off: published at once).',
  },
  JOB_ADDS_PER_HOUR: {
    kind: 'int', default: 30, adminEditable: true, public: true, group: 'jobs', min: 1, max: 1000,
    label: 'Jobs added by link per hour',
    help: 'Jobs one account may add by their link in an hour (the Add job dialog, the tracker, the MCP tool).',
  },
  ADMIN_ADD_LINKS_MAX: {
    kind: 'int', default: 1000, adminEditable: true, public: true, group: 'jobs', min: 1, max: 20_000,
    label: 'Links an admin adds at once',
    // v35 ADMIN (PLAN H9): pasted links only; files and Google Sheets use SHEET_MAX_ROWS.
    help: 'Pasted links one Admin add may queue for reading at once; files and Google Sheets use their own row limit.',
  },
  JOB_LINK_QUEUE_KEEP_DAYS: {
    kind: 'int', default: 30, adminEditable: true, public: false, group: 'jobs', min: 1, max: 365,
    label: 'Read links kept (days)',
    help: 'How long the results of queued link reads (imports, Admin add) are kept for their progress view.',
  },
  MSG_JOB_ADD_PUBLISHED: message('Add job: published', 'TailorIT read the posting from its link.'),
  MSG_JOB_ADD_WAITING: message(
    'Add job: waiting for approval',
    'Saved for you; everyone sees it once an admin approves it.',
  ),
  MSG_JOB_ADD_PRIVATE: message(
    'Add job: only you see it',
    'Only you see this job until TailorIT can read its posting.',
  ),
  MSG_JOB_ADD_NEEDS_DETAILS: message(
    'Add job: details needed',
    "Add the job's title and company to save it for yourself.",
  ),
  MSG_JOB_ADD_REFUSED_CLOSED: message('Add job: closed', 'This posting has closed, so TailorIT did not add it.'),
  MSG_JOB_ADD_REFUSED_LINK: message(
    'Add job: not a job link',
    "Paste the job posting's own address (https://...).",
  ),
  MSG_JOB_ADDS_RATE_LIMITED: message(
    'Add job: too many',
    'You added {limit} jobs by link this hour: try again in {minutes} {minutes|minute|minutes}.',
    ['limit', 'minutes'] as const,
  ),
  MSG_JOB_ADD_IMPORT_LINKS: message(
    'Import: links queued for reading',
    // v35 IMPORT (H2): the rows' other columns give each job's details when TailorIT cannot read its link.
    '{queued} {queued|link is|links are} queued for reading.',
    ['queued'] as const,
  ),
  MSG_JOB_ADD_TOO_MANY_LINKS: message('Admin add: too many links', 'Add at most {max} links at a time.', ['max'] as const),
  MSG_JOB_ONLY_YOU_UNTIL_VERIFIED: message('Job: only you see it', 'Only you can see this job until TailorIT verifies it.'),
  MSG_JOB_VERIFY_UNREADABLE_HOST: message(
    'Verify: a site TailorIT never reads',
    "TailorIT doesn't read this site: add the job from the employer's own posting.",
  ),
  MSG_JOB_VERIFY_NO_POSTING: message(
    'Verify: no posting data',
    'The page has no job posting TailorIT can read (schema.org JobPosting).',
  ),
  MSG_JOB_VERIFY_ROBOTS: message('Verify: robots.txt', "The site's robots.txt asks readers to skip this page."),
  MSG_JOB_VERIFY_BLOCKED: message('Verify: blocked', 'The site asked for a sign-in or a check TailorIT does not pass.'),
  MSG_JOB_VERIFY_UNAVAILABLE: message('Verify: unavailable', "The site didn't answer: try again later."),
  // v31 FIX-WEB (REV-UX UX-15): plain words for the reason most people see on a new install.
  MSG_JOB_VERIFY_NOT_SET_UP: message(
    'Verify: not set up',
    "This server can't read job pages yet, so the job stays yours.",
  ),
  MSG_JOB_VERIFY_UNLISTED: message('Verify: unlisted', "The posting isn't on its board's public list, so it can't be read."),
  MSG_JOB_VERIFY_OPTED_OUT: message('Verify: opted out', 'This company asked TailorIT not to read its site.'),
  MSG_JOB_VERIFY_REJECTED: message('Verify: rejected', 'An admin decided this link is not a job TailorIT lists.'),
  MSG_JOB_REVIEW_PAGE_UNREADABLE: message(
    'Review: page unreadable',
    "This page couldn't be read, so it can't be published: reject it or retry later.",
  ),
  MSG_JOB_VERIFY_NOT_YOURS: message('Verify: not yours', 'Only the person who added this job, or an admin, can retry it.'),
  // end v31 LINK
  // v31 LINK2: the weekly re-read of the jobs TailorIT read from their page, and an import's words.
  JOB_PAGE_RECHECK_DAYS: {
    kind: 'int', default: 7, adminEditable: true, public: false, group: 'jobs', min: 1, max: 60,
    label: 'Job pages read again (days)',
    help: 'A job TailorIT read from its own page is read again after this many days; a page that is gone or expired closes it.',
  },
  MSG_JOB_IMPORT_ONLY_LINKS: message(
    'Import: the link column',
    // v35 IMPORT (H2): the other columns are read for each row's details.
    'Links are read from the {column} column; {ignored} other {ignored|column gives|columns give} the details TailorIT cannot read.',
    ['column', 'ignored'] as const,
  ),
  // end v31 LINK2
  // v31 FIX-LINK: D12 (the coordinator's decision of 2026-11-18): a job TailorIT read from a page's own JobPosting (no
  // ATS API) waits in Admin › Review until an admin approves the server-read content, unless this is on; and the link
  // queue's limits (docs/design/v3.1/21-jobs-from-links.md §5), one source.
  PAGE_JOBS_AUTO_PUBLISH: {
    kind: 'bool', default: false, adminEditable: true, public: false, group: 'jobs',
    label: 'Publish page jobs at once',
    help: "Publish a job TailorIT read from a careers page's own job data at once (off: it waits in Review › New jobs).",
  },
  LINK_QUEUE_TICK_MS: {
    kind: 'int', default: 5000, adminEditable: false, public: false, group: 'jobs', min: 1000, max: 600_000,
    label: 'Link queue check (ms)',
    help: 'How often the ingest worker looks at the queue of links to read (set in .env only).',
  },
  LINK_QUEUE_PER_PASS: {
    kind: 'int', default: 8, adminEditable: true, public: false, group: 'jobs', min: 1, max: 64,
    label: 'Hosts read per queue pass',
    help: "The most hosts one pass of the link queue reads, taken in turn so no host waits behind another host's backlog.",
  },
  LINK_QUEUE_PER_HOST: {
    kind: 'int', default: 5, adminEditable: true, public: false, group: 'jobs', min: 1, max: 50,
    label: 'Links per host per queue pass',
    help: "The most links of one host one pass of the link queue reads, one after the other at the host's own pace.",
  },
  LINK_QUEUE_ATTEMPTS: {
    kind: 'int', default: 3, adminEditable: true, public: false, group: 'jobs', min: 1, max: 20,
    label: 'Reads of a queued link',
    help: 'How often a queued link whose site failed for now is read before it is given up (three times as often for a held job).',
  },
  LINK_QUEUE_RETRY_MS: {
    kind: 'int', default: 900_000, adminEditable: true, public: false, group: 'jobs', min: 60_000, max: 86_400_000,
    label: 'First wait before a queued link is read again (ms)',
    help: 'The wait after a queued link failed for now; it doubles at each new try, at most a day.',
  },
  JOB_PAGE_RECHECKS_PER_PASS: {
    kind: 'int', default: 2000, adminEditable: true, public: false, group: 'jobs', min: 1, max: 100_000,
    label: 'Job pages read again per day',
    help: 'The most jobs read from their page that the daily pass queues to read again, the longest unchecked first.',
  },
  // end v31 FIX-LINK
  // v31 INTEG: Integrations › Connections (decision D11): Connect on an app TailorIT does not connect to yet.
  MSG_INTEGRATION_COMING_SOON: message('Integrations: coming soon', '{name} is coming soon.', ['name']),
  // end v31 INTEG
  // v31 AUTO (D10): Prepare All on the Auto-apply page takes every saved job in To prepare that passes the filters,
  // within the caps; what it leaves for later is said in these words.
  MSG_PREPARE_ALL_HELD_BATCH: message(
    'Prepare All: more than one batch',
    '{count} more {count|job passes|jobs pass}: press Prepare All again ({max} at a time).',
    ['count', 'max'] as const,
  ),
  MSG_PREPARE_ALL_HELD_QUEUE: message(
    'Prepare All: queue room',
    '{count} more {count|job needs|jobs need} queue room ({limit} jobs): clear finished jobs first.',
    ['count', 'limit'] as const,
  ),
  MSG_PREPARE_ALL_HELD_RESUMES: message(
    'Prepare All: resume room',
    '{count} more {count|job needs|jobs need} resume room ({limit} on your plan): delete some resumes first.',
    ['count', 'limit'] as const,
  ),
  // end v31 AUTO
  // v31 HEADER: the top bar's AI-use meter (D9; docs/design/v3.1/24-notifications-usage.md §8): amber from this share of
  // the person's daily AI budget, red once the budget is used.
  AI_USE_WARNING_PERCENT: {
    kind: 'int', default: 80, adminEditable: true, public: true, group: 'accounts', min: 1, max: 100,
    label: 'AI use warning (%)',
    help: "The header's AI-use meter turns amber when today's use reaches this share of the person's daily AI budget, and red once the budget is used.",
  },
  // end v31 HEADER
  // v31 JOBSWEB: the mark of a job only its adder sees, whose words came from their side (their browser captured or
  // typed them), never TailorIT's read (21-jobs-from-links.md §1.4): on its card, its detail and its tracker row.
  // v35 FIX-WEB (the ux review's L10): a person's own job is made from a link TailorIT could not read, whether a browser
  // captured it, they typed its details or a row of their import gave them: "Added by you", not "From your browser".
  LABEL_JOB_FROM_BROWSER: message('Job: added by you, not verified', 'Added by you, not verified', [] as const, LABEL_MAX),
  // end v31 JOBSWEB
  // v31 FIX-JOBS: the Jobs page in TailorIT's own words (REV-UX UX-1, REV-REQ REQ-3): a feed of jobs measured against
  // the person's resume, each opening in a drawer with Your match, Tailor for this job, About the role and the company.
  LABEL_JOBS_SEARCH: message('Jobs: search box', 'Search by title, skill or company', [] as const, LABEL_MAX),
  // v32 JOBS2 (E5): the descriptions are "?" tips now, one short sentence each (MSG_JOBS_INTRO, MSG_JOBS_NONE_FILTERED,
  // MSG_JOBS_NONE_YET, MSG_JOBS_ADD_RESUME_HINT, MSG_JOB_ADD_RESUME, MSG_JOB_TAILOR_LEAD, MSG_JOB_SUMMARY_FAILED).
  MSG_JOBS_INTRO: message('Jobs: page description', 'Jobs read from their postings, matched to your resume.'),
  LABEL_JOBS_MODE_KEYWORDS: message('Jobs: search by words', 'Keywords', [] as const, LABEL_MAX),
  LABEL_JOBS_MODE_AI: message('Jobs: search by a sentence (AI)', 'Ask AI', [] as const, LABEL_MAX),
  LABEL_JOBS_FILTERING_BY: message('Jobs: active filters', 'Filtering by', [] as const, LABEL_MAX),
  MSG_JOBS_NONE_TITLE: message('Jobs: nothing matches', 'Nothing matches these filters'),
  MSG_JOBS_NONE_FILTERED: message('Jobs: nothing matches, what to do', 'Try other words or remove a filter.'),
  MSG_JOBS_NONE_YET_TITLE: message('Jobs: no jobs yet', 'No jobs yet'),
  MSG_JOBS_NONE_YET: message('Jobs: no jobs yet, what to do', "Add one now with its posting's link."),
  MSG_JOBS_ADD_RESUME_HINT: message('Jobs: measure the list against a resume', 'See how well each job matches your resume.'),
  LABEL_JOBS_ROW_MATCH: message("Jobs: a row's match", 'Match', [] as const, LABEL_MAX),
  LABEL_JOBS_ROW_APPLY: message("Jobs: a row's Apply", 'Apply to {title}', ['title'] as const, LABEL_MAX),
  LABEL_JOBS_ROW_NO_SKILLS: message('Jobs: a row with nothing to measure', 'No skills named', [] as const, LABEL_MAX),
  LABEL_JOB_PREVIOUS: message('Job: previous', 'Previous job', [] as const, LABEL_MAX),
  LABEL_JOB_NEXT: message('Job: next', 'Next job', [] as const, LABEL_MAX),
  MSG_JOB_POSITION: message('Job: place in the list', 'Job {index} of {total}', ['index', 'total'] as const),
  LABEL_JOB_MARK_APPLIED: message('Job: mark as applied', 'Mark as applied', [] as const, LABEL_MAX),
  MSG_JOB_KEYWORDS_FOUND: message('Job: keywords in the resume', '{matched} of {total} {total|keyword|keywords} {matched|is|are} in your resume.', ['matched', 'total'] as const),
  LABEL_JOB_KEYWORDS_HAVE: message('Job: keywords the resume has', 'In your resume', [] as const, LABEL_MAX),
  LABEL_JOB_KEYWORDS_MISSING: message('Job: keywords the resume lacks', 'Not in your resume yet', [] as const, LABEL_MAX),
  MSG_JOB_NO_SKILLS: message('Job: a posting with no skills', 'This posting names no skills to measure your resume against.'),
  MSG_JOB_ADD_RESUME_TITLE: message('Job: no resume yet', 'Add a resume to see your match'),
  MSG_JOB_ADD_RESUME: message('Job: no resume yet, what to do', "TailorIT compares it with the posting's keywords."),
  LABEL_JOB_TAILOR_TITLE: message('Job: tailor section', 'Tailor for this job', [] as const, LABEL_MAX),
  MSG_JOB_TAILOR_LEAD: message('Job: tailor section text', 'A copy of your resume made for this job; yours stays as it is.'),
  // v31 INT-3: also the Tracker's Documents tab (LABEL_TRACKER_TAILOR went: one constant holds the words).
  LABEL_JOB_TAILOR_BUTTON: message('Job and application: the tailor button', 'Tailor a resume', [] as const, LABEL_MAX),
  // v33 JOBDETAIL (F2): the owner's words for the job's left column (REQUEST.md).
  LABEL_JOB_ABOUT_ROLE: message('Job: about the job', 'About the job', [] as const, LABEL_MAX),
  LABEL_JOB_ROLE_DUTIES: message("Job: the role's duties", "What you'd do", [] as const, LABEL_MAX),
  LABEL_JOB_ROLE_ASKS: message("Job: the role's requirements", 'What they ask for', [] as const, LABEL_MAX),
  LABEL_JOB_ROLE_NICE: message("Job: the role's extras", 'Nice to have', [] as const, LABEL_MAX),
  LABEL_JOB_ROLE_ALSO: message('Job: other words the posting names', 'Also mentioned', [] as const, LABEL_MAX),
  MSG_JOB_NO_SUMMARY: message('Job: no summary yet', 'TailorIT has no summary of this posting yet.'),
  LABEL_JOB_ABOUT_COMPANY: message('Job: about the company', 'About {company}', ['company'] as const, LABEL_MAX),
  MSG_JOB_SUMMARY_FAILED: message('Job: summary failed', 'No summary: here is the posting as written.'),
  // end v31 FIX-JOBS
  // v33 JOBDETAIL (F2, the owner's "see job details at once"): the job's details in two columns. Left: About the job
  // (Summary | Full posting), then the company. Right: Requirements at a glance (each row's verdict computed on the
  // server: the person's numbers never reach the browser), Skills (what the resume has, highlighted), the Tailor card
  // (LABEL_JOB_DETAIL_TAILOR) and Benefits. The header's line under the title says when TailorIT last checked the posting was live.
  LABEL_JOB_CHECKED_LIVE: message('Job: checked live', 'Checked live {when}', ['when'] as const, LABEL_MAX),
  LABEL_JOB_GLANCE: message('Job: requirements at a glance', 'Requirements at a glance', [] as const, LABEL_MAX),
  MSG_JOB_GLANCE_TIP: message('Job: requirements at a glance, what it is', 'What the posting asks for, checked against your profile.'),
  LABEL_JOB_GLANCE_EXPERIENCE: message('Job glance: experience', 'Experience', [] as const, LABEL_MAX),
  LABEL_JOB_GLANCE_EDUCATION: message('Job glance: education', 'Education', [] as const, LABEL_MAX),
  LABEL_JOB_GLANCE_CERTIFICATIONS: message('Job glance: licences and certifications', 'Licences & certifications', [] as const, LABEL_MAX),
  LABEL_JOB_GLANCE_NOT_STATED: message('Job glance: the posting does not say', 'Not stated', [] as const, LABEL_MAX),
  LABEL_JOB_GLANCE_EQUIVALENT: message('Job glance: equivalent experience accepted', 'or equivalent experience', [] as const, LABEL_MAX),
  LABEL_JOB_GLANCE_HAVE_IT: message('Job glance: a licence you have', 'You have it', [] as const, LABEL_MAX),
  MSG_JOB_GLANCE_MEETS: message('Job glance: meets', 'Your profile meets this.'),
  MSG_JOB_GLANCE_BELOW: message('Job glance: below', 'This asks for more than your profile shows.'),
  MSG_JOB_GLANCE_UNKNOWN: message('Job glance: unknown', 'Add this to your Autofill profile to check it.'),
  LABEL_JOB_SKILLS: message('Job: skills', 'Skills', [] as const, LABEL_MAX),
  MSG_JOB_SKILLS_HIGHLIGHT: message('Job: skills, which are highlighted', 'Skills from your resume are highlighted', [] as const, LABEL_MAX),
  LABEL_JOB_BENEFITS: message('Job: benefits', 'Benefits', [] as const, LABEL_MAX),
  LABEL_JOB_SUMMARY: message('Job: about the job, the summary', 'Summary', [] as const, LABEL_MAX),
  LABEL_JOB_FULL_POSTING: message('Job: about the job, the full posting', 'Full posting', [] as const, LABEL_MAX),
  // v33 INT-A (the coordinator's decision): the job details' Tailor button reads the owner's own words, "Tailor my
  // resume" (the v3.3 request names it). The dialog it opens and the Tracker's Documents tab keep LABEL_JOB_TAILOR_BUTTON.
  LABEL_JOB_DETAIL_TAILOR: message("Job details: the tailor button (the owner's words)", 'Tailor my resume', [] as const, LABEL_MAX),
  // end v33 JOBDETAIL
  // v32 ADMINAPP (E6, the owner's "admin should be able to approve manually"): an admin publishes a job TailorIT could
  // not read, as it was captured (Admin › Review › Couldn't verify, a v3.0 page review); at most this many an hour each.
  ADMIN_APPROVALS_PER_HOUR: {
    kind: 'int', default: 300, adminEditable: true, public: false, group: 'jobs', min: 1, max: 10_000,
    label: 'Captured jobs one admin approves per hour',
    help: "How many jobs TailorIT couldn't read one admin may publish by approving them as captured in an hour.",
  },
  MSG_NOTIFY_JOB_APPROVED_BODY: message(
    'Notification: job approved by an admin',
    // v32 FIX-API (REV-UXREQ UXREQ-9): one sentence.
    'An admin checked the posting TailorIT couldn\'t read and published it as you added it.',
  ),
  // end v32 ADMINAPP
  // v32 JOBS2 (E5): Your match's "?" (what the section measures).
  MSG_JOB_MATCH_TIP: message('Job: your match, what it is', "How many of the posting's keywords your resume has."),
  // end v32 JOBS2
  // v33 ROLES (F4): the person's field. A resume's Field (the "what TailorIT read" panel and the editor), Settings ›
  // Account's "Your field", the Jobs page's My field chip.
  LABEL_RESUME_FIELD: message('Resume: field (label)', 'Field', [] as const, LABEL_MAX),
  MSG_RESUME_FIELD_TIP: message(
    'Resume: field, what it does',
    'The kind of work this resume is for: TailorIT tailors it and writes for it in that field.',
  ),
  LABEL_RESUME_FIELD_DETECT: message('Resume: field, detect automatically (choice)', 'Detect automatically', [] as const, LABEL_MAX),
  MSG_RESUME_FIELD_DETECTED: message('Resume: field, what TailorIT detected', 'Detected: {field}', ['field'] as const),
  MSG_RESUME_FIELD_SAVE_FAILED: message('Resume: field not saved', "Your field wasn't saved. Choose it again to retry."),
  LABEL_ACCOUNT_YOUR_FIELD: message('Account: your field (label)', 'Your field', [] as const, LABEL_MAX),
  MSG_ACCOUNT_YOUR_FIELD: message('Account: your field', '{field} (from your default resume)', ['field'] as const),
  MSG_ACCOUNT_FIELD_NONE: message('Account: no field yet', 'Add a resume and TailorIT works out your field from it.'),
  MSG_ACCOUNT_FIELD_TIP: message(
    'Account: your field, what it does',
    "Change it on your default resume's Field; tailoring and the Jobs page's My field follow it.",
  ),
  LABEL_JOBS_MY_FIELD: message('Jobs: my field (chip)', 'My field', [] as const, LABEL_MAX),
  MSG_JOBS_MY_FIELD_TIP: message('Jobs: my field, what it shows', 'Jobs in your field, {field}, from your default resume.', ['field'] as const),
  // end v33 ROLES
  // v32 INT-1 (E6 with E3): the mark of a job an admin published as it was captured (JobVerification admin_approved),
  // on the Jobs list and detail and the Tracker's card and detail, its "?" one sentence.
  LABEL_JOB_APPROVED_BY_ADMIN: message('Job: approved by an admin (mark)', 'Approved by an admin', [] as const, LABEL_MAX),
  MSG_JOB_APPROVED_BY_ADMIN: message('Job: approved by an admin, why', "TailorIT couldn't read this posting, so an admin checked it."),
  // end v32 INT-1
  // v32 FIX-API (REV-SECBEH SB-1, SB-4, SF-1; REV-UXREQ UXREQ-9, UXREQ-10): how long an admin's approval keeps its job in
  // search; the notices of an approval (its adder's title; every other adder's "a public version exists"); Fill from my
  // resume's AI mark, its "check" line and the no-resume reason.
  ADMIN_APPROVED_JOB_DAYS: {
    kind: 'int', default: 30, adminEditable: true, public: false, group: 'jobs', min: 1, max: 365,
    label: 'Approved jobs stay in search (days)',
    help: 'A job an admin approved as captured leaves search after this many days, unless approved again or TailorIT reads it.',
  },
  // v36 IMPORTTIME (SP v36 PLAN.md I1 refined, the owner's addendum 2): a job an admin's import brings in shows the
  // import's time (its board's own date kept for this rule only): "Reposted" when the board posted it more than this many
  // days before the import, "Posted" when later or unknown (a link TailorIT could not read). v36 FIX-SRC (the final
  // reviews' data D7 = ux L9): public, so the help guide reads the admin's value (help/content/jobs.tsx).
  ADMIN_IMPORT_REPOSTED_AFTER_DAYS: {
    kind: 'int', default: 7, adminEditable: true, public: true, group: 'jobs', min: 0, max: 365,
    label: 'Imported jobs read "Reposted" after (days)',
    help: 'Imported jobs show the import time: Reposted if the board posted it more than this many days before, else Posted.',
  },
  // end v36 IMPORTTIME
  MSG_NOTIFY_JOB_APPROVED_TITLE: message(
    'Notification: job approved by an admin (title)',
    'Approved by an admin: {title} at {company}',
    ['title', 'company'] as const,
  ),
  MSG_NOTIFY_JOB_PUBLIC_VERSION_TITLE: message(
    'Notification: another version of your job published (title)',
    'Published for everyone: {title} at {company}',
    ['title', 'company'] as const,
  ),
  MSG_NOTIFY_JOB_PUBLIC_VERSION_BODY: message(
    'Notification: another version of your job published',
    'An admin published another version of this job for everyone; yours stays as you added it.',
  ),
  LABEL_AUTOFILL_AI_READ: message('Autofill profile: a value the AI read (mark)', 'AI read, check it', [] as const, LABEL_MAX),
  MSG_AUTOFILL_SEED_AI_CHECK: message(
    'Autofill profile: check what the AI read',
    'The AI read your file: check each field marked "AI read" before you save.',
  ),
  MSG_AUTOFILL_SEED_NO_RESUME_IN_FILE: message('Autofill profile: the AI found no resume in the file', 'The AI found no resume in it.'),
  LABEL_AUTOFILL_CHECK_THESE: message('Autofill profile: the fill\'s notes (label)', 'Check these', [] as const, LABEL_MAX),
  MSG_AUTOFILL_CHECK_THESE_TIP: message(
    "Autofill profile: the fill's notes, what they are",
    'Fill could not be sure of these, so check them before you save.',
  ),
  MSG_AUTOFILL_FILL_NO_RESUME: message('Autofill profile: no resume to fill from', 'Add a resume to fill from it.'),
  LABEL_AUTOFILL_ADD_RESUME: message('Autofill profile: add a resume (link)', 'Add a resume', [] as const, LABEL_MAX),
  // end v32 FIX-API
  // v34 PUBLIC (PLAN G8): who runs this TailorIT, as the public Privacy, Terms and Support pages name them (an AI
  // directory asks for both). Blank: the pages name no operator and no website; production sets them. The contact
  // address is ADMIN_CONTACT_EMAIL's (CONTACT_EMAIL). The website shows as a link only when it is an https address
  // (http for localhost only; apps/web/src/features/public/operator.ts). The public pages read the public constants signed out too, so a
  // signed-out read of GET /api/constants/public is limited per network address.
  OPERATOR_NAME: {
    kind: 'text', default: '', adminEditable: true, public: true, group: 'contact', maxLength: 100,
    label: 'Operator name',
    help: 'Who runs this TailorIT (a person or a company), as the Privacy, Terms and Support pages name them.',
  },
  OPERATOR_WEBSITE: {
    kind: 'text', default: '', adminEditable: true, public: true, group: 'contact', maxLength: 200,
    label: 'Operator website',
    help: "The operator's own website (an https address), linked from the Privacy, Terms and Support pages.",
  },
  PUBLIC_PAGE_READS_PER_MINUTE: {
    kind: 'int', default: 120, adminEditable: true, public: false, group: 'accounts', min: 10, max: 10_000,
    label: 'Public page reads per minute',
    help: 'Reads of the public constants one network address may make a minute while signed out (the public pages).',
  },
  // end v34 PUBLIC
  // v34 MCPDIR (PLAN G8; Claude's directory review asks for answers within about 150,000 characters and 240 seconds):
  // how much one MCP tool answer holds and how long one call may take (features/mcp/profiles.ts runs every tool).
  // The MCPDIR reviews: 75,000 by default (Claude Code's 25,000-token output cap at about 3 characters a token), at least
  // 50,000 (above TailorIT's largest prompt, which is refused rather than cut); at least 30 seconds.
  MCP_RESULT_MAX_CHARS: {
    kind: 'int', default: 75_000, adminEditable: true, public: false, group: 'mcp', min: 50_000, max: 140_000,
    label: 'MCP answer size (characters)',
    help: 'The most characters one MCP tool answer holds; a longer page keeps the rows that fit, and a longer prompt is refused.',
  },
  MCP_TOOL_TIME_LIMIT_MS: {
    kind: 'int', default: 200_000, adminEditable: true, public: false, group: 'mcp', min: 30_000, max: 230_000,
    label: 'MCP tool time limit (ms)',
    help: "Milliseconds one MCP tool call may take before it answers that it took too long, under Claude's 240 seconds.",
  },
  MSG_MCP_TOOL_TOO_SLOW: message(
    'MCP: a tool took too long (to the person\'s AI)',
    '{tool} did not finish within {seconds} seconds, so TailorIT stopped waiting. {check}',
    ['tool', 'seconds', 'check'] as const,
  ),
  // end v34 MCPDIR
  // v34 FANOUT: one action on several profiles (PLAN G1-G3; @tailorit/shared/sharing fanout.ts): the refusals of the
  // /api/profiles routes and of the filters' PATCH.
  MSG_FANOUT_TOO_MANY_PROFILES: message('Several profiles: too many at once', 'Choose at most {max} profiles at once.', ['max'] as const),
  MSG_FANOUT_TOO_MANY_JOBS: message('Several profiles: too many jobs at once', 'Choose at most {max} jobs at once.', ['max'] as const),
  MSG_FANOUT_FILTER_TEXT: message(
    'Prepare filters: custom filter text with markup',
    'Write the custom filter in plain words, without tags or markers, then save again.',
  ),
  MSG_FANOUT_PROFILE_FAILED: message('Several profiles: one profile failed', 'Something failed on our side for this profile. Try it again.'),
  // A profile the person may not use for this action, whatever the reason (a share that ended, an unknown key, a box
  // its owner did not tick): one answer, which never says why.
  MSG_FANOUT_PROFILE_UNUSABLE: message('Several profiles: a profile not available for this', "This profile isn't available for this action."),
  // end v34 FANOUT
  // v34 AIKEY (PLAN Addendum G11): who pays for TailorIT's own AI, @tailorit/shared/ai billing.ts. Set in .env only (a
  // billing choice of the machine's operator, never an admin's) and read once at start: apps/api/src/config/env.ts
  // refuses `api-key` while ANTHROPIC_API_KEY is blank. Not public. The key itself is never a constant.
  AI_BILLING: {
    kind: 'text', default: 'subscription', choices: AI_BILLING_MODES, adminEditable: false, public: false, group: 'ai', maxLength: 20,
    label: 'AI billing',
    help: "Who pays for TailorIT's AI: subscription (the claude CLI's own sign-in) or api-key (ANTHROPIC_API_KEY); set in .env only.",
  },
  // Review fix H1: with AI_BILLING=api-key, the whole server's AI spend per UTC day (every account, the server's own job
  // analysis, company work and backlogs), from the cost each AI run records (ai_usage_hourly). At it every server-AI
  // action is refused until 00:00 UTC (apps/api/src/ai/capacity.ts). Ignored on a subscription. At least $1: never
  // Unlimited, never 0.
  AI_KEY_DAILY_BUDGET_USD: {
    kind: 'usd', default: 20_000_000, min: 1_000_000, adminEditable: true, public: false, group: 'ai',
    label: 'API key daily AI budget',
    // v34 FIX-API (the final security review, F2): soft but tight (asked before every AI call); a tip is one sentence,
    // so the Anthropic workspace's spend limit (the hard guard) is in the start line, SETUP and DEPLOYMENT.
    help: "With AI_BILLING=api-key: TailorIT stops starting AI calls when today's spend (UTC) reaches it; calls already running finish.",
  },
  // end v34 AIKEY
  // v34 ACCTDEL (PLAN G10): deleting an account (Settings › Account › Delete my account; Admin › Users › Delete account):
  // the refusals, what a deletion that finishes on its own says, the sign-in page's lines after it, and what the other
  // side of an ended share is told (in words that name nobody: the account, its name and its address are gone; the
  // words say who deleted it: the person, or an administrator).
  MSG_ACCOUNT_DELETE_EMAIL: message(
    "Delete account: the typed address is not the account's",
    'Type the email address of the account exactly as it is shown, then delete it.',
  ),
  MSG_ACCOUNT_DELETE_LAST_ADMIN: message(
    'Delete account: the last administrator',
    'This is the only administrator account that can sign in. Make another account an administrator first, then delete this one.',
  ),
  MSG_ACCOUNT_DELETE_OWN: message(
    'Delete account: your own account from Admin › Users',
    'You cannot delete the account you are signed in with here. Use Settings › Account › Delete my account.',
  ),
  MSG_ACCOUNT_DELETE_BLOCKED: message(
    'Delete account: something on our side holds on to the account',
    "This account cannot be deleted right now because of a problem on our side. Ask an administrator of this installation to look at the server's log.",
  ),
  MSG_ACCOUNT_DELETED: message('Sign in: your account was deleted', 'We deleted your account and everything in it.'),
  MSG_ACCOUNT_DELETE_PENDING: message(
    'Delete my account: turned off, the rest finishes on its own',
    'We turned your account off and are deleting it. That finishes on its own within a day; there is nothing more to do.',
  ),
  MSG_ACCOUNT_DELETE_PENDING_ADMIN: message(
    'Delete account (Admin › Users): turned off, the rest finishes on its own',
    'The account is off and being deleted. That finishes on its own within a day, or delete it again to finish it now.',
  ),
  MSG_ACCOUNT_BEING_DELETED: message(
    'Sign in: the account is being deleted',
    'This account is being deleted. That finishes within a day; then this address can start a new account.',
  ),
  MSG_NOTIFY_SHARED_PROFILE_DELETED_TITLE: message(
    'Notification: a profile shared with you was deleted (title)',
    'A profile shared with you was deleted',
  ),
  MSG_NOTIFY_SHARED_PROFILE_DELETED_BODY: message(
    'Notification: a profile shared with you was deleted by its owner',
    'Its owner deleted their account, so it is no longer among your profiles. Settings › Sharing shows what is shared now.',
  ),
  MSG_NOTIFY_SHARED_PROFILE_DELETED_ADMIN_BODY: message(
    'Notification: a profile shared with you was deleted by an administrator',
    'The account that shared it with you was deleted, so it is no longer among your profiles. Settings › Sharing shows what is shared now.',
  ),
  MSG_NOTIFY_SHARE_GRANTEE_DELETED_TITLE: message(
    'Notification: someone you shared with deleted their account (title)',
    'A share of your profile ended',
  ),
  MSG_NOTIFY_SHARE_GRANTEE_DELETED_BODY: message(
    'Notification: someone you shared with deleted their account',
    'Someone you shared your profile with deleted their account, so they no longer see it. Settings › Sharing shows what is shared now.',
  ),
  MSG_NOTIFY_SHARE_GRANTEE_DELETED_ADMIN_BODY: message(
    "Notification: an administrator deleted the account of someone you shared with",
    'An account you shared your profile with was deleted, so it no longer sees it. Settings › Sharing shows what is shared now.',
  ),
  // end v34 ACCTDEL
  // v34 DIRKIT (PLAN G8; docs/directory/CHECKLIST.md): whether report_unsupported keeps the person's words. Claude's
  // directory asks a connector to collect no conversation data beyond what a tool needs: a listed server turns it off,
  // and the tool then keeps only what TailorIT lacks and the tools tried (features/mcp/tools-report.ts). On by default,
  // so a self-hosted server keeps working as before. Public: `npm run directory:check` reads it (a WARN while on).
  MCP_REPORT_REQUEST_TEXT: {
    kind: 'bool', default: true, adminEditable: true, public: true, group: 'mcp',
    label: "Keep the request's words in AI reports",
    help: "Whether a report from a person's AI keeps what they asked; off: only what TailorIT lacks and the tools tried.",
  },
  // end v34 DIRKIT
  // v35 IMPORT (SP v35 PLAN.md H1-H2): a person's imports of job links (Jobs › Add job › File, Google Sheet). Counted per
  // person, as v3.3 counts limits: acting on a shared profile counts toward the person acting. An admin's imports take
  // ADMIN_ADD_LINKS_MAX (pasted links) and SHEET_MAX_ROWS (a file or a sheet).
  JOB_IMPORT_ROWS_MAX: {
    kind: 'int', default: 200, adminEditable: true, public: true /* the guide says it */, group: 'jobs', min: 1, max: 10_000,
    label: 'Rows a person imports at once',
    help: 'The most rows one file or Google Sheet a person imports in Jobs › Add job may hold.',
  },
  FREE_JOB_IMPORT_ROWS_PER_DAY: {
    kind: 'limit', default: 100, adminEditable: true, public: true /* the guide says it */, group: 'accounts', min: 0, max: 100_000,
    label: 'Free imported rows per day',
    help: 'Rows a Free account may import from files and Google Sheets in 24 hours; rows over it are refused until then.',
  },
  PAID_JOB_IMPORT_ROWS_PER_DAY: {
    kind: 'limit', default: 1000, adminEditable: true, public: true /* the guide says it */, group: 'accounts', min: 0, max: 100_000,
    label: 'Paid imported rows per day',
    help: 'Rows a Paid account may import from files and Google Sheets in 24 hours; rows over it are refused until then.',
  },
  JOB_IMPORTS_PER_MINUTE: {
    kind: 'int', default: 20, adminEditable: true, public: false, group: 'jobs', min: 1, max: 1000,
    label: 'Import requests per minute',
    help: 'Previews and imports of files and Google Sheets one person may send in a minute.',
  },
  MSG_JOB_IMPORT_TOO_MANY_ROWS: message(
    'Import: too many rows',
    'Import at most {max} rows at a time; this one has {rows}. Split it and import each part.',
    ['max', 'rows'] as const,
  ),
  MSG_JOB_IMPORT_DAY_LIMIT: message(
    'Import: rows per day used',
    'You imported {limit} rows in the last 24 hours: try again in {hours} {hours|hour|hours}.',
    ['limit', 'hours'] as const,
  ),
  MSG_JOB_IMPORT_ROW_OVER_DAY: message(
    'Import row: over the day',
    "Over today's rows: import it again in {hours} {hours|hour|hours}.",
    ['hours'] as const,
  ),
  MSG_JOB_IMPORT_NO_LINK_COLUMN: message('Import: no link column', 'Choose the column that holds the job links.'),
  MSG_JOB_IMPORT_EMPTY: message('Import: no rows', 'There are no rows to import: check the file or the tab.'),
  MSG_JOB_IMPORT_BUSY: message('Import: too many requests', 'You sent many imports at once: try again in a minute.'),
  MSG_JOB_IMPORT_FILE_UNREADABLE: message(
    'Import: file unreadable',
    'TailorIT cannot read this file: save it as .xlsx, .csv, .tsv, .txt or .json and try again.',
  ),
  MSG_JOB_IMPORT_FILE_TOO_BIG: message(
    'Import: file too big once opened',
    'This spreadsheet is too large once opened: save fewer rows or columns and try again.',
  ),
  MSG_JOB_IMPORT_ROW_NO_LINK: message('Import row: no link', 'This row has no job link.'),
  MSG_JOB_IMPORT_ROW_REPEATS: message('Import row: repeats', 'Repeats row {row}.', ['row'] as const),
  MSG_JOB_IMPORT_ROW_HOST: message('Import row: a site TailorIT never reads', "Can't import from {host}.", ['host'] as const),
  MSG_JOB_IMPORT_ROW_WAITING: message('Import row: waiting for review', 'Already waiting for review.'),
  MSG_NOTIFY_JOB_IMPORT_TITLE: message(
    'Notification: your import finished',
    'Your import of {rows} {rows|row|rows} finished',
    ['rows'] as const,
  ),
  // v35 FIX-STORE (ux M2, M3): the notice's body is its parts (MSG_NOTIFY_JOB_IMPORT_PART_*, below), zero ones left out.
  // end v35 IMPORT
  // v35 ADMIN (PLAN H3, H6): an admin's Approve all / Reject all (Admin › Review › New jobs) runs on the server in
  // batches for at most this long a request; a longer one answers where it stopped and the page asks again from there.
  ADMIN_BULK_ALL_SECONDS: {
    kind: 'int', default: 20, adminEditable: true, public: false, group: 'jobs', min: 1, max: 120,
    label: 'Seconds one "all" decision request runs',
    help: 'How long one Approve all or Reject all request decides reviews before it answers and the page asks again.',
  },
  // end v35 ADMIN
  // v35 FIX-STORE (the final review's S3, S4, S7): a Google Sheet belongs to the first account that reads it; "Download
  // these rows" is a file of its own (never in a results page); a person's reads of their imports are rate-limited.
  JOB_IMPORT_READS_PER_MINUTE: {
    kind: 'int', default: 120, adminEditable: true, public: false, group: 'jobs', min: 1, max: 10_000,
    label: 'Import result reads per minute',
    help: "Times one person may open or refresh their imports' results, list and downloads in a minute.",
  },
  JOB_IMPORT_DOWNLOAD_MAX_MB: {
    kind: 'int', default: 10, adminEditable: true, public: false, group: 'jobs', min: 1, max: 200,
    label: 'Download these rows (MB)',
    help: 'The largest file of the rows that need a title and company one import gives to download.',
  },
  MSG_JOB_IMPORT_SHEET_CLAIMED: message(
    'Import: a sheet linked to another account',
    "This sheet is linked to another TailorIT account. Make a copy of it, share the copy with TailorIT's address (Viewer), and import the copy.",
  ),
  MSG_JOB_IMPORT_SHEET_TAB_NOT_FOUND: message('Import: a tab that cannot be found', "This tab can't be found: choose a tab from the list."),
  MSG_JOB_IMPORT_READS_BUSY: message(
    'Import: results opened too often',
    'You opened import results many times in a minute: wait a minute and open them again.',
  ),
  MSG_JOB_IMPORT_DOWNLOAD_TOO_BIG: message(
    'Import: rows to download too large',
    'These rows make a file over {max} MB. Fill in Company and Title in your own file or sheet and import it again.',
    ['max'] as const,
  ),
  // The ux review's M2, M3: the "import finished" notice says what the results say, each count a part (the parts with a
  // count above 0, joined: "8 jobs waiting for review, 4 need a title and company."); placeholders in snake_case.
  MSG_NOTIFY_JOB_IMPORT_PART_ADDED: message('Notification: your import finished (added)', '{added} added', ['added'] as const),
  MSG_NOTIFY_JOB_IMPORT_PART_KNOWN: message('Notification: your import finished (already there)', '{known} already in TailorIT', ['known'] as const),
  MSG_NOTIFY_JOB_IMPORT_PART_REVIEW: message('Notification: your import finished (to review)', '{review} {review|job|jobs} waiting for review', ['review'] as const),
  MSG_NOTIFY_JOB_IMPORT_PART_NEEDS_DETAILS: message(
    'Notification: your import finished (needs details)',
    '{needs_details} {needs_details|needs|need} a title and company',
    ['needs_details'] as const,
  ),
  MSG_NOTIFY_JOB_IMPORT_PART_CLOSED: message('Notification: your import finished (closed)', '{closed} closed', ['closed'] as const),
  MSG_NOTIFY_JOB_IMPORT_PART_FAILED: message('Notification: your import finished (not imported)', '{failed} not imported', ['failed'] as const),
  // Decision 8: an admin import's Added row whose read waits in Review › New jobs.
  MSG_JOB_IMPORT_ROW_ADDED_HELD: message('Import row: added, waiting in New jobs', 'Added; waiting for approval in New jobs'),
  // end v35 FIX-STORE
  // v35 IMPORTWEB (SP v35 SPECS-W2.md IMPORTWEB §2-§3): the limits line under an import (Admin › Import, Jobs › Add job).
  MSG_JOB_IMPORT_ROWS_UP_TO: message('Import: rows a file or sheet takes', 'Up to {max} rows a file or sheet.', ['max'] as const),
  MSG_JOB_IMPORT_ROWS_LEFT_TODAY: message(
    "Import: a person's rows left today",
    'You can import {rows} more {rows|row|rows} today.',
    ['rows'] as const,
  ),
  MSG_ADMIN_IMPORT_PASTE_UP_TO: message(
    'Import: pasted links an admin may import',
    'Up to {max} pasted links or rows; a file or a Google Sheet takes up to {file_max} rows.',
    ['max', 'file_max'] as const,
  ),
  // end v35 IMPORTWEB
  // v35 FIX-WEB (the final ux review's M1, the coordinator's decision 11): a person's rows past the day's room are not
  // imported (the server's rule); Add job says so before Import, in the words the results then use ("in 24 hours").
  MSG_JOB_IMPORT_OVER_TODAY: message(
    "Import: some rows don't fit today",
    "Only the first {fit} {fit|row fits|rows fit} today; the other {over} won't be imported. Import the file again in 24 hours for the rest: rows already added are skipped.",
    ['fit', 'over'] as const,
  ),
  MSG_JOB_IMPORT_NONE_LEFT_TODAY: message(
    'Import: no rows left today',
    'You have no rows left to import today: import again in 24 hours.',
  ),
  // end v35 FIX-WEB
  // v36 SOURCES (SP v36 PLAN S5): Run now and a run's Continue on a source that is off (the words bulk Run now already
  // gives such a source); Admin › Sources shows them as Run now's tip while the source is off.
  MSG_INGEST_SOURCE_OFF: message('Source off: no run starts', 'It is off: turn it on first.'),
  // end v36 SOURCES
  // v36 APPLYAPI (SP v36 PLAN A3): Share All (the Auto-apply page) shares every job in Saved on one profile to others,
  // at most this many a press (the newest saved first); the start refuses more (@tailorit/shared/sharing share-all.ts).
  SHARE_ALL_MAX: {
    kind: 'int', default: 500, adminEditable: true, public: true, group: 'jobs', min: 1, max: 2000,
    label: 'Share All batch',
    help: 'The most saved jobs one Share All shares to other profiles; the newest saved go first.',
  },
  MSG_SHARE_ALL_TOO_MANY: message('Share All: too many jobs at once', 'Share at most {max} saved jobs at once.', ['max'] as const),
  // end v36 APPLYAPI
} as const satisfies Record<string, AnyConstantSpec>;

export type Constants = typeof CONSTANTS;
export type ConstantKey = keyof Constants;
export type ConstantValue<K extends ConstantKey> = ValueOf<Constants[K]['kind']>;

/** Every key, in the table's order. */
export const CONSTANT_KEYS = /* @__PURE__ */ Object.keys(CONSTANTS) as ConstantKey[];

/** The keys of the user-facing messages (kind `message`). */
export type MessageKey = { [K in ConstantKey]: Constants[K]['kind'] extends 'message' ? K : never }[ConstantKey];
export const MESSAGE_KEYS = /* @__PURE__ */ CONSTANT_KEYS.filter((key) => CONSTANTS[key].kind === 'message') as MessageKey[];

/** The keys GET /api/constants/public answers. */
export type PublicConstantKey = { [K in ConstantKey]: Constants[K]['public'] extends true ? K : never }[ConstantKey];
export const PUBLIC_CONSTANT_KEYS = /* @__PURE__ */ CONSTANT_KEYS.filter((key) => CONSTANTS[key].public) as PublicConstantKey[];
/** The web's subset, resolved. */
export type PublicConstants = { [K in PublicConstantKey]: ConstantValue<K> };
/**
 * v20 FIX-A (SEC-5): each public constant's kind, default and bounds, as the web's public module holds them
 * (./public/specs.ts, generated from this table): the web never imports CONSTANTS, which holds the budgets, the prices
 * and the capacity threshold.
 */
export type PublicConstantSpecs = {
  readonly [K in PublicConstantKey]: {
    readonly kind: Constants[K]['kind'];
    readonly default: ConstantValue<K>;
    readonly min?: number;
    readonly max?: number;
  };
};

/** The keys Admin › Constants may override. */
export const ADMIN_EDITABLE_KEYS = /* @__PURE__ */ CONSTANT_KEYS.filter((key) => CONSTANTS[key].adminEditable);

/** The spec of `key`, typed loosely (for code that walks every constant). */
export function constantSpec(key: ConstantKey): AnyConstantSpec {
  return CONSTANTS[key] as AnyConstantSpec;
}

/** Whether `key` names a constant. */
export function isConstantKey(key: string): key is ConstantKey {
  return Object.hasOwn(CONSTANTS, key);
}

/** The default of `key`. */
export function constantDefault<K extends ConstantKey>(key: K): ConstantValue<K> {
  return CONSTANTS[key].default as ConstantValue<K>;
}

/** The .env keys read for `key`, in order: its own (or `env`), then its aliases. */
export function envKeysOf(key: ConstantKey): string[] {
  const spec = constantSpec(key);
  return [spec.env ?? key, ...(spec.envAliases ?? [])];
}

// v32 FIX-PLAN (E12)
/** The constant an earlier key now names (`formerKeys`: TAILOR_PER_HOUR is FREE_TAILOR_PER_HOUR), or undefined. */
export function constantOfFormerKey(former: string): ConstantKey | undefined {
  return CONSTANT_KEYS.find((key) => constantSpec(key).formerKeys?.includes(former));
}
// end v32 FIX-PLAN
