'use client';

import { initialsOf, type Account } from '@tailorit/shared/auth';
import Link from 'next/link';
import {
  CaretDownIcon,
  GearSixIcon,
  MagicWandIcon,
  PlugsConnectedIcon,
  ShieldCheckIcon,
  SignOutIcon,
} from '@/components/ui/icons';
import { LetterAvatar } from '@/components/ui/LetterAvatar';
import { Menu, MenuContent, MenuItem, MenuLinkItem, MenuSeparator, MenuTrigger } from '@/components/ui/Menu';

/**
 * The top bar's account control: the initials on a 28 px tape-yellow square and a caret, named "Account menu for
 * <name>". The square is a picture of the account, not a label: its initials are drawn by CSS (`content:
 * attr(data-initials)`), so the button has no visible words outside its name (WCAG 2.5.3, Label in Name). The menu has
 * the name and email, Settings, Autofill (the extension's profile and connections), Integrations (your own AI over
 * MCP), Admin (administrators only) and Log out.
 */
export function AccountMenu({
  account,
  signingOut = false,
  onSignOut,
}: {
  account: Account;
  signingOut?: boolean;
  onSignOut: () => void;
}) {
  const displayName = account.name.trim() || account.email;
  const letters = initialsOf(account.name, account.email);
  return (
    <Menu>
      <MenuTrigger
        aria-label={`Account menu for ${displayName}`}
        className="group flex h-9 items-center gap-1.5 rounded-control py-1 pr-1.5 pl-1 transition-colors duration-150 hover:bg-hover data-popup-open:bg-hover"
      >
        <span
          aria-hidden="true"
          data-initials={letters}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-control bg-tape font-display text-xs leading-none font-bold text-foreground select-none before:content-[attr(data-initials)]"
        />
        <CaretDownIcon
          size={14}
          className="text-muted-foreground transition-transform duration-150 group-data-popup-open:rotate-180 max-sm:hidden"
        />
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
        <MenuLinkItem href="/settings" render={<Link href="/settings" />} icon={<GearSixIcon size={16} />}>
          Settings
        </MenuLinkItem>
        <MenuLinkItem href="/settings/autofill" render={<Link href="/settings/autofill" />} icon={<MagicWandIcon size={16} />}>
          Autofill
        </MenuLinkItem>
        <MenuLinkItem
          href="/settings/integrations"
          render={<Link href="/settings/integrations" />}
          icon={<PlugsConnectedIcon size={16} />}
        >
          Integrations
        </MenuLinkItem>
        {account.role === 'admin' && (
          <MenuLinkItem href="/settings/admin" render={<Link href="/settings/admin" />} icon={<ShieldCheckIcon size={16} />}>
            Admin
          </MenuLinkItem>
        )}
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
