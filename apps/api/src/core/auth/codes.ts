import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { AppDeps } from '../context';
import { normalizeEmail } from './users';

// Six-digit sign-in codes. A million values against five attempts and a ten-minute life is the balance these
// constants hold; only the code's SHA-256 is stored, and there is one live code per address.

export const LOGIN_CODE_TTL_MS = 10 * 60_000;
export const LOGIN_CODE_MAX_ATTEMPTS = 5;
/** How long before a second code may be sent to the same address. */
export const CODE_RESEND_COOLDOWN_MS = 60_000;

/** `randomInt` (a CSPRNG with rejection sampling), never Math.random: the code must not be guessable. */
export function generateLoginCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/** Stores a fresh code for an address, replacing any earlier one (a resend must not widen the guess space). */
export async function storeLoginCode(deps: Pick<AppDeps, 'db' | 'now'>, email: string, code: string): Promise<void> {
  const now = deps.now();
  await deps.db.run(
    `INSERT INTO login_codes(email, code_hash, attempts, created_at, expires_at) VALUES (?, ?, 0, ?, ?)
     ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, attempts = 0, created_at = excluded.created_at,
       expires_at = excluded.expires_at`,
    [normalizeEmail(email), hashCode(code), now.toISOString(), new Date(now.getTime() + LOGIN_CODE_TTL_MS).toISOString()],
  );
}

export type LoginCodeFailure = 'no_code' | 'expired' | 'too_many_attempts' | 'wrong_code';
export type LoginCodeCheck = { ok: true } | { ok: false; reason: LoginCodeFailure };

interface LoginCodeRow {
  code_hash: string;
  attempts: number;
  expires_at: string;
}

/**
 * Checks a submitted code and deletes it on success. A wrong guess costs an attempt, and the fifth wrong guess deletes
 * the code, so one code cannot be guessed at for its whole ten minutes. One transaction: two guesses at once never
 * both read the same attempt count.
 */
export async function consumeLoginCode(deps: Pick<AppDeps, 'db' | 'now'>, email: string, code: string): Promise<LoginCodeCheck> {
  const address = normalizeEmail(email);
  return deps.db.tx(
    async (t): Promise<LoginCodeCheck> => {
      const row = await t.one<LoginCodeRow>('SELECT code_hash, attempts, expires_at FROM login_codes WHERE email = ?', [address]);
      if (!row) return { ok: false, reason: 'no_code' };

      const remove = () => t.run('DELETE FROM login_codes WHERE email = ?', [address]);
      if (Date.parse(row.expires_at) <= deps.now().getTime()) {
        await remove();
        return { ok: false, reason: 'expired' };
      }
      if (row.attempts >= LOGIN_CODE_MAX_ATTEMPTS) {
        await remove();
        return { ok: false, reason: 'too_many_attempts' };
      }

      // Constant-time over two fixed-length hex digests, so timing says nothing about how many digits matched.
      const submitted = Buffer.from(hashCode(code), 'utf8');
      const stored = Buffer.from(row.code_hash, 'utf8');
      if (submitted.length === stored.length && timingSafeEqual(submitted, stored)) {
        await remove();
        return { ok: true };
      }

      const attempts = row.attempts + 1;
      if (attempts >= LOGIN_CODE_MAX_ATTEMPTS) {
        await remove();
        return { ok: false, reason: 'too_many_attempts' };
      }
      await t.run('UPDATE login_codes SET attempts = ? WHERE email = ?', [attempts, address]);
      return { ok: false, reason: 'wrong_code' };
    },
    { label: 'consumeLoginCode' },
  );
}

/** When the live code for an address was sent (ms since epoch), or null when there is none. */
export async function codeSentAt(deps: Pick<AppDeps, 'db'>, email: string): Promise<number | null> {
  const row = await deps.db.one<{ created_at: string }>('SELECT created_at FROM login_codes WHERE email = ?', [normalizeEmail(email)]);
  if (!row) return null;
  const sentAt = Date.parse(row.created_at);
  return Number.isFinite(sentAt) ? sentAt : null;
}

export async function deleteLoginCode(deps: Pick<AppDeps, 'db'>, email: string): Promise<void> {
  await deps.db.run('DELETE FROM login_codes WHERE email = ?', [normalizeEmail(email)]);
}

export async function pruneExpiredLoginCodes(deps: Pick<AppDeps, 'db' | 'now'>): Promise<number> {
  return (await deps.db.run('DELETE FROM login_codes WHERE expires_at <= ?', [deps.now().toISOString()])).changes;
}
