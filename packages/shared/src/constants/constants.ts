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
const COUNT_WORDS_HELP = ' {name|one|other} is the words for a count: the first when it is 1, the second otherwise.';
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
      ? `Shown to people as it is, with ${placeholders.map((name) => `{${name}}`).join(', ')} filled in.${COUNT_WORDS.test(text) ? COUNT_WORDS_HELP : ''}`
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
    help: 'Fills {reason} in "Filtered: {reason}". {value} is the filter\'s word for the job, such as on-site or TX, CA only.',
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
    help: "What TailorIT's AI may spend for a Free account each day before extra credit is used. People never see it.",
  },
  PAID_AI_DAILY_BUDGET_USD: {
    kind: 'usd_limit', default: 500_000, adminEditable: true, public: false, group: 'accounts',
    label: 'Paid daily AI budget',
    help: "What TailorIT's AI may spend for a Paid account each day before extra credit is used. People never see it.",
  },
  FREE_RESUME_LIMIT: {
    kind: 'limit', default: 30, adminEditable: true, public: true, group: 'accounts', min: 0, max: 100_000,
    label: 'Free resume limit',
    help: 'How many resumes of every kind a Free account may hold. At the limit, new resumes and edits are blocked.',
  },
  PAID_RESUME_LIMIT: {
    kind: 'limit', default: UNLIMITED, adminEditable: true, public: true, group: 'accounts', min: 0, max: 100_000,
    label: 'Paid resume limit',
    help: 'How many resumes of every kind a Paid account may hold. The safety cap applies as well.',
  },
  FREE_AI_JOB_SEARCH: {
    kind: 'bool', default: false, adminEditable: true, public: true, group: 'accounts',
    label: 'AI job search for Free',
    help: 'Whether a Free account may use AI job search. Classic search is always available.',
  },
  PAID_AI_JOB_SEARCH: {
    kind: 'bool', default: true, adminEditable: true, public: true, group: 'accounts',
    label: 'AI job search for Paid',
    help: 'Whether a Paid account may use AI job search. Classic search is always available.',
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
    help: 'One Paid term. "Extend" adds one term to the later of now and the current end.',
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
    help: 'A technical cap on resumes for every account, Paid included. It is not a plan limit.',
  },
  // v20 FIX-A (REQ-10, A18): the Tailor's hourly limit, with the extension contract's number as its default.
  TAILOR_PER_HOUR: {
    kind: 'int', default: AUTOFILL_TAILOR_PER_HOUR, adminEditable: true, public: false, group: 'resumes', min: 1,
    max: 1000,
    label: 'Tailorings per hour',
    help: "Tailorings one account may start in an hour (Tailor my resume, the extension's tailor, an own-AI tailor).",
  },

  // The auto-apply window and the queue (§4, §10).
  AUTO_APPLY_WINDOW_DAYS: {
    kind: 'int', default: 1, adminEditable: true, public: true, group: 'auto_apply', min: 1, max: 31,
    label: 'Auto-apply window (days)',
    help: 'The length of the window the auto-apply limits count in. 1 counts per day.',
  },
  AUTO_APPLY_WINDOW_EPOCH: {
    kind: 'date', default: '2026-01-01', adminEditable: false, public: false, group: 'auto_apply',
    label: 'Auto-apply window start',
    help: 'The day windows of more than one day are counted from.',
  },
  // v30 CT (audit B1): the default is the autofill contract's number, which cannot read this table (the extension
  // copies the contract folder byte for byte), as TAILOR_PER_HOUR's is.
  QUEUE_SIZE_MAX: {
    kind: 'int', default: AUTOFILL_AGENT_QUEUE_MAX, adminEditable: true, public: true, group: 'auto_apply', min: 1, max: 5000,
    label: 'Queue size',
    help: "The most rows an account's auto-apply queue holds.",
  },

  // The day boundary (§2, §10). A change moves today's day key at once.
  DAY_RESET_TIME: {
    kind: 'time_of_day', default: '00:00', adminEditable: true, public: true, group: 'time',
    label: 'Daily reset time',
    help: "When the AI budget and the auto-apply counter reset each day. Changing this moves today's reset at once.",
  },
  DAY_RESET_TIME_ZONE: {
    kind: 'time_zone', default: 'America/Los_Angeles', adminEditable: true, public: true, group: 'time',
    label: 'Daily reset time zone',
    help: "The time zone of the daily reset. Changing this moves today's reset at once.",
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
    help: "What TailorIT's own spend estimate counts as full when the CLI reports no usage. Unlimited: no fallback.",
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
    help: 'USD per million tokens by model, used only when the CLI reports no cost. "*" prices any other model.',
  },

  // Prepare & Queue (§1, §3).
  PREPARE_PER_HOUR: {
    kind: 'int', default: 30, envAliases: ['PREBUILD_PER_HOUR'], adminEditable: true, public: false, group: 'prepare',
    min: 1, max: 1000,
    label: 'Prepares per hour',
    help: "Server Prepares started per account per hour. It paces the runner and refuses nothing.",
  },
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
    help: '"required": a letter only when the application requires one. "always": a letter for every job.',
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
    help: '"saved": jobs in some Saved Jobs, oldest saved first. "all": every active job. "off": none.',
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
    help: "The longest custom instructions text. Tied to the database column's check, so it is set in .env only.",
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
    help: "Days finished Prepares are kept. Each application's newest is always kept.",
  },
  CUSTOM_FILTER_VERDICT_KEEP_DAYS: {
    kind: 'int', default: 30, adminEditable: true, public: false, group: 'retention', min: 1, max: 365,
    label: 'Custom filter verdicts (days)',
    help: 'Days a Custom filter verdict is kept before the job is judged again.',
  },
  RESERVATION_KEEP_DAYS: {
    kind: 'int', default: 35, adminEditable: true, public: false, group: 'retention', min: 7, max: 3650,
    label: 'Auto-apply reservations (days)',
    help: 'Days settled auto-apply reservations are kept. Only the current window is counted.',
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
    'Downloading several resumes at once is available with a Paid account. Subscribe to unlock it.',
  ),
  // end v20 P10

  // v20 A29 (DECISIONS A29): the Prepare & Queue resume mode. 'default': the person's default resume as it is;
  // 'similar': their most similar existing resume (rule-based, no AI); 'tailor': a new tailored resume (v1.5's
  // behaviour). The letter and the answers are written from the resume the mode chose.
  PREPARE_RESUME_MODE_DEFAULT: {
    kind: 'text', default: 'tailor', choices: ['default', 'similar', 'tailor'], adminEditable: true, public: true,
    group: 'prepare', maxLength: 10,
    label: 'Resume mode for a new account',
    help: '"default": the default resume as it is. "similar": the most similar existing resume. "tailor": a new tailored resume for each job.',
  },
  MSG_PREPARE_NO_RESUME: message(
    'Prepare: no resume',
    'Add a resume first: Prepare & Queue needs a default resume or one to choose from.',
  ),
  LABEL_RESUME_MODE_DEFAULT: choiceLabel('Resume mode: default', 'Only my default resume'),
  // v20 A30: the owner's words, best-matched.
  LABEL_RESUME_MODE_SIMILAR: choiceLabel('Resume mode: similar', 'Use my best-matched resume'),
  LABEL_RESUME_MODE_TAILOR: choiceLabel('Resume mode: tailor', 'Always tailor'),
  // end v20 A29

  // Messages. {reset_time} is "12:00 AM Pacific Time" (resetText); {contact_email} is ADMIN_CONTACT_EMAIL.
  MSG_AI_UNAVAILABLE: message(
    'AI unavailable',
    "AI is currently unavailable. Your account may be flagged, or the server's AI may not be working. Please contact the admin or use your own AI via MCP.",
  ),
  MSG_AI_USAGE_EXHAUSTED: message(
    'AI usage used up',
    "You've used your AI usage. Get extra credit or use your own AI via MCP.",
  ),
  MSG_LIMIT_AUTO_APPLY: message(
    'Auto-apply limit reached',
    "You've reached the Free account limit of {limit} auto-applies per day. Your limit resets at {reset_time}. Subscribe for unlimited auto-apply.",
    ['limit', 'reset_time'],
  ),
  MSG_LIMIT_RESUMES: message(
    'Resume limit reached',
    "You've reached the Free account limit of {limit} saved resumes. Delete some resumes or subscribe for unlimited storage.",
    ['limit'],
  ),
  MSG_PAID_AI_SEARCH: message(
    'AI search is Paid',
    'AI job search is available with a Paid account. You can keep using classic search, or subscribe to unlock AI search.',
  ),
  MSG_SUBSCRIBE_CONTACT: message('Subscribe', 'Please contact the admin to subscribe.'),
  MSG_CREDIT_CONTACT: message('Buy extra credit', 'Please contact the admin to purchase extra credit.'),
  MSG_CONTACT_EMAIL_MISSING: message('No contact email', 'The admin has not set a contact email yet.'),
  MSG_PREPARE_CONFIRM: message(
    'Prepare & Queue confirm',
    'This can use a significant amount of your AI usage. Continue?',
  ),
  MSG_PREPARE_CONFIRM_DONT_SHOW: message("Confirm's checkbox", "Don't show this again", [], LABEL_MAX),
  MSG_AUTO_APPLY_USAGE: message('Auto-apply usage', '{used} of {limit} used today', ['used', 'limit'], LABEL_MAX),
  MSG_WAITING_FOR_RESET: message(
    'Waiting for the daily reset',
    'Daily auto-apply limit reached. These jobs wait until {reset_time}.',
    ['reset_time'],
  ),
  MSG_FILTERED: message('Filtered', 'Filtered: {reason}', ['reason'], 200),
  MSG_PREPARE_NOT_SAVED: message(
    'Prepare: not saved',
    'This job is no longer at Saved in your Job Tracker, so it was not prepared.',
  ),
  MSG_PREPARE_NO_JOB: message(
    'Prepare: no job',
    'This Tracker entry has no job posting in TailorIT, so it cannot be prepared.',
  ),
  MSG_PREPARE_ACTIVE: message('Prepare: already preparing', 'This job is being prepared already.'),
  MSG_PREPARE_ALREADY_QUEUED: message('Prepare: already queued', 'This job is in your auto-apply queue already.'),
  MSG_PREPARE_QUEUE_FULL: message(
    'Prepare: queue full',
    'Your auto-apply queue is full ({limit} jobs). Clear finished jobs, then Prepare & Queue again.',
    ['limit'],
  ),
  MSG_PREPARE_INTERRUPTED: message(
    'Prepare: interrupted by the update',
    'The TailorIT update interrupted this preparation. Prepare & Queue it again.',
  ),
  MSG_PREPARE_NEEDS_COPY: message(
    'Prepare: needs an editable copy',
    'Your resume is an uploaded file with no editable copy yet. Make an editable copy in Documents, then Prepare & Queue again.',
  ),
  MSG_PREPARE_RESUME_FAILED: message('Prepare: resume failed', 'The tailored resume could not be made.'),
  MSG_PREPARE_LETTER_FAILED: message('Prepare: letter failed', 'The cover letter could not be written.'),
  MSG_PREPARE_ANSWERS_FAILED: message(
    'Prepare: answers failed',
    'Some answers could not be prepared; they are made during the application instead.',
  ),
  MSG_PREPARE_TOOK_TOO_LONG: message('Prepare: too slow', 'The AI took too long to answer.'),
  MSG_PREPARE_FAILED: message('Prepare: failed', 'Something went wrong while this job was prepared.'),
  MSG_DIRECT_QUEUE_REMOVED: message(
    'Direct queueing removed',
    'Jobs are queued by Prepare & Queue. Save the job, then Prepare & Queue it on the Auto-apply page.',
  ),
  MSG_CUSTOM_FILTER_PENDING: message(
    'Custom filter pending',
    'The custom filter has not judged this job yet.',
  ),
  MSG_MANUAL_ONLY: message(
    'Applied to by hand',
    "This job is applied to by hand. Open it from TailorIT's Auto-apply page.",
  ),

  // v20 FIX-A (REQ-3, A18): the limit and status messages the code still wrote itself, in the code's words.
  MSG_LIMIT_AUTO_APPLY_ACCOUNT: message(
    'Auto-apply limit reached (not Free)',
    "You've reached your account's limit of {limit} auto-applies per day. Your limit resets at {reset_time}.",
    ['limit', 'reset_time'],
  ),
  MSG_LIMIT_RESUMES_ACCOUNT: message(
    'Resume limit reached (not Free)',
    "You've reached your account's limit of {limit} saved resumes. Delete some resumes to add new ones.",
    ['limit'],
  ),
  MSG_PREPARE_BATCH_MAX: message('Prepare: too many jobs', 'Choose at most {max} saved jobs.', ['max']),
  MSG_BATCH_DOWNLOAD_MAX: message(
    'Batch download: too many resumes',
    'One download holds up to {max} resumes. Select fewer and try again.',
    ['max'],
  ),
  MSG_TEXT_TOO_LONG: message('Text too long', 'Use at most {max} characters.', ['max']),
  MSG_AI_SEARCH_TIMEOUT: message(
    'AI search: too slow',
    'The AI search took too long. Try again, or use the classic search.',
  ),
  MSG_AI_SEARCH_FAILED: message(
    'AI search: failed',
    'The AI search did not finish. Try again, or use the classic search.',
  ),
  MSG_CUSTOM_FILTER_FAILED: message('Custom filter failed', 'The custom filter could not judge these jobs.'),
  MSG_TAILOR_PER_HOUR: message(
    'Tailor limit reached',
    'You have tailored {max} {max|resume|resumes} in the last hour, the most TailorIT starts in an hour. Please wait {minutes} {minutes|minute|minutes} and try again.',
    ['max', 'minutes'],
  ),
  MSG_MCP_OFF: message('MCP off', "Connecting your own AI to TailorIT's MCP server is not available for your account."),
  MSG_MCP_TOKENS_MAX: message(
    'MCP tokens: at the limit',
    'This account already has {max} MCP tokens, the most TailorIT allows. Revoke one you no longer use, then make a new one.',
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
    help: 'Days an ingest run (its counts and log) is kept; each source keeps its newest run. The daily housekeeping deletes older ones.',
  },
  UPLOAD_MAX_MB: {
    kind: 'int', default: 5, adminEditable: false, public: true, group: 'resumes', min: 1, max: 10_000,
    label: 'Upload size (MB)',
    help: 'The largest file one upload takes (a resume, a letter, an import), in MB. Read at start: .env only.',
  },
  UPLOAD_BATCH_MAX_FILES: {
    kind: 'int', default: 50, adminEditable: true, public: true, group: 'resumes', min: 1, max: 500,
    label: 'Files per upload',
    help: 'Files one resume upload takes at a time.',
  },
  MSG_EXTENSION_TOKENS_MAX: message(
    'Connected browsers: at the limit',
    'This account already has {max} connected browsers, the most TailorIT allows. Disconnect one in Settings › Autofill, then connect again.',
    ['max'],
  ),
  MSG_PHOTO_TOO_LARGE: message('Photo too large', 'That photo is larger than {max_mb} MB. Choose a smaller image.', ['max_mb']),
  MSG_AI_BUSY: message(
    'AI request already running',
    'An AI request of this kind is already running for your account. Wait for it to finish, then try again.',
  ),
  MSG_AI_CANCELLED: message('AI request cancelled', 'This AI request was cancelled.'),
  MSG_AI_INTERRUPTED: message(
    'AI request interrupted',
    'The server restarted while this AI request was running. Please try again.',
  ),
  MSG_RESUME_IMPORT_MAX: message('Resume import: too many', 'A file can hold at most {max} resumes.', ['max']),
  MSG_UPLOAD_BATCH_MAX: message(
    'Upload: too many files',
    'Up to {max} files can be uploaded at a time, so {left_out} {left_out|file was|files were} not added.',
    ['max', 'left_out'],
  ),
  MSG_LETTER_BEING_WRITTEN: message(
    'Cover letter being written',
    'This cover letter is being written. Wait for it to finish, then try again.',
  ),
  MSG_SAVED_SEARCHES_MAX: message(
    'Saved searches: at the limit',
    'You can keep up to {max} saved searches. Delete one to save this search.',
    ['max'],
  ),
  MSG_SIGN_INS_MAX: message(
    'Job-site sign-ins: at the limit',
    'You can save up to {max} job-site sign-ins. Delete one you no longer use first.',
    ['max'],
  ),
  MSG_SAVED_ANSWERS_MAX: message(
    'Saved answers: at the limit',
    'You have saved {max} answers, the most TailorIT keeps. Delete some on Settings › Autofill › Saved answers, then save this one again.',
    ['max'],
  ),
  MSG_AUTOFILL_RESUME_TOO_LARGE: message(
    'Autofill: resume file too large',
    "This resume's file is larger than {max_mb} MB, more than the extension can attach. Choose another resume, or make this one smaller.",
    ['max_mb'],
  ),
  MSG_SIGN_IN_CODE_COOLDOWN: message(
    'Sign-in code: just sent',
    'A code was just sent to that address. Wait {seconds} more {seconds|second|seconds} before asking for another, and check the spam folder in the meantime.',
    ['seconds'],
  ),
  MSG_SIGN_IN_CODE_EXPIRED: message('Sign-in code: expired', 'That code has expired. Ask for a new one.'),
  MSG_SIGN_IN_CODE_ATTEMPTS: message(
    'Sign-in code: too many tries',
    'That code was entered wrongly {max} times and is no longer valid. Ask for a new one.',
    ['max'],
  ),
  MSG_CONNECT_CODE_EXPIRED: message(
    'Connect code: expired',
    'That code has expired or was already used. Get a new one from Settings › Autofill.',
  ),
  MSG_INGEST_IMPORT_RUNNING: message('Import running', 'This import is running. Wait for it to finish.'),
  MSG_INGEST_SOURCE_RUNNING: message('Source running', 'This source is already running. Wait for that run to finish.'),
  MSG_INGEST_SOURCE_RUNNING_DELETE: message(
    'Source running: no delete',
    'This source is running. Wait for the run to finish, then delete it.',
  ),
  MSG_SHEET_ROWS_MAX: message(
    'Sheet import: too many rows',
    'This tab has more than {max} rows below the header row. Split it into tabs of up to {max} rows and import each one.',
    ['max'],
  ),
  MSG_SHEET_TOO_LARGE: message(
    'Sheet import: too large',
    'This tab holds more than {max_mb} MB of text. Split it into smaller tabs and import each one.',
    ['max_mb'],
  ),
  LABEL_JOB_CLOSED: stateLabel('Job: closed', 'No longer accepting applications'),
  LABEL_JOB_LIVE: stateLabel('Job: confirmed live', 'Confirmed live in the last 24 hours'),
  // end v30 ST0
  // v30 ST4: the Google Sheet import's words for an answer from Google over the read's cap (ingest/sheets/client.ts),
  // which said the second sentence of MSG_SHEET_TOO_LARGE beside the code.
  MSG_SHEET_ANSWER_TOO_LARGE: message(
    'Sheet import: answer too large',
    'This tab is too large to import at once (Google sent more than {size}). Split it into smaller tabs and import each one.',
    ['size'],
  ),
  // end v30 ST4
  // v30 ST1: the resume ZIP's statuses (SP\p2\build\ST0-deferred-keys.txt), in today's words, which
  // features/resume-zip reads; MSG_ZIP_NOT_MADE too, since its second sentence is MSG_ZIP_GONE's; and the template
  // editor's cap on its AI prompt (cover-letter-templates/router.ts), its number written as the editor writes it.
  MSG_ZIP_ALREADY_BUILDING: message(
    'Resumes ZIP: already building',
    'Your resumes are already being built. Wait for that download to finish, then try again.',
  ),
  MSG_ZIP_STILL_BUILDING: message(
    'Resumes ZIP: still building',
    'Your resumes are still being built. Download them once they are ready.',
  ),
  MSG_ZIP_STOPPED: message(
    'Resumes ZIP: stopped',
    'Building your resumes was stopped because the server is restarting. Please try again.',
  ),
  MSG_ZIP_GONE: message('Resumes ZIP: gone', 'That zip is no longer available. Build your resumes again.'),
  MSG_ZIP_NOT_MADE: message('Resumes ZIP: not made', 'That zip could not be made. Build your resumes again.'),
  MSG_ZIP_SERVER_BUSY: message(
    'Resumes ZIP: server busy',
    'TailorIT is building another zip of resumes right now. Please try again in {seconds} {seconds|second|seconds}.',
    ['seconds'],
  ),
  MSG_ZIP_TOO_LARGE: message(
    'Resumes ZIP: too large',
    'These resumes add up to more than {max_mb} MB. Select fewer {items} and try again.',
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
    'Save all can run {max} {max|time|times} an hour. Please wait {minutes} {minutes|minute|minutes} and try again.',
    ['max', 'minutes'],
  ),
  MSG_SAVE_ALL_BUSY: message(
    'Save all: busy',
    'Save all is still working on your last request. Wait a moment and try again.',
  ),
  MSG_AUTOFILL_LETTER_TOO_LARGE: message(
    'Autofill: letter PDF too large',
    "This cover letter's PDF is larger than {max_mb} MB, more than the extension can attach.",
    ['max_mb'],
  ),
  MSG_AUTOFILL_NOTE_TOO_LONG: message(
    'Autofill: note too long',
    'With the lines this connection keeps hidden (they state sensitive answers), the note would be over {max} characters. Shorten it, or edit it on the Settings › Autofill page in TailorIT.',
    ['max'],
  ),
  MSG_QUEUE_JOB_NOT_RUNNING: message(
    'Auto-apply job: not running',
    'This auto-apply job is not running any more: it was finished or removed. Ask for the next one.',
  ),
  MSG_QUEUE_JOB_NOT_YOURS: message(
    'Auto-apply job: another browser',
    'Another browser is running this auto-apply job. Only that browser reports how it went.',
  ),
  MSG_QUEUE_JOB_APPLYING: message(
    'Auto-apply job: applying',
    'The extension is applying to this job now. Wait for its result, or stop auto-apply in the extension, then remove it.',
  ),
  MSG_QUEUE_JOB_TAKEN: message(
    'Auto-apply job: taken',
    'Another auto-apply run (the background agent, or another browser) has this job now. Open the next queued one.',
  ),
  MSG_QUEUE_JOB_FINISHED: message(
    'Auto-apply job: finished',
    'This auto-apply job is finished. Open the next queued one, or queue it again in TailorIT.',
  ),
  MSG_SIGN_IN_CODE_USED: message(
    'Sign-in code: used or never sent',
    'That code has already been used, or none was sent to this address. Ask for a new one.',
  ),
  // end v30 ST3
  // v30 ST5: the web's limit and status sentences (SP\p2\build\ST0-deferred-keys.txt, ST5's block, and the ones
  // ST5's allowlisted literals needed), each in today's words. The web reads them through usePublicConstants().t, or
  // their defaults where no session reads the server's values (the sign-in page) and in the pure helpers' defaults.
  // v30 INT-0: the words for one (a file, a second) come from the count's words ({left_out|file was|files were},
  // {seconds|second|seconds}: ./render.ts), so ST5's two *_ONE keys are gone.
  MSG_WRITE_WITH_AI_FAILED: message('Write with AI failed', 'Write with AI did not finish. Please try again.'),
  MSG_AI_READING_WAITING: message(
    'AI reading waiting',
    'Waiting for the AI reading. Uploads are read one at a time, so it can take a while.',
  ),
  LABEL_AI_READING_WAITING: message('AI reading waiting: list line', 'Waiting for the AI reading', [] as const, LABEL_MAX),
  MSG_UPLOAD_HINT: message('Upload hint', 'PDF, DOC, DOCX up to {max_mb} MB each. Up to {max} files at a time.', ['max_mb', 'max']),
  MSG_UPLOAD_SIZE_HINT: message('Upload hint: size', 'Up to {max_mb} MB.', ['max_mb']),
  MSG_UPLOAD_TILE_HINT: message('Upload hint: resume tile', 'PDF or Word, up to {max_mb} MB', ['max_mb']),
  MSG_SECTION_ENTRIES_MAX: message('Resume section: too many entries', 'A section holds {max} entries at most', ['max']),
  MSG_CUSTOM_SECTIONS_MAX: message('Resume: too many custom sections', 'A resume can have at most {max} custom sections.', ['max']),
  MSG_ENTRY_BULLETS_MAX: message('Resume entry: too many bullets', 'An entry holds {max} bullets at most', ['max']),
  MSG_SIGN_IN_CODE_SENT: message(
    'Sign-in code: already sent',
    'A code was already sent to {email}. Enter it below, or wait {seconds} {seconds|second|seconds} to ask for another.',
    ['email', 'seconds'],
  ),
  MSG_CSV_ROWS_MAX: message(
    'CSV import: too many rows',
    'That file has more than {max} rows. Split it and import the parts one at a time.',
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
    'This cover letter is still being written. Ask again in a moment.',
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
  MSG_FILE_TOO_LARGE: message('File too large', '{name} is larger than {max_mb} MB. Choose a smaller file.', ['name', 'max_mb']),
  // The web's own size checks before a file is sent, in today's words: a resume upload or PDF import (UPLOAD_MAX_MB,
  // resume-editor/files.ts) and the header photo's pick before cropping (resume-editor/photo/crop.ts).
  MSG_UPLOAD_FILE_TOO_LARGE: message(
    'Upload: file too large (before sending)',
    '{name} is {max_mb} MB or larger; files under {max_mb} MB are accepted. Choose a smaller file.',
    ['name', 'max_mb'],
  ),
  MSG_PHOTO_FILE_TOO_LARGE: message(
    'Photo: file too large (before cropping)',
    'That image is larger than {max_mb} MB. Choose a smaller one.',
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
    help: "Whether discovery reads found Greenhouse, Lever, Ashby and Workable boards with today's User-Agent (as their sources' runs do) before BOT_USER_AGENT is set. Other kinds always wait for BOT_USER_AGENT.",
  },
  // REV-SEC SEC-2, REV-BEH BEH-3: a company's opt-out is a gate on its sources.
  MSG_INGEST_SOURCE_OPTED_OUT: message(
    'Source of an opted-out company',
    "This source's company asked TailorIT not to read its jobs, so it stays off. Take the company's opt-out off first (Admin › Companies).",
  ),
  // end v30 FIX-A
  // v30 FIX-C (W5 review SEC-5, DECISIONS P6.2): E1's live Wikidata lookups read two Wikimedia API addresses that
  // robots.txt does not cover for crawlers (the robots exemption list, core/http/robots-exemptions.ts). Their own
  // switch, off: setting BOT_USER_AGENT for the other new reads does not turn them on (the owner decides the exception).
  // Before CT's block, which constants-v30.test.ts keeps last.
  REFDATA_LIVE_LOOKUPS: {
    kind: 'bool', default: false, adminEditable: true, public: false, group: 'jobs',
    label: 'Live Wikidata lookups',
    help: "Whether company enrichment asks Wikidata's APIs about companies the monthly dumps have not seen (needs BOT_USER_AGENT). Off until the owner accepts the API's robots.txt exception.",
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
    help: 'The most announcements one USAJOBS search answers (its own cap): a source whose search has more is read in part. Set in .env only.',
  },
  JOBICY_READ_GAP_MINUTES: {
    kind: 'int', default: 60, adminEditable: false, public: true, group: 'jobs', min: 60, max: 1440,
    label: 'Gap between Jobicy reads (minutes)',
    help: "The least time between two reads of Jobicy's API by any Jobicy source (its terms ask for one an hour). Set in .env only.",
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
    "Every open USAJOBS announcement (up to {max} a source). It runs once BOT_USER_AGENT names TailorIT's bot page and mailbox and USAJOBS_API_KEY is set in .env.",
    ['max'],
  ),
  MSG_SOURCE_NOTE_JOBICY: message(
    'Add source: the Jobicy note',
    "Jobicy's newest remote jobs in one region, read at most {gap}. It runs once BOT_USER_AGENT names TailorIT's bot page and mailbox.",
    ['gap'],
  ),
  MSG_SOURCE_NOTE_HIMALAYAS: message('Add source: the Himalayas note', "Himalayas' remote jobs open to one country. It runs once BOT_USER_AGENT names TailorIT's bot page and mailbox and HIMALAYAS_API_KEY is set in .env."),
  MSG_SOURCE_NOTE_CAREER_SITE: message(
    'Add source: the career site note',
    "Its job pages are read through the polite site reader, robots.txt and the host's pace included. It runs once Read career pages is on in Admin › Constants and BOT_USER_AGENT names TailorIT's bot page and mailbox.",
  ),
  // end v30 FIX-WEB
  // v30 FIX-PG (PG-LOAD PGL-5, docs/design/part2/measurements.md §6): the Jobs page's filter lists (the facets summary:
  // which filters the data can answer, the categories and "Remote in" countries with their counts) read every shared
  // search row three times a request: 2-3 s at mix B. Kept once for everyone instead, with the viewer's own page jobs
  // added at each request (features/jobs/facet-counts.ts). Before CT's block, which constants-v30.test.ts keeps last.
  JOB_FACETS_REFRESH_MINUTES: {
    kind: 'int', default: 10, adminEditable: true, public: false, group: 'jobs', min: 0, max: 1440,
    label: 'Filter counts refresh (minutes)',
    help: "How old the Jobs page's filter counts over the shared jobs may get before they are counted again (in the background; meanwhile the kept counts are shown). 0 counts them at every request.",
  },
  JOB_FACETS_CACHE_MIN_JOBS: {
    kind: 'int', default: 20_000, adminEditable: true, public: false, group: 'jobs', min: 0, max: 100_000_000,
    label: 'Filter counts kept from (open jobs)',
    help: 'Below this many open shared jobs the filter counts are counted at every request (exact, and cheap at that size); from it on they are kept and counted again every refresh period.',
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
    help: 'Days the mark of a job a person viewed is kept. Hidden jobs stay hidden.',
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
    help: 'The longest wait between retries of a failing host. Set in .env only.',
  },
  INGEST_ANSWER_MAX_BYTES: {
    kind: 'int', default: 67_108_864, adminEditable: false, public: false, group: 'jobs', min: 1_048_576,
    max: 1_073_741_824,
    label: 'Largest listing (bytes)',
    help: 'The largest listing a source may answer with, in bytes (64 MB). Set in .env only.',
  },
  INGEST_LEASE_MINUTES: {
    kind: 'int', default: 30, adminEditable: false, public: false, group: 'jobs', min: 1, max: 1440,
    label: 'Run lease (minutes)',
    help: "How long a worker holds a source's run; a crashed worker's lease runs out. Set in .env only.",
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
    help: "Requests a day to each ATS host guessing a known company's board name. 0 keeps probes off (owner question 17).",
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
    help: "Whether the site reader reads companies' own websites. Off until the lawyer's view (owner question 8).",
  },
  SITE_READER_CAREER_PAGES: {
    kind: 'bool', default: false, adminEditable: true, public: false, group: 'jobs',
    label: 'Read career pages',
    help: "Whether the site reader reads employers' career pages and discovery finds career sites. Off until the lawyer's view (owner question 8).",
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
    help: 'Publish the jobs the extension first read from an ATS board once their company and duplicate checks pass.',
  },
  EXT_AUTO_APPROVE_NEW_PAGE: {
    kind: 'bool', default: false, adminEditable: true, public: false, group: 'jobs',
    label: 'Approve page jobs automatically',
    // v30 FIX-B (SEC-10, DECISIONS P6.8): job-reviews/auto.ts refuses it while SITE_READER_CAREER_PAGES is off.
    help: "Publish jobs made from employers' pages once enough trusted accounts captured the same text. Works only while Read career pages is on. Off until the lawyer's view (owner question 25).",
  },
  EXT_NEW_PAGE_JOBS_REVIEW: {
    kind: 'bool', default: true, adminEditable: true, public: false, group: 'jobs',
    label: 'Queue page jobs for review',
    help: "Queue the jobs people make from employers' own pages in Admin › Review, so an admin may publish them.",
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
    help: "Distinct trusted accounts with the same captured text a page job needs before automatic approval; at least 2, so no one person's page extras are published.",
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
    'You can report up to {max} closed {max|job|jobs} a day. You can report more after {reset_time}.',
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
    help: "How long the enrichment worker holds the companies it took; a stopped worker's companies are taken again after it. Set in .env only.",
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
    help: 'Companies with the most open jobs and no website or registry key whose one Wikidata match by name goes to Admin › Companies › Reviews at each monthly build. 0 opens none.',
  },
  // end v30 E1
  // v30 INT-4: wave 4's limits that its handoffs kept beside their code, moved here (the owner's one-source rule; E2's
  // open item 7, and S5's run budgets beside S3's WORKDAY_SITE_* ones). The .env-only ones are design rules an admin
  // should not change at run time.
  SITE_READER_MAX_REDIRECTS: {
    kind: 'int', default: 3, adminEditable: false, public: false, group: 'jobs', min: 0, max: 3,
    label: 'Site reader redirects',
    help: "Redirects one site read follows at most, each on the first address's registrable domain (13 §4 rule 3). Set in .env only.",
  },
  SITE_READER_TURN_WAIT_GAPS: {
    kind: 'int', default: 3, adminEditable: false, public: false, group: 'jobs', min: 1, max: 20,
    label: 'Site reader wait (host gaps)',
    help: "How many of a host's gaps a site read waits for its turn; a later turn holds the read for later. Set in .env only.",
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
    help: 'A picture smaller than this on its shorter side (a wordmark: its longer side) is no logo (13 §6.1). Set in .env only.',
  },
  COMPANY_LOGO_SMALL_PX: {
    kind: 'int', default: 64, adminEditable: false, public: false, group: 'jobs', min: 16, max: 256,
    label: 'Small logo size (px)',
    help: "The smaller of the two sizes a company's logo is stored at (13 §10). Set in .env only.",
  },
  COMPANY_LOGO_LARGE_PX: {
    kind: 'int', default: 128, adminEditable: false, public: false, group: 'jobs', min: 32, max: 512,
    label: 'Large logo size (px)',
    help: "The larger of the two sizes a company's logo is stored at; the profile shows it when the source is that large. Set in .env only.",
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
