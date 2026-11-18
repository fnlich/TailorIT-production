import { Router, type Request } from 'express';
import {
  ApplicationExportQuerySchema,
  ApplicationListQuerySchema,
  BoardQuerySchema,
  BulkApplicationsBodySchema,
  CreateApplicationBodySchema,
  CreateQuestionBodySchema,
  EventDateBodySchema,
  EventStatusParam,
  IdParam,
  PatchApplicationBodySchema,
  PatchQuestionBodySchema,
  STATUS,
  StatusChangeBodySchema,
  TrackerImportBodySchema,
  booleanParam,
  firstParam,
  type ApplicationCounts,
  type ApplicationListResponse,
  type ApplyRecordDocuments,
  type ApplyRecordList,
  type BoardResponse,
  type SubmittedAnswersResponse,
} from '@tailorit/shared';
import { z } from 'zod';
import { requireUser, userOf } from '../../core/auth/guards';
import { todayIso, type AppDeps } from '../../core/context';
import { notFound, validationFailed } from '../../core/http/errors';
import { parseInput } from '../../core/http/validate';
import { submittedRows } from '../autofill/forms/store';
import { linkHandAddedEntry } from '../autofill/jobs';
import { currentJobId } from '../jobs/store';
import { listApplyRecords, recordDocuments } from './apply-records';
import { boardColumns, countApplications, filterClause, pageOfApplications, type ApplicationFilter } from './query';
import {
  companyNames,
  exportCsv,
  exportFileName,
  insightsReport,
  knownCompanies,
  lettersForApplication,
  resumeScore,
  sankeyReport,
} from './reports';
import { bestResumes, SINGLE_SAVE_MATCH_BUDGET_MS } from './resume-choice';
import {
  archiveAll,
  assertValidDate,
  bulkApplications,
  changeStatus,
  clearStatusDate,
  createApplication,
  createQuestion,
  deleteApplication,
  deleteQuestion,
  importApplications,
  patchApplication,
  patchQuestion,
  setArchived,
  setStatusDate,
  wantsResumeMatch,
  type CreateOptions,
} from './service';
import { emptyStatusCounts, getDetail, loadOwnedRow, loadQuestions } from './store';
import { trackerEntryOfLink } from '../jobs/add/tracker'; // v31 LINK

// Job tracker applications (/api/applications). Owned by work package T (see docs/ARCHITECTURE.md §6).
//
// Saving a job (POST / with a jobId and no resumeId, at Saved) links TailorIT's best resume. It is chosen first,
// read-only and within SINGLE_SAVE_MATCH_BUDGET_MS, then written with the save. When the choice is not ready, or a
// restore or a move back to Saved leaves an application due, the match worker is woken to choose within seconds.

/** An apply record's id in a path (v30 DB-JOBS). */
const RecordIdParam = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

function idOf(req: Request, name = 'id'): string {
  return parseInput(IdParam, req.params[name], 'link');
}

/**
 * POST /api/applications/import/companies: up to 1,000 company names of an import file (the wizard asks in batches).
 * Answer: `{ known: { [name]: name TailorIT knows it by } }`. Only the wizard reads it, so the contract lives here.
 */
const KnownCompaniesBodySchema = z.object({
  names: z.array(z.string().max(500)).min(1).max(1000),
});

/**
 * The import contract caps each cell; a spreadsheet cell longer than that is cut to the cap rather than failing the
 * whole batch (the service keeps 200 characters of titles, companies and locations anyway).
 */
const IMPORT_CELL_LIMITS: Record<string, number> = {
  title: 500,
  companyName: 500,
  location: 500,
  employmentType: 100,
  status: 100,
  notes: 20_000,
  postingUrl: 2_000,
  appliedOn: 100,
};

function clipImportCells(body: unknown): unknown {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { rows?: unknown }).rows)) return body;
  const rows = (body as { rows: unknown[] }).rows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
    for (const [field, max] of Object.entries(IMPORT_CELL_LIMITS)) {
      const value = out[field];
      if (typeof value === 'string' && value.length > max) out[field] = value.slice(0, max);
    }
    return out;
  });
  return { ...(body as Record<string, unknown>), rows };
}

function filterOf(query: {
  q?: string;
  statuses: ApplicationFilter['statuses'];
  jobType?: ApplicationFilter['jobType'];
  favorites?: boolean;
  from?: string;
  until?: string;
}): Omit<ApplicationFilter, 'tab'> {
  if (query.from && query.until && query.from > query.until) {
    throw validationFailed('"Applied from" must be on or before "Applied until".', { from: 'Check the dates' });
  }
  return {
    q: query.q,
    statuses: query.statuses,
    jobType: query.jobType,
    favorites: query.favorites,
    from: query.from,
    until: query.until,
  };
}

/** Mounted at /api/applications. */
export function createApplicationsRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireUser);
  /** Wakes the resume match worker: an application may be due (it does nothing before the worker starts). */
  const wakeMatcher = () => deps.services.resumeMatch?.nudge();

  // ---------------------------------------------------------------------------------------------- collections

  // The board: every status column (or one, from a cursor) under the filters. Archived applications have no board
  // in the UI (that tab is a list), but `tab=archived` / `archived=1` is honoured for completeness.
  router.get('/board', async (req, res) => {
    const user = userOf(req);
    const query = parseInput(BoardQuerySchema, req.query, 'board filter');
    const archived = booleanParam(req.query.archived) === true || firstParam(req.query.tab) === 'archived';
    const filter: ApplicationFilter = { ...filterOf(query), tab: archived ? 'archived' : 'active' };
    const columns = await boardColumns(
      deps.db,
      user.id,
      filter,
      { sort: query.sort, order: query.order },
      query.limit,
      query.status !== undefined ? { status: query.status, cursor: query.cursor } : undefined,
    );
    const body: BoardResponse = { columns };
    res.json(body);
  });

  router.get('/counts', async (req, res) => {
    const user = userOf(req);
    // `active` is a flag on PostgreSQL (true/false) and 1/0 on SQLite: read with Boolean().
    const rows = await deps.db.all<{ active: number | boolean; status: number; n: number }>(
      `SELECT (archived_at IS NULL) AS active, current_status AS status, COUNT(*) AS n
       FROM applications WHERE user_id = ? GROUP BY 1, 2`,
      [user.id],
    );
    const counts: ApplicationCounts = { active: 0, archived: 0, byStatus: emptyStatusCounts() };
    for (const row of rows) {
      if (row.active) {
        counts.active += row.n;
        counts.byStatus[String(row.status)] = (counts.byStatus[String(row.status)] ?? 0) + row.n;
      } else {
        counts.archived += row.n;
      }
    }
    res.json(counts);
  });

  router.get('/companies', async (req, res) => {
    res.json({ items: await companyNames(deps, userOf(req).id, firstParam(req.query.q)) });
  });

  router.get('/export.csv', async (req, res) => {
    const user = userOf(req);
    const query = parseInput(ApplicationExportQuerySchema, req.query, 'export filter');
    const csv = await exportCsv(deps, user.id, { ...filterOf(query), tab: query.tab }, { sort: query.sort, order: query.order });
    const name = exportFileName(todayIso(deps));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(csv);
  });

  router.get('/sankey', async (req, res) => {
    res.json(await sankeyReport(deps, userOf(req).id));
  });

  router.get('/insights', async (req, res) => {
    res.json(await insightsReport(deps, userOf(req).id));
  });

  router.post('/import', async (req, res) => {
    const body = parseInput(TrackerImportBodySchema, clipImportCells(req.body), 'import');
    res.json(await importApplications(deps, userOf(req).id, body));
  });

  // The import wizard's "Review companies": the file's company names TailorIT already knows.
  router.post('/import/companies', async (req, res) => {
    const { names } = parseInput(KnownCompaniesBodySchema, req.body, 'company list');
    res.json({ known: await knownCompanies(deps, userOf(req).id, names) });
  });

  router.post('/bulk', async (req, res) => {
    const body = parseInput(BulkApplicationsBodySchema, req.body, 'request');
    const affected = await bulkApplications(deps, userOf(req).id, body);
    if (body.action === 'unarchive' || (body.action === 'status' && body.status === STATUS.saved)) wakeMatcher();
    res.json({ affected });
  });

  router.post('/archive-all', async (req, res) => {
    res.json({ archived: await archiveAll(deps, userOf(req).id) });
  });

  // The list view (Active or Archived), searched, filtered and sorted, a page at a time.
  router.get('/', async (req, res) => {
    const user = userOf(req);
    const query = parseInput(ApplicationListQuerySchema, req.query, 'list filter');
    const where = filterClause(deps.db.dialect, user.id, { ...filterOf(query), tab: query.tab });
    const page = await pageOfApplications(deps.db, where, { sort: query.sort, order: query.order }, query.cursor, query.limit);
    const body: ApplicationListResponse = { ...page, total: await countApplications(deps.db, where) };
    res.json(body);
  });

  router.post('/', async (req, res) => {
    const user = userOf(req);
    // v31 LINK: an entry added with a posting's link is the job TailorIT reads from it, when it can (jobs/add/tracker.ts).
    const asked = await trackerEntryOfLink(deps, user.id, parseInput(CreateApplicationBodySchema, req.body, 'application'));
    // A page job an upgrade closed is saved as the shared job it gave way to (audit D4).
    const current = asked.jobId === undefined ? null : await currentJobId(deps, user.id, asked.jobId);
    if (asked.jobId !== undefined && current === null) throw notFound('That job');
    const body = current === null ? asked : { ...asked, jobId: current };
    const options: CreateOptions = {};
    if (body.jobId !== undefined) {
      // A date the save would refuse is refused before anything is written or chosen.
      assertValidDate(deps, body.occurredOn ?? todayIso(deps));
      // The entry the person added by hand with the posting's link is the job's from now on, so the save finds it
      // instead of adding a second entry beside it, as Add job's Save does (audit D6).
      await linkHandAddedEntry(deps, user.id, body.jobId, []);
    }
    if (body.jobId !== undefined && (await wantsResumeMatch(deps.db, user.id, body))) {
      const { choices, unfinished } = await bestResumes(deps, user.id, [body.jobId], SINGLE_SAVE_MATCH_BUDGET_MS);
      options.matchedResume = choices.get(body.jobId) ?? null;
      options.matchPending = unfinished.includes(body.jobId);
    }
    const { detail, created } = await createApplication(deps, user.id, body, options);
    if (detail.resumeMatchPending) wakeMatcher();
    res.status(created ? 201 : 200).json(detail);
  });

  // ------------------------------------------------------------------------------------------- one application

  router.get('/:id', async (req, res) => {
    res.json(await getDetail(deps.db, userOf(req).id, idOf(req)));
  });

  router.patch('/:id', async (req, res) => {
    const body = parseInput(PatchApplicationBodySchema, req.body, 'application');
    res.json(await patchApplication(deps, userOf(req).id, idOf(req), body));
  });

  router.delete('/:id', async (req, res) => {
    await deleteApplication(deps, userOf(req).id, idOf(req));
    res.status(204).end();
  });

  router.put('/:id/status', async (req, res) => {
    const body = parseInput(StatusChangeBodySchema, req.body, 'status');
    const result = await changeStatus(deps, userOf(req).id, idOf(req), body.status, body.occurredOn);
    if (result.currentStatus === STATUS.saved) wakeMatcher();
    res.json(result);
  });

  // v20 A30: the apply records ("Applied with" in the detail sheet), newest first.
  router.get('/:id/apply-records', async (req, res) => {
    const body: ApplyRecordList = await listApplyRecords(deps, userOf(req).id, idOf(req));
    res.json(body);
  });

  // v30 DB-JOBS (11 §5.8): exactly what one record was sent with (the live documents, or their snapshots).
  router.get('/:id/apply-records/:recordId/documents', async (req, res) => {
    const recordId = parseInput(RecordIdParam, req.params.recordId, 'link');
    const body: ApplyRecordDocuments = await recordDocuments(deps, userOf(req).id, idOf(req), recordId);
    res.json(body);
  });

  router.put('/:id/events/:status', async (req, res) => {
    const status = parseInput(EventStatusParam, req.params.status, 'status');
    const body = parseInput(EventDateBodySchema, req.body, 'date');
    res.json(await setStatusDate(deps, userOf(req).id, idOf(req), status, body.occurredOn));
  });

  router.delete('/:id/events/:status', async (req, res) => {
    const status = parseInput(EventStatusParam, req.params.status, 'status');
    const result = await clearStatusDate(deps, userOf(req).id, idOf(req), status);
    if (result.currentStatus === STATUS.saved) wakeMatcher();
    res.json(result);
  });

  router.post('/:id/archive', async (req, res) => {
    res.json(await setArchived(deps, userOf(req).id, idOf(req), true));
  });

  router.post('/:id/restore', async (req, res) => {
    const detail = await setArchived(deps, userOf(req).id, idOf(req), false);
    if (detail.resumeMatchPending) wakeMatcher();
    res.json(detail);
  });

  router.get('/:id/cover-letters', async (req, res) => {
    res.json({ items: await lettersForApplication(deps, userOf(req).id, idOf(req)) });
  });

  router.get('/:id/resume-score', async (req, res) => {
    res.json(await resumeScore(deps, userOf(req).id, idOf(req)));
  });

  // v1.3 A: the answers the person submitted through the extension (autofill/forms/), read-only, the owner's alone.
  router.get('/:id/submitted-answers', async (req, res) => {
    const user = userOf(req);
    const id = idOf(req);
    await loadOwnedRow(deps.db, user.id, id);
    const rows = await submittedRows(deps.db, user.id, id);
    const body: SubmittedAnswersResponse = {
      submittedAt: rows.reduce<string | null>((latest, row) => (latest === null || row.submittedAt > latest ? row.submittedAt : latest), null),
      items: rows.map(({ questionId, label, section, step, required, kind, answer }) => ({
        questionId,
        label,
        section,
        step,
        required,
        kind,
        answer,
      })),
    };
    res.json(body);
  });

  router.get('/:id/questions', async (req, res) => {
    const user = userOf(req);
    const id = idOf(req);
    await loadOwnedRow(deps.db, user.id, id);
    res.json({ items: await loadQuestions(deps.db, id) });
  });

  router.post('/:id/questions', async (req, res) => {
    const body = parseInput(CreateQuestionBodySchema, req.body, 'question');
    res.status(201).json(await createQuestion(deps, userOf(req).id, idOf(req), body));
  });

  router.patch('/:id/questions/:questionId', async (req, res) => {
    const body = parseInput(PatchQuestionBodySchema, req.body, 'question');
    res.json(await patchQuestion(deps, userOf(req).id, idOf(req), idOf(req, 'questionId'), body));
  });

  router.delete('/:id/questions/:questionId', async (req, res) => {
    await deleteQuestion(deps, userOf(req).id, idOf(req), idOf(req, 'questionId'));
    res.status(204).end();
  });

  return router;
}
