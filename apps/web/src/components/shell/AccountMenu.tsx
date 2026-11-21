'use client';

import { initialsOf, type Account } from '@tailorit/shared/auth';
import { clsx } from 'clsx';
import Link from 'next/link';
import { isOwnOnlyPath } from '@/lib/profile';
import { BriefcaseIcon, CaretDownIcon, SignOutIcon } from '@/components/ui/icons';
import { LetterAvatar } from '@/components/ui/LetterAvatar';
import { Menu, MenuContent, MenuItem, MenuLinkItem, MenuSeparator, MenuTrigger } from '@/components/ui/Menu';
import { TRIGGER_TONE, useHeaderTone } from './header/tone';
import { accountNavFor, activeNavHref } from './layout';
import { NAV_ICONS } from './Nav';
import { PROFILE_COPY } from './profile/copy';
import { ProfilesMenuGroup, useProfileSwitch } from './profile/ProfilesMenu';
import { profileInitials, useProfile } from './profile/useProfile';

/**
 * The top bar's account control: the initials on a 28 px tape-yellow square and a caret, named "Account menu for
 * <name>". The square is a picture of the account, not a label: its initials are drawn by CSS (`content:
 * attr(data-initials)`), so the button has no visible words outside its name (WCAG 2.5.3, Label in Name). v3.2 SHELL
 * (E2): the menu has the name and email, then setting up (Integrations, Settings, Autofill, Admin for administrators;
 * layout.ts ACCOUNT_NAV) and Log out. On one of those pages the trigger carries the tape bar on the bar's bottom edge
 * (as the header's active link) and the menu marks the page with aria-current.
 *
 * v33 SHARE-4 (PLAN F9; PLAN-sharing.md §9): once the person has a shared profile (or an invite), the menu's Profiles
 * group comes after their name (You, each profile as a radio, All profiles, "1 invite"). While the tab works on a
 * shared profile the trigger's name says so ("Account menu for Bob, working on Ana's profile"), the profile's initials
 * sit on the square's corner (drawn by CSS too), and the pages only ever done on one's own profile (Integrations,
 * Admin) are left out.
 */
export function AccountMenu({
  account,
  signingOut = false,
  onSignOut,
  path = null,
}: {
  account: Account;
  signingOut?: boolean;
  onSignOut: () => void;
  /** The page's path: its account link is marked, and the trigger carries the tape bar. */
  path?: string | null;
}) {
  const tone = useHeaderTone();
  const view = useProfile();
  const { choose } = useProfileSwitch(view);
  const displayName = account.name.trim() || account.email;
  const letters = initialsOf(account.name, account.email);
  const items = accountNavFor(account.role).filter((item) => !view.acting || !isOwnOnlyPath(item.href));
  const current = activeNavHref(path, items);
  const overlay = view.acting && view.profile ? profileInitials(view.profile) : null;
  return (
    <Menu>
      <MenuTrigger
        aria-label={PROFILE_COPY.accountMenu(displayName, view.acting ? view.label : null)}
        data-account-current={current ? '' : undefined}
        className={clsx(
          'group relative flex h-9 items-center gap-1.5 rounded-control py-1 pr-1.5 pl-1 transition-colors duration-150',
          TRIGGER_TONE[tone],
        )}
      >
        <span
          aria-hidden="true"
          data-initials={letters}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-control bg-tape font-display text-xs leading-none font-bold text-foreground select-none before:content-[attr(data-initials)]"
        />
        {overlay && (
          // v33 SHARE-4: the shared profile's initials on the square's lower right corner (the square is 28 px at
          // 4 px from the button's top and left edges; this 16 px badge sits 6 px past that corner).
          <span
            aria-hidden="true"
            data-initials={overlay}
            data-profile-overlay=""
            className={clsx(
              'absolute top-[22px] left-[22px] inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] leading-none font-bold text-on-primary ring-2 select-none before:content-[attr(data-initials)]',
              tone === 'dark' ? 'ring-sidebar' : 'ring-surface',
            )}
          />
        )}
        <CaretDownIcon
          size={14}
          className={clsx(
            'transition-transform duration-150 group-data-popup-open:rotate-180 max-sm:hidden',
            tone === 'dark' ? 'text-sidebar-muted' : 'text-muted-foreground',
          )}
        />
        {current && tone === 'dark' && (
          <span aria-hidden="true" data-tape-bar="" className="absolute inset-x-1 -bottom-2.5 h-[3px] rounded-t-full bg-tape" />
        )}
      </MenuTrigger>
      <MenuContent align="end" width={view.hasProfiles ? 'w-72' : 'w-64'} aria-label="Account">
        <div className="flex items-center gap-2.5 px-2 pt-1.5 pb-2">
          <LetterAvatar letters={letters} size={36} tone="brand" />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-semibold text-foreground">{displayName}</span>
            {account.name.trim() && <span className="truncate text-xs text-muted-foreground">{account.email}</span>}
          </div>
        </div>
        {view.hasProfiles && (
          <>
            <MenuSeparator />
            <ProfilesMenuGroup view={view} onChoose={choose} />
          </>
        )}
        <MenuSeparator />
        {items.map((item) => {
          const ItemIcon = NAV_ICONS[item.href] ?? BriefcaseIcon;
          const here = current === item.href;
          return (
            <MenuLinkItem
              key={item.href}
              href={item.href}
              render={<Link href={item.href} aria-current={here ? 'page' : undefined} />}
              icon={<ItemIcon size={16} weight={here ? 'fill' : 'regular'} />}
              className={here ? 'font-semibold' : undefined}
            >
              {item.label}
            </MenuLinkItem>
          );
        })}
        <MenuSeparator />
        <MenuItem
          tone="danger"
          icon={<SignOutIcon size={16} />}
          closeOnClick={false}
          disabled={signingOut}
          onClick={() => onSignOut()}
        >
          {signingOut ? 'Signing out...' : 'Log out'}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
