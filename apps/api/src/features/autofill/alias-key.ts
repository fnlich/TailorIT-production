import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppDeps } from '../../core/context';
import type { AliasValueHash } from './lookup';

// The key a page address's alias keeps an ambiguous or long parameter's value under (lookup.ts storedPageAddress,
// autofill API version 5): `name=h:<12 hex>`, the first 12 hex digits of HMAC-SHA256("<name>=<value>") under one
// 32-byte key per TailorIT, kept in its data folder beside the job-site sign-ins' key (DATA_DIR/keys/
// autofill-link-alias.key), never in the database. So two postings named by such a value (?code=ENG-42, ?code=OPS-77)
// keep two aliases, and a copy of the database alone cannot read a short value back by trying every one. The key is
// made on first use; a lost key only means the aliases kept under it are no longer matched (the person's next add from
// such a page keeps a new one).

/** The key file under DATA_DIR. */
export function aliasKeyPath(dataDir: string): string {
  return join(dataDir, 'keys', 'autofill-link-alias.key');
}

const KEY_BYTES = 32;

/** The keys read in this process, by file. */
const keys = new Map<string, Buffer>();

function aliasKey(dataDir: string): Buffer {
  const path = aliasKeyPath(dataDir);
  const known = keys.get(path);
  if (known) return known;
  let key: Buffer | null = null;
  try {
    key = readFileSync(path);
  } catch {
    key = null;
  }
  if (!key || key.length !== KEY_BYTES) {
    if (key) throw new Error('The link alias key file is damaged.');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    key = randomBytes(KEY_BYTES);
    try {
      writeFileSync(path, key, { mode: 0o600, flag: 'wx' });
    } catch {
      // Another process made it first: read theirs.
      key = readFileSync(path);
      if (key.length !== KEY_BYTES) throw new Error('The link alias key file is damaged.');
    }
  }
  keys.set(path, key);
  return key;
}

/** The hash an alias keeps an ambiguous or long value as, under this TailorIT's key (made on first use). */
export function aliasValueHash(deps: Pick<AppDeps, 'config'>): AliasValueHash {
  const dataDir = deps.config.dataDir;
  return (name, value) => {
    const digest = createHmac('sha256', aliasKey(dataDir)).update(`${name}=${value}`, 'utf8').digest('hex');
    return `h:${digest.slice(0, 12)}`;
  };
}
