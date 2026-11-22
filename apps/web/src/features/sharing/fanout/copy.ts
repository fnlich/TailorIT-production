// v34 FANWEB (PLAN G2-G4): the words of working on several profiles at once (brief, from the person's side; the v3.2
// rules: controls in a few words, a description is a "?" tip, a notice is an alert). The server's own sentences (a
// profile's own refusal) come in its answers; a profile left out or refused is explained from the boxes the shell holds.

/** "You and Ana", "You, Ana and Ben". */
export function namesList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** v34 FIX-WEB (final review U-L2): past this many names a result says the count ("Filters changed on 9 profiles"). */
export const NAMES_SHOWN = 3;

/** "Ana, Ben and Cy"; past NAMES_SHOWN, the first two and the rest counted ("Ana, Ben and 5 more"). */
export function shortNamesList(names: readonly string[]): string {
  if (names.length <= NAMES_SHOWN) return namesList(names);
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export const FANOUT_COPY = {
  you: 'You',
  /** The tab's own profile in a menu or a list. */
  thisProfile: 'This profile',
  allProfiles: 'All profiles',
  chooseProfiles: 'Choose profiles…',
  /** The list of profiles in a choice (its group's name). */
  profilesGroup: 'Profiles',
  /** A profile its owner did not tick the box for. */
  needs: (box: string) => `Needs ${box}.`,
  /** v34 FANWEB fix: the same in a result, with the next step (only the owner ticks a box, in their Sharing settings). */
  needsAsk: (box: string) => `Needs ${box}. Ask its owner to tick it in Settings › Sharing.`,
  /**
   * A profile allowed when the list was read and refused by the time the answer came (v34 FANWEB fix: the known reason,
   * and where to look next).
   */
  unavailable: 'Its owner changed or ended the share; All profiles in your account menu shows what you can do now.',
  /** A refused profile the list no longer names (its share ended). */
  unknownProfile: 'A profile no longer shared',
  /** v34 FANWEB fix (spec L5): an entry at any status is in that profile's Job Tracker. */
  savedAlready: 'In its Job Tracker',

  // Save to ------------------------------------------------------------------------------------------------------------
  saveTo: 'Save to…',
  saveToLabel: (title: string) => `Save ${title} to profiles`,
  saveToMenu: 'Save to profiles',
  saveToTitle: 'Save to profiles',
  saveToHelp: 'Each profile saves the job with its own best-matched resume.',
  saveToConfirm: (count: number) => (count === 1 ? 'Save to 1 profile' : `Save to ${count} profiles`),
  saveSelectedTitle: (jobs: number) => `Save ${plural(jobs, 'job', 'jobs')} to profiles`,
  savedOn: (names: string) => `Saved on ${names}`,
  notSavedTitle: 'Nothing was saved',
  /** One profile's line in a result: "Ana: 2 saved, 1 already there". */
  savedCounts: (saved: number, already: number, notFound: number) =>
    [
      saved > 0 ? `${saved} saved` : null,
      already > 0 ? `${already} already there` : null,
      notFound > 0 ? `${notFound} not visible there` : null,
    ]
      .filter(Boolean)
      .join(', ') || 'nothing new',
  undo: 'Undo',
  undone: (count: number) => `${plural(count, 'job', 'jobs')} removed from saved jobs`,
  undoneNone: 'Nothing was removed',
  undoFailed: "The save couldn't be undone",
  /** v34 FANWEB fix (sharing L4): the alert's line for a profile the Undo could not reach. */
  notUndone: 'Not undone there.',
  /** v34 FANWEB fix (spec M2): a profile where nothing was saved, named with why. */
  cantSee: (name: string, count: number) => `${name} can't see ${count === 1 ? 'this job' : 'these jobs'}.`,
  notReached: (name: string) => `Not saved on ${name}: try again.`,
  nothingNewOn: (name: string) => `Nothing new on ${name}.`,

  // Saved on chips -----------------------------------------------------------------------------------------------------
  savedOnChip: (names: string) => `Saved on ${names}`,
  savedOnLabel: (names: string) => `Also saved on ${names}`,

  // Save all to --------------------------------------------------------------------------------------------------------
  saveAllTo: 'Save all to…',
  saveAllToTip: "Save this search's jobs on other profiles too",
  saveAllToTitle: 'Save all to profiles',
  saveAllToHelp: "Each profile saves its own matches for this search, with its own resume.",
  saveAllContinue: 'Continue',
  /** v34 FANWEB fix (spec L4): the lines under it give each profile's count. */
  saveAllConfirmTitle: (profiles: number) => `Save on ${plural(profiles, 'profile', 'profiles')}?`,
  saveAllConfirmNone: 'Nothing new to save',
  saveAllConfirmLine: 'Each profile saves the jobs it does not have yet.',
  saveAllConfirmLabel: 'Save',
  saveAllBusy: 'Saving...',
  willSave: (count: number) => (count === 0 ? 'nothing new' : `saves ${count}`),
  /** v34 FANWEB fix (spec M2): Save all on a profile that saved nothing. */
  allSavedAlready: (name: string) => `${name} has these jobs saved already.`,
  noNewMatches: (name: string) => `No new matches on ${name}.`,

  // Add job ------------------------------------------------------------------------------------------------------------
  alsoSaveTo: 'Also save to',
  alsoSaveToHelp: 'The job is added on each profile you tick too.',
  alsoSaved: (names: string) => `Also on ${names}.`,
  alsoNot: (lines: string) => `Not on ${lines}.`,
  /** v34 FANWEB fix (sharing L7): the tab's own profile refused while the others were added. */
  addRefusedTitle: 'Not added to this profile',

  // Copy (the Job Tracker) ---------------------------------------------------------------------------------------------
  copyTo: 'Copy to profiles…',
  copyToTitle: (count: number) => `Copy ${plural(count, 'application', 'applications')} to profiles`,
  copyToHelp: 'Only the jobs are copied, as Saved; notes, history and documents stay here.',
  copyConfirm: (count: number) => (count === 1 ? 'Copy to 1 profile' : `Copy to ${count} profiles`),
  copiedTo: (names: string) => `Copied to ${names}`,
  nothingCopied: 'Nothing was copied',
  /** v34 FANWEB fix (spec L3): Copy's Undo. */
  copyUndone: (count: number) => `${plural(count, 'copied job', 'copied jobs')} removed`,
  noJob: (count: number) => `${plural(count, 'application', 'applications')} added by hand ${count === 1 ? 'has' : 'have'} no job to copy.`,

  // The All profiles view's bulk actions -------------------------------------------------------------------------------
  readOnlySkipped: (names: string) => `Left alone on ${names}: shared to see only.`,
  /** v34 FANWEB fix (spec M6): the Select bar while cards of a see-only profile are chosen. */
  seeOnlyChosen: (names: string, all: boolean) =>
    all
      ? `Only cards of ${names} are chosen: shared to see only, so they can be copied but not moved, archived or restored.`
      : `${names}: shared to see only, so moving, archiving and restoring leave those cards alone.`,
  bulkDone: (count: number, word: string) => `${plural(count, 'application', 'applications')} ${word}`,
  bulkNothing: 'Nothing was changed',
  nothingToChangeOn: (name: string) => `Nothing to change on ${name}.`,
  nothingStartedOn: (name: string, why: string | null) => (why ? `Nothing started on ${name}: ${why.replace(/\.$/, '')}.` : `Nothing started on ${name}.`),
  prepareConfirmTitle: (jobs: number, profiles: number) =>
    `Prepare & Queue ${plural(jobs, 'job', 'jobs')}${profiles > 1 ? ` on ${profiles} profiles` : ''}?`,
  prepareConfirmLine: 'Your AI use pays for every profile. What you prepare on a shared profile waits for its owner\'s OK unless they let you apply.',
  prepareConfirmLabel: 'Prepare & Queue',
  prepareBusy: 'Starting...',
  prepareStarted: (count: number) => `${plural(count, 'job', 'jobs')} preparing`,
  prepareNone: 'Nothing was prepared',
  prepareOutcome: (started: number, filtered: number, skipped: number, skipWhy: string | null = null) =>
    [
      started > 0 ? `${started} preparing` : null,
      filtered > 0 ? `${filtered} filtered out` : null,
      skipped > 0 ? (skipWhy ? `${skipped} skipped (${skipWhy.replace(/\.$/, '')})` : `${skipped} skipped`) : null,
    ]
      .filter(Boolean)
      .join(', ') || 'nothing started',
  prepareBlocked: (box: string) => `Needs ${box} on this profile.`,

  // Apply to (filters, Prepare settings, the Auto-save rule) -----------------------------------------------------------
  applyTo: 'Apply to',
  applyToLabel: 'Apply the changes to',
  applyThis: 'This profile',
  applyAll: 'All profiles',
  applyChoose: 'Choose profiles…',
  applyChosen: (count: number) => (count === 1 ? '1 profile' : `${count} profiles`),
  applyToTitle: 'Apply to profiles',
  applyToHelp: 'Only the filters you change or tick are applied; Where you live stays each person\'s own.',
  applyToConfirm: 'Choose',
  /** The per-field mark while the changes go to several profiles. */
  mark: 'Apply',
  markLabel: (field: string) => `Apply ${field} to the chosen profiles`,
  /** v34 FANWEB fix (the reviews' HIGH): the custom filter's words on several profiles. */
  customReplaces: "These words replace each chosen profile's own.",
  customKept: 'Other profiles keep their own words: type new words to turn it on there.',
  customLeftOut: (names: string) => `Custom (AI) left out on ${names}: type the filter's words to turn it on there.`,
  /** v34 FANWEB fix (spec L6): changed here, its mark unticked: not sent. */
  notTicked: (fields: string) => `Changed but not ticked, so not applied: ${fields}.`,
  /** v34 FANWEB fix (sharing L5): the form over every profile waits for the list of shared profiles. */
  loadingProfiles: 'Loading profiles…',
  marksNone: 'Change or tick the filters to apply.',
  marksCount: (count: number) => `${plural(count, 'filter', 'filters')} to apply`,
  filtersChangedOn: (names: string) => `Filters changed on ${names}`,
  filtersNotChanged: 'No filters were changed',
  /**
   * v34 FIX-WEB (final review U-L2): one line for every profile that kept an eligibility switch, with the box and the
   * next step ("Kept on 7 profiles (Ben Ito, Eva Li and 5 more): I need visa sponsorship. Needs …; ask each owner …").
   */
  keptOn: (names: readonly string[], switches: string, box: string) =>
    names.length === 1
      ? `Kept on ${names[0]}'s profile: ${switches}. Needs ${box}; ask its owner to tick it in Settings › Sharing.`
      : `Kept on ${names.length} profiles (${shortNamesList(names)}): ${switches}. Needs ${box}; ask each owner to tick it in Settings › Sharing.`,
  keptOnYours: (switches: string) => `Kept: ${switches}.`,
  readOnlyNote: (owner: string | null, box: string) =>
    owner ? `You can see ${owner}'s filters. Changing them needs ${box}.` : `You can see these filters. Changing them needs ${box}.`,
  readOnlySettings: (owner: string | null, box: string) =>
    owner ? `You can see ${owner}'s settings. Changing them needs ${box}.` : `You can see these settings. Changing them needs ${box}.`,

  applyOthers: 'Apply to other profiles…',
  applyOthersTitle: 'Apply to other profiles',
  applySettingsHelp: 'Tick the settings to copy to the profiles you choose.',
  applyRuleHelp: 'Tick what to copy to the profiles you choose.',
  applyConfirm: 'Apply',
  applyNothing: 'Tick a setting and a profile.',
  /** v34 FANWEB fix (spec L7): "applied" (a profile may have had the value already). */
  settingsChangedOn: (names: string) => `Settings applied to ${names}`,
  ruleChangedOn: (names: string) => `Auto-save applied to ${names}`,
  notChanged: 'Nothing was changed',

  // The Profiles page --------------------------------------------------------------------------------------------------
  filtersLine: 'Filters',
  filtersNone: 'None on',
  filtersNotShared: 'Not shared with you',
  filtersEdit: 'Edit',
  filtersEditLabel: (whose: string) => `Edit ${whose} Prepare filters`,
  /** v34 FANWEB fix (spec M5): a locked Edit's reason, as text. */
  filtersLocked: (box: string) => `Changing them needs ${box}.`,
  filtersAll: 'Change filters for all profiles',
  filtersAllTitle: 'Filters for all profiles',
  filtersAllHelp: 'Starts from your own filters; only the ones you change or tick go to each profile.',
  filtersAllSave: 'Apply filters',
  filtersAllSaving: 'Applying...',

  // The result alert ---------------------------------------------------------------------------------------------------
  /** A result's title past NAMES_SHOWN profiles: their count (each profile has its line in the alert). */
  profilesCount: (count: number) => plural(count, 'profile', 'profiles'),
  resultLead: 'Not done on every profile:',
  /** v34 FIX-WEB (final review U-L2): the lead when no profile refused, only a switch or a filter was kept. */
  resultLeadKept: 'Done, with exceptions:',
  ok: 'OK',
  /**
   * v34 FANWEB fix (spec M3): the shares 'all' left out, each with the box it needs ("Ben Ito (needs Job Tracker ›
   * Change)"), then the next step.
   */
  leftOut: (items: string, ask: 'its' | 'each' | null) =>
    `Left out: ${items}.${ask ? ` Ask ${ask === 'each' ? 'each owner' : 'its owner'} to tick it in Settings › Sharing.` : ''}`,
  leftOutItem: (name: string, box: string | null) => (box ? `${name} (needs ${box})` : `${name} (the share changed)`),
} as const;
