import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough, type Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import JSZip from 'jszip';

// v30 E1: reading the dump files of a refdata build: plain or gzip text read as lines (the Wikidata entity dump: one
// entity a line), CSV records (GLEIF's Golden Copy, quoted fields across lines included), and ZIP archives' entries
// (SEC's submissions.zip, GLEIF's zipped CSVs). Everything streams but a ZIP, which JSZip reads whole into memory: for
// the real SEC and GLEIF files (hundreds of MB) unpacking them into the folder first keeps memory low.

/** One input file of a build, as its record names it (never its contents). */
export interface InputFile {
  source: 'wikidata' | 'sec' | 'gleif';
  file: string;
  bytes: number;
  modifiedAt: string;
}

/** The files of `dir` whose names end with one of `endings`, sorted; [] when the folder is missing. */
export function filesIn(dir: string, endings: readonly string[]): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => endings.some((ending) => name.toLowerCase().endsWith(ending)))
    .sort()
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile());
}

/** An input file's record. */
export function inputOf(source: InputFile['source'], path: string): InputFile {
  const stat = statSync(path);
  return { source, file: basename(path), bytes: stat.size, modifiedAt: stat.mtime.toISOString() };
}

/** A file's bytes as text, gunzipped when its name ends with .gz. */
export function textStreamOf(path: string): Readable {
  const raw = createReadStream(path);
  if (!path.toLowerCase().endsWith('.gz')) return raw.setEncoding('utf8');
  const gunzip = createGunzip();
  raw.on('error', (error) => gunzip.destroy(error));
  return raw.pipe(gunzip).setEncoding('utf8');
}

/** The lines of a text stream (no line ends), however long a line is. */
export async function* linesOf(stream: Readable): AsyncGenerator<string> {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) yield line;
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** A ZIP archive's file entries (folders left out), in the archive's order. */
export async function zipEntries(path: string): Promise<Array<{ name: string; text: () => Promise<string>; stream: () => Readable }>> {
  const zip = await JSZip.loadAsync(readFileSync(path));
  return Object.values(zip.files)
    .filter((entry) => !entry.dir)
    .map((entry) => ({
      name: entry.name,
      text: () => entry.async('string'),
      // JSZip's stream is an older stream kind (not async-iterable): piped into a Node stream.
      stream: () => (entry.nodeStream('nodebuffer') as unknown as Readable).pipe(new PassThrough()).setEncoding('utf8'),
    }));
}

/**
 * The records of a CSV text stream (RFC 4180: quoted fields with doubled quotes and line breaks inside), each as an
 * object by the header row's names. A row with fewer fields than the header leaves the rest ''.
 */
export async function* csvRecords(stream: Readable): AsyncGenerator<Record<string, string>> {
  let header: string[] | null = null;
  let field = '';
  let row: string[] = [];
  let quoted = false;
  let afterQuote = false;
  const emit = function* (): Generator<Record<string, string>> {
    row.push(field);
    field = '';
    const fields = row;
    row = [];
    if (fields.length === 1 && fields[0] === '') return; // a blank line
    if (!header) {
      header = fields.map((name, index) => (index === 0 ? name.replace(/^\uFEFF/, '') : name).trim());
      return;
    }
    const record: Record<string, string> = {};
    header.forEach((name, index) => {
      record[name] = fields[index] ?? '';
    });
    yield record;
  };
  for await (const chunk of stream) {
    const text = String(chunk);
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i]!;
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 1;
          } else if (i + 1 === text.length) {
            // A quote at the chunk's end: the next chunk says whether it is doubled.
            quoted = false;
            afterQuote = true;
          } else {
            quoted = false;
          }
        } else field += c;
        continue;
      }
      if (afterQuote) {
        afterQuote = false;
        if (c === '"') {
          field += '"';
          quoted = true;
          continue;
        }
      }
      if (c === '"') quoted = true;
      else if (c === ',') {
        row.push(field);
        field = '';
      } else if (c === '\n') yield* emit();
      else if (c !== '\r') field += c;
    }
  }
  if (field !== '' || row.length > 0) yield* emit();
}
