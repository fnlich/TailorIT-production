import type { Request, RequestHandler, Response } from 'express';
import { actorOf } from '../../../core/auth/guards';

// v36 JOBS (PLAN J7; SP v36 REQUEST.md: "`Approved by an admin` badge will be shown for only admin (not the other
// users)"): a job's `admin_approved` verification (verification.ts verificationOf: a job TailorIT could not read that an
// admin published as it was added) is for administrators only. Every answer of the routers that carry a job's
// verification (the jobs list and a job, the Job Tracker's entries, the Auto-apply Saved list, a company's jobs) drops
// it for anyone whose signed-in role is not admin: the job then carries the state everyone else's published jobs carry,
// no `verification` at all (no label). The actor decides (actorOf: an admin working on a shared profile still sees it;
// the profile's owner is never an admin's role through a share). The person's own marks stay: `waiting_admin` (a job
// they added that an admin approves next) and `private_unverified` (their own unread job). The adder's "Approved by an
// admin" notification is a notice, not this mark, and still reaches them.

/** The verification state only admins are sent. */
export const ADMIN_ONLY_STATE = 'admin_approved';

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
};

const isAdminApproval = (value: unknown): boolean => isPlainObject(value) && value.state === ADMIN_ONLY_STATE;

/**
 * `value` without any `verification` whose state is `admin_approved`, at any depth (a list's items, an entry's job): the
 * same object where nothing is dropped, a copy along the path where something is.
 */
export function withoutAdminApproval<T>(value: T): T {
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item: unknown) => {
      const next = withoutAdminApproval(item);
      if (next !== item) changed = true;
      return next;
    });
    return (changed ? out : value) as T;
  }
  if (!isPlainObject(value)) return value;
  let out: Record<string, unknown> | null = null;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'verification' && isAdminApproval(child)) {
      out ??= { ...value };
      delete out.verification;
      continue;
    }
    const next = withoutAdminApproval(child);
    if (next !== child) {
      out ??= { ...value };
      out[key] = next;
    }
  }
  return (out ?? value) as T;
}

/** Whether the request's signed-in person (the actor, never a shared profile's owner) is an administrator. */
export const actorIsAdmin = (req: Request): boolean => actorOf(req).role === 'admin';

/**
 * A router's middleware (after requireUser): for an actor who is not an admin, every JSON answer of the router leaves
 * out the admin-approved state (withoutAdminApproval).
 */
export const adminApprovalForAdminsOnly: RequestHandler = (req, res, next) => {
  if (actorIsAdmin(req)) return next();
  const json = res.json.bind(res) as Response['json'];
  res.json = ((body?: unknown) => json(withoutAdminApproval(body))) as Response['json'];
  next();
};
