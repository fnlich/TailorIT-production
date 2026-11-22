/**
 * Splits the CLI's stdout into NDJSON lines. Not `readline`: the final `result` event repeats the whole answer on one
 * line, so any line-length cap is a cliff. Splitting Buffers (not decoded strings) keeps a multi-byte character that
 * straddles two chunks intact, and pieces are only concatenated once their line is complete.
 */
export class NdjsonSplitter {
  private parts: Buffer[] = [];

  /** Feeds one chunk; returns the complete lines it finished (without the newline or a trailing \r). */
  push(chunk: Buffer): string[] {
    const lines: string[] = [];
    let start = 0;
    for (let newline = chunk.indexOf(0x0a); newline >= 0; newline = chunk.indexOf(0x0a, start)) {
      const piece = chunk.subarray(start, newline);
      lines.push(decode(this.parts.length ? Buffer.concat([...this.parts, piece]) : piece));
      this.parts = [];
      start = newline + 1;
    }
    if (start < chunk.length) this.parts.push(chunk.subarray(start));
    return lines;
  }

  /** The unterminated last line at end of stream (a killed child can leave one; it may still be complete JSON). */
  flush(): string | null {
    if (!this.parts.length) return null;
    const rest = decode(Buffer.concat(this.parts));
    this.parts = [];
    return rest.trim() ? rest : null;
  }
}

function decode(bytes: Buffer): string {
  const text = bytes.toString('utf8');
  return text.endsWith('\r') ? text.slice(0, -1) : text;
}

/** Keeps the last `max` bytes written (stderr: the CLI puts its diagnosis at the end). */
export class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  /** v34 AIKEY: whether a chunk was let go from the front (what is kept starts mid-text). */
  private dropped = false;

  constructor(private readonly max = 64 * 1024) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.chunks.length > 1 && this.size - this.chunks[0]!.length >= this.max) {
      this.size -= this.chunks.shift()!.length;
      this.dropped = true; // v34 AIKEY
    }
  }

  /**
   * The last `max` bytes. v34 AIKEY (review fix L3): with `scrub`, what is kept is scrubbed BEFORE it is cut to `max`
   * (`cutAtStart`: a chunk was let go, so its first characters may be the end of a value cut there).
   */
  text(scrub?: (text: string, cutAtStart: boolean) => string): string {
    const all = Buffer.concat(this.chunks);
    if (!scrub) return all.subarray(Math.max(0, all.length - this.max)).toString('utf8');
    const clean = Buffer.from(scrub(all.toString('utf8'), this.dropped), 'utf8');
    return clean.subarray(Math.max(0, clean.length - this.max)).toString('utf8');
  }
}

/** The last non-empty lines of some output, at most `maxChars`, for error details. */
export function lastLines(text: string, maxChars = 600): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let out = '';
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const next = out ? `${lines[i]} | ${out}` : lines[i]!;
    if (next.length > maxChars) return out || next.slice(-maxChars);
    out = next;
  }
  return out;
}
