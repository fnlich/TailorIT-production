import type { LimitKind } from './limits';

// v2.0: the words of the shared limit pieces (docs/design/v2.0/08-ui.md, "Shared pieces"). The limit and status
// messages themselves are constants (02-constants.md): the server renders them in its error bodies, and the web reads
// the rest with usePublicConstants. These are the buttons, titles and labels around them.

export const LIMIT_COPY = {
  subscribe: 'Subscribe',
  buyCredit: 'Get extra credit',
  copyEmail: 'Copy email',
  emailCopied: 'Email copied',
  copyByHand: 'Copy the email by hand',
  copyRefused: 'Your browser did not let TailorIT copy it.',
  continueToPayment: 'Continue to payment',
  subscribeTitle: 'Subscribe',
  buyCreditTitle: 'Buy extra credit',
  /** The UsageMeter's accessible name (08-ui.md). */
  usageLabel: 'Auto-applies used today',
  /**
   * v2.0 fix (UX-15): what a locked Paid feature's control adds to its accessible name ("Download (Paid accounts
   * only)"), so it is announced as locked before it is pressed.
   */
  paidOnly: 'Paid accounts only',
  /** Under the UsageMeter at the limit: "Resets at 12:00 AM Pacific Time". */
  resetsAt: (when: string) => `Resets at ${when}`,
  /** v31 AUTO: under the UsageMeter while runs are in progress: "1 applying now". */
  running: (count: number) => `${count} applying now`,
  /** v32 COPY (E7): the AI use meter's name (a share only, never the amounts). */
  aiUseLabel: 'AI use today',
  aiUseUnlimited: 'No daily limit',
} as const;

/** The LimitDialog's title for each kind of limit (its body is the message). */
export const LIMIT_TITLES: Record<LimitKind, string> = {
  ai_unavailable: 'AI unavailable',
  ai_usage_exhausted: "Today's AI use is used up",
  resume_limit_reached: 'Resume limit reached',
  paid_feature: 'Paid feature',
  auto_apply_limit: 'Daily auto-apply limit reached',
};
