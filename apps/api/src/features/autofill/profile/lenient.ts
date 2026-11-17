import { z } from 'zod';

// Stored autofill JSON read leniently against its contract schema: what parses is kept (unknown keys dropped, as
// z.object does), and what does not falls back field by field instead of losing the whole row, so a row written by
// an older or newer TailorIT still opens. Writes stay strict: they are checked against the save schemas.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The value a field takes when it is missing: '' for text, null where null is allowed, [] for a list, false for a
 * yes/no, 'other' for a choice from a list that has it (a degree's level, so the entry is kept), an object of its
 * fields' empties, a union's first option that parses ({state: 'not_provided'} for a sensitive answer). Undefined when
 * the schema has none (a number, another choice from a list): the field is required. The lenient read never goes
 * inside a union, so an unreadable sensitive answer stays not provided; it never becomes a value such as 'other'.
 */
export function emptyOf(schema: z.ZodType): unknown {
  if (schema instanceof z.ZodOptional) return undefined;
  if (schema instanceof z.ZodNullable) return null;
  if (schema instanceof z.ZodString) return '';
  if (schema instanceof z.ZodBoolean) return false;
  if (schema instanceof z.ZodArray) return [];
  if (schema instanceof z.ZodLiteral) return [...schema.values][0];
  if (schema instanceof z.ZodEnum && (schema.options as readonly unknown[]).includes('other')) return 'other';
  if (schema instanceof z.ZodObject) {
    return Object.fromEntries(Object.entries(schema.shape).map(([key, field]) => [key, emptyOf(field as z.ZodType)]));
  }
  if (schema instanceof z.ZodUnion) {
    for (const option of schema.options as readonly z.ZodType[]) {
      const empty = emptyOf(option);
      if (option.safeParse(empty).success) return empty;
    }
  }
  return undefined;
}

function lenient(schema: z.ZodType, value: unknown, fallback: unknown): unknown {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  if ((schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) && value !== undefined && value !== null) {
    return lenient(schema.unwrap() as z.ZodType, value, fallback);
  }
  if (schema instanceof z.ZodObject && isRecord(value)) {
    const fallbacks = isRecord(fallback) ? fallback : {};
    const fields = Object.entries(schema.shape).map(([key, field]) => {
      const inner = field as z.ZodType;
      return [key, lenient(inner, value[key], key in fallbacks ? fallbacks[key] : emptyOf(inner))];
    });
    const repaired = schema.safeParse(Object.fromEntries(fields));
    return repaired.success ? repaired.data : fallback;
  }
  if (schema instanceof z.ZodArray && Array.isArray(value)) {
    const element = schema.element as z.ZodType;
    // An entry that cannot be read is dropped (an entry has no fallback of its own).
    const items = value.map((item) => lenient(element, item, undefined)).filter((item) => item !== undefined);
    // A list longer than its limit keeps its first entries.
    while (items.length > 0 && !schema.safeParse(items).success) items.pop();
    const repaired = schema.safeParse(items);
    return repaired.success ? repaired.data : fallback;
  }
  return fallback;
}

/** `value` as `schema` reads it leniently (see the top of this file); `fallback` when nothing of it can be read. */
export function readLeniently<T>(schema: z.ZodType<T>, value: unknown, fallback: T): T {
  return lenient(schema, value, fallback) as T;
}
