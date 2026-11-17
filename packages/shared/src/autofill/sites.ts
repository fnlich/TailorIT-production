import { z } from 'zod';
import { HostNameSchema, InstantSchema } from './common';

// "Ask TailorIT to support this site" (version 3): on a page the extension cannot fill, the side panel offers the
// person a button that records the site's host name, and nothing else of the page (no path, no query, no text).
// TailorIT keeps, per account, each host's count and the first and last time it was asked, listed in Settings ›
// Autofill.

/** The most sites an account's list keeps: past it, the one asked longest ago goes. */
export const AUTOFILL_SITE_REQUESTS_MAX = 200;

/** POST /api/autofill/site-requests (scope jobs:lookup): answers 204. */
export const AutofillSiteRequestBodySchema = z.object({ host: HostNameSchema });
export type AutofillSiteRequestBody = z.infer<typeof AutofillSiteRequestBodySchema>;

export const AutofillSiteRequestItemSchema = z.object({
  host: HostNameSchema,
  /** How many times the person asked. */
  count: z.number().int().positive(),
  firstRequestedAt: InstantSchema,
  lastRequestedAt: InstantSchema,
});
export type AutofillSiteRequestItem = z.infer<typeof AutofillSiteRequestItemSchema>;

/** GET /api/autofill/site-requests (the Settings page only): the account's requests, the latest first. */
export const AutofillSiteRequestListSchema = z.object({
  items: z.array(AutofillSiteRequestItemSchema).max(AUTOFILL_SITE_REQUESTS_MAX),
  total: z.number().int().nonnegative(),
});
export type AutofillSiteRequestList = z.infer<typeof AutofillSiteRequestListSchema>;
