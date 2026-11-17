import { constantsOf } from '../../../core/constants/index';
import { nowIso, type AppDeps } from '../../../core/context';
import type { DailyStep } from '../../../core/feature';
import { newReadsAllowed } from '../../../core/http/identity';
import { queueEnrichment } from '../resolve';

// v30 E2: the company websites' and logos' refresh (docs/design/part2/13-company-enrichment.md §7): once a day, the
// companies whose website is due (never read, or its company_site row's next read, expires_at, has come) are put on the
// enrichment queue with the `company_site` step, and those with a domain and no logo, never asked of logo.dev or due
// again, with the `logo_dev` step. Only while the reads may run: SITE_READER_COMPANY_SITES on (sites), LOGO_DEV_KEY
// set (logo.dev), and BOT_USER_AGENT no placeholder (both). The enrichment worker (E1's) works the queue under each
// step's own pace. Own, merged and opted-out companies are never queued (queueEnrichment).

/** Queues the due company sites and logo.dev asks; answers how many queue rows it wrote. */
export async function queueDueCompanySites(deps: AppDeps): Promise<number> {
  if (!newReadsAllowed(deps)) return 0;
  const at = nowIso(deps);
  let queued = 0;
  const due = async (sql: string, step: string) => {
    // The most companies one pass queues for each step (v30 INT-4: COMPANY_SITE_REFRESH_BATCH, 5,000 by default).
    const rows = await deps.db.all<{ id: number }>(sql, { at, batch: constantsOf(deps).get('COMPANY_SITE_REFRESH_BATCH') });
    for (let from = 0; from < rows.length; from += 500) {
      const chunk = rows.slice(from, from + 500);
      await deps.db.tx(
        async (t) => {
          for (const row of chunk) if (await queueEnrichment(t, row.id, at, [step])) queued += 1;
        },
        { label: `queue ${step}` },
      );
    }
  };
  if (constantsOf(deps).get('SITE_READER_COMPANY_SITES')) {
    await due(
      `SELECT c.id FROM companies c
         JOIN company_profiles p ON p.company_id = c.id
         LEFT JOIN company_sources s ON s.company_id = c.id AND s.kind = 'company_site' AND s.ref = ''
       WHERE c.owner_user_id IS NULL AND c.merged_into_id IS NULL AND NOT c.do_not_fetch
         AND (p.website IS NOT NULL OR p.domain IS NOT NULL)
         AND (s.id IS NULL OR s.expires_at IS NULL OR s.expires_at <= CAST(@at AS timestamptz))
         AND NOT EXISTS (SELECT 1 FROM company_enrichment_queue q WHERE q.company_id = c.id AND q.steps @> CAST('["company_site"]' AS jsonb))
       ORDER BY s.expires_at NULLS FIRST, c.id LIMIT @batch`,
      'company_site',
    );
  }
  if (deps.config.outside.logoDevKey) {
    await due(
      `SELECT c.id FROM companies c
         JOIN company_profiles p ON p.company_id = c.id
         LEFT JOIN company_sources s ON s.company_id = c.id AND s.kind = 'logo_dev' AND s.ref = ''
       WHERE c.owner_user_id IS NULL AND c.merged_into_id IS NULL AND NOT c.do_not_fetch
         AND p.domain IS NOT NULL AND p.logo_path IS NULL
         AND (s.id IS NULL OR s.expires_at IS NULL OR s.expires_at <= CAST(@at AS timestamptz))
         AND NOT EXISTS (SELECT 1 FROM company_enrichment_queue q WHERE q.company_id = c.id AND q.steps @> CAST('["logo_dev"]' AS jsonb))
       ORDER BY s.expires_at NULLS FIRST, c.id LIMIT @batch`,
      'logo_dev',
    );
  }
  return queued;
}

/** The daily step (Feature.daily of the companies feature: INT-4 registers it, E2's handoff). */
export const companySitesDailyStep: DailyStep = { name: 'site-refresh', run: (deps) => queueDueCompanySites(deps) };
