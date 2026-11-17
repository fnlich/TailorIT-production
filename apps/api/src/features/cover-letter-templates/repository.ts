import { randomUUID } from 'node:crypto';
import {
  templatePreviewText,
  type LetterTemplateDetail,
  type LetterTemplateSummary,
  type TemplateOrigin,
} from '@tailorit/shared';
import { nowIso, type AppDeps } from '../../core/context';
import type { Dialect } from '../../core/db/index';
import { AppError, notFound } from '../../core/http/errors';
import { letterText } from '../cover-letters/sanitize';

// The cover_letter_templates table. A person sees the system templates and their own; another account's template is
// "not found", and a system template cannot be changed or deleted (403 system_template_read_only).
// v3.0 PG-E: `is_system` is a boolean on PostgreSQL (0/1 on SQLite): rows are read as booleans (`templateRowOf`), and
// the SQL spells the flag through the dialect.

export interface TemplateRow {
  id: string;
  user_id: string | null;
  is_system: boolean;
  system_key: string | null;
  name: string;
  content_html: string;
  content_text: string;
  font_family: string;
  ai_prompt: string;
  origin: TemplateOrigin;
  created_at: string;
  updated_at: string;
  last_edited_at: string | null;
}

export const SYSTEM_READ_ONLY =
  'System templates cannot be changed. Duplicate it to make your own copy, then edit the copy.';

export function systemReadOnly(): AppError {
  return new AppError('system_template_read_only', SYSTEM_READ_ONLY);
}

export function toTemplateSummary(row: TemplateRow): LetterTemplateSummary {
  return {
    id: row.id,
    name: row.name,
    isSystem: row.is_system,
    preview: templatePreviewText(row.content_text),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastEditedAt: row.last_edited_at,
  };
}

export function toTemplateDetail(row: TemplateRow): LetterTemplateDetail {
  return {
    ...toTemplateSummary(row),
    contentHtml: row.content_html,
    fontFamily: row.font_family,
    aiPrompt: row.ai_prompt,
  };
}

export interface NewTemplate {
  name: string;
  origin: Exclude<TemplateOrigin, 'system'>;
  contentHtml?: string;
  fontFamily?: string;
  aiPrompt?: string;
}

export interface TemplateChanges {
  name?: string;
  contentHtml?: string;
  fontFamily?: string;
  aiPrompt?: string;
  edited?: boolean;
}

/** System templates in their seeded order (position in static/letter-templates), set by the seed. */
let systemOrder: Map<string, number> = new Map();
export function setSystemOrder(keys: readonly string[]): void {
  systemOrder = new Map(keys.map((key, index) => [key, index]));
}

const SELECT_VISIBLE = (d: Dialect) =>
  `SELECT * FROM cover_letter_templates WHERE id = ? AND (is_system = ${d.true} OR user_id = ?)`;
const SELECT_LIST = (d: Dialect) => `SELECT * FROM cover_letter_templates WHERE is_system = ${d.true} OR user_id = ?`;
const INSERT_TEMPLATE = `INSERT INTO cover_letter_templates(id, user_id, is_system, system_key, name, content_html, content_text,
           font_family, ai_prompt, origin, created_at, updated_at, last_edited_at)
         VALUES (@id, @user_id, @is_system, @system_key, @name, @content_html, @content_text, @font_family, @ai_prompt,
           @origin, @created_at, @updated_at, @last_edited_at)`;
const DELETE_OWN = (d: Dialect) => `DELETE FROM cover_letter_templates WHERE id = ? AND user_id = ? AND is_system = ${d.false}`;

/** A row as read (its flag 0/1 on SQLite, a boolean on PostgreSQL) with the flag as a boolean. */
function templateRowOf(d: Dialect, row: Omit<TemplateRow, 'is_system'> & { is_system: unknown }): TemplateRow {
  return { ...row, is_system: d.isTrue(row.is_system) };
}

/** System templates first (seeded order), then the account's own, newest first. */
function sortTemplates(rows: TemplateRow[]): TemplateRow[] {
  const rank = (row: TemplateRow) => systemOrder.get(row.system_key ?? '') ?? Number.MAX_SAFE_INTEGER;
  return rows.sort((a, b) => {
    if (a.is_system !== b.is_system) return Number(b.is_system) - Number(a.is_system);
    if (a.is_system) return rank(a) - rank(b) || a.name.localeCompare(b.name);
    return b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id);
  });
}

/** A new template's row. */
function newRow(deps: Pick<AppDeps, 'now'>, userId: string, template: NewTemplate): TemplateRow {
  const now = nowIso(deps);
  const html = template.contentHtml ?? '';
  return {
    id: randomUUID(),
    user_id: userId,
    is_system: false,
    system_key: null,
    name: template.name,
    content_html: html,
    content_text: letterText(html),
    font_family: template.fontFamily ?? 'Times New Roman',
    ai_prompt: template.aiPrompt ?? '',
    origin: template.origin,
    created_at: now,
    updated_at: now,
    last_edited_at: null,
  };
}

/** The UPDATE of a template's changes and its named parameters. */
function updateOf(deps: Pick<AppDeps, 'now'>, d: Dialect, id: string, userId: string, changes: TemplateChanges) {
  const sets: string[] = [];
  const params: Record<string, string> = { id, userId, now: nowIso(deps) };
  if (changes.name !== undefined) {
    sets.push('name = @name');
    params.name = changes.name;
  }
  if (changes.contentHtml !== undefined) {
    sets.push('content_html = @content_html', 'content_text = @content_text');
    params.content_html = changes.contentHtml;
    params.content_text = letterText(changes.contentHtml);
  }
  if (changes.fontFamily !== undefined) {
    sets.push('font_family = @font_family');
    params.font_family = changes.fontFamily;
  }
  if (changes.aiPrompt !== undefined) {
    sets.push('ai_prompt = @ai_prompt');
    params.ai_prompt = changes.aiPrompt;
  }
  if (changes.edited) sets.push('last_edited_at = @now');
  sets.push('updated_at = @now');
  return {
    sql: `UPDATE cover_letter_templates SET ${sets.join(', ')} WHERE id = @id AND user_id = @userId AND is_system = ${d.false}`,
    params,
  };
}

/**
 * The cover letter templates of an account, through the async client.
 */
export function createTemplateRepository(deps: Pick<AppDeps, 'db' | 'now'>) {
  const { db } = deps;
  const d = db.dialect;

  /** A template the account may see (system or its own). */
  const getVisible = async (id: string, userId: string) => {
    const row = await db.one<TemplateRow>(SELECT_VISIBLE(d), [id, userId]);
    return row && templateRowOf(d, row);
  };

  const requireVisible = async (id: string, userId: string): Promise<TemplateRow> => {
    const row = await getVisible(id, userId);
    if (!row) throw notFound('That template');
    return row;
  };

  return {
    requireVisible,

    /** One of the account's own templates; a system template is 403, anything else 404. */
    async requireOwn(id: string, userId: string): Promise<TemplateRow> {
      const row = await requireVisible(id, userId);
      if (row.is_system) throw systemReadOnly();
      return row;
    },

    /** System templates first (seeded order), then the account's own, newest first. */
    async list(userId: string): Promise<TemplateRow[]> {
      return sortTemplates((await db.all<TemplateRow>(SELECT_LIST(d), [userId])).map((row) => templateRowOf(d, row)));
    },

    async create(userId: string, template: NewTemplate): Promise<TemplateRow> {
      const row = newRow(deps, userId, template);
      await db.run(INSERT_TEMPLATE, { ...row });
      return row;
    },

    async update(id: string, userId: string, changes: TemplateChanges): Promise<TemplateRow> {
      const { sql, params } = updateOf(deps, d, id, userId, changes);
      const result = await db.run(sql, params);
      if (result.changes === 0) throw notFound('That template');
      return requireVisible(id, userId);
    },

    async remove(id: string, userId: string): Promise<void> {
      const row = await requireVisible(id, userId);
      if (row.is_system) throw systemReadOnly();
      await db.run(DELETE_OWN(d), [id, userId]);
    },

    /** Deletes the account's own templates among `ids`; system ones are skipped (and reported), others ignored. */
    async removeMany(ids: readonly string[], userId: string): Promise<{ deleted: number; skippedIds: string[] }> {
      return db.tx(
        async (t) => {
          let deleted = 0;
          const skippedIds: string[] = [];
          for (const id of new Set(ids)) {
            const row = await t.one<TemplateRow>(SELECT_VISIBLE(d), [id, userId]);
            if (!row) continue;
            if (d.isTrue(row.is_system)) {
              skippedIds.push(id);
              continue;
            }
            deleted += (await t.run(DELETE_OWN(d), [id, userId])).changes;
          }
          return { deleted, skippedIds };
        },
        { label: 'remove letter templates' },
      );
    },
  };
}

export type TemplateRepository = ReturnType<typeof createTemplateRepository>;

