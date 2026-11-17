'use client';

import type { AccountSummary } from '@tailorit/shared/accounts';
import { useCallback, type ReactElement } from 'react';
// Relative, not '@/': the web tests read these.
import { resumeLimit, useLimitDialog, type LimitInfo } from '../../../components/limits';
import { useAccount } from '../../../lib/account';
import { usePublicConstants } from '../../../lib/constants';

// v2.0 (A15; docs/design/v2.0/08-ui.md, "Other screens touched", Documents › Resumes): the Free resume limit as the
// Documents page and the editor meet it. At the limit (count >= limit, an account's every resume of every kind), a new
// resume of any kind and a save of a resume's document are refused by the server (403 resume_limit_reached); the page
// says so before asking: the notice above the list, and the message (with Subscribe) when New, Upload, Duplicate or
// Make editable copy is pressed. Deleting is always allowed.

/** Whether the account is at its resume limit (a Paid account's is unlimited: never). Unknown account: not at it. */
export function atResumeLimit(account: Pick<AccountSummary, 'resumes'> | null | undefined): boolean {
  if (!account || account.resumes.limit === null) return false;
  return account.resumes.count >= account.resumes.limit;
}

export interface ResumeLimitGate {
  /** The limit's message (MSG_LIMIT_RESUMES, Subscribe) while at the limit; null otherwise. */
  info: LimitInfo | null;
  /** Before making a resume: at the limit, shows the message and answers true (the caller stops); else false. */
  blocks: () => boolean;
  /** Shows a refusal the server gave (any limit error) in the same dialog; false for any other error. */
  show: (error: unknown) => boolean;
  /** Render once. */
  dialog: ReactElement;
}

export function useResumeLimitGate(): ResumeLimitGate {
  const { data: account } = useAccount();
  const { t } = usePublicConstants();
  const limits = useLimitDialog();
  const info = atResumeLimit(account) && account?.resumes.limit != null ? resumeLimit(t, account.resumes.limit, account.type) : null;
  const { show } = limits;
  const blocks = useCallback(() => (info ? show(info) : false), [info, show]);
  return { info, blocks, show, dialog: limits.dialog };
}
