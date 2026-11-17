import type {
  ApplicationDraftAnswer,
  PrepareDraft,
  PrepareOutcome,
  PreparePartStatus,
  PrepareResumeMode,
  PrepareStartResponse,
  PrepareStep,
} from '@tailorit/shared/prepare';

// v2.0: the words of Prepare & Queue (docs/design/v2.0/08-ui.md, "Prepare & Queue: the button, the confirm, the
// errors") and of the Tracker's "Prepared" tab: pure, so the tests read them without a page. Limit and status words
// come from the constants (usePublicConstants().t); these are the feature's own.

/** The button's words: "Prepare & Queue", or "Prepare & Queue (3)" for a selection. */
export const PREPARE_LABEL = 'Prepare & Queue';
export function prepareLabel(count?: number): string {
  return count === undefined ? PREPARE_LABEL : `${PREPARE_LABEL} (${count})`;
}

/** Where "Change filters" goes: Settings › Prepare & Queue. */
export const FILTERS_HREF = '/settings#prepare';

/** The confirm's title: "Prepare & Queue", or "Prepare & Queue 5 jobs". */
export function confirmTitle(count: number): string {
  return count > 1 ? `${PREPARE_LABEL} ${count} jobs` : PREPARE_LABEL;
}

// v20 A29: which resume a prepared item uses, in short ("Default resume", "Best-matched resume", "Tailored").
export const RESUME_MODE_SHORT: Record<PrepareResumeMode, string> = {
  default: 'Default resume',
  similar: 'Best-matched resume',
  tailor: 'Tailored',
};
/** The same, as a sentence's end: "Uses your default resume". */
export const RESUME_MODE_SENTENCE: Record<PrepareResumeMode, string> = {
  default: 'Uses your default resume',
  similar: 'Uses your best-matched resume',
  tailor: 'A resume tailored to this job',
};

/** What an active server Prepare is doing, for the Queue pane's "Preparing" line. */
export function stepText(step: PrepareStep | null, resumeMode: PrepareResumeMode): string {
  switch (step) {
    case 'filters':
      return 'Checking filters';
    case 'analysis':
      return 'Reading the job';
    case 'resume':
      return resumeMode === 'tailor' ? 'Tailoring resume' : 'Choosing your resume';
    case 'letter':
      return 'Writing cover letter';
    case 'answers':
      return 'Preparing answers';
    case null:
      return 'Waiting its turn';
  }
}

/** "Filtered: on-site" from a reason's words ("on-site"); words that already say it are kept. */
export function filteredText(label: string, render: (reason: string) => string): string {
  return /^filtered\b/i.test(label.trim()) ? label : render(label);
}

/** A job's title and company, as one result names it. */
export interface PreparedJobName {
  title: string;
  company: string;
}

/** One request's result, as its toast says it. */
export interface PrepareResultCopy {
  tone: 'success' | 'info';
  title: string;
  description?: string;
  /** Some job was filtered: the toast offers "Change filters". */
  filtered: boolean;
  /** Some job started or was queued at once. */
  anyStarted: boolean;
}

const OUTCOME_ORDER: readonly PrepareOutcome[] = ['started', 'queued', 'filtered', 'skipped'];

/** "2 on-site, 1 contract" (most first), or "on-site" when every filtered job has the same reason. */
function reasonsSummary(labels: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (entries.length === 1) return entries[0]![0];
  return entries.map(([label, count]) => `${count} ${label}`).join(', ');
}

/**
 * The toast after Prepare & Queue. One job: its own words ("Preparing Senior Engineer at Acme", "Filtered: on-site",
 * the skip's message). Several: one line summing the outcomes, "3 preparing · 1 queued · 1 filtered (on-site)".
 * `filtered` renders MSG_FILTERED.
 */
export function prepareResultCopy(
  response: PrepareStartResponse,
  nameOf: (applicationId: string) => PreparedJobName | undefined,
  filtered: (reason: string) => string,
): PrepareResultCopy {
  const { results } = response;
  const has = (outcome: PrepareOutcome) => results.some((result) => result.outcome === outcome);
  const anyStarted = has('started') || has('queued');
  const anyFiltered = has('filtered');
  if (results.length === 1) {
    const [result] = results;
    const name = nameOf(result!.applicationId);
    const at = name ? `${name.title} at ${name.company}` : 'the job';
    switch (result!.outcome) {
      case 'started':
        return { tone: 'success', title: `Preparing ${at}`, description: 'It joins your queue when it is ready.', filtered: false, anyStarted };
      case 'queued':
        return { tone: 'success', title: `Queued ${at}`, description: 'Its prepared kit was used again.', filtered: false, anyStarted };
      case 'filtered':
        return {
          tone: 'info',
          title: filteredText(result!.reason?.label ?? 'a filter', filtered),
          description: `${name ? `${at} was` : 'It was'} not prepared. It stays in your saved jobs.`,
          filtered: true,
          anyStarted,
        };
      case 'skipped':
        return {
          tone: 'info',
          title: result!.reason?.label || 'This job was not prepared',
          description: name ? at : undefined,
          filtered: false,
          anyStarted,
        };
    }
  }
  const parts: string[] = [];
  for (const outcome of OUTCOME_ORDER) {
    const matching = results.filter((result) => result.outcome === outcome);
    if (matching.length === 0) continue;
    if (outcome === 'started') parts.push(`${matching.length} preparing`);
    else if (outcome === 'queued') parts.push(`${matching.length} queued`);
    else if (outcome === 'skipped') parts.push(`${matching.length} skipped`);
    else {
      const labels = matching.map((result) => result.reason?.label).filter((label): label is string => Boolean(label));
      parts.push(labels.length > 0 ? `${matching.length} filtered (${reasonsSummary(labels)})` : `${matching.length} filtered`);
    }
  }
  const skippedWords = [
    ...new Set(
      results
        .filter((result) => result.outcome === 'skipped' && result.reason?.label)
        .map((result) => result.reason!.label),
    ),
  ];
  return {
    tone: anyStarted ? 'success' : 'info',
    title: parts.join(' · '),
    description: skippedWords.length > 0 ? skippedWords.join(' ') : undefined,
    filtered: anyFiltered,
    anyStarted,
  };
}

/** The live region's words after a Prepare & Queue: the same as the toast's title. */
export const announcement = (copy: PrepareResultCopy) => (copy.description ? `${copy.title}. ${copy.description}` : copy.title);

// The Tracker's "Prepared" tab ------------------------------------------------------------------------------------

/**
 * The Prepared tab's words for an answer's state. v2.0 fix (UX-4): a question with no prepared answer is answered on the
 * form (by the extension as it fills, or by the person), not "made during the application": no application is made
 * for a job the person applies to by hand.
 */
export const ANSWER_STATE_TEXT: Record<ApplicationDraftAnswer['state'], string> = {
  ready: 'Ready',
  not_ready: 'Not prepared: answered on the form',
  profile: 'From your autofill profile',
};

// v2.0 fix (UX-4): a kit with no letter or no answers says only what is true. "Not needed" only when TailorIT knew the
// job's questions (none asked for a letter); when it did not know them, it says so; when it cannot tell (the kit's
// application could not be read), it says only that none was prepared.

/** TailorIT did not know the job's questions, so the kit has no letter and no answers. */
export const QUESTIONS_UNKNOWN = "TailorIT didn't know this job's questions";

/** Why a kit has no cover letter, from how many of the job's questions TailorIT knows (null: not known here). */
export function noLetterText(questionsKnown: number | null): string {
  if (questionsKnown === 0) return `${QUESTIONS_UNKNOWN}, so no cover letter was prepared.`;
  if (questionsKnown === null) return 'No cover letter was prepared for this job.';
  return 'No cover letter needed for this job.';
}

/** Why a kit has no answers to copy (null: not known here). */
export function noAnswersText(questionsKnown: number | null): string {
  if (questionsKnown === 0) return `${QUESTIONS_UNKNOWN}, so no answers were prepared. Answer them on the form.`;
  return 'No answers were prepared for this kit. Answer the questions on the form.';
}

/** Whether any part of a kit came from an AI: a tailored resume, a letter, or a prepared answer (UX-11). */
export function kitUsedAi(kit: Pick<PrepareDraft, 'builtBy' | 'resume' | 'letter' | 'answers'>): boolean {
  if (kit.builtBy === 'mcp') return true;
  if (kit.resume.status === 'ready' && (kit.resume.resumeMode ?? 'tailor') === 'tailor') return true;
  return kit.letter.status === 'ready' || kit.answers.ready > 0;
}

/** Who prepared a kit: the person's own AI, TailorIT's AI, or TailorIT with no AI at all (UX-11). */
export function preparedByText(kit: Pick<PrepareDraft, 'builtBy' | 'resume' | 'letter' | 'answers'>): string {
  if (kit.builtBy === 'mcp') return 'Prepared by your own AI';
  return kitUsedAi(kit) ? "Prepared by TailorIT's AI" : 'Prepared by TailorIT';
}

/** The Prepared tab's line for a document part that is not ready (`questionsKnown`: the job's, for a letter "off"). */
export function partLine(part: 'resume' | 'letter', status: PreparePartStatus, questionsKnown: number | null = null): string {
  const words = part === 'resume' ? 'resume' : 'cover letter';
  switch (status) {
    case 'ready':
      return '';
    case 'pending':
      return `The ${words} is waiting to be made.`;
    case 'building':
      return `The ${words} is being made now.`;
    case 'failed':
      return `The ${words} could not be made.`;
    case 'off':
      return noLetterText(questionsKnown);
    case 'skipped':
    case 'not_ready':
      return `The ${words} was not made.`;
  }
}
