import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { constantDefault, normalizeJobsQuery, renderMessage, type JobsQuery, type SavedSearch } from '@tailorit/shared';
import { z } from 'zod';
import { requireUser, userOf } from '../../core/auth/guards';
import { nowIso, type AppDeps } from '../../core/context';
import { constantsOf } from '../../core/constants/service';
import { notFound } from '../../core/http/errors';
import { refuse } from '../../core/http/refuse';
import { parseInput } from '../../core/http/validate';
import { isoTimestamp } from './rows';

// Saved searches (the toolbar's bookmark): a name and the page's filters. The query is stored in its canonical form
// (`normalizeJobsQuery`) without a cursor, and normalized again on the way out, so a value the taxonomy no longer has
// quietly drops out instead of breaking the list. v3.0 D2-C: through the async client.

// v30 ST3: the most an account keeps is the constant SAVED_SEARCHES_MAX (read at each save) and its refusal
// MSG_SAVED_SEARCHES_MAX; a name's length words are MSG_TEXT_TOO_LONG's (its default: the schema is made once).
const NAME_MAX = 100;
const NameSchema = z
  .string()
  .trim()
  .min(1, 'Give the search a name')
  .max(NAME_MAX, renderMessage(constantDefault('MSG_TEXT_TOO_LONG'), { max: NAME_MAX }));
const CreateBodySchema = z.object({ name: NameSchema, query: z.unknown().optional() });
const RenameBodySchema = z.object({ name: NameSchema });
const IdParam = z.string().min(1).max(64);

interface SavedSearchRow {
  id: string;
  name: string;
  query: string;
  created_at: string;
}

/** The stored filters without a cursor (a saved search always starts at the top). */
export function savedQueryOf(input: unknown): JobsQuery {
  const { cursor: _cursor, ...query } = normalizeJobsQuery(input);
  return { ...query, cursor: undefined };
}

function toSavedSearch(row: SavedSearchRow): SavedSearch {
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(row.query);
  } catch {
    parsed = {};
  }
  return {
    id: row.id,
    name: row.name,
    query: savedQueryOf(parsed),
    createdAt: isoTimestamp(row.created_at) ?? row.created_at,
  };
}

function storedJson(query: JobsQuery): string {
  const { cursor: _cursor, ...rest } = query;
  return JSON.stringify(rest);
}

/** Mounted at /api/saved-searches. */
export function createSavedSearchesRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireUser);

  const load = async (userId: string, id: string): Promise<SavedSearchRow> => {
    const row = await deps.db.one<SavedSearchRow>('SELECT id, name, query, created_at FROM saved_searches WHERE id = ? AND user_id = ?', [
      id,
      userId,
    ]);
    if (!row) throw notFound('That saved search');
    return row;
  };

  router.get('/', async (req, res) => {
    const user = userOf(req);
    const rows = await deps.db.all<SavedSearchRow>(
      'SELECT id, name, query, created_at FROM saved_searches WHERE user_id = ? ORDER BY created_at DESC, id',
      [user.id],
    );
    res.json({ items: rows.map(toSavedSearch), total: rows.length });
  });

  router.post('/', async (req, res) => {
    const user = userOf(req);
    const body = parseInput(CreateBodySchema, req.body, 'saved search');
    const row: SavedSearchRow = {
      id: randomUUID(),
      name: body.name,
      query: storedJson(savedQueryOf(body.query ?? {})),
      created_at: nowIso(deps),
    };
    // Count, then insert: behind the person's lock, so two saves at once never pass the limit together (v3.0 D2-C).
    await deps.db.tx(
      async (t) => {
        await t.lockPerson(user.id);
        const count = (await t.one<{ n: number }>('SELECT COUNT(*) AS n FROM saved_searches WHERE user_id = ?', [user.id]))!.n;
        const max = constantsOf(deps).get('SAVED_SEARCHES_MAX');
        if (count >= max) throw refuse(deps, 'conflict', 'MSG_SAVED_SEARCHES_MAX', { max });
        await t.run('INSERT INTO saved_searches(id, user_id, name, query, created_at) VALUES (?, ?, ?, ?, ?)', [
          row.id,
          user.id,
          row.name,
          row.query,
          row.created_at,
        ]);
      },
      { label: 'saveSearch' },
    );
    res.status(201).json(toSavedSearch(row));
  });

  router.patch('/:id', async (req, res) => {
    const user = userOf(req);
    const id = IdParam.safeParse(req.params.id);
    if (!id.success) throw notFound('That saved search');
    const body = parseInput(RenameBodySchema, req.body, 'saved search');
    await load(user.id, id.data);
    await deps.db.run('UPDATE saved_searches SET name = ? WHERE id = ? AND user_id = ?', [body.name, id.data, user.id]);
    res.json(toSavedSearch(await load(user.id, id.data)));
  });

  router.delete('/:id', async (req, res) => {
    const user = userOf(req);
    const id = IdParam.safeParse(req.params.id);
    if (!id.success) throw notFound('That saved search');
    await load(user.id, id.data);
    await deps.db.run('DELETE FROM saved_searches WHERE id = ? AND user_id = ?', [id.data, user.id]);
    res.status(204).end();
  });

  return router;
}
