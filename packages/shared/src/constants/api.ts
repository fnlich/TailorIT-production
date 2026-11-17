import { z } from 'zod';
import { IsoDateTime } from '../core/list';
import { CONSTANT_GROUPS, CONSTANT_KINDS, CONSTANT_SOURCES, type ConstantKey, type ConstantSource } from './constants';

// The routes that read and write the constants (02-constants.md, "The resolution service" and "What the web reads"):
//   GET    /api/constants/public                 (session) → PublicConstantsResponse
//   GET    /api/admin/constants                  (admin)   → AdminConstantList
//   PUT    /api/admin/constants/:key             (admin)   AdminConstantSetBody → AdminConstantRow (400: not valid)
//   DELETE /api/admin/constants/:key             (admin)   → AdminConstantRow (back to .env or the default)

/**
 * GET /api/constants/public's schema: the constants the web shows (never a budget, a price or a server-capacity value).
 * v20 FIX-A (SEC-5): defined in ./public, the web's module, from the generated public specs; re-exported here.
 */
export {
  PublicConstantValuesSchema,
  PublicConstantsResponseSchema,
  type PublicConstantsResponse,
} from './public/index';

/**
 * One row of Admin › Constants. Values are in their stored form (a usd kind in micro-dollars, UNLIMITED as null);
 * `display` is the same value as the admin reads it ("$0.10", "Unlimited", "12:00 AM", "1 month").
 */
export const AdminConstantRowSchema = z.object({
  key: z.string(),
  kind: z.enum(CONSTANT_KINDS),
  group: z.enum(CONSTANT_GROUPS),
  label: z.string(),
  help: z.string(),
  /** The resolved value and where it came from. */
  value: z.unknown(),
  display: z.string(),
  source: z.enum(CONSTANT_SOURCES),
  /** The default in the constants file. */
  defaultValue: z.unknown(),
  defaultDisplay: z.string(),
  /** The .env key, the older keys still read, and the parsed .env value when .env sets it. */
  envKey: z.string(),
  envAliases: z.array(z.string()),
  envSet: z.boolean(),
  envValue: z.unknown().optional(),
  envDisplay: z.string().nullable(),
  adminEditable: z.boolean(),
  public: z.boolean(),
  min: z.number().optional(),
  max: z.number().optional(),
  maxLength: z.number().int().positive().optional(),
  /** message: the placeholders an override may use. */
  placeholders: z.array(z.string()),
  /** text: the only values allowed. */
  choices: z.array(z.string()).optional(),
  /** A stored override that no longer validates ("Stored override is invalid"): ignored until it is reset. */
  invalidOverride: z.boolean(),
  /**
   * When the stored override was last written, and the email of the admin who wrote it (null: none, or the admin is
   * gone).
   */
  updatedAt: IsoDateTime.nullable(),
  updatedBy: z.string().nullable(),
});
export type AdminConstantRow = z.infer<typeof AdminConstantRowSchema> & { key: ConstantKey; source: ConstantSource };

export const AdminConstantListSchema = z.object({
  items: z.array(AdminConstantRowSchema),
  version: z.number().int().nonnegative(),
});
export type AdminConstantList = z.infer<typeof AdminConstantListSchema>;

/**
 * PUT /api/admin/constants/:key: the new value in its stored form (micro-dollars for a usd kind, null for
 * Unlimited; the web turns "0.10" into micro-dollars with usdToMicros). The server checks it with validateConstant.
 */
export const AdminConstantSetBodySchema = z.object({ value: z.unknown() });
export type AdminConstantSetBody = z.infer<typeof AdminConstantSetBodySchema>;
