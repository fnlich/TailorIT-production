'use client';

import { initialsOf, type Account } from '@tailorit/shared/auth';
import { clsx } from 'clsx';
import Link from 'next/link';
import { BriefcaseIcon, CaretDownIcon, SignOutIcon } from '@/components/ui/icons';
import { LetterAvatar } from '@/components/ui/LetterAvatar';
import { Menu, MenuContent, MenuItem, MenuLinkItem, MenuSeparator, MenuTrigger } from '@/components/ui/Menu';
import { TRIGGER_TONE, useHeaderTone } from './header/tone';
import { accountNavFor, activeNavHref } from './layout';
import { NAV_ICONS } from './Nav';

/**
 * The top bar's account control: the initials on a 28 px tape-yellow square and a caret, named "Account menu for
 * <name>". The square is a picture of the account, not a label: its initials are drawn by CSS (`content:
 * attr(data-initials)`), so the button has no visible words outside its name (WCAG 2.5.3, Label in Name). v3.2 SHELL
 * (E2): the menu has the name and email, then setting up (Integrations, Settings, Autofill, Admin for administrators;
 * layout.ts ACCOUNT_NAV) and Log out. On one of those pages the trigger carries the tape bar on the bar's bottom edge
 * (as the header's active link) and the menu marks the page with aria-current.
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
  const displayName = account.name.trim() || account.email;
  const letters = initialsOf(account.name, account.email);
  const items = accountNavFor(account.role);
  const current = activeNavHref(path, items);
  return (
    <Menu>
      <MenuTrigger
        aria-label={`Account menu for ${displayName}`}
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
      <MenuContent align="end" width="w-64" aria-label="Account">
        <div className="flex items-center gap-2.5 px-2 pt-1.5 pb-2">
          <LetterAvatar letters={letters} size={36} tone="brand" />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-semibold text-foreground">{displayName}</span>
            {account.name.trim() && <span className="truncate text-xs text-muted-foreground">{account.email}</span>}
          </div>
        </div>
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
