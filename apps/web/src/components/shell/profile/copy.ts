// v33 SHARE-4 (PLAN F9; SP v33 PLAN-sharing.md §9): the words of the profile switcher, the profile chip and the
// profile notices. No banners (v3.2): the chip and the account menu say whose profile the tab works on; an ended or
// refused profile is one alert; a quiet move back is a toast. The refusals' own sentences are message constants
// (MSG_SHARING_*), read through usePublicConstants().t.

export const PROFILE_COPY = {
  /** The chip and the menu's own row. */
  you: 'You',
  /** The account menu's and the phone sheet's group. */
  group: 'Profiles',
  allProfiles: 'All profiles',
  invites: (count: number) => `${count} ${count === 1 ? 'invite' : 'invites'}`,
  /** A shared profile whose owner's name is the person's own: told apart by the owner's email. */
  sharedBy: (email: string) => `Shared: ${email}`,
  /** The chip's accessible name ("Shared: <email>" reads "Working on the profile Shared: <email>"). */
  workingOn: (name: string) => (name.startsWith('Shared: ') ? `Working on the profile ${name}` : `Working on ${name}'s profile`),
  workingOnYours: 'Working on your profile',
  /** Before the list is read (or for a key it does not have). */
  workingOnShared: 'Working on a shared profile',
  shared: 'Shared',
  /** The account menu trigger's name while the tab works on a shared profile. */
  accountMenu: (person: string, profile: string | null) =>
    profile === null
      ? `Account menu for ${person}`
      : profile.startsWith('Shared: ') || profile === ''
        ? `Account menu for ${person}, working on a shared profile`
        : `Account menu for ${person}, working on ${profile}'s profile`,
  /** The usage chip's tip once the person has shared profiles: every AI use is theirs, on any profile. */
  usageTip: 'Your AI use',
  /** The tab's title while it works on a shared profile ("Ana · Job Tracker · TailorIT"). */
  titlePrefix: (name: string) => `${name} · `,
  /** The page header's small line above the title on a shared profile. */
  eyebrow: (name: string) => `${name}'s profile`,
  switching: 'Switching...',
  // A switch that would leave unsaved changes behind.
  unsavedTitle: 'Changes not saved yet',
  unsavedMessage: 'Wait until your changes are saved, then switch again.',
  // An outside link that names a profile: asked first.
  askTitle: (name: string) => `Open ${name}'s profile?`,
  askDescription: (email: string) => `${email}. This tab works on their profile until you switch back.`,
  askConfirm: 'Open profile',
  askOwnTitle: 'Go back to your profile?',
  askOwnDescription: 'This tab works on your own profile again.',
  askOwnConfirm: 'Go back',
  askCancel: 'Stay here',
  /** A link or a choice naming a profile the person has no more. */
  unavailable: "That shared profile isn't available.",
  // The notices after a reload.
  endedTitle: (name: string | null) => (name ? `${name}'s profile isn't available` : "Shared profile isn't available"),
  backOnYours: 'Back on your profile.',
  // A write the profile's owner did not allow, or one done only on the person's own profile.
  notSharedTitle: 'Not shared with you',
  notSharedBy: (name: string) => `${name} hasn't shared this with you.`,
  ownOnlyTitle: 'Only on your own profile',
  switchBack: 'Switch back',
} as const;
