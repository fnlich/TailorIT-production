// v2.0: the central constants (docs/design/v2.0/02-constants.md). Every business number this release adds or touches,
// and every user-facing limit or status message, is defined here once: its kind, its default, its .env key, whether an
// admin may change it at runtime (Admin › Constants) and whether the web may read it (GET /api/constants/public). The
// API resolves each value in the order DB override, then .env, then the default below (apps/api/src/core/constants).
// This module is pure data and pure functions: it reads no environment and no database. Technical constants (parser
// caps, regexes, timeouts inside one module) stay beside their code, and the autofill contract keeps its own.

import { AUTOFILL_AGENT_QUEUE_MAX } from '../autofill/agent';
import { AUTOFILL_TAILOR_PER_HOUR } from '../autofill/tailor';

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
/** The words of one choice of a setting (Settings › Prepare & Queue's resume mode). */
/* @__NO_SIDE_EFFECTS__ */
function choiceLabel(label: string, text: string) {
  return {
    ...message(label, text, [] as const, LABEL_MAX),
    help: "A choice's words in Settings › Prepare & Queue.",
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

  // Prepare & Queue (§1, §3).
  PREPARE_BATCH_MAX: {
    kind: 'int', default: 100, adminEditable: true, public: true, group: 'prepare', min: 1, max: 500,
    label: 'Prepare & Queue batch',
    help: 'The most saved jobs one Prepare & Queue takes.',
  },
  PREPARE_MCP_STALE_DAYS: {
    kind: 'int', default: 7, adminEditable: true, public: false, group: 'prepare', min: 1, max: 90,
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
    label: 'Save all batch',
    help: 'The most jobs one Save all saves (was SAVE_ALL_LIMIT).',
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

  // v20 A29 (DECISIONS A29): the Prepare & Queue resume mode. 'default': the person's default resume as it is;
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
    'Add a resume first: Prepare & Queue needs one.',
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
    'Prepare & Queue confirm',
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
    'An update stopped this: Prepare & Queue it again.',
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
    'Save the job, then Prepare & Queue it on Auto-apply.',
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
  // v20 A30: a Saved entry with a live queue row shows Draft (the Tracker's derived status, and this marker); it
  // replaces the marker Queued. One source: tracker/statuses.ts's displayStatusLabel reads it.
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
  LABEL_TRACKER_STEP_DRAFT: message('Tracker: the next step at Draft', 'check the draft', [] as const, LABEL_MAX),
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
    kind: 'int', default: 30, adminEditable: true, public: false, group: 'retention', min: 1, max: 3650,
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
    kind: 'int', default: 30, adminEditable: true, public: false, group: 'retention', min: 1, max: 3650,
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
  SAVE_ALL_RUNS_PER_HOUR: {
    kind: 'int', default: 20, adminEditable: true, public: false, group: 'jobs', min: 1, max: 1000,
    label: 'Save all runs per hour',
    help: 'Times one account may run Save all in any sliding hour.',
  },
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
  // v30 ST3: the constants audit's keys deferred to their adoption (Save all, the auto-apply queue's job states, two
  // autofill refusals), read by the autofill and jobs features, and the sign-in refusal that shares their words
  // (MSG_SIGN_IN_CODE_USED).
  MSG_SAVE_ALL_PER_HOUR: message(
    'Save all: too often',
    'Save all runs {max} {max|time|times} an hour: try again in {minutes} {minutes|minute|minutes}.',
    ['max', 'minutes'],
  ),
  MSG_SAVE_ALL_BUSY: message(
    'Save all: busy',
    'Save all is still working: try again in a moment.',
  ),
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
    help: "Whether discovery reads found Greenhouse, Lever, Ashby and Workable boards with today's User-Agent before BOT_USER_AGENT is set.",
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
    help: 'Found boards and career sites read once a day to test them before they become sources.',
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
    kind: 'int', default: 90, adminEditable: true, public: false, group: 'retention', min: 7, max: 3650,
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
    kind: 'int', default: 30, adminEditable: true, public: false, group: 'mcp', min: 1, max: 365,
    label: 'Connected AI: idle days',
    help: 'A connected AI app that asks for no new token in this many days is disconnected (its refresh token ends).',
  },
  OAUTH_CODE_SECONDS: {
    kind: 'int', default: 120, adminEditable: true, public: false, group: 'mcp', min: 30, max: 600,
    label: 'Connected AI: code (seconds)',
    help: 'How long the one-time code an AI app gets after Allow works; it is used once, within seconds.',
  },
  OAUTH_REQUEST_MINUTES: {
    kind: 'int', default: 10, adminEditable: true, public: false, group: 'mcp', min: 1, max: 60,
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
    kind: 'int', default: 7, adminEditable: true, public: false, group: 'retention', min: 1, max: 365,
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
    help: 'Links one Admin add or one import may queue for reading at a time.',
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
    'Import: only links are read',
    '{queued} {queued|link is|links are} queued for reading; other columns are ignored.',
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
    'Import: only the link column',
    'Only the {column} column is read; {ignored} other {ignored|column is|columns are} ignored.',
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
  LABEL_JOB_FROM_BROWSER: message('Job: from the browser', 'From your browser, not verified', [] as const, LABEL_MAX),
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
  LABEL_JOB_NAV_MATCH: message('Job: jump to the match', 'Match', [] as const, LABEL_MAX),
  LABEL_JOB_NAV_ROLE: message('Job: jump to the role', 'Role', [] as const, LABEL_MAX),
  LABEL_JOB_NAV_COMPANY: message('Job: jump to the company', 'Company', [] as const, LABEL_MAX),
  LABEL_JOB_YOUR_MATCH: message('Job: your match', 'Your match', [] as const, LABEL_MAX),
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
  LABEL_JOB_ABOUT_ROLE: message('Job: about the role', 'About the role', [] as const, LABEL_MAX),
  LABEL_JOB_ROLE_DUTIES: message("Job: the role's duties", "What you'd do", [] as const, LABEL_MAX),
  LABEL_JOB_ROLE_ASKS: message("Job: the role's requirements", 'What they ask for', [] as const, LABEL_MAX),
  LABEL_JOB_ROLE_NICE: message("Job: the role's extras", 'Nice to have', [] as const, LABEL_MAX),
  LABEL_JOB_ROLE_ALSO: message('Job: other words the posting names', 'Also mentioned', [] as const, LABEL_MAX),
  LABEL_JOB_POSTING_SHOW: message('Job: show the full posting', 'Read the full posting', [] as const, LABEL_MAX),
  LABEL_JOB_POSTING_HIDE: message('Job: hide the full posting', 'Hide the full posting', [] as const, LABEL_MAX),
  MSG_JOB_NO_SUMMARY: message('Job: no summary yet', 'TailorIT has no summary of this posting yet.'),
  LABEL_JOB_ABOUT_COMPANY: message('Job: about the company', 'About {company}', ['company'] as const, LABEL_MAX),
  MSG_JOB_SUMMARY_FAILED: message('Job: summary failed', 'No summary: here is the posting as written.'),
  // end v31 FIX-JOBS
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
