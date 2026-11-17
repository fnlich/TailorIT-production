import { randomUUID } from 'node:crypto';
import type { Account, Role } from '@tailorit/shared';
import { nowIso, type AppDeps } from '../context';

// Accounts. There is no registration step: an account is made the first time someone proves they control an address
// (an emailed code or a verified Google sign-in), and the address is the identity.

export interface UserRow {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  google_sub: string | null;
  role: Role;
  default_resume_id: string | null;
  disabled_at: string | null;
  created_at: string;
  updated_at: string;
  last_sign_in_at: string | null;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** RFC 5321's limit for a whole address. */
export const MAX_EMAIL_LENGTH = 254;
export const MAX_NAME_LENGTH = 120;

/** Trim + lowercase: the one form addresses are compared and stored in. */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isEmailAddress(email: string): boolean {
  return email.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(email);
}

export function toAccount(row: UserRow): Account {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url,
    role: row.role,
    defaultResumeId: row.default_resume_id,
    createdAt: row.created_at,
  };
}

export async function getUserById(deps: Pick<AppDeps, 'db'>, id: string): Promise<UserRow | undefined> {
  return deps.db.one<UserRow>('SELECT * FROM users WHERE id = ?', [id]);
}

export async function getUserByEmail(deps: Pick<AppDeps, 'db'>, email: string): Promise<UserRow | undefined> {
  // v3.0 PG-0: without case, as SQLite's COLLATE NOCASE column compared (PostgreSQL's users_email_lower index).
  return deps.db.one<UserRow>('SELECT * FROM users WHERE lower(email) = ?', [normalizeEmail(email)]);
}

export async function getAccount(deps: Pick<AppDeps, 'db'>, id: string): Promise<Account | null> {
  const row = await getUserById(deps, id);
  return row ? toAccount(row) : null;
}

/** ADMIN_EMAILS, keeping only entries that are addresses. */
export function configuredAdminEmails(deps: Pick<AppDeps, 'config'>): string[] {
  return [...new Set(deps.config.auth.adminEmails.map(normalizeEmail).filter(isEmailAddress))];
}

export function isConfiguredAdmin(deps: Pick<AppDeps, 'config'>, email: string): boolean {
  return configuredAdminEmails(deps).includes(normalizeEmail(email));
}

/** What a sign-in proved: always the address; Google adds a name, a picture and its stable account id. */
export interface ProvenIdentity {
  email: string;
  name?: string;
  avatarUrl?: string;
  googleSub?: string;
}

function cleanName(value: string | undefined): string {
  return (value ?? '').replace(/\p{Cc}+/gu, ' ').trim().slice(0, MAX_NAME_LENGTH);
}

function cleanAvatarUrl(value: string | undefined): string | null {
  const url = value?.trim() ?? '';
  return /^https?:\/\//i.test(url) && url.length <= 2000 ? url : null;
}

/**
 * The account for a proven address, created on first sign-in (named after the address's local part, admin when
 * ADMIN_EMAILS lists it). Google's name, picture and account id are refreshed on every Google sign-in; a code sign-in
 * carries none of them and changes nothing.
 */
export async function findOrCreateUser(deps: AppDeps, identity: ProvenIdentity): Promise<{ user: UserRow; created: boolean }> {
  const email = normalizeEmail(identity.email);
  const name = cleanName(identity.name);
  const avatarUrl = cleanAvatarUrl(identity.avatarUrl);
  const googleSub = identity.googleSub?.trim() || null;

  // v3.0 D2: in the caller's transaction when it holds one (completeSignIn), else in one of its own.
  return deps.db.atomic(async (): Promise<{ user: UserRow; created: boolean }> => {
    const now = nowIso(deps);
    const existing = await getUserByEmail(deps, email);
    if (googleSub) {
      // One Google account belongs to one TailorIT account. When its address changed at Google, the old account lets
      // go of it (the address is the identity here), instead of the UNIQUE index refusing the sign-in.
      await deps.db.run('UPDATE users SET google_sub = NULL, updated_at = ? WHERE google_sub = ? AND id <> ?', [
        now,
        googleSub,
        existing?.id ?? '',
      ]);
    }

    if (existing) {
      const next = {
        name: name || existing.name,
        avatar_url: avatarUrl ?? existing.avatar_url,
        google_sub: googleSub ?? existing.google_sub,
      };
      if (
        next.name === existing.name &&
        next.avatar_url === existing.avatar_url &&
        next.google_sub === existing.google_sub
      ) {
        return { user: existing, created: false };
      }
      await deps.db.run('UPDATE users SET name = ?, avatar_url = ?, google_sub = ?, updated_at = ? WHERE id = ?', [
        next.name,
        next.avatar_url,
        next.google_sub,
        now,
        existing.id,
      ]);
      return { user: { ...existing, ...next, updated_at: now }, created: false };
    }

    const user: UserRow = {
      id: randomUUID(),
      email,
      name: name || email.split('@')[0]!.slice(0, MAX_NAME_LENGTH),
      avatar_url: avatarUrl,
      google_sub: googleSub,
      role: isConfiguredAdmin(deps, email) ? 'admin' : 'user',
      default_resume_id: null,
      disabled_at: null,
      created_at: now,
      updated_at: now,
      last_sign_in_at: null,
    };
    await deps.db.run(
      `INSERT INTO users(id, email, name, avatar_url, google_sub, role, default_resume_id, disabled_at, created_at,
         updated_at, last_sign_in_at)
       VALUES (@id, @email, @name, @avatar_url, @google_sub, @role, @default_resume_id, @disabled_at, @created_at,
         @updated_at, @last_sign_in_at)`,
      { ...user },
    );
    deps.log.info(`[auth] new account ${email}${user.role === 'admin' ? ' (administrator, from ADMIN_EMAILS)' : ''}`);
    return { user, created: true };
  }, { label: 'findOrCreateUser' });
}

/**
 * Makes an account an administrator when ADMIN_EMAILS names it. Promote only, never demote: a typo in .env must not
 * lock the operator out of their own installation. Returns true when it changed something.
 */
export async function promoteIfConfiguredAdmin(deps: AppDeps, user: Pick<UserRow, 'id' | 'email' | 'role'>): Promise<boolean> {
  if (user.role === 'admin' || !isConfiguredAdmin(deps, user.email)) return false;
  const { changes: changed } = await deps.db.run("UPDATE users SET role = 'admin', updated_at = ? WHERE id = ? AND role <> 'admin'", [
    nowIso(deps),
    user.id,
  ]);
  if (changed) deps.log.info(`[auth] ${user.email} is listed in ADMIN_EMAILS; it is now an administrator.`);
  return changed > 0;
}

/** The startup pass of the same rule, for accounts that already exist. Returns how many were promoted. */
export async function promoteConfiguredAdmins(deps: AppDeps): Promise<number> {
  let promoted = 0;
  for (const email of configuredAdminEmails(deps)) {
    const user = await getUserByEmail(deps, email);
    if (user && (await promoteIfConfiguredAdmin(deps, user))) promoted += 1;
  }
  return promoted;
}

export async function markSignedIn(deps: AppDeps, userId: string): Promise<void> {
  await deps.db.run('UPDATE users SET last_sign_in_at = ? WHERE id = ?', [nowIso(deps), userId]);
}
