import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { AI_FEATURE_ENV, AI_TASK_KINDS, constantDefault, readConstantsEnv, type AiTaskKind, type ConstantKey } from '@tailorit/shared';
import { AUTOFILL_AI_WAIT_MS } from '@tailorit/shared/autofill';
import { repoRoot } from '../core/paths';
import { defaultMcpEndpoint, mcpAllowedHosts, parseAppOrigin, parseHost, parseMcpPublicUrl } from './addresses';
// v1.3 C (decision 9): the per-kind default models, and AI_CLI_THINKING's modes.
import { aiFeatureModel, CLI_THINKING_MODES, type CliThinking } from './models';
// end v1.3 C
// v30 SCH: the database's keys (PG-0 read them from process.env; moved here) and the new outside reads' identity and keys.
import { DEFAULT_PG_POOL_MAX } from '../core/db/pg/client';
import { DEFAULT_PG_PORT } from '../core/db/pg/embedded';
import { isPostgresUrl, readBotUserAgent, readServiceKey } from './outside';
// end v30 SCH

// Reads the repository's single root `.env` (also decoded by scripts/env.mjs — change the two together: PowerShell
// 5.1 writes UTF-16, which must not be read as UTF-8) and turns process.env into a typed AppConfig.

function readEnvText(filePath: string): string {
  const buffer = readFileSync(filePath);
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return Buffer.from(buffer.subarray(2)).swap16().toString('utf16le');
  }
  return buffer.toString('utf8').replace(/^\uFEFF/, '');
}

export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    let value = match[2]!;
    if (value.startsWith('"')) {
      const end = value.lastIndexOf('"');
      value = (end > 0 ? value.slice(1, end) : value.slice(1)).replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else if (value.startsWith("'")) {
      const end = value.lastIndexOf("'");
      value = end > 0 ? value.slice(1, end) : value.slice(1);
    } else {
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash);
      value = value.trim();
    }
    out[key] = value;
  }
  return out;
}

/** Applies the root `.env` to process.env; variables already set win. Safe to call more than once. */
export function loadRootEnv(): void {
  const file = join(repoRoot(), '.env');
  if (!existsSync(file)) return;
  for (const [key, value] of Object.entries(parseEnvText(readEnvText(file)))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? fallback : /^(1|true|yes|on)$/i.test(v.trim())));
const int = (fallback: number, min = 0) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return fallback;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min) {
        ctx.addIssue({ code: 'custom', message: `must be an integer >= ${min}` });
        return z.NEVER;
      }
      return n;
    });
/** A TCP port: an integer from 1 to 65535. */
const port = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return fallback;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 65_535) {
        ctx.addIssue({ code: 'custom', message: 'must be a port number, from 1 to 65535' });
        return z.NEVER;
      }
      return n;
    });
const optional = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? null : v.trim()));
const list = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(/[\s,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );

// ── Addresses (config/addresses.ts holds the rules) ──
/** APP_ORIGIN: the address people open, an http(s) origin; unset or blank, http://localhost:3100. */
const appOrigin = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v.trim() === '') return 'http://localhost:3100';
    const parsed = parseAppOrigin(v);
    if ('error' in parsed) {
      ctx.addIssue({ code: 'custom', message: `"${v.trim()}" ${parsed.error}` });
      return z.NEVER;
    }
    return parsed.origin;
  });

/** API_HOST: where the API listens, an IP address or a host name; unset or blank, 127.0.0.1 (this computer only). */
const apiHost = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v.trim() === '') return '127.0.0.1';
    const host = parseHost(v);
    if (host === null) {
      ctx.addIssue({
        code: 'custom',
        message: `"${v.trim()}" is not an address: write an IP address or a host name, with no http:// and no port`,
      });
      return z.NEVER;
    }
    return host;
  });

/** MCP_PUBLIC_URL: the MCP endpoint's address as clients reach it; unset or blank, from API_HOST and API_PORT. */
const mcpPublicUrl = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v.trim() === '') return null;
    const parsed = parseMcpPublicUrl(v);
    if ('error' in parsed) {
      ctx.addIssue({ code: 'custom', message: `"${v.trim()}" ${parsed.error}` });
      return z.NEVER;
    }
    return parsed.url;
  });

/** MCP_ALLOWED_HOSTS: more names /mcp answers to, comma or space separated (IP addresses or host names, no port). */
const hostList = z
  .string()
  .optional()
  .transform((v, ctx) => {
    const hosts: string[] = [];
    for (const item of list.parse(v)) {
      const host = parseHost(item);
      if (host === null) {
        ctx.addIssue({
          code: 'custom',
          message: `"${item}" is not a host name: write IP addresses or host names, with no http:// and no port`,
        });
        return z.NEVER;
      }
      if (!hosts.includes(host)) hosts.push(host);
    }
    return hosts;
  });
// ── end Addresses ──

// ── v30 SCH: the database and the new outside reads (docs/design/part2/00-overview.md §4; config/outside.ts) ──
/** DATABASE_URL: a PostgreSQL 18 server; unset or blank, the embedded cluster. A bad value is never repeated (a password). */
const databaseUrl = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v.trim() === '') return null;
    if (!isPostgresUrl(v.trim())) {
      ctx.addIssue({ code: 'custom', message: 'is not a PostgreSQL address: write postgres://user:password@host:5432/database' });
      return z.NEVER;
    }
    return v.trim();
  });

/** BOT_USER_AGENT: config/outside.ts's rule; unset, blank or the placeholder keeps every new outside read off. */
const botUserAgent = z
  .string()
  .optional()
  .transform((v, ctx) => {
    const read = readBotUserAgent(v);
    if ('error' in read) {
      ctx.addIssue({ code: 'custom', message: read.error });
      return z.NEVER;
    }
    return read;
  });

/** USAJOBS_API_KEY, HIMALAYAS_API_KEY, LOGO_DEV_KEY: unset or blank keeps the source or step off. */
const serviceKey = z
  .string()
  .optional()
  .transform((v, ctx) => {
    const read = readServiceKey(v);
    if ('error' in read) {
      ctx.addIssue({ code: 'custom', message: read.error });
      return z.NEVER;
    }
    return read.key;
  });
// ── end v30 SCH ──

/** The TailorIT Autofill extension's id: its manifest `key` fixes it for every local build, on every machine. */
export const AUTOFILL_EXTENSION_ID = 'flmloalhjldmcihejnmkndbcnhaacmng';

/**
 * AUTOFILL_EXTENSION_IDS: the extensions Settings › Autofill hands a connect code to, comma or space separated. Unset
 * means the TailorIT Autofill extension's own id; set but empty means none (the page shows the code to type in).
 */
const extensionIds = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (v === undefined) return [AUTOFILL_EXTENSION_ID];
    const ids = [...new Set(list.parse(v))];
    const bad = ids.find((id) => !/^[a-p]{32}$/.test(id));
    if (bad !== undefined) {
      ctx.addIssue({ code: 'custom', message: `"${bad}" is not an extension id (32 letters from a to p)` });
      return z.NEVER;
    }
    return ids;
  });

/** The longest AUTOFILL_AI_WAIT_MS: the extension gives up on any request at 25 s. */
const AUTOFILL_AI_WAIT_MAX_MS = 20_000;

/**
 * AUTOFILL_AI_WAIT_MS: how long POST /api/autofill/ai/pick and /ai/classify wait for their task before answering
 * 202 {taskId}. Unset: the contract's AUTOFILL_AI_WAIT_MS (10 s); tests shorten it.
 */
const aiWaitMs = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v.trim() === '') return AUTOFILL_AI_WAIT_MS;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > AUTOFILL_AI_WAIT_MAX_MS) {
      ctx.addIssue({ code: 'custom', message: `must be an integer from 0 to ${AUTOFILL_AI_WAIT_MAX_MS}` });
      return z.NEVER;
    }
    return n;
  });

function defaultDataDir(): string {
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'TailorIT');
  }
  return join(homedir(), '.local', 'share', 'tailorit');
}

/**
 * When Claude refines job analyses (AI_JOB_ANALYSIS): `ingest` (the default) = every added job, once, newest first,
 * through a background backlog; `saved` = only jobs someone saved; `lazy` = the first time a job is opened; `off` =
 * never (rules only). Only `lazy` lets opening a job queue anything.
 */
export const JOB_ANALYSIS_MODES = ['ingest', 'saved', 'lazy', 'off'] as const;
export type JobAnalysisMode = (typeof JOB_ANALYSIS_MODES)[number];
/** Whether Claude reads each uploaded resume after its quick rule-based reading (AI_RESUME_ANALYSIS). */
export const RESUME_ANALYSIS_MODES = ['auto', 'off'] as const;
export type ResumeAnalysisMode = (typeof RESUME_ANALYSIS_MODES)[number];

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).optional().default('development'),
  APP_ORIGIN: appOrigin,
  API_HOST: apiHost,
  API_PORT: port(4100),
  MCP_PUBLIC_URL: mcpPublicUrl,
  MCP_ALLOWED_HOSTS: hostList,
  DATA_DIR: optional,
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).optional().default('info'),

  SESSION_TTL_DAYS: int(30, 1),
  ADMIN_EMAILS: list,
  CONTACT_EMAIL: optional,
  GOOGLE_CLIENT_ID: optional,
  SMTP_HOST: optional,
  SMTP_PORT: int(465, 1),
  SMTP_SECURE: optional,
  SMTP_USER: optional,
  SMTP_PASS: optional,
  SMTP_FROM: optional,
  AUTH_DEV_LOG_CODES: bool(true),
  AUTH_DEV_FIXED_CODE: optional,

  AI_ENABLED: bool(true),
  AI_CLI_BIN: z.string().optional().default('claude'),
  AI_CLI_MODEL: z.string().optional().default('claude-sonnet-5-5'),
  AI_CLI_EFFORT: z.string().optional().default('low'),
  AI_CLI_FALLBACK_MODEL: optional,
  AI_CLI_CONCURRENCY: int(4, 1),
  AI_CLI_BACKGROUND_SLOTS: int(1, 0),
  // v5 (the autofill's two tasks at once): the CLI processes one account may run at once; its other tasks wait. Unset
  // or 0 (the review's M2): AI_CLI_CONCURRENCY, so a server of one person keeps every slot.
  AI_CLI_PER_ACCOUNT: int(0, 0),
  AI_CLI_TIMEOUT_MS: int(300_000, 1000),
  AI_CLI_FIRST_EVENT_MS: int(30_000, 1000),
  // v1.3 C (decision 9): `on` (the default) leaves thinking to the CLI, as before; `off` turns it off for every call.
  AI_CLI_THINKING: z.enum(CLI_THINKING_MODES).optional().default('on'),
  // end v1.3 C
  AI_JOB_ANALYSIS: z.enum(JOB_ANALYSIS_MODES).optional().default('ingest'),
  AI_JOB_ANALYSIS_WARMUP_PER_HOUR: int(0, 0),
  AI_JOB_ANALYSIS_PER_HOUR: int(0, 0),
  AI_RESUME_ANALYSIS: z.enum(RESUME_ANALYSIS_MODES).optional().default('auto'),
  AI_RESUME_ANALYSIS_PER_HOUR: int(20, 0),

  CHROME_PATH: optional,
  PDF_RENDER_TIMEOUT_MS: int(30_000, 1000),
  PDF_MAX_CONCURRENCY: int(2, 1),
  // v30 ST4: the default is the central constant's (UPLOAD_MAX_MB: .env only, read at start), one source with the web.
  UPLOAD_MAX_MB: int(constantDefault('UPLOAD_MAX_MB'), 1),

  // v30 S1-API: the ingest worker's due queue (features/ingest/scheduler.ts) replaces the daily run, so INGEST_DAILY_AT
  // and INGEST_TIMEZONE are gone (12-job-sourcing.md §13); a value left in .env is ignored.
  INGEST_ENABLED: bool(true),
  INGEST_HTTP_TIMEOUT_MS: int(30_000, 1000),
  INGEST_USER_AGENT: z.string().optional().default('TailorIT job ingest'),
  FT_LAKE_DB_PATH: optional,
  FT_LAKE_MAX_AGE_DAYS: int(45, 1),
  GOOGLE_SERVICE_ACCOUNT_KEY_FILE: optional,

  AUTOFILL_EXTENSION_IDS: extensionIds,
  AUTOFILL_TOKEN_TTL_DAYS: int(90, 1),
  AUTOFILL_AI_WAIT_MS: aiWaitMs,

  // v30 ST4: the demo data's switch is the dev-only seam's, never read here: the production export has none.

  // v30 SCH: the database (PostgreSQL 18; core/db/engine.ts, core/db/pg/embedded.ts).
  DATABASE_URL: databaseUrl,
  PG_PORT: port(DEFAULT_PG_PORT),
  PG_DATA_DIR: optional,
  PG_POOL_MAX: int(DEFAULT_PG_POOL_MAX, 1),
  // v30 SCH: the new outside reads' identity and keys (DECISIONS P1: each stays off until the owner supplies it).
  BOT_USER_AGENT: botUserAgent,
  USAJOBS_API_KEY: serviceKey,
  HIMALAYAS_API_KEY: serviceKey,
  LOGO_DEV_KEY: serviceKey,
  // end v30 SCH
});

export type AiFeatureModels = Record<AiTaskKind, { model: string; effort: string }>;

export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test';
  isProduction: boolean;
  /** APP_ORIGIN: the address people open, as browsers send it in their Origin header. */
  appOrigin: string;
  /** API_HOST: where the API listens (an IPv6 address unbracketed); config/addresses.ts apiBindHost maps localhost. */
  apiHost: string;
  apiPort: number;
  /** The MCP endpoint (features/mcp). */
  mcp: {
    /** What Settings shows in the setup snippets: MCP_PUBLIC_URL, else APP_ORIGIN/mcp (v31 OAUTH). */
    endpoint: string;
    /** The names its Host and Origin checks accept: loopback, API_HOST, the endpoint's host and MCP_ALLOWED_HOSTS. */
    allowedHosts: string[];
  };
  dataDir: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  auth: {
    sessionTtlDays: number;
    adminEmails: string[];
    contactEmail: string | null;
    googleClientId: string | null;
    smtp: { host: string; port: number; secure: boolean; user: string; pass: string; from: string } | null;
    /** Print codes to the console when SMTP is missing. Always false in production. */
    devLogCodes: boolean;
    /** Accept this code for any address. Always null in production. */
    devFixedCode: string | null;
  };
  ai: {
    enabled: boolean;
    cliBin: string;
    model: string;
    effort: string;
    fallbackModel: string | null;
    concurrency: number;
    backgroundSlots: number;
    /** v5: the interactive CLI processes one account may run at once (AI_CLI_PER_ACCOUNT, by default
     *  AI_CLI_CONCURRENCY); its other tasks wait their turn. Background work is held to AI_CLI_BACKGROUND_SLOTS alone. */
    perAccount: number;
    timeoutMs: number;
    firstEventMs: number;
    // v1.3 C
    /** AI_CLI_THINKING: `on` (the default) passes nothing; `off`, the CLI's thinking-off setting (ai/provider/argv.ts). */
    thinking: CliThinking;
    // end v1.3 C
    features: AiFeatureModels;
    jobAnalysis: JobAnalysisMode;
    warmupPerHour: number;
    /** Background job analyses started per hour; 0 = no cap. */
    jobAnalysisPerHour: number;
    resumeAnalysis: ResumeAnalysisMode;
    /** Background resume readings started per hour; 0 = no cap. */
    resumeAnalysisPerHour: number;
  };
  render: { chromePath: string | null; pdfTimeoutMs: number; pdfMaxConcurrency: number };
  uploadMaxMb: number;
  ingest: {
    /** The ingest worker reads due sources (false: only an admin's Run now reads one). */
    enabled: boolean;
    httpTimeoutMs: number;
    userAgent: string;
    ftLakeDbPath: string;
    ftLakeMaxAgeDays: number;
    /** The Google service account's JSON key for the Sheet import (read when needed; it may not exist). */
    googleServiceAccountKeyFile: string;
  };
  /** The TailorIT Autofill extension (features/autofill). */
  autofill: {
    /** The extensions the Settings page offers a connect code to; empty: it only shows the code. */
    extensionIds: string[];
    /** A token's fixed lifetime, from the moment the extension connected. */
    tokenTtlDays: number;
    /** How long an autofill AI route waits for its task before it answers 202 {taskId} (AUTOFILL_AI_WAIT_MS). */
    aiWaitMs: number;
  };
  // v2.0 (02-constants.md)
  /**
   * The central constants .env sets, each parsed and checked by its kind (readConstantsEnv): the .env layer of the
   * constants service (core/constants), which resolves DB override > .env > default. Unset keys are absent.
   */
  constants: Partial<Record<ConstantKey, unknown>>;
  /** The .env key each of `constants` was read from: its own, or an older alias (PREBUILD_PER_HOUR). */
  constantsEnvKeys: Partial<Record<ConstantKey, string>>;
  // end v2.0
  // v30 SCH
  /** The database (core/db/engine.ts): a server by DATABASE_URL, else the embedded cluster (core/db/pg/embedded.ts). */
  database: {
    /** DATABASE_URL: a PostgreSQL 18 server's address; null: the embedded cluster below. Never logged (a password). */
    url: string | null;
    /** PG_PORT: the embedded cluster's loopback port (5442, DEFAULT_PG_PORT). */
    pgPort: number;
    /** PG_DATA_DIR, else `<DATA_DIR>/pg`: the embedded cluster's data folder (its password beside it, `<folder>.password`). */
    pgDataDir: string;
    /** PG_POOL_MAX: the connections one process's pool opens at most (10, DEFAULT_PG_POOL_MAX). */
    poolMax: number;
  };
  /**
   * The new outside reads (docs/design/part2/00-overview.md §4; DECISIONS P1). Every NEW kind of outside read calls
   * core/http/identity.ts's assertNewReadAllowed, which refuses while `botUserAgentIsPlaceholder`.
   */
  outside: {
    /** BOT_USER_AGENT: the new reads' User-Agent (config/outside.ts BOT_USER_AGENT_PLACEHOLDER until the owner sets it). */
    botUserAgent: string;
    /** BOT_USER_AGENT is unset or still a placeholder: every new kind of outside read refuses. */
    botUserAgentIsPlaceholder: boolean;
    /** USAJOBS_API_KEY: the USAJOBS source (S4) stays off while null. */
    usajobsApiKey: string | null;
    /** HIMALAYAS_API_KEY: the Himalayas source (S4) stays off while null. */
    himalayasApiKey: string | null;
    /** LOGO_DEV_KEY: logo.dev (E2) stays off while null. */
    logoDevKey: string | null;
  };
  // end v30 SCH
}

/** Pure: builds the config from an environment map (tests pass their own). Throws a readable error on bad values. */
export function buildConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  // v2.0: the central constants' keys are read and checked with the rest; a value that does not parse refuses startup.
  const constants = readConstantsEnv(env);
  const lines = [
    ...(parsed.success ? [] : parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)),
    ...constants.errors.map((error) => `  ${error.envKey}: ${error.message}`),
  ];
  if (!parsed.success || lines.length > 0) {
    throw new Error(`Invalid configuration in .env:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production';
  const smtp =
    e.SMTP_HOST && e.SMTP_USER && e.SMTP_PASS
      ? {
          host: e.SMTP_HOST,
          port: e.SMTP_PORT,
          secure: e.SMTP_SECURE === null ? e.SMTP_PORT === 465 : /^(1|true|yes|on)$/i.test(e.SMTP_SECURE),
          user: e.SMTP_USER,
          pass: e.SMTP_PASS,
          from: e.SMTP_FROM ?? e.SMTP_USER,
        }
      : null;
  const fixed = e.AUTH_DEV_FIXED_CODE && /^\d{6}$/.test(e.AUTH_DEV_FIXED_CODE) ? e.AUTH_DEV_FIXED_CODE : null;
  const mcpEndpoint = e.MCP_PUBLIC_URL ?? defaultMcpEndpoint(e.APP_ORIGIN); // v31 OAUTH: APP_ORIGIN/mcp

  const features = Object.fromEntries(
    AI_TASK_KINDS.map((kind) => {
      const name = AI_FEATURE_ENV[kind];
      // v1.3 C (decision 9): AI_MODEL_<KIND>, else the kind's default (config/models.ts), else AI_CLI_MODEL.
      const model = aiFeatureModel(kind, env[`AI_MODEL_${name}`], e.AI_CLI_MODEL);
      const effort = (env[`AI_EFFORT_${name}`] ?? '').trim() || e.AI_CLI_EFFORT;
      return [kind, { model, effort }];
    }),
  ) as AiFeatureModels;

  return {
    nodeEnv: e.NODE_ENV,
    isProduction,
    appOrigin: e.APP_ORIGIN,
    apiHost: e.API_HOST,
    apiPort: e.API_PORT,
    mcp: { endpoint: mcpEndpoint, allowedHosts: mcpAllowedHosts(e.API_HOST, mcpEndpoint, e.MCP_ALLOWED_HOSTS) },
    dataDir: e.DATA_DIR ?? defaultDataDir(),
    logLevel: e.LOG_LEVEL,
    auth: {
      sessionTtlDays: e.SESSION_TTL_DAYS,
      adminEmails: e.ADMIN_EMAILS,
      contactEmail: e.CONTACT_EMAIL,
      googleClientId: e.GOOGLE_CLIENT_ID,
      smtp,
      devLogCodes: !isProduction && e.AUTH_DEV_LOG_CODES,
      devFixedCode: isProduction ? null : fixed,
    },
    ai: {
      enabled: e.AI_ENABLED,
      cliBin: e.AI_CLI_BIN,
      model: e.AI_CLI_MODEL,
      effort: e.AI_CLI_EFFORT,
      fallbackModel: e.AI_CLI_FALLBACK_MODEL,
      concurrency: e.AI_CLI_CONCURRENCY,
      backgroundSlots: e.AI_CLI_BACKGROUND_SLOTS,
      perAccount: e.AI_CLI_PER_ACCOUNT > 0 ? e.AI_CLI_PER_ACCOUNT : e.AI_CLI_CONCURRENCY,
      timeoutMs: e.AI_CLI_TIMEOUT_MS,
      firstEventMs: e.AI_CLI_FIRST_EVENT_MS,
      thinking: e.AI_CLI_THINKING, // v1.3 C
      features,
      jobAnalysis: e.AI_JOB_ANALYSIS,
      warmupPerHour: e.AI_JOB_ANALYSIS_WARMUP_PER_HOUR,
      jobAnalysisPerHour: e.AI_JOB_ANALYSIS_PER_HOUR,
      resumeAnalysis: e.AI_RESUME_ANALYSIS,
      resumeAnalysisPerHour: e.AI_RESUME_ANALYSIS_PER_HOUR,
    },
    render: {
      chromePath: e.CHROME_PATH,
      pdfTimeoutMs: e.PDF_RENDER_TIMEOUT_MS,
      pdfMaxConcurrency: e.PDF_MAX_CONCURRENCY,
    },
    uploadMaxMb: e.UPLOAD_MAX_MB,
    ingest: {
      enabled: e.INGEST_ENABLED,
      httpTimeoutMs: e.INGEST_HTTP_TIMEOUT_MS,
      userAgent: e.INGEST_USER_AGENT,
      // v30 FIX-B (REV-REQ REQ-14): no default. The lake is another project's database on the developer's machine, so an
      // install names it (FT_LAKE_DB_PATH, or the lake source's own path); blank reads none ("There is no free_tailor
      // database").
      ftLakeDbPath: e.FT_LAKE_DB_PATH ?? '',
      ftLakeMaxAgeDays: e.FT_LAKE_MAX_AGE_DAYS,
      // A relative path is read from the repository root, where .env lives.
      googleServiceAccountKeyFile: e.GOOGLE_SERVICE_ACCOUNT_KEY_FILE
        ? resolve(repoRoot(), e.GOOGLE_SERVICE_ACCOUNT_KEY_FILE)
        : join(repoRoot(), 'service-account-key.json'),
    },
    autofill: {
      extensionIds: e.AUTOFILL_EXTENSION_IDS,
      tokenTtlDays: e.AUTOFILL_TOKEN_TTL_DAYS,
      aiWaitMs: e.AUTOFILL_AI_WAIT_MS,
    },
    constants: constants.values,
    constantsEnvKeys: constants.readFrom,
    // v30 SCH
    database: {
      url: e.DATABASE_URL,
      pgPort: e.PG_PORT,
      pgDataDir: e.PG_DATA_DIR ?? join(e.DATA_DIR ?? defaultDataDir(), 'pg'),
      poolMax: e.PG_POOL_MAX,
    },
    outside: {
      botUserAgent: e.BOT_USER_AGENT.userAgent,
      botUserAgentIsPlaceholder: e.BOT_USER_AGENT.placeholder,
      usajobsApiKey: e.USAJOBS_API_KEY,
      himalayasApiKey: e.HIMALAYAS_API_KEY,
      logoDevKey: e.LOGO_DEV_KEY,
    },
    // end v30 SCH
  };
}

let cached: AppConfig | null = null;

/** The process-wide config: loads the root `.env` once, then parses process.env. */
export function getConfig(): AppConfig {
  if (!cached) {
    loadRootEnv();
    cached = buildConfig(process.env);
  }
  return cached;
}
