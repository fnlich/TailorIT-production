import { z } from 'zod';

// v30 CT: what the admin lists of v3.0 share (Admin › Review, Sources, Hosts, Candidates, Companies): a page of rows
// behind an opaque cursor, the filters a query string carries, and bulk actions over chosen rows, one request per
// ADMIN_BULK_MAX items, each row answered with what happened (14-extension-reports.md §6.2, 12 §9.8).

/** Rows one bulk request takes (14 §6.2: "Bulk actions run in one request per 100 items"). */
export const ADMIN_BULK_MAX = 100;
/** Rows one page of an admin list holds at most, and by default. */
export const ADMIN_PAGE_MAX = 100;
export const ADMIN_PAGE_DEFAULT = 50;

/** An admin list's cursor: opaque, from the last page's `nextCursor`. */
export const AdminCursorSchema = z.string().trim().min(1).max(500);
/** A page size from a query string (1 to ADMIN_PAGE_MAX, ADMIN_PAGE_DEFAULT when absent). */
export const AdminPageSizeSchema = z.coerce.number().int().min(1).max(ADMIN_PAGE_MAX).default(ADMIN_PAGE_DEFAULT);

/**
 * A list filter from a query string: repeated keys (`kind=a&kind=b`), commas (`kind=a,b`) or one value; each value
 * `item` refuses is dropped, repeats too; [] when absent.
 */
export function adminQueryList<T extends z.ZodType<string>>(item: T, max: number) {
  return z.preprocess(
    (value) => {
      const raw = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
      const items = raw.flatMap((entry) => (typeof entry === 'string' ? entry.split(',') : [])).map((entry) => entry.trim());
      return [...new Set(items.filter((entry) => item.safeParse(entry).success))];
    },
    z.array(item).max(max),
  );
}

/** A yes-or-no filter from a query string: true for 1, true or yes; absent (undefined) otherwise. */
export const AdminQueryFlagSchema = z.preprocess(
  (value) => (typeof value === 'string' && ['1', 'true', 'yes'].includes(value.trim().toLowerCase())) || value === true || undefined,
  z.literal(true).optional(),
);

/** The rows a bulk action names: 1 to ADMIN_BULK_MAX ids, each once. */
export function adminBulkIds<T extends z.ZodType<number | string>>(id: T) {
  return z
    .array(id)
    .min(1)
    .max(ADMIN_BULK_MAX)
    .refine((ids) => new Set(ids).size === ids.length, { error: 'Name each row once' });
}

/**
 * A bulk action's answer: one result per row, in the request's order (`outcome` one of the action's, `message` the
 * words for a row that was skipped or failed), and the counts of each outcome.
 */
export function adminBulkResultSchema<const O extends readonly [string, ...string[]]>(outcomes: O) {
  return z.object({
    results: z
      .array(
        z.object({
          id: z.union([z.number().int(), z.string().max(64)]),
          outcome: z.enum(outcomes),
          message: z.string().max(400).optional(),
        }),
      )
      .max(ADMIN_BULK_MAX),
    counts: z.partialRecord(z.enum(outcomes), z.number().int().nonnegative()),
  });
}
