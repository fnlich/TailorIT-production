import type { CompanyMatchReviewKind } from '@tailorit/shared';
import type { DbQueries } from '../../core/db/types';

// v30 E0-API: the match review queue (company_match_reviews; docs/design/part2/13-company-enrichment.md §5.5): the
// merges, homonyms and weak matches an admin decides. resolveCompany opens a `homonym` review (a new company whose
// name another company has) and a `board_by_name` one (a second board of one platform joined by the name alone);
// wave 4's matchers open `domain` and `wikidata` ones. The decisions are the admin router's (admin.ts).

export interface MatchReviewInput {
  kind: CompanyMatchReviewKind;
  companyId: number;
  otherCompanyId: number | null;
  /** The evidence as the matcher saw it (keys, names, the record). Names no person. */
  candidate: Record<string, unknown>;
  score: number;
  at: string;
}

/** Opens a review unless an open one of the same kind about the same pair is waiting; answers its id (or the open one's). */
export async function openMatchReview(t: DbQueries, input: MatchReviewInput): Promise<number> {
  const open = await t.one<{ id: number }>(
    `SELECT id FROM company_match_reviews WHERE status = 'open' AND kind = ? AND company_id = ?
       AND other_company_id IS NOT DISTINCT FROM CAST(? AS bigint) LIMIT 1`,
    [input.kind, input.companyId, input.otherCompanyId],
  );
  if (open) return open.id;
  const row = await t.one<{ id: number }>(
    `INSERT INTO company_match_reviews(kind, company_id, other_company_id, candidate, score, created_at)
     VALUES (?, ?, ?, CAST(? AS jsonb), ?, ?) RETURNING id`,
    [input.kind, input.companyId, input.otherCompanyId, JSON.stringify(input.candidate), Math.max(0, Math.min(100, Math.round(input.score))), input.at],
  );
  return row!.id;
}
