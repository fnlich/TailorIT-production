import type { AutofillKnownQuestion } from '@tailorit/shared/autofill';
import { screenQuestion } from './screen';

// A job's known questions (v1.3 A's job_form_questions: from submissions and Greenhouse's board API), as the MCP tools
// hand them to the person's AI (v1.5 M): only the ones it may answer. P's draftQuestions (prepare/service.ts) plans
// each one (draft, not_ready or profile); the others are counted, never shown: the profile, or the person, answers them
// on the form.

/**
 * The questions the person's AI may answer, from the drafts' own reading of the job's questions (P's draftQuestions:
 * state 'draft'), screened once more here (screenQuestion), in form order.
 */
export function openQuestions(questions: ReadonlyArray<{ question: AutofillKnownQuestion; state: string }>): AutofillKnownQuestion[] {
  return questions.filter((item) => item.state === 'draft' && screenQuestion(item.question) === null).map((item) => item.question);
}

/** A question as the AI is shown it: what it asks, how it is answered, and the options to choose from. */
export function questionView(question: AutofillKnownQuestion) {
  return {
    questionId: question.id,
    label: question.label,
    section: question.section || null,
    kind: question.kind,
    answerAs: answerShape(question),
    required: question.required,
    ...(question.options.length > 0 ? { options: question.options } : {}),
  };
}

/** The answer shape a question takes (prepare_save_answers checks it). */
export type AnswerShape = 'text' | 'one_option' | 'options' | 'checked';

export function answerShape(question: Pick<AutofillKnownQuestion, 'kind' | 'options'>): AnswerShape {
  switch (question.kind) {
    case 'checkbox':
      return 'checked';
    case 'select':
    case 'radio':
    case 'combobox':
      return question.options.length > 0 ? 'one_option' : 'text';
    case 'multiselect':
    case 'checkbox-group':
      return question.options.length > 0 ? 'options' : 'text';
    default:
      // text, textarea, date, typeahead-remote: written.
      return 'text';
  }
}
