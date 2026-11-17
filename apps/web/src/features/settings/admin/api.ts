import {
  AdminAccountHistorySchema,
  AdminUserListSchema,
  AdminUserPatchResponseSchema,
  AdminUserSchema,
  type AdminAccountHistory,
  type AdminAiBudgetBody,
  type AdminCreditBody,
  type AdminEntitlementBody,
  type AdminUser,
  type AdminUserList,
  type AdminUserPatchResponse,
  type AdminUserTypeFilter,
} from '@tailorit/shared/accounts';
import {
  AiBackgroundWorkSchema,
  AiCapacitySchema,
  AiUsageSummarySchema,
  type AiBackgroundWork,
  type AiCapacity,
  type AiUsageSummary,
} from '@tailorit/shared/ai';
import {
  AdminConstantListSchema,
  AdminConstantRowSchema,
  type AdminConstantList,
  type AdminConstantRow,
} from '@tailorit/shared/constants';
import { SheetAccountSchema, SheetPreviewSchema } from '@tailorit/shared/ingest';
import { api } from '@/lib/api';
import type {
  AiHealth,
  AiTestResult,
  ImportMapping,
  ImportPreview,
  ImportResult,
  SheetAccount,
  SheetImportBody,
  SheetPreview,
  SheetPreviewBody,
} from './types';

/** React Query keys of the admin console. */
export const adminKeys = {
  all: ['admin'] as const,
  sources: ['admin', 'sources'] as const,
  aiHealth: ['admin', 'ai', 'health'] as const,
  aiBackground: ['admin', 'ai', 'background'] as const,
  aiUsage: ['admin', 'ai', 'usage'] as const,
  users: ['admin', 'users'] as const,
  // v2.0 (P8)
  usersPage: (q: string, type: AdminUserTypeFilter) => ['admin', 'users', 'page', q, type] as const,
  userHistory: (id: string) => ['admin', 'users', 'history', id] as const,
  constants: ['admin', 'constants'] as const,
  aiCapacity: ['admin', 'ai', 'capacity'] as const,
  sheetAccount: ['admin', 'import', 'sheets', 'account'] as const,
};

// ------------------------------------------------------------------------------------------------ import jobs

function importForm(file: File, mapping?: ImportMapping, name?: string): FormData {
  const form = new FormData();
  form.append('file', file, file.name);
  if (mapping) form.append('mapping', JSON.stringify(mapping));
  if (name?.trim()) form.append('name', name.trim());
  return form;
}

export function previewImport(file: File, mapping?: ImportMapping) {
  return api.post<ImportPreview>('/api/admin/import/jobs/preview', importForm(file, mapping));
}

export function importJobs(file: File, mapping: ImportMapping, name?: string) {
  return api.post<ImportResult>('/api/admin/import/jobs', importForm(file, mapping, name));
}

// ------------------------------------------------------------------------------------- Google Sheet import

/** Whether the server has a service account key, and the address to share sheets with. */
export function fetchSheetAccount(signal?: AbortSignal) {
  return api.get<SheetAccount>('/api/admin/import/sheets/account', { signal, schema: SheetAccountSchema });
}

/** Reads a tab (or, with `refresh: false`, re-maps the last read) and answers its preview. Saves nothing. */
export function previewSheet(body: SheetPreviewBody, signal?: AbortSignal) {
  return api.post<SheetPreview>('/api/admin/import/sheets/preview', body, { signal, schema: SheetPreviewSchema });
}

/** Reads the tab again and imports it: 201 with the run, or 202 while it imports in the background. */
export function importSheet(body: SheetImportBody) {
  return api.post<ImportResult>('/api/admin/import/sheets/jobs', body);
}

// --------------------------------------------------------------------------------------------- AI and users

export function fetchAiHealth(force = false, signal?: AbortSignal) {
  return api.get<AiHealth>('/api/admin/ai/health', { signal, query: { force: force ? 1 : undefined } });
}

export function runAiTest() {
  return api.post<AiTestResult>('/api/admin/ai/test', {});
}

/** What Claude still has to read in the background, the resume matches to update, and whether background work runs. */
export function fetchAiBackground(signal?: AbortSignal) {
  return api.get<AiBackgroundWork>('/api/admin/ai/background', { signal, schema: AiBackgroundWorkSchema });
}

/** v1.3 C: what the AI calls used per task over the last 1, 7 and 30 days (Admin > AI usage). */
export function fetchAiUsage(signal?: AbortSignal) {
  return api.get<AiUsageSummary>('/api/admin/ai/usage', { signal, schema: AiUsageSummarySchema });
}

// v2.0 (P8): Admin › Users, server-paged, with each account's type, budget override, credit and today
// (docs/design/v2.0/04-accounts-limits.md, "Admin routes (accounts)").

/** GET /api/admin/users?q=&type=&cursor=&limit= (newest accounts first; `nextCursor` while more follow). */
export function fetchUsers(
  options: { q?: string; type?: AdminUserTypeFilter; cursor?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<AdminUserList> {
  return api.get<AdminUserList>('/api/admin/users', {
    signal: options.signal,
    schema: AdminUserListSchema,
    query: {
      q: options.q?.trim() || undefined,
      type: options.type && options.type !== 'all' ? options.type : undefined,
      cursor: options.cursor,
      limit: options.limit,
    },
  });
}

/** PATCH /api/admin/users/:id: role and sign-in, as before (the answer may carry a note). */
export function updateUser(id: string, patch: { role?: AdminUser['role']; disabled?: boolean }) {
  return api.patch<AdminUserPatchResponse>(`/api/admin/users/${encodeURIComponent(id)}`, patch, {
    schema: AdminUserPatchResponseSchema,
  });
}

/** PUT /api/admin/users/:id/entitlement: the type and term (audited, source admin). */
export function changeEntitlement(id: string, body: AdminEntitlementBody) {
  return api.put<AdminUser>(`/api/admin/users/${encodeURIComponent(id)}/entitlement`, body, { schema: AdminUserSchema });
}

/** PUT /api/admin/users/:id/ai-budget: a daily budget in dollars, or Unlimited. */
export function setAiBudget(id: string, body: AdminAiBudgetBody) {
  return api.put<AdminUser>(`/api/admin/users/${encodeURIComponent(id)}/ai-budget`, body, { schema: AdminUserSchema });
}

/** DELETE /api/admin/users/:id/ai-budget: back to the type's default budget. */
export function clearAiBudget(id: string) {
  return api.delete<AdminUser>(`/api/admin/users/${encodeURIComponent(id)}/ai-budget`, { schema: AdminUserSchema });
}

/** POST /api/admin/users/:id/credit: a grant or an adjustment (the balance never goes below $0). */
export function addCredit(id: string, body: AdminCreditBody) {
  return api.post<AdminUser>(`/api/admin/users/${encodeURIComponent(id)}/credit`, body, { schema: AdminUserSchema });
}

/** GET /api/admin/users/:id/history: entitlement events and credit rows, newest first. */
export function fetchUserHistory(id: string, cursor?: string, signal?: AbortSignal): Promise<AdminAccountHistory> {
  return api.get<AdminAccountHistory>(`/api/admin/users/${encodeURIComponent(id)}/history`, {
    signal,
    query: { cursor },
    schema: AdminAccountHistorySchema,
  });
}

// v2.0 (P8): Admin › Constants (02-constants.md, "The resolution service").

/** GET /api/admin/constants: every constant, its value, source and editor's facts. */
export function fetchAdminConstants(signal?: AbortSignal): Promise<AdminConstantList> {
  return api.get<AdminConstantList>('/api/admin/constants', { signal, schema: AdminConstantListSchema });
}

/** PUT /api/admin/constants/:key: an override in the stored form (400 with the reason when it is not valid). */
export function setAdminConstant(key: string, value: unknown): Promise<AdminConstantRow> {
  return api.put<AdminConstantRow>(`/api/admin/constants/${encodeURIComponent(key)}`, { value }, {
    schema: AdminConstantRowSchema,
  });
}

/** DELETE /api/admin/constants/:key: the override removed (back to .env or the default). */
export function clearAdminConstant(key: string): Promise<AdminConstantRow> {
  return api.delete<AdminConstantRow>(`/api/admin/constants/${encodeURIComponent(key)}`, {
    schema: AdminConstantRowSchema,
  });
}

// v2.0 (P8): Admin › AI › Server AI status (03-ai-usage.md, "What the admin sees").

/** GET /api/admin/ai/capacity (admin only). */
export function fetchAiCapacity(signal?: AbortSignal): Promise<AiCapacity> {
  return api.get<AiCapacity>('/api/admin/ai/capacity', { signal, schema: AiCapacitySchema });
}
