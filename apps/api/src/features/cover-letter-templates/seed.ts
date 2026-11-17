import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { escapeHtml, LETTER_FONT_NAMES } from '@tailorit/shared';
import { nowIso, type AppDeps } from '../../core/context';
import { staticDir } from '../../core/paths';
import { letterText } from '../cover-letters/sanitize';
import { setSystemOrder } from './repository';

// TailorIT's starter templates (static/letter-templates/*.json, our own text), upserted by system_key at every start:
// a new file is added, a changed one updated, an unchanged one left alone (its times stay). Two processes may seed at
// once (the API and the worker at an empty install's first start): the insert skips a row the other one wrote.

const BlockSchema = z.union([
  z.string(),
  z.object({
    tag: z.enum(['p', 'h1', 'h2', 'h3']).default('p'),
    align: z.enum(['left', 'center', 'right', 'justify']).optional(),
    text: z.string(),
  }),
]);

const StarterSchema = z.object({
  systemKey: z.string().regex(/^[a-z0-9-]+$/),
  position: z.number().int(),
  name: z.string().min(3).max(200),
  fontFamily: z.enum(LETTER_FONT_NAMES),
  aiPrompt: z.string().max(1000),
  blocks: z.array(BlockSchema).min(1),
});
export type StarterTemplate = z.infer<typeof StarterSchema>;

let starters: StarterTemplate[] | null = null;

/** The starter templates, in position order (read once). */
export function starterTemplates(): StarterTemplate[] {
  if (starters) return starters;
  const dir = staticDir('letter-templates');
  starters = readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      const parsed = StarterSchema.safeParse(JSON.parse(readFileSync(join(dir, file), 'utf8')));
      if (!parsed.success) throw new Error(`static/letter-templates/${file} is not a valid starter template: ${parsed.error.message}`);
      return parsed.data;
    })
    .sort((a, b) => a.position - b.position);
  return starters;
}

/** A starter's blocks as editor HTML; `{{NAME}}` survives escaping untouched. */
export function starterHtml(template: StarterTemplate): string {
  return template.blocks
    .map((block) => {
      const { tag, align, text } = typeof block === 'string' ? { tag: 'p' as const, align: undefined, text: block } : block;
      const style = align ? ` style="text-align: ${align}"` : '';
      return `<${tag}${style}>${escapeHtml(text)}</${tag}>`;
    })
    .join('');
}

interface ExistingRow {
  id: string;
  name: string;
  content_html: string;
  font_family: string;
  ai_prompt: string;
}

/** Inserts or refreshes every starter as a system template. Returns how many rows it wrote. */
export async function seedSystemTemplates(deps: Pick<AppDeps, 'db' | 'now'>): Promise<number> {
  const list = starterTemplates();
  setSystemOrder(list.map((template) => template.systemKey));
  const now = nowIso(deps);
  return deps.db.tx(async (t) => {
    let written = 0;
    for (const template of list) {
      const html = starterHtml(template);
      const existing = await t.one<ExistingRow>(
        'SELECT id, name, content_html, font_family, ai_prompt FROM cover_letter_templates WHERE system_key = ?',
        [template.systemKey],
      );
      if (!existing) {
        // v30 FIX-B (BEH-9): the API and the ingest worker both run this at their first start on an empty install; the
        // slower one's INSERT waits for the other's and then writes nothing (no 23505, no exit at first start).
        const inserted = await t.run(
          `INSERT INTO cover_letter_templates(id, user_id, is_system, system_key, name, content_html, content_text,
               font_family, ai_prompt, origin, created_at, updated_at, last_edited_at)
             VALUES (?, NULL, ${t.dialect.true}, ?, ?, ?, ?, ?, ?, 'system', ?, ?, NULL)
             ON CONFLICT (system_key) DO NOTHING`, // v30 PG-0: a flag literal both engines read
          [randomUUID(), template.systemKey, template.name, html, letterText(html), template.fontFamily, template.aiPrompt, now, now],
        );
        written += inserted.changes;
        continue;
      }
      const changed =
        existing.name !== template.name ||
        existing.content_html !== html ||
        existing.font_family !== template.fontFamily ||
        existing.ai_prompt !== template.aiPrompt;
      if (!changed) continue;
      await t.run(
        `UPDATE cover_letter_templates SET name = ?, content_html = ?, content_text = ?, font_family = ?, ai_prompt = ?,
             updated_at = ? WHERE id = ?`,
        [template.name, html, letterText(html), template.fontFamily, template.aiPrompt, now, existing.id],
      );
      written += 1;
    }
    return written;
  }, { label: 'seed system letter templates' });
}
