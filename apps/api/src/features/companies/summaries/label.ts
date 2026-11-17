// v30 E3: the AI summary's label (docs/design/part2/13-company-enrichment.md §6.3 `ai_derived`, §8 "Marking"): "Summary
// written by AI from the company's website and Wikidata." The words are the web's (E0-WEB's summaryOriginLine in
// apps/web/src/features/companies/format.ts: the sources' words once each, joined "a", "a and b", "a, b and c"), so the
// AI row's `attribution` says what the Company section shows; here the "from …" names the summary's own inputs.

/** "a", "a and b", "a, b and c" (the web's joinWords). */
export function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/** The label of a summary written from texts of these sources' words ("the company's website", "Wikidata"). */
export function aiSummaryLabel(from: readonly string[]): string {
  const names: string[] = [];
  for (const label of from) {
    const text = label.trim();
    if (text && !names.some((name) => name.toLowerCase() === text.toLowerCase())) names.push(text);
  }
  return names.length > 0 ? `Summary written by AI from ${joinWords(names)}.` : 'Summary written by AI.';
}
