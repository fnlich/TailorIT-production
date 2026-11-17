import { AppError } from '../../../core/http/errors';

// v1.5 Q1: how the MCP save tools refuse what they cannot normalize. Every refusal names the field, as a path into
// what the AI sent ("resume.experience[1].achievements[2]"), and the shape TailorIT expects there, so the AI can fix
// exactly that and send it again.

/** What a value is, in words, for a refusal ("a number", "an object"). */
export function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'string') return value.trim() ? 'a string' : 'an empty string';
  return `a ${typeof value}`;
}

/** The message of a refusal: "<field>: expected <shape>; got <what>." */
export function refusalMessage(field: string, expected: string, got?: unknown): string {
  return `${field}: expected ${expected}${got === undefined ? '' : `; got ${kindOf(got)}`}.`;
}

/** A refusal of the field: the save keeps nothing, and the message says what to send instead. */
export function refuse(field: string, expected: string, got?: unknown): AppError {
  return new AppError('validation_failed', refusalMessage(field, expected, got));
}

/** A refusal in TailorIT's own words (no expected shape: the value is the right shape but cannot be used). */
export function refuseWith(field: string, sentence: string): AppError {
  return new AppError('validation_failed', `${field}: ${sentence}`);
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The first of `keys` the object holds (not undefined or null), with its key. */
export function firstOf(object: Record<string, unknown>, keys: readonly string[]): [string, unknown] | null {
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null) return [key, object[key]];
  }
  return null;
}

/** A text field: a string (trimmed), or '' when absent; anything else is refused. */
export function optionalText(value: unknown, field: string, expected = 'a string'): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw refuse(field, expected, value);
  return value.trim();
}

/**
 * A list of texts: an array of strings, or one string with a line per item (list markers dropped); '' items left out.
 * Anything else, or an item that is not a string, is refused.
 */
export function textList(value: unknown, field: string, expected = 'an array of strings'): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return linesOf(value);
  if (!Array.isArray(value)) throw refuse(field, expected, value);
  return value.map((item, index) => {
    if (typeof item !== 'string') throw refuse(`${field}[${index}]`, 'a string', item);
    return item.trim();
  }).filter(Boolean);
}

/** A text's lines, each without a list marker ("- ", "• ", "1. "). */
export function linesOf(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-•*·▪●]|\d{1,2}[.)])\s+/, '').trim())
    .filter(Boolean);
}
