import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import type { AppDeps } from '../../../core/context';
import { AppError } from '../../../core/http/errors';

// The job-site passwords' encryption (work package AF, autofill API version 3): AES-256-GCM under one 32-byte key per
// TailorIT, kept in a file in its data folder (DATA_DIR/keys/autofill-credentials.key), never in the database.
//
// What this protects against, precisely: a copy of the database alone (a backup of tailorit.db, a database file sent
// for support) opens no password. It does not protect against a copy of the whole data folder, which holds the key
// too, nor against a program running as the account TailorIT runs as, which can read both. The key file is made with
// owner-only permissions where the system has them (0600, its folder 0700); on Windows it takes the data folder's
// access rules, which under the user profile (%LOCALAPPDATA%, TailorIT's default) admit only that user and the
// administrators. Windows' DPAPI would bind the key to the user's logon, but Node reaches it only through a native
// module or PowerShell, neither of which TailorIT takes on for this; so a data folder outside the user profile is
// reported in the log once per process, as the key is no better protected than the folder.
//
// The key file is made on the first save, from 32 random bytes, and only while no sign-in is saved: a sign-in sealed
// under a key that is gone can never open again, so a lost key is reported, never silently replaced. It is never
// written over: a key file of the wrong size stops the sign-ins (500) rather than lose them. Each password has its own
// random 12-byte IV and its 16-byte tag, and the account and the host are bound in as associated data, so a row moved
// to another account or site does not open. Nothing here logs a password or the key, and no error carries either.

/** The key file under DATA_DIR. */
export function credentialKeyPath(dataDir: string): string {
  return join(dataDir, 'keys', 'autofill-credentials.key');
}

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ALGORITHM = 'aes-256-gcm';

const WHERE = "their key file (keys/autofill-credentials.key in TailorIT's data folder)";
const KEY_DAMAGED =
  `TailorIT cannot open the saved job-site sign-ins: ${WHERE} is damaged. Restore it from a backup; or delete every ` +
  'saved sign-in in Settings › Autofill, remove that file, and save them again.';
const KEY_MISSING =
  `TailorIT cannot open the saved job-site sign-ins: ${WHERE} is missing. Restore it from a backup; or delete every ` +
  'saved sign-in in Settings › Autofill and save them again.';
const CANNOT_OPEN = 'TailorIT cannot open this saved job-site sign-in. Delete it in Settings › Autofill and save it again.';

/** The keys read in this process, by file. */
const keys = new Map<string, Buffer>();
/** The data folders already reported as outside the user profile. */
const reported = new Set<string>();

function errorCode(error: unknown): string | undefined {
  return (error as { code?: unknown } | null)?.code as string | undefined;
}

/** True when `dataDir` is not the user's profile folder or inside it (compared case-blind on Windows). */
export function outsideUserProfile(dataDir: string, home = homedir()): boolean {
  const fold = (path: string) => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path));
  const path = relative(fold(home), fold(dataDir));
  return path.startsWith('..') || isAbsolute(path);
}

type KeyDeps = Pick<AppDeps, 'config' | 'db' | 'log'>;

/** Reports, once per process and folder, a data folder outside the user profile (see the top of this file). */
function reportPlace(deps: KeyDeps): void {
  const dataDir = deps.config.dataDir;
  if (reported.has(dataDir) || !outsideUserProfile(dataDir)) return;
  reported.add(dataDir);
  deps.log.warn(
    "[autofill] TailorIT's data folder is outside the user profile: the job-site sign-ins' key file there is protected " +
      'only by that folder\'s access rules. Keep the folder private to the account TailorIT runs as.',
  );
}

/**
 * The key, read once per process. `create`: made now when there is no key file and no sign-in is saved (the first
 * save); a read never makes one, and neither does a save while sign-ins sealed under a lost key remain (500).
 */
async function credentialKey(deps: KeyDeps, create: boolean): Promise<Buffer> {
  const path = credentialKeyPath(deps.config.dataDir);
  const known = keys.get(path);
  if (known) return known;
  reportPlace(deps);
  let key: Buffer;
  try {
    key = readFileSync(path);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw new AppError('internal', KEY_DAMAGED, { cause: error });
    const saved = await deps.db.one<{ n: number }>('SELECT count(*) AS n FROM autofill_credentials');
    if (!create || (saved?.n ?? 0) > 0) throw new AppError('internal', KEY_MISSING);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      // 'wx': made only when there is none, so a key is never written over, even by two saves at once.
      writeFileSync(path, randomBytes(KEY_BYTES), { flag: 'wx', mode: 0o600 });
    } catch (made) {
      if (errorCode(made) !== 'EEXIST') {
        throw new AppError('internal', 'TailorIT could not make the key for job-site sign-ins.', { cause: made });
      }
    }
    key = readFileSync(path);
  }
  if (key.length !== KEY_BYTES) throw new AppError('internal', KEY_DAMAGED);
  keys.set(path, key);
  return key;
}

/** What a password is bound to: the account and the site, so a row moved elsewhere does not open. */
function associatedData(userId: string, host: string): Buffer {
  return Buffer.from(`tailorit:autofill-credential:v1\u0000${userId}\u0000${host}`, 'utf8');
}

export interface SealedPassword {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

/** Encrypts a password for `userId`'s sign-in on `host` (the key file is made on the first save). */
export async function sealPassword(deps: KeyDeps, userId: string, host: string, password: string): Promise<SealedPassword> {
  const key = await credentialKey(deps, true);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(associatedData(userId, host));
  const ciphertext = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

/** Decrypts a stored password; 500 (a sentence naming neither the password nor the key) when it does not open. */
export async function openPassword(deps: KeyDeps, userId: string, host: string, sealed: SealedPassword): Promise<string> {
  const key = await credentialKey(deps, false);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, sealed.iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(associatedData(userId, host));
    decipher.setAuthTag(sealed.tag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // The cipher's own error says only that the tag did not match; it is not kept either.
    throw new AppError('internal', CANNOT_OPEN);
  }
}

/** Forgets the keys read (tests that remove a data folder's key file). */
export function forgetCredentialKeys(): void {
  keys.clear();
}
