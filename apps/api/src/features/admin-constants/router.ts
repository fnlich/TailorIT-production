import type { Router } from 'express';
import { z } from 'zod';
import { AdminConstantSetBodySchema, isConstantKey, type AdminConstantList, type ConstantKey } from '@tailorit/shared';
import { adminRouter } from '../../core/admin/index';
import { constantsOf } from '../../core/constants/index';
import type { AppDeps } from '../../core/context';
import { AppError } from '../../core/http/errors';
import { parseInput } from '../../core/http/validate';

// v2.0: Admin › Constants (docs/design/v2.0/02-constants.md, "The resolution service"; 08-ui.md). Every constant with
// its value, source, .env key, default and editability; an override is validated by the constants service
// (validateConstant: the kind, the bounds, a message's placeholders) and applies to the next request, with no restart.
// v30 ST4: an adminRouter (core/admin): its guard, and an audit line for each change.

/** A key the URL names: 404 for one that is no constant. */
function keyOf(raw: string | undefined): ConstantKey {
  const key = (raw ?? '').trim();
  if (!isConstantKey(key)) throw new AppError('not_found', 'There is no such constant.');
  return key;
}

/**
 * v2.0 FIX-INT (UX-12): who changed an override, by email (app_settings keeps the admin's user id); null once the
 * admin's account is gone.
 */
async function withAdminEmails<T extends { updatedBy: string | null }>(deps: AppDeps, rows: T[]): Promise<T[]> {
  const ids = [...new Set(rows.map((row) => row.updatedBy).filter((id): id is string => id !== null))];
  if (ids.length === 0) return rows;
  const found = await deps.db.all<{ id: string; email: string }>(
    `SELECT id, email FROM users WHERE id IN (${deps.db.dialect.list(ids.length)})`,
    ids,
  );
  const emails = new Map(found.map((user) => [user.id, user.email]));
  return rows.map((row) => (row.updatedBy === null ? row : { ...row, updatedBy: emails.get(row.updatedBy) ?? null }));
}

/** Mounted at /api/admin/constants (admin only). */
export function createAdminConstantsRouter(deps: AppDeps): Router {
  return adminRouter(deps, {
    resource: 'constant',
    list: {
      query: z.object({}),
      run: async () => {
        const constants = constantsOf(deps);
        const body: AdminConstantList = { items: await withAdminEmails(deps, constants.list()), version: constants.version() };
        return body;
      },
    },
    routes(router, { handle, audit }) {
      router.put(
        '/:key',
        handle(async (req, admin) => {
          const key = keyOf(req.params.key);
          const { value } = parseInput(AdminConstantSetBodySchema, req.body ?? {}, 'value');
          if (value === undefined) {
            throw new AppError('validation_failed', 'Send the new value.', { fields: { value: 'Send the new value.' } });
          }
          const row = await constantsOf(deps).set(key, value, admin.id);
          // A per-hour or batch limit may have changed: Prepare's runner reads the constants again now.
          deps.services.prepare?.kick();
          await audit({ action: 'set', ids: [key], actor: admin, change: { value } });
          return (await withAdminEmails(deps, [row]))[0];
        }),
      );

      router.delete(
        '/:key',
        handle(async (req, admin) => {
          const key = keyOf(req.params.key);
          const row = await constantsOf(deps).clear(key, admin.id);
          deps.services.prepare?.kick();
          await audit({ action: 'clear', ids: [key], actor: admin, change: null });
          return (await withAdminEmails(deps, [row]))[0];
        }),
      );
    },
  });
}
