import type { z } from 'zod';
import {
  CONSTANT_KEYS,
  constantSpec,
  envKeysOf,
  isConstantKey,
  UNLIMITED,
  type AiPrices,
  type ConstantKey,
  type ConstantValue,
} from './constants';
import { durationText, formatTimeOfDay } from './day';
import { placeholdersOf } from './render';
import { KIND_SCHEMAS, MICROS_PER_USD, USD_MICROS_MAX } from './schemas';

// Per kind: the zod schema of a value, the .env parser and the formatter (02-constants.md, "The module"). One check,
// validateConstant, is used in three places: on .env at startup, on an admin write, and on each stored override as it
// is read (one that no longer validates is ignored and falls back to .env or the default).
// v20 FIX-A (SEC-5): the kinds' zod schemas live in ./schemas, which reads no constant, so the web's public constants
// module (./public) builds its schema without the whole table; they are exported from here as before.
export { AiPricesSchema, KIND_SCHEMAS, MICROS_PER_USD, USD_MICROS_MAX } from './schemas';

/** A message's longest text when its spec names none. */
const MESSAGE_FALLBACK_MAX = 400;

export type ConstantCheck<T> = { ok: true; value: T } | { ok: false; error: string };

const between = (min: number | undefined, max: number | undefined) =>
  min !== undefined && max !== undefined ? ` from ${min} to ${max}` : min !== undefined ? ` of ${min} or more` : '';

/** What a valid value of `key` looks like, in words: the message of every refusal. */
export function expectedOf(key: ConstantKey): string {
  const spec = constantSpec(key);
  switch (spec.kind) {
    case 'int':
      return `Use a whole number${between(spec.min, spec.max)}.`;
    case 'limit':
      return `Use a whole number${between(spec.min ?? 0, spec.max)}, or Unlimited.`;
    case 'usd':
      return 'Use a dollar amount of 0 or more, such as 0.10 (at most 6 decimal places).';
    case 'usd_limit':
      return 'Use a dollar amount of 0 or more, such as 0.10 (at most 6 decimal places), or Unlimited.';
    case 'ratio':
      return 'Use a number above 0 and at most 1, such as 0.98.';
    case 'bool':
      return 'Use true or false.';
    case 'time_of_day':
      return 'Use a time as HH:MM on the 24-hour clock, such as 00:00.';
    case 'time_zone':
      return 'Use a time zone name such as America/Los_Angeles.';
    case 'duration':
      return 'Use a calendar length such as P1M (1 month), P1W (1 week), P30D (30 days) or P1Y (1 year).';
    case 'date':
      return 'Use a date as YYYY-MM-DD.';
    case 'email':
      return 'Enter an email address, or nothing for none.';
    case 'text':
      return spec.choices
        ? `Use one of: ${spec.choices.join(', ')}.`
        : `Use at most ${spec.maxLength ?? 'any number of'} characters.`;
    case 'message': {
      const allowed = spec.placeholders ?? [];
      const names = allowed.length ? `It may use ${allowed.map((name) => `{${name}}`).join(', ')}.` : 'It takes no placeholders.';
      return `Write the message, at most ${spec.maxLength ?? MESSAGE_FALLBACK_MAX} characters. ${names}`;
    }
    case 'prices':
      return 'Give prices in USD per million tokens (input, output, cacheRead, cacheWrite) for each model and for "*".';
  }
}

/**
 * Checks `value` as a value of `key`: its kind's schema, then the constant's own bounds (min/max, maxLength, choices),
 * a time zone Intl accepts, a calendar-only duration, and for a message, that it is not empty and that every
 * {placeholder} in it is one the constant allows. Answers the value, or the refusal in words.
 */
export function validateConstant<K extends ConstantKey>(key: K, value: unknown): ConstantCheck<ConstantValue<K>> {
  if (!isConstantKey(key)) return { ok: false, error: `There is no constant ${String(key)}.` };
  const spec = constantSpec(key);
  const refuse = (error = expectedOf(key)): ConstantCheck<ConstantValue<K>> => ({ ok: false, error });
  const parsed = (KIND_SCHEMAS[spec.kind] as z.ZodType<unknown>).safeParse(value);
  if (!parsed.success) return refuse();
  const checked = parsed.data;
  if (typeof checked === 'number' && (spec.kind === 'int' || spec.kind === 'limit')) {
    if (spec.min !== undefined && checked < spec.min) return refuse();
    if (spec.max !== undefined && checked > spec.max) return refuse();
  }
  if (typeof checked === 'string' && (spec.kind === 'text' || spec.kind === 'message')) {
    const max = spec.maxLength ?? (spec.kind === 'message' ? MESSAGE_FALLBACK_MAX : undefined);
    if (max !== undefined && checked.length > max) return refuse();
    if (spec.kind === 'text' && spec.choices && !spec.choices.includes(checked)) return refuse();
    if (spec.kind === 'message') {
      const allowed = spec.placeholders ?? [];
      const unknown = placeholdersOf(checked).filter((name) => !allowed.includes(name));
      if (unknown.length > 0) {
        return refuse(`${unknown.map((name) => `{${name}}`).join(', ')} cannot be used here. ${expectedOf(key)}`);
      }
    }
  }
  return { ok: true, value: checked as ConstantValue<K> };
}

// Money ---------------------------------------------------------------------------------------------------------------

const USD_TEXT = /^(\d{1,10})(?:\.(\d{1,6}))?$/;

/**
 * "0.10" → 100000 micro-dollars, read exactly as a string (never through a float). A leading "$" and spaces are
 * allowed; with `signed`, a leading "-" too (a credit adjustment). Null when it is not such an amount.
 */
export function usdToMicros(text: string, options: { signed?: boolean } = {}): number | null {
  let rest = text.trim();
  let sign = 1;
  if (options.signed && rest.startsWith('-')) {
    sign = -1;
    rest = rest.slice(1).trim();
  }
  if (rest.startsWith('$')) rest = rest.slice(1).trim();
  const match = USD_TEXT.exec(rest);
  if (!match) return null;
  const micros = Number(match[1]) * MICROS_PER_USD + Number((match[2] ?? '').padEnd(6, '0'));
  if (micros > USD_MICROS_MAX) return null;
  return sign * micros || 0;
}

/** 100000 → "0.10"; at least two decimals, up to six when needed ("0.000001"). Negative amounts keep their "-". */
export function microsToUsdText(micros: number): string {
  const sign = micros < 0 ? '-' : '';
  const whole = Math.abs(Math.trunc(micros));
  const dollars = Math.floor(whole / MICROS_PER_USD);
  const fraction = String(whole % MICROS_PER_USD).padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${sign}${dollars}.${fraction}`;
}

/** 100000 → "$0.10"; UNLIMITED → "Unlimited". */
export function formatUsd(micros: number | null): string {
  if (micros === UNLIMITED) return 'Unlimited';
  const text = microsToUsdText(micros);
  return text.startsWith('-') ? `-$${text.slice(1)}` : `$${text}`;
}

// .env ----------------------------------------------------------------------------------------------------------------

const isUnlimitedWord = (text: string) => text.trim().toLowerCase() === 'unlimited';

/** What a .env value of `key` must look like, in words (the startup refusal names the key and this). */
export function envFormOf(key: ConstantKey): string {
  const spec = constantSpec(key);
  switch (spec.kind) {
    case 'int':
      return `a whole number${between(spec.min, spec.max)}`;
    case 'limit':
      return `a whole number${between(spec.min ?? 0, spec.max)}, or unlimited`;
    case 'usd':
      return 'a dollar amount such as 0.10 (at most 6 decimal places)';
    case 'usd_limit':
      return 'a dollar amount such as 0.10 (at most 6 decimal places), or unlimited';
    case 'ratio':
      return 'a number above 0 and at most 1, such as 0.98';
    case 'bool':
      return 'true, false, 1 or 0';
    case 'prices':
      return 'JSON: {"<model>": {"input", "output", "cacheRead", "cacheWrite"}, ..., "*": {...}} in USD per million tokens';
    case 'message':
      return `${expectedOf(key)} Write a line break as \\n`;
    default:
      return expectedOf(key).replace(/^Use /, '').replace(/\.$/, '');
  }
}

/**
 * One .env value of `key`, parsed: `unlimited` (any case) for a limit, a decimal for a usd amount, true/false/1/0, JSON
 * for prices, `\n` for a line break in a message. Null when the value is empty (an empty value counts as unset).
 */
export function parseConstantEnv<K extends ConstantKey>(key: K, raw: string): ConstantCheck<ConstantValue<K>> | null {
  const spec = constantSpec(key);
  const text = raw.trim();
  if (text === '') return null;
  const refuse = (): ConstantCheck<ConstantValue<K>> => ({ ok: false, error: `Use ${envFormOf(key)}` });
  let value: unknown;
  switch (spec.kind) {
    case 'int':
      if (!/^-?\d+$/.test(text)) return refuse();
      value = Number(text);
      break;
    case 'limit':
      if (isUnlimitedWord(text)) value = UNLIMITED;
      else if (/^\d+$/.test(text)) value = Number(text);
      else return refuse();
      break;
    case 'usd':
    case 'usd_limit':
      if (spec.kind === 'usd_limit' && isUnlimitedWord(text)) value = UNLIMITED;
      else {
        value = usdToMicros(text);
        if (value === null) return refuse();
      }
      break;
    case 'ratio':
      if (!/^(\d+(\.\d*)?|\.\d+)$/.test(text)) return refuse();
      value = Number(text);
      break;
    case 'bool': {
      const word = text.toLowerCase();
      if (word === 'true' || word === '1') value = true;
      else if (word === 'false' || word === '0') value = false;
      else return refuse();
      break;
    }
    case 'prices':
      try {
        value = JSON.parse(text);
      } catch {
        return refuse();
      }
      break;
    case 'message':
      // The text as it is (not trimmed), with "\n" written for a line break.
      value = raw.replace(/\\n/g, '\n');
      break;
    default:
      value = text;
  }
  const checked = validateConstant(key, value);
  return checked.ok ? checked : { ok: false, error: `Use ${envFormOf(key)}` };
}

export interface ConstantsFromEnv {
  /** The parsed value of every constant .env sets (the `config.constants` of the API's buildConfig). */
  values: Partial<Record<ConstantKey, unknown>>;
  /** The .env key each value was read from: the constant's own, or an alias (PREBUILD_PER_HOUR). */
  readFrom: Partial<Record<ConstantKey, string>>;
  /** One per bad value: the .env key and what it must look like. Startup is refused while any is left. */
  errors: { envKey: string; message: string }[];
}

/**
 * Reads every constant from an environment map (pure: the API passes process.env, tests their own). For each
 * constant, its own key (or `env`) is read, else its aliases in order; an empty value counts as unset.
 */
export function readConstantsEnv(env: Readonly<Record<string, string | undefined>>): ConstantsFromEnv {
  const result: ConstantsFromEnv = { values: {}, readFrom: {}, errors: [] };
  for (const key of CONSTANT_KEYS) {
    for (const envKey of envKeysOf(key)) {
      const raw = env[envKey];
      if (raw === undefined) continue;
      const parsed = parseConstantEnv(key, raw);
      if (parsed === null) continue;
      if (parsed.ok) {
        result.values[key] = parsed.value;
        result.readFrom[key] = envKey;
      } else {
        result.errors.push({ envKey, message: parsed.error });
      }
      break;
    }
  }
  return result;
}

// Formatting ----------------------------------------------------------------------------------------------------------

/** A value as Admin › Constants shows it: "$0.10", "Unlimited", "12:00 AM", "1 month", "98%". */
export function formatConstant<K extends ConstantKey>(key: K, value: ConstantValue<K>): string {
  const spec = constantSpec(key);
  switch (spec.kind) {
    case 'int':
      return String(value);
    case 'limit':
      return value === UNLIMITED ? 'Unlimited' : String(value);
    case 'usd':
    case 'usd_limit':
      return formatUsd(value as number | null);
    case 'ratio':
      return `${Math.round((value as number) * 10_000) / 100}%`;
    case 'bool':
      return value ? 'On' : 'Off';
    case 'time_of_day':
      return formatTimeOfDay(value as string);
    case 'duration':
      return durationText(value as string);
    case 'email':
      return (value as string | null) ?? 'None';
    case 'prices': {
      const models = Object.keys(value as AiPrices).filter((model) => model !== '*');
      return `${models.length} model${models.length === 1 ? '' : 's'} and a default`;
    }
    default:
      return String(value);
  }
}
