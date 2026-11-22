import {
  FANOUT_ALL,
  PROFILE_SELF,
  rowOfPermission,
  SHARE_COLUMN_LABELS,
  type FanoutTargets,
  type ProfileChoice,
  type ProfileKey,
  type SharedProfile,
  type SharePermission,
} from '@tailorit/shared/sharing';
import { FANOUT_COPY } from './copy';

// v34 FANWEB (PLAN G1, G4): which profiles an action on several profiles offers, pure so the tests read it. The list is
// the signed-in person's own profile ("You", always first) and each profile shared with them, in the switcher's order
// (the oldest share first, as the server's 'all'). A shared profile whose owner did not tick a box the action needs is
// listed but off, with a one-line reason read from the boxes the shell already holds (useProfile().profiles), never
// from an answer: the server refuses every unusable profile with the same words, whatever the reason (FANOUT decision
// 1). Nothing of this shows while the person has no shared profile.

/** One profile an action may run on. */
export interface FanoutProfile {
  /** 'me' (the signed-in person) or the shared profile's key. */
  choice: ProfileChoice;
  /** "You", or the owner's name as the switcher names them. */
  label: string;
  /** The signed-in person's own profile. */
  own: boolean;
  /** The profile this tab works on (its "Save" and "This profile"). */
  current: boolean;
  /** Every box the action needs is ticked (always on the person's own). */
  allowed: boolean;
  /** The boxes it lacks (empty when allowed). */
  missing: SharePermission[];
}

/** What the boxes' names are read with (usePublicConstants().t, or a test's stand-in). */
export type LabelOf = (key: string) => string;

/** "Job Tracker › Change": a box by the words the Sharing page shows. */
export function boxName(perm: SharePermission, label: LabelOf): string {
  const row = rowOfPermission(perm);
  const column = row.see === perm ? SHARE_COLUMN_LABELS.see : SHARE_COLUMN_LABELS.change;
  return `${label(row.label)} › ${label(column)}`;
}

/** Why a profile is off for an action: "Needs Job Tracker › Change." (the first box it lacks). */
export function missingReason(profile: Pick<FanoutProfile, 'missing'>, label: LabelOf): string | null {
  const first = profile.missing[0];
  return first ? FANOUT_COPY.needs(boxName(first, label)) : null;
}

/**
 * The profiles an action needing `perms` offers: "You" first, then every shared profile (off without a box). `nameOf`
 * names a shared profile as the shell does (profileName); `tab` is the profile the tab works on (null: the person's own).
 */
export function fanoutProfiles(
  shared: readonly SharedProfile[],
  tab: ProfileKey | null,
  perms: readonly SharePermission[],
  nameOf: (profile: SharedProfile) => string,
): FanoutProfile[] {
  return [
    { choice: PROFILE_SELF, label: FANOUT_COPY.you, own: true, current: tab === null, allowed: true, missing: [] },
    ...shared.map((profile) => {
      const missing = perms.filter((perm) => !profile.permissions.includes(perm));
      return {
        choice: profile.key,
        label: nameOf(profile),
        own: false,
        current: profile.key === tab,
        allowed: missing.length === 0,
        missing,
      };
    }),
  ];
}

/** Whether several profiles are there at all: the person has a shared profile (else every v3.4 part stays hidden). */
export const hasSharedProfiles = (shared: readonly SharedProfile[]): boolean => shared.length > 0;

/** The tab's own profile as a target ('me' on the person's own, else its key). */
export function tabChoice(tab: ProfileKey | null): ProfileChoice {
  return tab ?? PROFILE_SELF;
}

/**
 * The targets a choice of profiles sends: 'all' when every allowed profile of the whole list is chosen (the server's
 * "you and every share whose boxes allow it"), else the chosen ones in the list's order (the person's own first). An off
 * profile is never sent. `complete` false: the list leaves some profile out (Copy to leaves out where the cards are), so
 * the choice is always sent as it is.
 */
export function targetsOf(profiles: readonly FanoutProfile[], chosen: ReadonlySet<ProfileChoice>, complete = true): FanoutTargets | null {
  const allowed = profiles.filter((profile) => profile.allowed);
  const picked = allowed.filter((profile) => chosen.has(profile.choice)).map((profile) => profile.choice);
  if (picked.length === 0) return null;
  if (complete && picked.length === allowed.length && allowed.some((profile) => profile.own)) return FANOUT_ALL;
  return picked;
}

/** The profiles a target list names (for the words of a confirm), in the list's order. */
export function profilesOfTargets(profiles: readonly FanoutProfile[], targets: FanoutTargets): FanoutProfile[] {
  if (targets === FANOUT_ALL) return profiles.filter((profile) => profile.allowed);
  const wanted = new Set<string>(targets);
  return profiles.filter((profile) => wanted.has(profile.choice));
}
