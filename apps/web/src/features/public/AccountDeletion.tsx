import { B, TextLink } from './prose';

// ---------------------------------------------------------------------------------------------------- DELETION_TEXT
// v34 PUBLIC (PLAN G8, G10; the review's finding 1): how a person has their account deleted, as the Privacy page says it.
// v34 ACCTDEL (G10): the tool exists (Settings › Account › Delete my account; Admin › Users › Delete account, for a
// request sent to the contact address), and this block says exactly what it deletes and keeps
// (apps/api/src/features/account-deletion/service.ts): every row and file of the account, at once, and its sessions (a
// file held open at that moment goes at the daily pass: within a day; a deletion that stops part way leaves the account
// off and is finished by the daily pass: within a day); sharing ended both ways, the other side told with no name or
// address; kept, without the account: the lake jobs it added, what it saved or changed on a profile someone shared with
// it (that owner's), the invites someone else sent to the address that it never answered (pending, expired or
// cancelled: their sender's records, as typed; a declined one is removed); one line that an account was deleted (when,
// and whether by its owner or an administrator: nothing that says whose); backups until they are replaced and server
// logs until they are rotated. public.test.ts holds these words, and the API's tests (v34-acctdel*.test.ts) hold the
// code to them. The retention list (PrivacyPage.tsx) says a deletion cuts each line short.

/** The Privacy page's "Delete your account" item (Change, export or delete). */
export function AccountDeletionText() {
  return (
    <span data-deletion-text="tool">
      <B>Delete your account</B> yourself in <B>Settings › Account › Delete my account</B>, or ask us from the address
      you sign in with (see <TextLink href="#contact">Contact</TextLink>). Everything the account holds is deleted at
      once and for good, and you are signed out: your resumes, cover letters, templates and files; your Job Tracker, its
      sent applications and the copies you sent; your profile, answers, sensitive answers and job-site sign-ins; the jobs
      only you could see; your plan, credit and usage history; your notifications; what was sent to the AI for you and its
      answers; and every sign-in, connected AI app, access token and extension connection. A file in use at that moment
      is removed within a day, and if the deletion stops part way, the account stays turned off and the rest is deleted
      within a day. Sharing ends both ways: the people you shared your profile with, and those who shared theirs with
      you, are told a share ended, without your name or address. What you saved or changed on a profile someone shared
      with you stays theirs, without your name, and so do jobs you added to the job list everyone sees. An invite someone
      else sent to your address that you never answered stays in their sharing records as they typed it, also once it
      has expired or they cancelled it; an invite you declined is removed. We keep only a note that an account was
      deleted, when, and whether by its owner or an administrator, which does not say whose. Copies in backups go when
      those backups are replaced, and the server&apos;s logs (which may hold your email address) when they are rotated.
    </span>
  );
}

/** How the Children section says a child's account goes (it points at the item above). */
export const CHILD_ACCOUNT_DELETION =
  'tell us: we delete the account and everything it holds at once, as described under Change, export or delete.';

/**
 * v34 ACCTDEL: the retention list's lines that a deletion cuts short (PrivacyPage.tsx draws them; public.test.ts
 * holds them): your own data goes with your account; what is kept about a share also goes when the other person
 * deletes theirs.
 */
export const RETENTION_DELETION = {
  /** After "Counts of what was done on a shared profile are deleted after N days". */
  sharingCounts: ', or sooner when you or the other person deletes their account',
  /** After "... ended sharing (with whom, by email address, the boxes and the dates) are kept while your account exists". */
  endedSharing:
    '; ended sharing with someone goes sooner when they delete their account, except an invite they never answered',
  /** Before the server's logs and the backups (which a deletion does not reach). */
  cutShort: 'Deleting your account cuts each of the lines above short: what it holds goes at once, as described under Change, export or delete.',
} as const;
// ------------------------------------------------------------------------------------------------ end DELETION_TEXT
