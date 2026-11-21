'use client';

import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { ProfileChoice } from '@tailorit/shared/sharing';
import { SHARING_PROFILES_QUERY_KEY, profileName, useProfile, type ProfileView } from '@/components/shell/profile';
import { useAuth } from '@/lib/auth';
import { choiceOfKey, onProfileEvent } from '@/lib/profile';
import { hasSharedTrackers, trackerProfiles, type TrackerProfile } from './scope';

/** The Tracker's profiles (v33 SHARE-9): who the All profiles view reads, and what the tab itself may do. */
export interface TrackerScope {
  /** The person's own profile, then each shared profile whose Job Tracker they may see (an ended one leaves at once). */
  profiles: TrackerProfile[];
  /** The All profiles view has something to add: a shared profile whose Job Tracker the person may see. */
  available: boolean;
  /** The list of shared profiles is read (or failed). */
  settled: boolean;
  /** The tab's own profile ("me" or the key it works on). */
  tab: ProfileChoice;
  /** The tab's profile view (its `can`, `switchTo`). */
  view: ProfileView;
}

/**
 * What the Tracker hears from the answers (apiFetch's profile events), until the returned stop is called: a profile that
 * ends while the view shows it (`gone`: a card's read was refused as ended) leaves the view at once (`setGone`); the
 * shell reads the list again. A Job Tracker request refused for its permission (the owner unticked the Job Tracker)
 * reads the list again too, so that profile leaves with its next answer. v33 SHARE-9 fix: kept apart for the tests.
 */
export function subscribeTrackerScope(client: QueryClient, setGone: Dispatch<SetStateAction<ReadonlySet<string>>>): () => void {
  return onProfileEvent((event) => {
    if (event.kind === 'gone') {
      setGone((current) => (current.has(event.key) ? current : new Set([...current, event.key])));
      return;
    }
    if (event.kind === 'refused' && event.path.startsWith('/api/applications')) {
      void client.invalidateQueries({ queryKey: SHARING_PROFILES_QUERY_KEY });
    }
  });
}

/** The profiles of the Tracker (an ended one leaves at once: subscribeTrackerScope). */
export function useTrackerScope(): TrackerScope {
  const view = useProfile();
  const { account } = useAuth();
  const client = useQueryClient();
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => subscribeTrackerScope(client, setGone), [client]);

  const profiles = useMemo(
    () => trackerProfiles(view.profiles, (profile) => profileName(profile, account), gone),
    [view.profiles, account, gone],
  );
  return {
    profiles,
    available: hasSharedTrackers(view.profiles.filter((profile) => !gone.has(profile.key))),
    settled: view.settled,
    tab: choiceOfKey(view.key),
    view,
  };
}
