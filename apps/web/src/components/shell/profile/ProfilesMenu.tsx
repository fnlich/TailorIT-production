'use client';

import { EnvelopeSimpleIcon } from '@phosphor-icons/react/EnvelopeSimple';
import { UsersThreeIcon } from '@phosphor-icons/react/UsersThree';
import { PROFILE_SELF, SHARING_PROFILES_PATH, SHARING_SETTINGS_PATH, type ProfileChoice } from '@tailorit/shared/sharing';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import Link from 'next/link';
import { useCallback, useId } from 'react';
// Relative, not '@/': the web tests draw the shell.
import { useAuth } from '../../../lib/auth';
import { choiceOfKey } from '../../../lib/profile';
import { MenuLinkItem, MenuRadioGroup, MenuRadioItem } from '../../ui/Menu';
import { HEADER_QUERY_KEY, fetchHeaderSummary } from '../header/api';
import { PROFILE_COPY } from './copy';
import { profileName, type ProfileView } from './useProfile';

// v33 SHARE-4 (PLAN F9; PLAN-sharing.md §9 "The switcher"): the Profiles group of the account menu, the profile chip
// and the phone's menu sheet: You, each profile shared with the person (a radio: the tab's one is checked), All
// profiles, and "1 invite" while one waits. Choosing a profile saves the editors' changes, then opens that profile's
// section list page in this tab (a new document); a change that could not be saved keeps the tab where it is.

/** The Profiles page (SHARE-7): every profile at once (v33 INT-B: SHARE-2's path, one source). */
export const PROFILES_HREF = SHARING_PROFILES_PATH;
/** Settings › Sharing (SHARE-7): invites, people, activity (v33 INT-B: SHARE-2's path, one source). */
export const SHARING_SETTINGS_HREF = SHARING_SETTINGS_PATH;

/** Invites waiting: the header's count (polled every minute) when it has one, else the list's. */
export function useInviteCount(view: ProfileView): number {
  const { account } = useAuth();
  // The header's summary from the cache only (the header slots read and poll it).
  const header = useQuery({ queryKey: HEADER_QUERY_KEY, queryFn: ({ signal }) => fetchHeaderSummary(signal), enabled: false });
  return account ? (header.data?.invites ?? view.invites.length) : 0;
}

/**
 * A switch from a menu (the tab's own profile again does nothing). One that stays put because an editor's change could
 * not be saved first is told once, by the shell's runtime (ProfileRuntime).
 */
export function useProfileSwitch(view: ProfileView): { choose: (choice: ProfileChoice) => void } {
  const { switchTo } = view;
  const current = choiceOfKey(view.key);
  const choose = useCallback(
    (choice: ProfileChoice) => {
      if (choice !== current) void switchTo(choice);
    },
    [current, switchTo],
  );
  return { choose };
}

/** The group inside a Menu (the account menu, the chip's menu). */
export function ProfilesMenuGroup({ view, onChoose }: { view: ProfileView; onChoose: (choice: ProfileChoice) => void }) {
  const { account } = useAuth();
  const invites = useInviteCount(view);
  return (
    <div data-profiles-group="">
      <MenuRadioGroup<string> label={PROFILE_COPY.group} value={choiceOfKey(view.key)} onValueChange={(value) => onChoose(value as ProfileChoice)}>
        <MenuRadioItem value={PROFILE_SELF} closeOnClick>
          {PROFILE_COPY.you}
        </MenuRadioItem>
        {view.profiles.map((profile) => (
          <MenuRadioItem key={profile.key} value={profile.key} closeOnClick>
            <span data-profile-option={profile.key}>{profileName(profile, account)}</span>
            {profile.name.trim() && <span className="ml-1.5 text-xs text-muted-foreground">{profile.email}</span>}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
      {view.profiles.length > 0 && (
        <MenuLinkItem href={PROFILES_HREF} render={<Link href={PROFILES_HREF} />} icon={<UsersThreeIcon size={16} />}>
          {PROFILE_COPY.allProfiles}
        </MenuLinkItem>
      )}
      {invites > 0 && !view.acting && (
        <MenuLinkItem href={SHARING_SETTINGS_HREF} render={<Link href={SHARING_SETTINGS_HREF} />} icon={<EnvelopeSimpleIcon size={16} />}>
          <span data-profile-invites="">{PROFILE_COPY.invites(invites)}</span>
        </MenuLinkItem>
      )}
    </div>
  );
}

/** The group in the phone's menu sheet (dark): the same choices as buttons and links, the tab's one marked. */
export function SheetProfiles({ view, onNavigate }: { view: ProfileView; onNavigate: () => void }) {
  const { account } = useAuth();
  const invites = useInviteCount(view);
  const { choose } = useProfileSwitch(view);
  const headingId = useId();
  const current = choiceOfKey(view.key);
  if (!view.hasProfiles) return null;
  const row =
    'relative flex h-10 w-full items-center gap-3 rounded-control px-3 text-left text-sm font-medium transition-colors duration-150 outline-offset-[-2px] focus-visible:outline-tape';
  const choices: Array<{ choice: ProfileChoice; label: string; email: string | null }> = [
    { choice: PROFILE_SELF, label: PROFILE_COPY.you, email: null },
    ...view.profiles.map((profile) => ({
      choice: profile.key as ProfileChoice,
      label: profileName(profile, account),
      email: profile.name.trim() ? profile.email : null,
    })),
  ];
  return (
    <div role="group" aria-labelledby={headingId} data-nav-group="profiles" className="mt-3 border-t border-sidebar-border pt-3">
      <p id={headingId} className="px-3 pb-1 text-[11px] leading-4 font-semibold tracking-[0.06em] text-sidebar-muted uppercase">
        {PROFILE_COPY.group}
      </p>
      <ul className="flex flex-col gap-0.5">
        {choices.map((item) => {
          const here = item.choice === current;
          return (
            <li key={item.choice}>
              <button
                type="button"
                aria-current={here ? 'true' : undefined}
                data-profile-option={item.choice}
                // The sheet stays open while the editors' changes are saved (an alert says so if one could not be);
                // then a new document opens.
                onClick={() => choose(item.choice)}
                className={clsx(row, here ? 'bg-sidebar-active text-sidebar-strong' : 'text-sidebar-foreground hover:bg-sidebar-hover hover:text-sidebar-strong')}
              >
                {here && <span aria-hidden="true" data-tape-bar="" className="absolute inset-y-2 -left-3 w-[3px] rounded-r-full bg-tape" />}
                <span aria-hidden="true" className={clsx('size-2 shrink-0 rounded-full', here ? 'bg-tape' : 'bg-sidebar-muted')} />
                <span className="min-w-0 truncate">
                  {item.label}
                  {item.email && <span className="ml-1.5 text-xs text-sidebar-muted">{item.email}</span>}
                </span>
              </button>
            </li>
          );
        })}
        {view.profiles.length > 0 && (
          <li>
            <Link href={PROFILES_HREF} onClick={onNavigate} className={clsx(row, 'text-sidebar-foreground hover:bg-sidebar-hover hover:text-sidebar-strong')}>
              <UsersThreeIcon size={20} />
              <span className="min-w-0 truncate">{PROFILE_COPY.allProfiles}</span>
            </Link>
          </li>
        )}
        {invites > 0 && !view.acting && (
          <li>
            <Link href={SHARING_SETTINGS_HREF} onClick={onNavigate} className={clsx(row, 'text-sidebar-foreground hover:bg-sidebar-hover hover:text-sidebar-strong')}>
              <EnvelopeSimpleIcon size={20} />
              <span className="min-w-0 truncate" data-profile-invites="">
                {PROFILE_COPY.invites(invites)}
              </span>
            </Link>
          </li>
        )}
      </ul>
    </div>
  );
}
