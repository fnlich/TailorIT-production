import { z } from 'zod';
import type { PublicConstantKey, PublicConstants } from '../constants';
import { KIND_SCHEMAS } from '../schemas';
import { PUBLIC_CONSTANT_SPECS } from './specs';

// v20 FIX-A (SEC-5): the public constants, for the web (`@tailorit/shared/constants/public`). Everything here comes
// from ./specs (generated from ../constants.ts: the public constants' kinds, defaults and bounds) and the modules that
// read no constant (../schemas, ../render, ../day), so a page that imports it never gets the whole table, whose daily
// budgets, prices and capacity threshold people must never see. The API answers the same schema (../api re-exports it).

export { PUBLIC_CONSTANT_SPECS } from './specs';
export { placeholdersOf, renderMessage, type MessageParams } from '../render';
export { formatTimeOfDay, resetText } from '../day';
// v30 CT: the words of the shared contracts' own checks, which an admin's edit reaches once the app sets them.
export { defaultMessage, messageError, setSharedMessages, sharedMessage, type PublicMessageKeyOf } from './defaults';

/** The public keys, in the table's order. */
const PUBLIC_KEYS = Object.keys(PUBLIC_CONSTANT_SPECS) as PublicConstantKey[];

/**
 * Every public constant at its default (the constants file's): what the web shows until GET /api/constants/public
 * answers, and if it never does.
 */
export const PUBLIC_CONSTANT_DEFAULTS: PublicConstants = Object.freeze(
  Object.fromEntries(PUBLIC_KEYS.map((key) => [key, PUBLIC_CONSTANT_SPECS[key].default])),
) as PublicConstants;

/** Every public constant's value, each checked against its kind; a key the web does not know yet is dropped. */
export const PublicConstantValuesSchema = z.object(
  Object.fromEntries(PUBLIC_KEYS.map((key) => [key, KIND_SCHEMAS[PUBLIC_CONSTANT_SPECS[key].kind]])),
) as unknown as z.ZodType<PublicConstants>;

/**
 * GET /api/constants/public: the constants the web shows (never a budget, a price or a server-capacity value).
 * `version` goes up with every admin change and every reload that changed something.
 */
export const PublicConstantsResponseSchema = z.object({
  version: z.number().int().nonnegative(),
  values: PublicConstantValuesSchema,
});
export type PublicConstantsResponse = z.infer<typeof PublicConstantsResponseSchema>;
