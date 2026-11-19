// v32 COPY (E7): today's AI use is shown to people only as a share of their daily budget ("40%"), never as money: no
// "$0.04 of $0.10" anywhere a person who is not an admin can see. Extra usage (credit) keeps its amount. Pure, so the
// tests read it without a page.
//
// The server's answers move from the amounts (`usedMicros`, `budgetMicros`) to the share (`percent`) for people who are
// not admins (v32 ADMINAPP). This reads either: `percent` when the answer has it, else the share of the amounts.

/** Today's AI use as an answer gives it: the share (v3.2), or the amounts (v3.1 and the admin's answers). */
export interface AiUseInput {
  /** 0-100, today's share of the daily budget; null when the plan has no daily budget. */
  percent?: number | null;
  /** Whether the plan has no daily budget (an answer may say so instead of a null percent). */
  unlimited?: boolean;
  usedMicros?: number;
  /** null: no daily budget. */
  budgetMicros?: number | null;
}

export type AiUseTone = 'tape' | 'primary' | 'warning' | 'danger';

export type AiUse =
  | { kind: 'unlimited' }
  | {
      kind: 'budget';
      /** 0-100, whole; 100 only once the budget is used (just under it stays at 99). */
      percent: number;
      /** "40%". */
      percentText: string;
      /** The budget is used: new AI work takes extra credit, or waits for the reset. */
      reached: boolean;
    };

const centsOf = (micros: number) => Math.round(micros / 10_000);

/** Today's AI use as a share of the budget, from either kind of answer. */
export function aiUseOf(ai: AiUseInput | null | undefined): AiUse {
  if (!ai || ai.unlimited) return { kind: 'unlimited' };
  if (typeof ai.percent === 'number' && Number.isFinite(ai.percent)) return budget(Math.round(ai.percent));
  if (typeof ai.budgetMicros === 'number' && typeof ai.usedMicros === 'number') {
    if (ai.usedMicros >= ai.budgetMicros) return budget(100);
    // The share of whole cents, as the header chip rounds it (v31 FIX-WEB, UX-14): just under the budget stays at 99%.
    const budgetCents = centsOf(ai.budgetMicros);
    return budget(budgetCents > 0 ? Math.min(99, Math.round((centsOf(ai.usedMicros) / budgetCents) * 100)) : 0);
  }
  return { kind: 'unlimited' };
}

function budget(raw: number): AiUse {
  const percent = Math.max(0, Math.min(100, raw));
  return { kind: 'budget', percent, percentText: `${percent}%`, reached: percent >= 100 };
}

/**
 * v32 FIX-UX (UXREQ-3, UXREQ-12): today's AI use is spent and no extra credit is left to spend, so new AI work would
 * be refused (the limit alert says so before asking for it).
 */
export function aiUsedUp(ai: (AiUseInput & { creditMicros: number }) | null | undefined): boolean {
  if (!ai) return false;
  const use = aiUseOf(ai);
  return use.kind === 'budget' && use.reached && ai.creditMicros <= 0;
}

/**
 * The meter's tone for a share: `primary` (or the tape) until `warningPercent` (AI_USE_WARNING_PERCENT, 80 by
 * default), `warning` from it, `danger` once the budget is used.
 */
export function aiUseTone(percent: number, warningPercent = 80, base: 'tape' | 'primary' = 'primary'): AiUseTone {
  if (percent >= 100) return 'danger';
  return percent >= warningPercent ? 'warning' : base;
}
