import { z } from 'zod';
import type { AiPrices, ConstantKind, ValueOf } from './constants';
import { isCalendarDate, isTimeZone, parseDuration } from './day';

// v20 FIX-A (SEC-5): the zod schema of each constant kind's value, apart from ./kinds, because it reads no constant: the
// web's public constants module (./public) builds GET /api/constants/public's schema from it without importing the
// whole table (whose budgets, prices and capacity threshold must never reach a browser). ./kinds re-exports it all.

/** The micro-dollars in one dollar. */
export const MICROS_PER_USD = 1_000_000;
/** The largest amount a usd constant holds ($1,000,000,000), far above any budget, inside a safe integer. */
export const USD_MICROS_MAX = 1_000_000_000 * MICROS_PER_USD;

const AiPriceSchema = z.object({
  input: z.number().nonnegative().max(10_000),
  output: z.number().nonnegative().max(10_000),
  cacheRead: z.number().nonnegative().max(10_000),
  cacheWrite: z.number().nonnegative().max(10_000),
});
/** The price table: model id → USD per million tokens. `*` must be there: it prices any other model. */
export const AiPricesSchema = z
  .record(z.string().min(1).max(80), AiPriceSchema)
  .refine((prices) => Object.hasOwn(prices, '*'), { message: 'Give a price for "*" (any other model)' });

const Micros = z.number().int().nonnegative().max(USD_MICROS_MAX);

/** The zod schema of each kind's value, before a constant's own bounds (min, max, maxLength, choices, placeholders). */
export const KIND_SCHEMAS: { [K in ConstantKind]: z.ZodType<ValueOf<K>> } = {
  int: z.number().int(),
  limit: z.number().int().nonnegative().nullable(),
  usd: Micros,
  usd_limit: Micros.nullable(),
  ratio: z.number().gt(0).lte(1),
  bool: z.boolean(),
  time_of_day: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  time_zone: z.string().min(1).max(64).refine(isTimeZone),
  duration: z.string().refine((text) => parseDuration(text) !== null),
  date: z.string().refine(isCalendarDate),
  email: z.email().max(254).nullable(),
  text: z.string(),
  message: z.string().refine((text) => text.trim().length > 0),
  prices: AiPricesSchema as z.ZodType<AiPrices>,
};
