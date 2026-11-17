import type { Router } from 'express';
import { z } from 'zod';
import {
  AdminCompaniesQuerySchema,
  AdminCompanyEditBodySchema,
  AdminCompanyMatchDecisionBodySchema,
  AdminCompanyMatchReviewsQuerySchema,
  AdminCompanyMergeBodySchema,
  AdminCompanyOptOutBodySchema,
  AdminCompanyRefreshBodySchema,
  AdminCompanySplitBodySchema,
  AdminCursorSchema,
  AdminOptOutCreateBodySchema,
  AdminPageSizeSchema,
  COMPANY_PROFILE_FIELDS,
  JOB_SOURCE_KINDS,
  RegistrableDomainSchema,
  normalizeCompanyName,
  type AdminCompaniesQuery,
  type AdminCompany,
  type AdminCompanyEditBody,
  type AdminCompanyField,
  type AdminCompanyMatchReview,
  type AdminCompanyRow,
  type CompanyProfileField,
  type JobSourceKind,
} from '@tailorit/shared';
import { adminRouter, PositiveId, type AdminActor } from '../../core/admin/resource';
import type { AppDeps } from '../../core/context';
import type { DbQueries, DbTx } from '../../core/db/types';
import { getFileStore } from '../../core/files/store';
import { conflict, notFound, validationFailed } from '../../core/http/errors';
import { parseInput } from '../../core/http/validate';
import { logoUrlOf } from '../jobs/rows';
import { projectJobs } from '../jobs/search-projection/index';
import { addAlias, boardAliasOfSource, survivorOf } from './aliases';
import { recountCompanyJobs } from './counts';
import { storeLogo } from './logos';
import { mergeCompanies, moveSources } from './merge';
import { addOptOut, listOptOuts, optOutAfterMerge, removeOptOut, setOptOut } from './opt-out';
import {
  candidatesOf,
  cleanFields,
  groupOf,
  minConfidenceOf,
  profileOfRow,
  profileRowOf,
  recomputeProfile,
  sourcesOf,
  stableJson,
  upsertSource,
  valuesOfRow,
  type ProfileFields,
} from './profile';
import { NEW_COMPANY_STEPS, newCompany, queueEnrichment } from './resolve';
import { refreshCompanySearchIn } from './search-refresh'; // v30 FIX-PERF (PGL-19)

// v30 E0-API: Admin › Companies' API (docs/design/part2/13-company-enrichment.md §6.4, §5.5; the shared contracts of
// packages/shared/src/companies/schemas.ts), on adminRouter (administrators only, audited):
//   /api/admin/companies
//     GET    /                 ?q&filter=all|open_jobs|needs_review|opted_out|merged&cursor&limit: AdminCompaniesList
//     GET    /:id              the editor's company (AdminCompany): each field with its source, confidence, lock and
//                              the other candidates; its keys, sources, boards, parents and children, counts
//     PATCH  /:id              AdminCompanyEditBody: set values (each then locked), lock, unlock -> AdminCompany
//     POST   /:id/merge        {otherId}: the other company merges into this one -> AdminCompany
//     POST   /:id/split        {sourceIds, name}: those boards and their jobs to a new company -> the new AdminCompany
//     POST   /:id/refresh      {steps?}: queues the enrichment steps -> {queued}
//     PUT    /:id/opt-out      {doNotFetch, reason}: the opt-out switch -> AdminCompany
//     PUT    /:id/logo         multipart `logo` (PNG, JPEG, WebP, GIF): the admin's logo, stored and locked -> AdminCompany
//     DELETE /:id/logo         the logo removed (locked empty) -> AdminCompany
//   /api/admin/company-reviews
//     GET    /                 ?status=open|accepted|rejected|all&kind&cursor&limit: AdminCompanyMatchReviewsList
//     POST   /:id              {decision: accept|reject|reopen} -> AdminCompanyMatchReview
//   /api/admin/company-opt-outs
//     GET    /                 ?cursor&limit: AdminOptOutList
//     POST   /                 AdminOptOutCreateBody -> AdminOptOut
//     DELETE /:domain          -> {removed}
// Every change that moves jobs or the values search copies re-projects those jobs in its transaction.

const Id = PositiveId;
/** The confidence of a key an admin confirmed (a corroborated domain, a Wikidata match by a strong key: 13 §6.2). */
const CONFIRMED_KEY = 90;
const nowOf = (deps: Pick<AppDeps, 'now'>) => deps.now().toISOString();

// ── The editor's company ───────────────────────────────────────────────────────────────────────────────────────────

interface CompanyRow {
  id: number;
  name: string;
  owner_user_id: string | null;
  do_not_fetch: boolean;
  merged_into_id: number | null;
  updated_at: string;
}

async function companyRowOf(t: DbQueries, id: number, forUpdate = false): Promise<CompanyRow | undefined> {
  return t.one<CompanyRow>(
    `SELECT id, name, owner_user_id, do_not_fetch, merged_into_id, updated_at FROM companies WHERE id = ?${forUpdate ? ' FOR UPDATE' : ''}`,
    [id],
  );
}

/** A shared company the editor may change (never an account's own row; never a merged one). */
async function editableCompany(t: DbQueries, id: number): Promise<CompanyRow> {
  const row = await companyRowOf(t, id, true);
  if (!row || row.owner_user_id !== null) throw notFound('That company');
  if (row.merged_into_id !== null) throw conflict(`That company was merged into company ${row.merged_into_id}. Edit that one.`);
  return row;
}

const parseList = (text: string | null | undefined): unknown[] => {
  try {
    const value: unknown = text ? JSON.parse(text) : [];
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
};

const parseObject = (text: string | null | undefined): Record<string, unknown> => {
  try {
    const value: unknown = text ? JSON.parse(text) : {};
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** AdminCompany: the editor's view of one company (any company, merged or not, that is no account's own row). */
export async function adminCompany(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>, id: number): Promise<AdminCompany | null> {
  const db = deps.db;
  const company = await companyRowOf(db, id);
  if (!company || company.owner_user_id !== null) return null;
  const row = await profileRowOf(db, id);
  const profile = profileOfRow(row);
  const provenance = parseObject(row?.provenance);
  const confidence = parseObject(row?.confidence);
  const conflicts = parseObject(row?.conflicts);
  const locked = new Set(parseList(row?.locked_fields).filter((field): field is string => typeof field === 'string'));
  const sources = await sourcesOf(db, id);
  const kindOf = new Map(sources.map((source) => [source.id, source.kind]));
  const minConfidence = minConfidenceOf(deps);
  const fields: AdminCompanyField[] = COMPANY_PROFILE_FIELDS.map((field) => {
    const candidates = candidatesOf(field, sources);
    const used = (profile as Record<string, unknown>)[field];
    const inUse = field === 'otherLinks' ? (used as unknown[]).length > 0 : used !== null && used !== undefined;
    const sourceId = typeof provenance[field] === 'number' ? (provenance[field] as number) : null;
    const below = !inUse ? candidates.find((candidate) => candidate.sourceKind !== 'admin') : undefined;
    const fieldConfidence = typeof confidence[field] === 'number' ? (confidence[field] as number) : (below?.confidence ?? null);
    return {
      field,
      value: inUse ? used : (below?.value ?? (field === 'otherLinks' ? [] : null)),
      sourceId: inUse ? sourceId : (below?.sourceId ?? null),
      sourceKind: inUse ? ((sourceId !== null ? kindOf.get(sourceId) : undefined) ?? null) : (below?.sourceKind ?? null),
      confidence: fieldConfidence,
      // v30 FIX-WEB (REV-UX UX-14): the name people know is always shown, whatever its confidence.
      shown: field === 'displayName' || (inUse && (locked.has(field) || (fieldConfidence ?? 0) >= minConfidence)),
      locked: locked.has(field),
      conflict: Object.hasOwn(conflicts, field),
      candidates: candidates.slice(0, 20).map(({ sourceId: candidateId, sourceKind, value, confidence: score }) => ({
        sourceId: candidateId,
        sourceKind,
        value,
        confidence: score,
      })),
    };
  });
  const aliases = await db.all<{ kind: string; value: string; confidence: number; is_primary: boolean; source_id: number | null; valid_from: string | null; valid_to: string | null }>(
    'SELECT kind, value, confidence, is_primary, source_id, valid_from, valid_to FROM company_aliases WHERE company_id = ? ORDER BY kind, value',
    [id],
  );
  const sourceRows = await db.all<{
    id: number;
    kind: string;
    ref: string;
    licence: string;
    attribution: string | null;
    match_confidence: number;
    status: string;
    retrieved_at: string;
    expires_at: string | null;
    purge_group: string | null;
  }>(
    `SELECT id, kind, ref, licence, attribution, match_confidence, status, retrieved_at, expires_at, purge_group
     FROM company_sources WHERE company_id = ? ORDER BY id`,
    [id],
  );
  const boards = await db.all<{ id: number; kind: string; name: string; enabled: boolean; open_jobs: number }>(
    `SELECT s.id, s.kind, s.name, s.enabled,
       (SELECT count(*)::int FROM job_source_links l JOIN jobs j ON j.id = l.job_id
         WHERE l.source_id = s.id AND l.missing_since IS NULL AND j.active /* held_since: held jobs count (the admin's view of a board) */) AS open_jobs
     FROM job_sources s WHERE s.company_id = ? ORDER BY s.id`,
    [id],
  );
  const relations = await db.all<{ parent_id: number; child_id: number; kind: string; confidence: number; name: string; other: number }>(
    `SELECT r.parent_id, r.child_id, r.kind, r.confidence, o.name, o.id AS other
     FROM company_relations r JOIN companies o ON o.id = CASE WHEN r.parent_id = ? THEN r.child_id ELSE r.parent_id END
     WHERE r.parent_id = ? OR r.child_id = ? ORDER BY r.confidence DESC, o.id`,
    [id, id, id],
  );
  const counts = await db.one<{ open_jobs: number; closed_jobs: number; reviews: number }>(
    `SELECT count(*) FILTER (WHERE j.active AND j.held_since IS NULL)::int AS open_jobs, count(*) FILTER (WHERE NOT j.active)::int AS closed_jobs,
       (SELECT count(*)::int FROM company_match_reviews r WHERE r.status = 'open' AND (r.company_id = ? OR r.other_company_id = ?)) AS reviews
     FROM jobs j WHERE j.company_id = ? AND j.owner_user_id IS NULL`,
    [id, id, id],
  );
  const iso = (value: string | null | undefined) => (value ? new Date(value).toISOString() : null);
  const relation = (r: (typeof relations)[number]) => ({
    company: { id: r.other, name: r.name },
    kind: r.kind as 'subsidiary' | 'brand' | 'acquired',
    confidence: Math.max(0, Math.min(100, r.confidence)),
  });
  return {
    id,
    name: company.name,
    doNotFetch: company.do_not_fetch,
    mergedIntoId: company.merged_into_id,
    profile,
    fields,
    aliases: aliases.map((alias) => ({
      kind: alias.kind as AdminCompany['aliases'][number]['kind'],
      value: alias.value,
      confidence: alias.confidence,
      isPrimary: alias.is_primary,
      sourceId: alias.source_id,
      validFrom: alias.valid_from,
      validTo: alias.valid_to,
    })),
    sources: sourceRows.map((source) => ({
      id: source.id,
      kind: source.kind as AdminCompany['sources'][number]['kind'],
      ref: source.ref,
      licence: source.licence as AdminCompany['sources'][number]['licence'],
      attribution: source.attribution,
      matchConfidence: source.match_confidence,
      status: source.status as AdminCompany['sources'][number]['status'],
      retrievedAt: iso(source.retrieved_at)!,
      expiresAt: iso(source.expires_at),
      purgeGroup: source.purge_group,
    })),
    boards: boards
      .filter((board) => (JOB_SOURCE_KINDS as readonly string[]).includes(board.kind))
      .map((board) => ({ sourceId: board.id, kind: board.kind as JobSourceKind, name: board.name, enabled: board.enabled, openJobs: board.open_jobs })),
    parents: relations.filter((r) => r.child_id === id).map(relation),
    children: relations.filter((r) => r.parent_id === id).map(relation),
    counts: { openJobs: counts?.open_jobs ?? 0, closedJobs: counts?.closed_jobs ?? 0 },
    openReviews: counts?.reviews ?? 0,
    enrichedAt: iso(row?.enriched_at),
    nextRefreshAt: iso(row?.next_refresh_at),
    updatedAt: iso(company.updated_at)!,
  };
}

/** The editor's company after a change, or 404. */
async function changed(deps: AppDeps, id: number): Promise<AdminCompany> {
  const company = await adminCompany(deps, id);
  if (!company) throw notFound('That company');
  return company;
}

/**
 * Recomputes a company's profile in `t`, projects the jobs moved to it, and has its open jobs' search rows follow a
 * value search copies (v30 FIX-PERF PGL-19: their company columns, or their whole rows when its name changed).
 */
async function settle(deps: AppDeps, t: DbTx, companyId: number, at: string, moved: readonly number[] = []): Promise<void> {
  const result = await recomputeProfile(t, companyId, at, minConfidenceOf(deps));
  await projectJobs(t, [...new Set(moved)]);
  await refreshCompanySearchIn(t, companyId, result);
}

// ── The list ───────────────────────────────────────────────────────────────────────────────────────────────────────

const FILTER_SQL: Record<AdminCompaniesQuery['filter'], string> = {
  all: 'c.merged_into_id IS NULL',
  open_jobs: 'c.merged_into_id IS NULL AND COALESCE(k.open_jobs, 0) > 0',
  needs_review: `c.merged_into_id IS NULL AND EXISTS (SELECT 1 FROM company_match_reviews r WHERE r.status = 'open' AND (r.company_id = c.id OR r.other_company_id = c.id))`,
  opted_out: 'c.do_not_fetch',
  merged: 'c.merged_into_id IS NOT NULL',
};

export async function listAdminCompanies(deps: Pick<AppDeps, 'db'>, query: AdminCompaniesQuery) {
  const db = deps.db;
  const where = ['c.owner_user_id IS NULL', FILTER_SQL[query.filter]];
  const params: unknown[] = [];
  if (query.q) {
    const pattern = `%${query.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    where.push(`(${db.dialect.like('c.name', '?')} OR ${db.dialect.like('p.domain', '?')})`);
    params.push(pattern, pattern);
  }
  const from = `FROM companies c LEFT JOIN company_profiles p ON p.company_id = c.id LEFT JOIN company_job_counts k ON k.company_id = c.id
    WHERE ${where.join(' AND ')}`;
  const total = (await db.one<{ n: number }>(`SELECT count(*)::int AS n ${from}`, params as never))!.n;
  const after = query.cursor && /^\d+$/.test(query.cursor) ? Number(query.cursor) : null;
  const rows = await db.all<{
    id: number;
    name: string;
    domain: string | null;
    logo_path: string | null;
    open_jobs: number | null;
    closed_jobs: number | null;
    do_not_fetch: boolean;
    merged_into_id: number | null;
    reviews: number;
    updated_at: string;
  }>(
    `SELECT c.id, c.name, p.domain, p.logo_path, k.open_jobs, k.closed_jobs, c.do_not_fetch, c.merged_into_id, c.updated_at,
       (SELECT count(*)::int FROM company_match_reviews r WHERE r.status = 'open' AND (r.company_id = c.id OR r.other_company_id = c.id)) AS reviews
     ${from} ${after === null ? '' : 'AND c.id < ?'}
     ORDER BY c.id DESC LIMIT ?`,
    [...params, ...(after === null ? [] : [after]), query.limit + 1] as never,
  );
  const page = rows.slice(0, query.limit);
  const items: AdminCompanyRow[] = page.map((row) => ({
    id: row.id,
    name: row.name,
    domain: row.domain,
    logoUrl: logoUrlOf(row.logo_path),
    openJobs: row.open_jobs ?? 0,
    closedJobs: row.closed_jobs ?? 0,
    doNotFetch: row.do_not_fetch,
    mergedIntoId: row.merged_into_id,
    openReviews: row.reviews,
    updatedAt: new Date(row.updated_at).toISOString(),
  }));
  const last = page[page.length - 1];
  return { items, total, ...(rows.length > query.limit && last ? { nextCursor: String(last.id) } : {}) };
}

// ── Edits ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A value an admin left empty: nothing, blank text or an empty list. */
const isEmptyValue = (value: unknown) =>
  value === null || value === undefined || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0);

/** The fields an edit names, each with the rest of its group (a group's fields come from one source together). */
function withGroups(fields: readonly string[]): CompanyProfileField[] {
  const out = new Set<CompanyProfileField>();
  for (const field of fields) {
    if ((COMPANY_PROFILE_FIELDS as readonly string[]).includes(field)) for (const member of groupOf(field as CompanyProfileField)) out.add(member);
  }
  return [...out];
}

/** The admin's source row (its values are the locked fields), read for a change. */
async function adminFieldsOf(t: DbQueries, companyId: number): Promise<Record<string, unknown>> {
  const row = await t.one<{ fields: string }>("SELECT fields FROM company_sources WHERE company_id = ? AND kind = 'admin' AND ref = ''", [companyId]);
  return parseObject(row?.fields);
}

/** Writes the admin's values (or removes the row when none is left). */
async function writeAdminFields(t: DbQueries, companyId: number, fields: Record<string, unknown>, at: string): Promise<void> {
  if (Object.keys(fields).length === 0) {
    await t.run("DELETE FROM company_sources WHERE company_id = ? AND kind = 'admin' AND ref = ''", [companyId]);
    return;
  }
  await upsertSource(t, companyId, { kind: 'admin', ref: '', licence: 'admin', matchConfidence: 100 }, fields as never, at);
}

/** PATCH /api/admin/companies/:id. */
export async function editCompany(deps: AppDeps, id: number, edit: AdminCompanyEditBody): Promise<AdminCompany> {
  const at = nowOf(deps);
  await deps.db.tx(async (t) => {
    await editableCompany(t, id);
    const fields = await adminFieldsOf(t, id);
    const current = valuesOfRow(await profileRowOf(t, id));
    for (const field of withGroups(edit.unlock ?? [])) {
      delete fields[field];
      if (field === 'employees') delete fields.employeesAsOf;
      if (field === 'fundingTotalUsd') delete fields.fundingAsOf;
    }
    for (const field of withGroups(edit.lock ?? [])) {
      if (!Object.hasOwn(fields, field)) fields[field] = current[field] ?? null;
    }
    if (edit.set) {
      // v30 FIX-C UX-5: a field saved empty, or with the value it shows, is no change: it is not locked (an empty lock
      // is asked for with `lock`, which keeps what the field shows).
      const given = Object.fromEntries(
        Object.entries(edit.set as Record<string, unknown>).filter(([key, value]) => {
          if (isEmptyValue(value)) return false;
          // A value the field cannot keep goes on, to be refused below.
          const clean = cleanFields({ [key]: value }, true)[key as keyof ProfileFields] ?? null;
          return clean === null || stableJson(clean) !== stableJson(current[key as keyof typeof current] ?? null);
        }),
      );
      const cleaned = cleanFields(given, true);
      const refused: Record<string, string> = {};
      for (const [key, value] of Object.entries(given)) {
        if (value !== null && value !== undefined && (cleaned as Record<string, unknown>)[key] === null) refused[`set.${key}`] = 'This value cannot be kept for this field.';
      }
      if (Object.keys(refused).length > 0) throw validationFailed('Check the values marked.', refused);
      // A group's other fields keep their values in use (an admin who sets the city keeps the country).
      for (const field of withGroups(Object.keys(given))) {
        if (!Object.hasOwn(given, field) && !Object.hasOwn(fields, field)) fields[field] = current[field] ?? null;
      }
      Object.assign(fields, cleaned);
    }
    await writeAdminFields(t, id, fields, at);
    // A name handed back to its sources: the best source's name (the oldest board's), else the name the admin set.
    if ((edit.unlock ?? []).includes('displayName')) {
      const best = candidatesOf('displayName', await sourcesOf(t, id))[0];
      if (best && typeof best.value === 'string') await t.run('UPDATE companies SET name = ? WHERE id = ?', [best.value, id]);
    }
    await settle(deps, t, id, at);
    await t.run('UPDATE companies SET updated_at = ? WHERE id = ?', [at, id]);
  });
  return changed(deps, id);
}

/** POST /api/admin/companies/:id/merge: `otherId` merges into `id`. */
export async function mergeInto(deps: AppDeps, id: number, otherId: number, actorId: string | null = null): Promise<AdminCompany> {
  if (id === otherId) throw validationFailed('Choose another company to merge into this one.', { otherId: 'Choose another company.' });
  const at = nowOf(deps);
  await deps.db.tx(async (t) => {
    // Both rows locked, in id order (two merges of one pair never wait on each other in a circle).
    const [first, second] = id < otherId ? [id, otherId] : [otherId, id];
    const a = await companyRowOf(t, first, true);
    const b = await companyRowOf(t, second, true);
    const survivor = first === id ? a : b;
    const other = first === id ? b : a;
    if (!survivor || survivor.owner_user_id !== null || !other || other.owner_user_id !== null) throw notFound('That company');
    if (survivor.merged_into_id !== null) throw conflict(`That company was merged into company ${survivor.merged_into_id}. Merge into that one.`);
    if (other.merged_into_id !== null) throw conflict(`The other company was merged into company ${other.merged_into_id} already.`);
    const moved = await mergeCompanies(t, id, otherId, at);
    // v30 FIX-C BEH-3: either opted out: the opt-out reaches what the survivor now has.
    await optOutAfterMerge(deps, t, id, actorId, at);
    await settle(deps, t, id, at, moved);
    await recountCompanyJobs(t, [id, otherId], at);
  });
  return changed(deps, id);
}

/** POST /api/admin/companies/:id/split: the chosen boards and their jobs to a new company named `name`. */
export async function splitCompany(deps: AppDeps, id: number, body: { sourceIds: number[]; name: string }): Promise<AdminCompany> {
  const at = nowOf(deps);
  const newId = await deps.db.tx(async (t) => {
    await editableCompany(t, id);
    const sources = await t.all<{ id: number; kind: string; config: string }>(
      `SELECT id, kind, config FROM job_sources WHERE company_id = ? AND id IN (${t.dialect.list(body.sourceIds.length)})`,
      [id, ...body.sourceIds],
    );
    if (sources.length === 0) throw validationFailed("Choose boards of this company's.", { sourceIds: "Choose this company's boards." });
    const nameKey = normalizeCompanyName(body.name) || body.name.toLowerCase().replace(/\s+/g, '');
    const made = await newCompany(t, body.name, nameKey, at);
    const moved = await moveSources(t, id, made, sources.map((source) => source.id));
    const boards = sources.map((source) => boardAliasOfSource({ kind: source.kind, config: parseObject(source.config) })).filter((alias): alias is string => alias !== null);
    if (boards.length > 0) {
      const list = t.dialect.list(boards.length);
      await t.run(`UPDATE company_aliases SET company_id = ? WHERE company_id = ? AND kind = 'board' AND value IN (${list})`, [made, id, ...boards]);
      await t.run(`UPDATE company_sources SET company_id = ? WHERE company_id = ? AND kind = 'ats_board' AND ref IN (${list})`, [made, id, ...boards]);
    }
    await upsertSource(t, made, { kind: 'admin', ref: '', licence: 'admin', matchConfidence: 100 }, { displayName: body.name }, at);
    await settle(deps, t, made, at, moved);
    await settle(deps, t, id, at);
    await queueEnrichment(t, made, at);
    await recountCompanyJobs(t, [id, made], at);
    return made;
  });
  return changed(deps, newId);
}

/** PUT /api/admin/companies/:id/opt-out. */
export async function optOutCompany(deps: AppDeps, id: number, body: { doNotFetch: boolean; reason: string }, actor: AdminActor): Promise<AdminCompany> {
  await deps.db.tx(async (t) => {
    await editableCompany(t, id);
    await setOptOut(deps, t, id, { doNotFetch: body.doNotFetch, reason: body.reason, actorId: actor.id }, nowOf(deps));
  });
  return changed(deps, id);
}

/** PUT /api/admin/companies/:id/logo (bytes) and DELETE (null): the admin's logo, locked. */
export async function setCompanyLogo(deps: AppDeps, id: number, bytes: Buffer | null, name?: string): Promise<AdminCompany> {
  // The file is written first, outside any transaction; the same bytes are always one file.
  const stored = bytes ? storeLogo(deps, bytes, name) : null;
  const at = nowOf(deps);
  await deps.db.tx(async (t) => {
    await editableCompany(t, id);
    const fields = await adminFieldsOf(t, id);
    fields.logoUrl = stored?.path ?? null;
    await writeAdminFields(t, id, fields, at);
    await t.run('UPDATE company_profiles SET logo_sha256 = ? WHERE company_id = ?', [stored?.sha256 ?? null, id]);
    await settle(deps, t, id, at);
  });
  return changed(deps, id);
}

// ── Match reviews ──────────────────────────────────────────────────────────────────────────────────────────────────

interface ReviewRow {
  id: number;
  kind: AdminCompanyMatchReview['kind'];
  status: AdminCompanyMatchReview['status'];
  company_id: number;
  company_name: string;
  other_company_id: number | null;
  other_name: string | null;
  candidate: string;
  score: number;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

const REVIEW_SQL = `SELECT r.id, r.kind, r.status, r.company_id, c.name AS company_name, r.other_company_id, o.name AS other_name,
    r.candidate, r.score, r.created_at, r.decided_at, u.email AS decided_by
  FROM company_match_reviews r JOIN companies c ON c.id = r.company_id LEFT JOIN companies o ON o.id = r.other_company_id
  LEFT JOIN users u ON u.id = r.decided_by`;

function toReview(row: ReviewRow): AdminCompanyMatchReview {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    company: { id: row.company_id, name: row.company_name },
    otherCompany: row.other_company_id !== null ? { id: row.other_company_id, name: row.other_name ?? '' } : null,
    candidate: parseObject(row.candidate),
    score: Math.max(0, Math.min(100, row.score)),
    createdAt: new Date(row.created_at).toISOString(),
    decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
    decidedBy: row.decided_by,
  };
}

export async function listMatchReviews(deps: Pick<AppDeps, 'db'>, query: z.infer<typeof AdminCompanyMatchReviewsQuerySchema>) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (query.status !== 'all') {
    where.push('r.status = ?');
    params.push(query.status);
  }
  if (query.kind) {
    where.push('r.kind = ?');
    params.push(query.kind);
  }
  const filter = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await deps.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM company_match_reviews r ${filter}`, params as never))!.n;
  const after = query.cursor && /^\d+$/.test(query.cursor) ? Number(query.cursor) : null;
  const rows = await deps.db.all<ReviewRow>(
    `${REVIEW_SQL} ${filter} ${after === null ? '' : `${filter ? 'AND' : 'WHERE'} r.id < ?`} ORDER BY r.id DESC LIMIT ?`,
    [...params, ...(after === null ? [] : [after]), query.limit + 1] as never,
  );
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return { items: page.map(toReview), total, ...(rows.length > query.limit && last ? { nextCursor: String(last.id) } : {}) };
}

/**
 * v30 FIX-C UX-13: `{decision: 'reopen'}` puts a rejected review back on the open list, undecided (a Reject pressed by
 * mistake). A rejected `board_by_name` review's split stays (the board is its own company now; accepting the reopened
 * review keeps it there). An accepted review cannot be reopened: its merge or its key is done.
 */
async function reopenMatchReview(deps: AppDeps, reviewId: number): Promise<AdminCompanyMatchReview> {
  await deps.db.tx(async (t) => {
    const review = await t.one<{ status: string }>('SELECT status FROM company_match_reviews WHERE id = ? FOR UPDATE', [reviewId]);
    if (!review) throw notFound('That review');
    if (review.status === 'open') throw conflict('That review is open already.');
    if (review.status !== 'rejected') throw conflict('Only a rejected review can be reopened: an accepted one was carried out.');
    await t.run("UPDATE company_match_reviews SET status = 'open', decided_at = NULL, decided_by = NULL WHERE id = ?", [reviewId]);
  });
  return toReview((await deps.db.one<ReviewRow>(`${REVIEW_SQL} WHERE r.id = ?`, [reviewId]))!);
}

/** A PostgreSQL deadlock or serialization failure (40P01, 40001), also as an error's cause. */
function isLockConflict(error: unknown): boolean {
  const codeOf = (value: unknown) => (value && typeof value === 'object' ? (value as { code?: unknown }).code : undefined);
  const code = codeOf(error) ?? codeOf((error as { cause?: unknown } | null)?.cause);
  return code === '40P01' || code === '40001';
}

/** The message of a decision that met another change of the same companies (BEH-10). */
const TRY_AGAIN = 'Another change to these companies went first. Try again.';

/**
 * v30 FIX-C BEH-10: locks the companies two reviewed companies now are (survivorOf: the end of each merge chain), in id
 * order, as mergeInto locks a pair, and answers them once the chains read after the locks are the ones locked (a merge
 * that committed while this waited moves a chain on: its new end is locked too). A review row is locked after them.
 */
async function lockSurvivors(t: DbTx, companyId: number, otherId: number): Promise<[number, number] | null> {
  const locked = new Set<number>();
  for (let round = 0; round < 5; round += 1) {
    const a = await survivorOf(t, companyId);
    const b = await survivorOf(t, otherId);
    if (!a || !b) return null;
    const ids = [...new Set([a.id, b.id])].filter((id) => !locked.has(id)).sort((x, y) => x - y);
    for (const id of ids) {
      await companyRowOf(t, id, true);
      locked.add(id);
    }
    if (ids.length === 0) return [a.id, b.id];
  }
  throw conflict(TRY_AGAIN);
}

/**
 * POST /api/admin/company-reviews/:id: an admin's decision. Accepting a `merge` or `homonym` review merges the two
 * companies (the one with more jobs survives); accepting a `domain` or `wikidata` one adds the candidate's key
 * (`candidate.alias: {kind, value}`) to the company; accepting a `board_by_name` one keeps the board where the name
 * filed it. Rejecting a `board_by_name` review splits that board (and its jobs) into a company of its own; rejecting
 * any other leaves the companies apart.
 */
export async function decideMatchReview(
  deps: AppDeps,
  reviewId: number,
  decision: 'accept' | 'reject' | 'reopen',
  actor: AdminActor,
): Promise<AdminCompanyMatchReview> {
  if (decision === 'reopen') return reopenMatchReview(deps, reviewId);
  const at = nowOf(deps);
  let split: { companyId: number; sourceId: number; name: string } | null = null;
  try {
    await deps.db.tx(async (t) => {
      // v30 FIX-C BEH-10: an accepted merge locks its companies first (as mergeInto and mergeCompanies' other callers
      // do), then the review row: a concurrent merge that re-points this review never waits on it in a circle.
      const seen = await t.one<{ kind: string; company_id: number; other_company_id: number | null }>(
        'SELECT kind, company_id, other_company_id FROM company_match_reviews WHERE id = ?',
        [reviewId],
      );
      if (!seen) throw notFound('That review');
      const merges = (kind: string, otherId: number | null) => decision === 'accept' && (kind === 'merge' || kind === 'homonym') && otherId !== null;
      if (merges(seen.kind, seen.other_company_id)) await lockSurvivors(t, seen.company_id, seen.other_company_id!);
      const review = await t.one<{ id: number; kind: string; status: string; company_id: number; other_company_id: number | null; candidate: string }>(
        'SELECT id, kind, status, company_id, other_company_id, candidate FROM company_match_reviews WHERE id = ? FOR UPDATE',
        [reviewId],
      );
      if (!review) throw notFound('That review');
      if (review.status !== 'open') throw conflict('That review was decided already.');
      const candidate = parseObject(review.candidate);
      if (decision === 'accept') {
        if (merges(review.kind, review.other_company_id)) {
          // The review as it is now (a merge meanwhile may have re-pointed it): its companies' survivors, locked.
          const pair = await lockSurvivors(t, review.company_id, review.other_company_id!);
          if (pair && pair[0] !== pair[1]) {
            const [a, b] = pair;
            const jobs = await t.all<{ company_id: number; n: number }>(
              'SELECT company_id, count(*)::int AS n FROM jobs WHERE company_id IN (?, ?) /* held_since: every job counts */ GROUP BY company_id',
              [a, b],
            );
            const count = (companyId: number) => jobs.find((row) => row.company_id === companyId)?.n ?? 0;
            // The company with more jobs survives; of two alike, the older one (the name's first company).
            const [survivor, other] = count(b) > count(a) || (count(b) === count(a) && b < a) ? [b, a] : [a, b];
            const moved = await mergeCompanies(t, survivor, other, at);
            await optOutAfterMerge(deps, t, survivor, actor.id, at);
            await settle(deps, t, survivor, at, moved);
            await recountCompanyJobs(t, [survivor, other], at);
          }
        }
        const alias = candidate.alias as { kind?: unknown; value?: unknown } | undefined;
        if ((review.kind === 'domain' || review.kind === 'wikidata') && alias && typeof alias.kind === 'string' && typeof alias.value === 'string') {
          const value = alias.kind === 'domain' ? RegistrableDomainSchema.safeParse(alias.value).data : alias.value;
          if (value) {
            await addAlias(t, review.company_id, alias.kind, value, CONFIRMED_KEY, at);
            // v30 E1 (INT-4): the worker attaches the accepted item at its next pass (else the next monthly build does).
            await queueEnrichment(t, review.company_id, at, ['wikidata', 'sec', 'gleif']);
          }
        }
      } else if (review.kind === 'board_by_name' && typeof candidate.sourceId === 'number') {
        const name = typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name.trim() : null;
        if (name) split = { companyId: review.company_id, sourceId: candidate.sourceId, name };
      }
      await t.run(`UPDATE company_match_reviews SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?`, [
        decision === 'accept' ? 'accepted' : 'rejected',
        at,
        actor.id,
        reviewId,
      ]);
    });
  } catch (error) {
    // Two admins' changes of the same companies at once: the one PostgreSQL stopped is asked to try again (never a 500).
    if (isLockConflict(error)) throw conflict(TRY_AGAIN);
    throw error;
  }
  const toSplit = split as { companyId: number; sourceId: number; name: string } | null;
  if (toSplit) {
    const owner = await deps.db.one<{ company_id: number | null }>('SELECT company_id FROM job_sources WHERE id = ?', [toSplit.sourceId]);
    if (owner?.company_id === toSplit.companyId) await splitCompany(deps, toSplit.companyId, { sourceIds: [toSplit.sourceId], name: toSplit.name });
  }
  return toReview((await deps.db.one<ReviewRow>(`${REVIEW_SQL} WHERE r.id = ?`, [reviewId]))!);
}

// ── The routers ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Mounted at /api/admin/companies. */
export function createAdminCompaniesRouter(deps: AppDeps): Router {
  return adminRouter(deps, {
    resource: 'company',
    id: Id,
    list: { query: AdminCompaniesQuerySchema, run: (_deps, query) => listAdminCompanies(deps, query) },
    get: (_deps, id) => adminCompany(deps, id),
    patch: { body: AdminCompanyEditBodySchema, run: (_deps, id, edit) => editCompany(deps, id, edit) },
    routes: (router, { handle, audit }) => {
      const idOf = (value: unknown) => parseInput(Id, value ?? '', 'company id');
      router.post(
        '/:id/merge',
        handle(async (req, actor) => {
          const id = idOf(req.params.id);
          const body = parseInput(AdminCompanyMergeBodySchema, req.body ?? {}, 'merge');
          const company = await mergeInto(deps, id, body.otherId, actor.id);
          await audit({ action: 'merge', ids: [id, body.otherId], actor, change: body });
          return company;
        }),
      );
      router.post(
        '/:id/split',
        handle(async (req, actor) => {
          const id = idOf(req.params.id);
          const body = parseInput(AdminCompanySplitBodySchema, req.body ?? {}, 'split');
          const company = await splitCompany(deps, id, body);
          await audit({ action: 'split', ids: [id, company.id], actor, change: body });
          return company;
        }),
      );
      router.post(
        '/:id/refresh',
        handle(async (req, actor) => {
          const id = idOf(req.params.id);
          const body = parseInput(AdminCompanyRefreshBodySchema, req.body ?? {}, 'refresh');
          const queued = await deps.db.tx(async (t) => {
            const company = await editableCompany(t, id);
            if (company.do_not_fetch) throw conflict('That company opted out: nothing is read about it.');
            return queueEnrichment(t, id, nowOf(deps), body.steps && body.steps.length > 0 ? body.steps : NEW_COMPANY_STEPS);
          });
          await audit({ action: 'refresh', ids: [id], actor, change: body });
          return { queued };
        }),
      );
      router.put(
        '/:id/opt-out',
        handle(async (req, actor) => {
          const id = idOf(req.params.id);
          const body = parseInput(AdminCompanyOptOutBodySchema, req.body ?? {}, 'opt-out');
          const company = await optOutCompany(deps, id, body, actor);
          await audit({ action: 'opt-out', ids: [id], actor, change: body });
          return company;
        }),
      );
      // The upload itself (multipart, one file in `logo`, capped at UPLOAD_MAX_MB); the logo store's own cap is checked next.
      router.put('/:id/logo', (req, res, next) => getFileStore(deps).uploadSingle('logo')(req, res, next));
      router.put(
        '/:id/logo',
        handle(async (req, actor) => {
          const id = idOf(req.params.id);
          const file = req.file;
          if (!file) throw validationFailed('Choose a logo to upload.', { logo: 'Choose a logo to upload.' });
          const company = await setCompanyLogo(deps, id, file.buffer, file.originalname);
          await audit({ action: 'logo', ids: [id], actor, change: { bytes: file.buffer.length } });
          return company;
        }),
      );
      router.delete(
        '/:id/logo',
        handle(async (req, actor) => {
          const id = idOf(req.params.id);
          const company = await setCompanyLogo(deps, id, null);
          await audit({ action: 'logo', ids: [id], actor, change: { removed: true } });
          return company;
        }),
      );
    },
  });
}

/** Mounted at /api/admin/company-reviews. */
export function createAdminCompanyReviewsRouter(deps: AppDeps): Router {
  return adminRouter(deps, {
    resource: 'company review',
    id: Id,
    list: { query: AdminCompanyMatchReviewsQuerySchema, run: (_deps, query) => listMatchReviews(deps, query) },
    routes: (router, { handle, audit }) => {
      router.post(
        '/:id',
        handle(async (req, actor) => {
          const id = parseInput(Id, req.params.id ?? '', 'review id');
          const body = parseInput(AdminCompanyMatchDecisionBodySchema, req.body ?? {}, 'decision');
          const review = await decideMatchReview(deps, id, body.decision, actor);
          await audit({ action: body.decision, ids: [id], actor, change: body });
          return review;
        }),
      );
    },
  });
}

const OptOutsQuery = z.object({ cursor: AdminCursorSchema.optional(), limit: AdminPageSizeSchema });

/** Mounted at /api/admin/company-opt-outs. */
export function createAdminOptOutsRouter(deps: AppDeps): Router {
  return adminRouter(deps, {
    resource: 'opt-out',
    id: RegistrableDomainSchema,
    list: { query: OptOutsQuery, run: (_deps, query) => listOptOuts(deps, query) },
    routes: (router, { handle, audit }) => {
      router.post(
        '/',
        handle(async (req, actor) => {
          const body = parseInput(AdminOptOutCreateBodySchema, req.body ?? {}, 'opt-out');
          const entry = await addOptOut(deps, body, actor.id, nowOf(deps));
          await audit({ action: 'add', ids: [body.domain], actor, change: body });
          return entry;
        }),
      );
      router.delete(
        '/:id',
        handle(async (req, actor) => {
          const domain = parseInput(RegistrableDomainSchema, req.params.id ?? '', 'domain');
          const removed = await removeOptOut(deps, domain);
          if (!removed) throw notFound('That domain');
          await audit({ action: 'remove', ids: [domain], actor, change: null });
          return { removed };
        }),
      );
    },
  });
}

