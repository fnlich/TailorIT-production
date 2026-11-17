import { AutofillProfileSaveSchema, AutofillSensitiveSaveSchema } from '@tailorit/shared/autofill';
import type { z } from 'zod';
import { PUBLIC_CONSTANT_DEFAULTS, defaultTooLong, renderPublicMessage, type TooLongText } from '../../lib/constants';
import type { AutofillDraft } from './draft';

// The Profile tab's checks are the contract's own save schemas, the ones the server parses the PUT with, so the page and
// the server never disagree about what may be saved. Only the wording of zod's built-in messages (a number out of
// range, a whole number) is put into the page's words; the contract's own sentences are kept as written.

type Issue = z.core.$ZodIssue;

/** zod's own sentences start like this ("Too big: expected number to be <=52"); the contract's never do. */
const BUILT_IN_MESSAGE = /^(Too (big|small):|Invalid )/;

/** v30 ST5: a list past its length, in MSG_LIST_TOO_LONG's words ("List at most {max}"); the page passes its `t`'s. */
const defaultListTooLong: TooLongText = (max) => renderPublicMessage(PUBLIC_CONSTANT_DEFAULTS, 'MSG_LIST_TOO_LONG', { max });

/** The page's words for a text and a list past their lengths (MSG_TEXT_TOO_LONG, MSG_LIST_TOO_LONG). */
interface TooLongWords {
  text: TooLongText;
  list: TooLongText;
}

/** A sentence for an issue zod worded itself; a text or a list past its length in the constants' words. */
function plainMessage(issue: Issue, tooLong: TooLongWords): string {
  switch (issue.code) {
    case 'too_big':
      if (issue.origin === 'number') {
        return issue.inclusive === false ? `Use less than ${issue.maximum}` : `Use ${issue.maximum} or less`;
      }
      if (issue.origin === 'array' || issue.origin === 'set') return tooLong.list(Number(issue.maximum));
      return tooLong.text(Number(issue.maximum));
    case 'too_small':
      if (issue.origin === 'number') {
        return issue.inclusive === false ? `Use a number above ${issue.minimum}` : `Use ${issue.minimum} or more`;
      }
      if (issue.origin === 'array' || issue.origin === 'set') return `Choose at least ${issue.minimum}`;
      return 'Required';
    case 'invalid_type':
      if (issue.expected === 'int') return 'Use a whole number';
      if (issue.expected === 'number') return 'Enter a number';
      return 'Required';
    case 'invalid_value':
      return 'Choose one of the options';
    default:
      return 'Check this value';
  }
}

function messageOf(issue: Issue, tooLong: TooLongWords): string {
  return BUILT_IN_MESSAGE.test(issue.message) ? plainMessage(issue, tooLong) : issue.message;
}

function collect(part: 'profile' | 'sensitive', issues: readonly Issue[], into: Record<string, string>, tooLong: TooLongWords): void {
  for (const issue of issues) {
    const place = [part, ...issue.path.map(String)].join('.');
    into[place] ??= messageOf(issue, tooLong);
  }
}

/**
 * What a save of this draft would be refused for, by place, as the server's `fields` name them
 * ("profile.name.first", "profile.education.0.endDate", "sensitive.eeo.races.value"); each place keeps its first
 * message. Empty when the save would pass. A text past its length reads MSG_TEXT_TOO_LONG (`tooLong`: the page passes
 * its `t`'s, v2.0 fix wave REQ-3), a list past its length MSG_LIST_TOO_LONG (`listTooLong`, v30 ST5).
 */
export function validateAutofillProfile(
  draft: AutofillDraft,
  textTooLong: TooLongText = defaultTooLong,
  listTooLong: TooLongText = defaultListTooLong,
): Record<string, string> {
  const tooLong: TooLongWords = { text: textTooLong, list: listTooLong };
  const messages: Record<string, string> = {};
  const profile = AutofillProfileSaveSchema.safeParse(draft.profile);
  if (!profile.success) collect('profile', profile.error.issues, messages, tooLong);
  const sensitive = AutofillSensitiveSaveSchema.safeParse(draft.sensitive);
  if (!sensitive.success) collect('sensitive', sensitive.error.issues, messages, tooLong);
  return messages;
}
