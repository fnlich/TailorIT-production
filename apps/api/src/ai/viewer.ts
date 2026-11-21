import type { Request } from 'express';
import { payerOf } from '../core/accounts/payer';
import { userOf } from '../core/auth/guards';
import type { TaskViewer } from './queue';

// v33 SHARE-3 (PLAN F9; SP v33 PLAN-sharing.md §4 "Mixed routes"): who reads an AI task on a route, as the AI queue's
// getTaskFor / watchFor / cancelFor take it: whose profile (userOf: A while acting), who pays (payerOf: B with the grant)
// and the boxes of the grant the request acts under (null on the person's own profile). A route that reads a task the
// person started (Tailor's progress, AI search, the AI tasks routes) passes taskViewerOf(req) instead of userOf(req).id.

/** The request's task reader: on the own profile the person's tasks; acting on A's profile, what getTaskFor allows. */
export function taskViewerOf(req: Request): TaskViewer {
  return { ownerId: userOf(req).id, payer: payerOf(req), permissions: req.acting ? req.acting.permissions : null };
}
