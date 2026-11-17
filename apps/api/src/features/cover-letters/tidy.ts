// The letters' house style enforced on an AI answer (v30 ST1: moved unchanged from ./prompts.ts when the prompts
// moved to the prompt catalogue).

/**
 * The house style the prompts ask for, enforced on the answer: dashes become commas (a range of numbers keeps a plain
 * hyphen), stray markdown emphasis is dropped, spaces are tidied.
 */
export function tidyAiText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/(\d)\s*[–—]\s*(\d)/g, '$1-$2')
    .replace(/\s*(?:—|–|\s--\s)\s*/g, ', ')
    .replace(/(^|\s)--(\s|$)/g, '$1,$2')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/,\s*,/g, ',')
    .replace(/[ \t]+,/g, ',')
    .replace(/[ \t]{2,}/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
