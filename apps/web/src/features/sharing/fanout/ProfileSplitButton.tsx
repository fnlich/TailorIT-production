'use client';

import { UsersThreeIcon } from '@phosphor-icons/react/UsersThree';
import { FANOUT_ALL, type FanoutTargets } from '@tailorit/shared/sharing';
import { clsx } from 'clsx';
import { useId, type ReactNode } from 'react';
// Relative, not '@/': the web tests draw these parts.
import { Button, type ButtonSize } from '../../../components/ui/Button';
import { CaretDownIcon, CheckIcon } from '../../../components/ui/icons';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../../../components/ui/Menu';
import { Tooltip } from '../../../components/ui/Tooltip';
import { FANOUT_COPY } from './copy';
import { missingReason, type FanoutProfile, type LabelOf } from './targets';

// v36 JOBS (PLAN J4; SP v36 REQUEST.md: "If user have access to the other user, there will be dropdown right to save,
// unsave button"): an action that runs on the tab's profile, with a caret beside it that runs it on other profiles.
// ProfileSplitButton is the two halves (the main part acts on the tab's profile; the caret's menu: the tab's profile,
// each other profile, All profiles, Choose profiles…); ProfileMenuItems is that menu's rows alone, for a menu of the
// caller's own (a submenu: "Share to ›"). A profile its owner did not tick the action's box for is listed off, with the
// reason the shell's boxes give ("Needs Job Tracker › Change."), never left out. The Jobs page's Select bar uses them for
// Save ▾ and Unsave ▾; the Auto-apply page's Prepare All ▾, Share All ▾ and its Select bar reuse them (APPLYWEB).
// v36 APPLYWEB (PLAN A2-A5): a profile that has the job already can be drawn checked and off (`checked`: a row's
// "Share to ›"); the main part alone can be off while the caret still offers other profiles (`mainDisabled`: the
// Select bar's Prepare on a tab that may not prepare), and can say why in a tooltip it is described by (`mainTip`).

/** The order of the menu's profiles: the tab's own first (a split button's), or the list's (You first). */
export type ProfileMenuOrder = 'tab-first' | 'list';

export interface ProfileMenuItemsProps {
  /** The profiles the action offers (useFanoutChoices(perms).profiles: You first, the tab's marked `current`). */
  profiles: readonly FanoutProfile[];
  /** Reads a box's name for an off profile's reason (useFanoutChoices().label). */
  labelOf: LabelOf;
  /** One profile ([its choice]) or All profiles ('all'). */
  onPick: (targets: FanoutTargets) => void;
  /** Choose profiles… (the caller opens ProfilesDialog); absent: not offered. */
  onChoose?: () => void;
  /** Another reason a profile is off (e.g. the job is there already: FANOUT_COPY.savedAlready), or null. */
  offReason?: (profile: FanoutProfile) => string | null;
  /** Profiles not listed at all (a share's targets leave out the tab's own profile). */
  exclude?: (profile: FanoutProfile) => boolean;
  /** Offer All profiles (default true). */
  allowAll?: boolean;
  /** Each profile row's icon. */
  icon?: ReactNode;
  /**
   * v36 APPLYWEB (PLAN A5): a profile drawn checked (a tick for its icon) and off, its reason from `offReason` (the job
   * is in its Job Tracker already).
   */
  checked?: (profile: FanoutProfile) => boolean;
  /** Default `tab-first`. */
  order?: ProfileMenuOrder;
  /**
   * The data attribute each row carries, valued with its choice, `all` or `choose` (default `data-profile-item`); a
   * profile's name carries `<itemData>-name`.
   */
  itemData?: string;
}

/** Why a profile is off in a menu (its missing box first, then the caller's reason), or null when it is on. */
export function profileOffReason(
  profile: FanoutProfile,
  labelOf: LabelOf,
  offReason?: (profile: FanoutProfile) => string | null,
): string | null {
  if (!profile.allowed) return missingReason(profile, labelOf);
  return offReason?.(profile) ?? null;
}

/**
 * v36 APPLYWEB: one row of a profile menu: off with its reason (a missing box, the caller's reason, or "In its Job
 * Tracker" for a profile drawn checked), and whether it is drawn checked.
 */
export function profileRowOf(
  profile: FanoutProfile,
  labelOf: LabelOf,
  offReason?: (profile: FanoutProfile) => string | null,
  checked?: (profile: FanoutProfile) => boolean,
): { off: string | null; checked: boolean } {
  const tick = checked?.(profile) === true;
  return { off: profileOffReason(profile, labelOf, offReason) ?? (tick ? FANOUT_COPY.savedAlready : null), checked: tick };
}

/** The profiles a menu lists, in its order. */
export function menuProfiles(profiles: readonly FanoutProfile[], order: ProfileMenuOrder = 'tab-first', exclude?: (profile: FanoutProfile) => boolean) {
  const shown = exclude ? profiles.filter((profile) => !exclude(profile)) : [...profiles];
  return order === 'tab-first' ? [...shown.filter((profile) => profile.current), ...shown.filter((profile) => !profile.current)] : shown;
}

/**
 * The rows of a profile menu: each profile (off with its reason; the tab's own says "This profile"), then All profiles
 * and Choose profiles…, off while no profile is on. Put them in a MenuContent or a MenuSubContent.
 */
export function ProfileMenuItems({
  profiles,
  labelOf,
  onPick,
  onChoose,
  offReason,
  exclude,
  allowAll = true,
  icon,
  checked,
  order = 'tab-first',
  itemData = 'data-profile-item',
}: ProfileMenuItemsProps) {
  const listed = menuProfiles(profiles, order, exclude);
  const anyOn = listed.some((profile) => profileRowOf(profile, labelOf, offReason, checked).off === null);
  const data = (value: string, suffix = '') => ({ [`${itemData}${suffix}`]: value });
  return (
    <>
      {listed.map((profile) => {
        const { off, checked: tick } = profileRowOf(profile, labelOf, offReason, checked);
        return (
          <MenuItem
            key={profile.choice}
            icon={tick ? <CheckIcon size={16} weight="bold" className="text-primary" /> : icon}
            disabled={off !== null}
            {...(tick ? { 'data-profile-checked': '' } : {})}
            hint={off ?? (profile.current ? FANOUT_COPY.thisProfile : undefined)}
            onClick={() => onPick([profile.choice])}
            {...data(profile.choice)}
          >
            {/* v34 FIX-WEB (final review U-L4): a long owner's name wraps to a second line, and the whole name is its
                tooltip. */}
            <span className="line-clamp-2 whitespace-normal break-words" title={profile.label} {...data('', '-name')}>
              {profile.label}
            </span>
          </MenuItem>
        );
      })}
      {(allowAll || onChoose) && <MenuSeparator />}
      {allowAll && (
        <MenuItem icon={<UsersThreeIcon size={16} />} disabled={!anyOn} onClick={() => onPick(FANOUT_ALL)} {...data('all')}>
          {FANOUT_COPY.allProfiles}
        </MenuItem>
      )}
      {onChoose && (
        <MenuItem disabled={!anyOn} onClick={onChoose} {...data('choose')}>
          {FANOUT_COPY.chooseProfiles}
        </MenuItem>
      )}
    </>
  );
}

/** The kit button looks a split button takes. */
export type ProfileSplitVariant = 'primary' | 'outline';

/**
 * The caret's classes: the main part's look, joined on its left; 44 px tall on a phone, as the main part. v36 FIX-WEB
 * (ux L3): and 44 px wide there (a touch target).
 */
function caretClasses(variant: ProfileSplitVariant, size: Exclude<ButtonSize, 'lg'>): string {
  return clsx(
    'inline-flex shrink-0 items-center justify-center rounded-r-control transition-[background-color,border-color] duration-150',
    'disabled:pointer-events-none disabled:opacity-50 data-disabled:pointer-events-none data-disabled:opacity-50 max-sm:h-11 max-sm:w-11',
    size === 'sm' ? 'h-8 w-7' : 'h-9 w-8',
    variant === 'primary'
      ? 'border-l border-on-primary/35 bg-primary text-on-primary shadow-control hover:bg-primary-hover data-popup-open:bg-primary-active'
      : 'border border-l-0 border-border-strong bg-surface text-foreground shadow-control hover:bg-surface-low data-popup-open:bg-surface-muted',
  );
}

export interface ProfileSplitButtonProps extends Omit<ProfileMenuItemsProps, 'order'> {
  /** The main part's words: the action on the tab's profile ("Save", "Prepare All"). */
  children: ReactNode;
  /** The main part's accessible name, when its words alone are not enough. */
  mainLabel?: string;
  /** An icon before the words. */
  mainIcon?: ReactNode;
  /** The main part: the action on the tab's profile. */
  onMain: () => void;
  /** The caret's accessible name, and its menu's ("Save to profiles"). */
  menuLabel: string;
  /** The caret's tooltip (default `menuLabel`). */
  menuTip?: string;
  /** false: no caret, a plain button (the person has no shared profile). Default true. */
  split?: boolean;
  variant?: ProfileSplitVariant;
  size?: Exclude<ButtonSize, 'lg'>;
  /** Both halves off. */
  disabled?: boolean;
  /** The main part spins; both halves off. */
  loading?: boolean;
  /** The main part keeps focus while off (focusableWhenDisabled), so its tooltip or reason can be read. */
  focusableWhenDisabled?: boolean;
  /** v36 APPLYWEB: the main part alone is off (the caret still offers the other profiles); it stays focusable. */
  mainDisabled?: boolean;
  /** v36 APPLYWEB: the main part's tooltip, which describes it too (why it is off: "Needs Job Tracker › See …"). */
  mainTip?: string;
  /** v36 APPLYWEB: data attributes for the main part (a page's own hook: `data-prepare-all`). */
  mainData?: Record<`data-${string}`, string>;
  className?: string;
  /** The wrapper's data-profile-split value (a hook for tests: "save", "unsave"). */
  name?: string;
}

/**
 * An action on the tab's profile with a caret for other profiles (ProfileMenuItems, the tab's own first). The halves are
 * one control to the eye (the caret joined on the right) and two to the keyboard: the main part, then the caret, whose
 * menu opens on Enter, Space or Arrow down.
 */
export function ProfileSplitButton({
  children,
  mainLabel,
  mainIcon,
  onMain,
  menuLabel,
  menuTip,
  split = true,
  variant = 'outline',
  size = 'sm',
  disabled = false,
  loading = false,
  focusableWhenDisabled,
  mainDisabled = false,
  mainTip,
  mainData,
  className,
  name,
  ...items
}: ProfileSplitButtonProps) {
  const off = disabled || loading;
  const tipId = useId();
  const main = (
    <Button
      variant={variant}
      size={size}
      icon={mainIcon}
      aria-label={mainLabel}
      aria-describedby={mainTip ? tipId : undefined}
      onClick={onMain}
      disabled={disabled || mainDisabled}
      loading={loading}
      focusableWhenDisabled={focusableWhenDisabled || mainDisabled || Boolean(mainTip)}
      className={clsx('max-sm:h-11', split && 'rounded-r-none')}
      data-profile-split-main=""
      {...mainData}
    >
      {children}
    </Button>
  );
  return (
    <span className={clsx('inline-flex items-stretch', className)} data-profile-split={name ?? ''}>
      {mainTip ? (
        <>
          <Tooltip content={mainTip}>{main}</Tooltip>
          <span id={tipId} hidden>
            {mainTip}
          </span>
        </>
      ) : (
        main
      )}
      {split && (
        <Menu>
          <Tooltip content={menuTip ?? menuLabel}>
            <MenuTrigger aria-label={menuLabel} disabled={off} className={caretClasses(variant, size)} data-profile-split-caret="">
              <CaretDownIcon size={size === 'sm' ? 12 : 14} weight="bold" aria-hidden="true" />
            </MenuTrigger>
          </Tooltip>
          <MenuContent align="end" width="w-64" aria-label={menuLabel}>
            <ProfileMenuItems {...items} order="tab-first" />
          </MenuContent>
        </Menu>
      )}
    </span>
  );
}
