import type { GrantState, SharingActivityArea, SharingActivityVia } from '@tailorit/shared/sharing';

// v33 SHARE-7 (PLAN F9; SP v33 PLAN-sharing.md §8, §9): the words of Settings › Sharing, the share dialog and the
// Profiles page. v3.2 rules: labels, values and actions in view, every description in a "?" tip, errors say what to do
// next. The grid's row names and tips, the presets and the refusals are message constants (LABEL_SHARING_*,
// MSG_SHARING_*), read through usePublicConstants().t.

export const SHARING_COPY = {
  title: 'Sharing',
  description: 'Share your profile with someone, and see the profiles shared with you.',
  // Shared with you
  withYouTitle: 'Shared with you',
  withYouTip: 'Profiles other people share with you; any TailorIT AI you use on them comes from your own plan.',
  withYouEmpty: 'Nobody shares a profile with you yet.',
  invitedYou: 'Invited you',
  invitedExpires: (when: string) => `Invite ends ${when}`,
  accept: 'Accept',
  decline: 'Decline',
  open: 'Open',
  leave: 'Leave',
  accepted: (name: string) => `You can work on ${name}'s profile now.`,
  declined: 'Invite declined',
  left: (name: string) => `You left ${name}'s profile.`,
  acceptFailed: "The invite wasn't accepted",
  declineFailed: "The invite wasn't declined",
  leaveTitle: (name: string) => `Leave ${name}'s profile?`,
  leaveDescription: "You can't open it any more. Jobs you prepared that are waiting for their OK are removed.",
  leaveConfirm: 'Leave',
  // People you share with
  withOthersTitle: 'People you share with',
  withOthersTip: 'They sign in with their own account and pay for any TailorIT AI they use on your profile.',
  withOthersEmpty: "You don't share your profile with anyone.",
  share: 'Share your profile',
  change: 'Change',
  stop: 'Stop sharing',
  cancelInvite: 'Cancel invite',
  sendAgain: 'Send again',
  copyLink: 'Copy link',
  copied: 'Link copied',
  copyFailed: "The link wasn't copied. Copy it from the address bar.",
  copyTip: 'Opens Settings › Sharing, where they accept; the link grants nothing by itself.',
  stopTitle: (name: string) => `Stop sharing with ${name}?`,
  stopDescription: "They can't open your profile any more. What they already changed stays.",
  stopRemoveQueued: "Also remove the jobs they queued that haven't started",
  stopConfirm: 'Stop sharing',
  stopped: (name: string) => `You stopped sharing with ${name}.`,
  cancelTitle: (email: string) => `Cancel the invite to ${email}?`,
  cancelDescription: 'They can no longer accept it. You can send a new one later.',
  cancelConfirm: 'Cancel invite',
  keepInvite: 'Keep invite',
  cancelled: 'Invite cancelled',
  // Each share's state, as the list says it.
  state: {
    pending: 'Invited',
    active: 'Sharing',
    declined: 'Declined',
    revoked: 'Stopped',
    left: 'Left',
    expired: 'Ended',
  } satisfies Record<GrantState, string>,
  invitePending: (email: string) => `Waiting for ${email} to accept`,
  until: (when: string) => `Until ${when}`,
  noEnd: 'No end date',
  // Activity
  activityTitle: 'Activity',
  activityTip: 'What was done on a shared profile, counted by the hour: counts only, never what changed.',
  activityEmpty: 'Nothing done on a shared profile yet.',
  loadMore: 'Load more',
  you: 'You',
  times: (count: number) => `${count} ${count === 1 ? 'time' : 'times'}`,
  // Load errors ("Sharing didn't load.")
  loadThing: 'Sharing',
  activityThing: 'Activity',
} as const;

/** The share dialog's words. */
export const GRANT_COPY = {
  createTitle: 'Share your profile',
  changeTitle: (name: string) => `Change what ${name} can do`,
  help: 'They sign in with this email and pay for any TailorIT AI they use.',
  email: 'Their email',
  emailPlaceholder: 'name@example.com',
  emailMissing: 'Enter their email.',
  emailInvalid: 'Enter an email like name@example.com.',
  preset: 'Access',
  grid: 'What they can do',
  gridTip: 'Your sign-in, connected apps, extension, job-site sign-ins and sharing always stay yours.',
  noEndTip: 'Leave it empty to share until you stop.',
  endDate: 'End date',
  endPast: 'Choose today or a later day, or leave it empty.',
  clearEnd: 'No end date',
  submitCreate: 'Share',
  submitChange: 'Save changes',
  busyCreate: 'Sharing...',
  busyChange: 'Saving...',
  cancel: 'Cancel',
  changed: 'Sharing changed',
  saveFailed: "Sharing wasn't saved",
  reading: 'Reading what they can do now...',
  endedMeanwhile: 'This share has ended, so there is nothing to change. Use Send again to share once more.',
  close: 'Close',
  nothingTicked: 'Tick at least one box.',
  see: 'See',
  change: 'Change',
  notApplicable: 'Not offered',
} as const;

/** The Profiles page's words. */
export const PROFILES_COPY = {
  title: 'Profiles',
  description: 'Your profile and the profiles shared with you, at once.',
  you: 'You',
  yours: 'Your profile',
  current: 'Open now',
  open: 'Open',
  until: (when: string) => `Until ${when}`,
  counts: {
    saved: 'Saved',
    applied: 'Applied',
    preparing: 'Preparing',
    queued: 'In queue',
    waitingForOk: 'Waiting for OK',
    needsYou: 'Needs you',
  },
  waitingTip: {
    own: 'Jobs others prepared on your profile that wait for your OK.',
    shared: "Jobs you prepared that wait for the owner's OK.",
  },
  notShown: 'Not shared',
  needsYouTitle: 'Needs you',
  needsYouTip: 'Applications to finish, and jobs waiting for your OK, on every profile.',
  needsYouEmpty: 'Nothing needs you right now.',
  itemKind: { needs_you: 'Finish applying', awaiting_ok: 'Waiting for your OK' } as const,
  prepareAll: 'Prepare all profiles',
  prepareAllTip: 'Prepares the saved jobs that pass the filters on each profile you may prepare, all of it on your AI use.',
  reading: 'Checking...',
  confirmTitle: (count: number) => `Prepare ${count} ${count === 1 ? 'job' : 'jobs'}?`,
  confirmNone: 'Nothing to prepare',
  confirmLine: (profiles: number) => `On ${profiles} ${profiles === 1 ? 'profile' : 'profiles'} · Uses your AI`,
  confirmNothing: 'No saved job on these profiles passes the filters now.',
  confirmLabel: (count: number) => `Prepare ${count}`,
  starting: 'Starting...',
  started: (count: number, profiles: number) =>
    `Preparing ${count} ${count === 1 ? 'job' : 'jobs'} on ${profiles} ${profiles === 1 ? 'profile' : 'profiles'}`,
  refusedTitle: (count: number) => `${count} ${count === 1 ? 'profile' : 'profiles'} not prepared`,
  refusedLead: 'Nothing started on these:',
  endedReason: "It isn't shared with you any more.",
  notSharedReason: "Preparing it isn't shared with you now.",
  loadThing: 'Profiles',
  off: 'Only your profile shows while sharing is off.',
} as const;

/** What an activity row's area is called (the grid's rows, plus the share itself). */
export const ACTIVITY_AREA: Record<SharingActivityArea, string> = {
  tracker: 'Job Tracker',
  documents: 'Documents',
  prepare: 'Prepare',
  queue: 'Queue changes',
  apply: 'Applying',
  autofill: 'Autofill info',
  settings: 'Job settings',
  sensitive: 'Sensitive answers',
  exports: 'Exports',
  mcp: 'Their own AI',
  sharing: 'Sharing',
};

/** How the counted work came. */
export const ACTIVITY_VIA: Record<SharingActivityVia, string> = {
  web: 'on the web',
  mcp: 'with their AI',
  extension: 'by the extension',
  system: 'by TailorIT',
};

/** An activity row's action in words (`read`, `write`, a share's event); an unknown code reads as itself. */
export function activityAction(action: string): string {
  switch (action) {
    case 'read':
      return 'Looked';
    case 'write':
      return 'Changed';
    case 'invited':
      return 'Invited';
    case 'accepted':
      return 'Accepted';
    case 'declined':
      return 'Declined';
    case 'changed':
      return 'Changed access';
    case 'revoked':
      return 'Stopped sharing';
    case 'cancelled':
      return 'Cancelled the invite';
    case 'left':
      return 'Left';
    case 'expired':
      return 'Ended';
    case 'ended':
      return 'Ended';
    case 'prepared':
      return 'Prepared';
    default:
      return action.replace(/_/g, ' ').replace(/^./, (first) => first.toUpperCase());
  }
}
