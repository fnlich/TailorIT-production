'use client';

import { clsx } from 'clsx';
// Relative, not '@/': the web tests draw the shell.
import { useAuth } from '../../../lib/auth';
import { Menu, MenuContent, MenuTrigger } from '../../ui/Menu';
import { Tooltip } from '../../ui/Tooltip';
import { TRIGGER_TONE, useHeaderTone } from '../header/tone';
import { PROFILE_COPY } from './copy';
import { ProfilesMenuGroup, useProfileSwitch } from './ProfilesMenu';
import { profileInitials, useProfile, type ProfileView } from './useProfile';

/** The chip's accessible name: "Working on Ana's profile", "Working on your profile". */
export function chipName(view: Pick<ProfileView, 'acting' | 'label'>): string {
  if (!view.acting) return PROFILE_COPY.workingOnYours;
  if (!view.label) return PROFILE_COPY.workingOnShared;
  return PROFILE_COPY.workingOn(view.label);
}

/**
 * v33 SHARE-4 (PLAN F9; PLAN-sharing.md §9 "Identity, with no banners"): whose profile the tab works on, left of the
 * usage chip. Shown once the person has a shared profile or an invite (or the tab works on one): "You" on their own;
 * the owner's name on a shared one (its initials below 640 px, drawn by CSS as the account menu's are, so the name says
 * the words: WCAG 2.5.3), named "Working on Ana's profile", the owner's email in its tooltip. It opens the Profiles
 * group (the account menu's), so switching is one press away. On the bar's dark denim a shared profile's dot is the
 * tape (you are somewhere else); your own is the quiet grey.
 */
export function ProfileChip() {
  const view = useProfile();
  const { account } = useAuth();
  const tone = useHeaderTone();
  const { choose } = useProfileSwitch(view);
  if (!account || !view.hasProfiles) return null;
  // Until the list is read a shared profile's chip says "Shared" (its name comes from the list).
  const text = view.acting ? view.label || PROFILE_COPY.shared : PROFILE_COPY.you;
  const initials = view.profile ? profileInitials(view.profile) : '';
  const trigger = (
    <MenuTrigger
      aria-label={chipName(view)}
      data-profile-chip={view.acting ? 'shared' : 'own'}
      className={clsx(
        'flex h-9 max-w-[11rem] min-w-0 shrink-0 items-center gap-1.5 rounded-control px-2 text-xs leading-4 font-semibold transition-colors duration-150',
        TRIGGER_TONE[tone],
      )}
    >
      <span
        aria-hidden="true"
        className={clsx('size-2 shrink-0 rounded-full', view.acting ? 'bg-tape' : tone === 'dark' ? 'bg-sidebar-muted' : 'bg-subtle-foreground')}
      />
      {initials ? (
        <>
          <span className="min-w-0 truncate max-sm:hidden" data-profile-chip-name="">
            {text}
          </span>
          {/* A phone's chip: the initials, drawn by CSS, so the button's name ("Working on Ana's profile") holds its words. */}
          <span aria-hidden="true" data-initials={initials} className="sm:hidden before:content-[attr(data-initials)]" />
        </>
      ) : (
        <span className="min-w-0 truncate" data-profile-chip-name="">
          {text}
        </span>
      )}
    </MenuTrigger>
  );
  return (
    <Menu>
      {view.profile ? (
        <Tooltip content={view.profile.email} side="bottom">
          {trigger}
        </Tooltip>
      ) : (
        trigger
      )}
      <MenuContent align="end" width="w-72" aria-label={PROFILE_COPY.group}>
        <ProfilesMenuGroup view={view} onChoose={choose} />
      </MenuContent>
    </Menu>
  );
}
