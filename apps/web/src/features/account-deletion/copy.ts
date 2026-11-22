// v34 ACCTDEL (PLAN G10): the words of Delete my account (Settings › Account) and Delete account (Admin › Users). The
// refusals are the server's (MSG_ACCOUNT_DELETE_*, shown as it sends them), and so are a pending deletion's words
// (MSG_ACCOUNT_DELETE_PENDING*); the sign-in page's lines after a deletion are MSG_ACCOUNT_DELETED and
// MSG_ACCOUNT_DELETE_PENDING.

/**
 * What a deletion removes, in the dialog's list (true of features/account-deletion/service.ts on the API): four short
 * lines, so the dialog fits a short screen (the list scrolls when it does not).
 */
export const WHAT_GOES = [
  'Resumes, cover letters, templates, files and the Job Tracker, with what was sent',
  'The autofill profile, answers, job-site sign-ins, private jobs, settings and notifications',
  'Connected AI apps, access tokens, extension connections and sign-ins',
  'Shares, both ways (the others are told, with no name); the plan, credit and usage history',
] as const;

export const DELETE_COPY = {
  rowLabel: 'Delete account',
  rowTip: 'Deletes your account and everything in it, for good.',
  openSelf: 'Delete my account',
  openAdmin: 'Delete account',
  titleSelf: 'Delete your account?',
  /** The title names the account; `who` is drawn so that a long name breaks inside the dialog. */
  titleAdmin: (who: string) => `Delete ${who}'s account?`,
  descriptionSelf: 'Everything goes at once and cannot be brought back. You are signed out after.',
  descriptionAdmin: 'Everything goes at once and cannot be brought back. The account is signed out everywhere.',
  listLabel: 'What goes',
  stays: 'Jobs added for everyone, and work saved on profiles others shared, stay without a name.',
  /** The field's label, around the address (drawn so that a long address wraps): "Type <address> to confirm". */
  typeBefore: 'Type',
  typeAfter: 'to confirm',
  typeLabel: (email: string) => `Type ${email} to confirm`,
  confirmSelf: 'Delete my account',
  confirmAdmin: 'Delete account',
  busy: 'Deleting…',
  adminDone: 'Account deleted',
  adminPending: 'Account turned off',
  ownInAdmin: 'Delete your own account in Settings › Account.',
  sectionAdmin: 'Delete account',
  /** Admin › Users: the status of an account whose deletion finishes on its own. */
  beingDeleted: 'Being deleted',
  beingDeletedNote: 'The deletion of this account has not finished. It finishes on its own within a day; Delete account finishes it now.',
} as const;
