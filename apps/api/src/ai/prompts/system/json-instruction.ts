import { JSON_BEGIN, JSON_END } from '../../json';
import { defineTextPrompt } from '../types';

// v30 ST0: moved word for word from ai/runPrompt.ts's jsonInstruction (which now reads it). Appended to every model
// prompt's system text. The CLI enforces no JSON, so the answer is fenced by sentinels that extractJSON keys on. The
// `[feature:<kind>]` tag is how the fake CLI (tools/fake-claude) picks its scenario.
export const jsonInstructionPrompt = defineTextPrompt<{ tag: string }>({
  area: 'system',
  name: 'json-instruction',
  version: 1,
  description: 'The JSON-only instruction every model prompt ends with, with its [feature:<kind>] tag.',
  text: ({ tag }) =>
    [
      'Reply with JSON only, exactly in this form and with nothing before or after it:',
      JSON_BEGIN,
      '<one JSON value matching the requested shape>',
      JSON_END,
      'Use double quotes for every key and string. No markdown fences, no comments, no trailing commas, no "..." ' +
        'placeholders. Escape quotes, backslashes and newlines inside strings. When you have no value for a field, use ' +
        'null, an empty string or an empty array; never leave a field out.',
      `[feature:${tag}]`,
    ].join('\n'),
});
