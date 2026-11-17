// A skill's name as the library writes it (pure, node-tested): the chip as typed, read the way the server reads it,
// and the library's own spelling of it when the library knows it.

/** Trimmed, inner whitespace collapsed: the server's own reading of a chip. */
export function cleanChip(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** The library's spelling of a skill when it knows it (case-insensitively), else null. */
export function librarySpelling(library: readonly string[], value: string): string | null {
  const wanted = cleanChip(value).toLowerCase();
  if (!wanted) return null;
  return library.find((skill) => skill.toLowerCase() === wanted) ?? null;
}
