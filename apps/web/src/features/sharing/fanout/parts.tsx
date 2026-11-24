'use client';

import { FANOUT_ALL, type FanoutTargets, type ProfileChoice } from '@tailorit/shared/sharing';
import { clsx } from 'clsx';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
// Relative, not '@/': the web tests draw these parts.
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { Checkbox } from '../../../components/ui/Checkbox';
import { Dialog, DialogContent, DialogFooter } from '../../../components/ui/Dialog';
import { BookmarkSimpleIcon, CaretDownIcon } from '../../../components/ui/icons';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../../../components/ui/Menu';
import { Notice } from '../../../components/ui/Notice';
import { Tooltip } from '../../../components/ui/Tooltip';
import { userMessage } from '../../../lib/api';
import { FANOUT_COPY, namesList } from './copy';
import { ProfileMenuItems } from './ProfileSplitButton'; // v36 JOBS
import { missingReason, targetsOf, type FanoutProfile, type LabelOf } from './targets';

// v34 FANWEB (PLAN G4): the pieces of working on several profiles. ProfilesDialog chooses profiles (a box each, "All
// profiles" over them, a profile its owner did not tick the box for off with the reason); SaveToMenu is the arrow half
// of the split Save (each profile, All profiles, Choose profiles…); SavedOnChips is the "Saved on Ana · Ben" mark;
// ApplyToChoice is the filters form's "Apply to: This profile | All profiles | Choose profiles…". v36 JOBS: SaveToMenu's
// rows are ProfileMenuItems (ProfileSplitButton.tsx), in the list's order (You first), as before.

/** The hint of a profile in a list: why it is off, that the job is saved there already, or that the tab is on it. */
function hintOf(profile: FanoutProfile, label: LabelOf, savedOn?: ReadonlySet<ProfileChoice>): string | null {
  if (!profile.allowed) return missingReason(profile, label);
  if (savedOn?.has(profile.choice)) return FANOUT_COPY.savedAlready;
  return profile.current ? FANOUT_COPY.thisProfile : null;
}

export interface ProfilesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** One sentence, as the title's "?". */
  help?: string;
  profiles: readonly FanoutProfile[];
  label: LabelOf;
  /** Profiles this choice leaves out (Copy to: where the cards are). The rest are sent as chosen, never as 'all'. */
  exclude?: (profile: FanoutProfile) => boolean;
  /** Ticked when the dialog opens (default: none). */
  initial?: readonly ProfileChoice[];
  /** Where the job is saved already (shown, not offered). */
  savedOn?: ReadonlySet<ProfileChoice>;
  confirmLabel: (count: number) => string;
  busyLabel?: string;
  /** More above the list (the settings to copy). */
  children?: ReactNode;
  /** The confirm waits for more than a profile (a setting ticked). */
  ready?: boolean;
  /** Runs with the targets; a refusal stays in the dialog with its words. */
  onConfirm: (targets: FanoutTargets) => Promise<void> | void;
  /** v34 FANWEB fix (spec L2): where focus goes when it closes (default: the control that opened it). */
  finalFocus?: () => HTMLElement | boolean | null;
  /**
   * v34 FIX-WEB (final review U-L1): why the confirm is off, shown beside the buttons while it is (nothing ticked yet:
   * "Tick a setting and a profile.").
   */
  waiting?: string;
}

/**
 * v34 FANWEB fix (spec L2): focus after a choice made from the Job Tracker's Select bar, whose opener is off once the
 * selection clears: the bar's Done.
 */
export const manageBarFocus = (): HTMLElement | boolean => document.querySelector<HTMLElement>('[data-manage-done]') ?? true;

/** Chooses profiles for one action (a box each; "All profiles" over the allowed ones). */
export function ProfilesDialog(props: ProfilesDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent title={props.title} help={props.help} size="md" finalFocus={props.finalFocus}>
        {props.open && <ProfilesChoice {...props} />}
      </DialogContent>
    </Dialog>
  );
}

/** The dialog's body (drawn by the tests on its own: a closed dialog draws nothing). */
export function ProfilesChoice({
  onOpenChange,
  profiles,
  label,
  exclude,
  initial = [],
  savedOn,
  confirmLabel,
  busyLabel,
  children,
  ready = true,
  onConfirm,
  waiting,
}: ProfilesDialogProps) {
  const shown = useMemo(() => profiles.filter((profile) => !exclude?.(profile)), [profiles, exclude]);
  const offered = shown.filter((profile) => profile.allowed && !savedOn?.has(profile.choice));
  const [chosen, setChosen] = useState<ReadonlySet<ProfileChoice>>(() => new Set(initial.filter((one) => offered.some((p) => p.choice === one))));
  // "All profiles" ticked (and nothing unticked since) sends 'all': you and every share whose boxes allow it then. The
  // profiles ticked one by one are sent as they are (a share whose box went meanwhile is then refused, and said).
  const [allPicked, setAllPicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = offered.filter((profile) => chosen.has(profile.choice)).length;
  const all = offered.length > 0 && count === offered.length;
  const toggle = (choice: ProfileChoice, on: boolean) => {
    if (!on) setAllPicked(false);
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(choice);
      else next.delete(choice);
      return next;
    });
  };
  const confirm = async () => {
    const targets = targetsOf(offered, chosen, allPicked && all && !exclude && !savedOn);
    if (!targets) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(targets);
      onOpenChange(false);
    } catch (caught) {
      setError(userMessage(caught, 'That did not work. Please try again.'));
    } finally {
      setBusy(false);
    }
  };
  const confirmOff = count === 0 || !ready;
  // v34 FIX-WEB (final review U-M2): never taller than the window: the settings above, the title and the buttons stay
  // on screen and the list of profiles scrolls under its sticky "All profiles" (ten shares on a short window).
  return (
    <div className="mt-4 flex min-h-0 flex-1 flex-col gap-4" data-profiles-dialog="">
      {children && <div className="shrink-0">{children}</div>}
      <div
        className="flex min-h-0 shrink flex-col gap-1 overflow-y-auto overscroll-contain rounded-control border border-border p-1"
        role="group"
        aria-label={FANOUT_COPY.profilesGroup}
        data-profiles-list=""
      >
        {offered.length > 1 && (
          <div className="sticky top-0 z-10 flex shrink-0 items-center gap-3 border-b border-divider-soft bg-surface px-2.5 py-2" data-profiles-all="">
            <Checkbox
              checked={all}
              indeterminate={!all && count > 0}
              onCheckedChange={(on) => {
                setAllPicked(on);
                setChosen(new Set(on ? offered.map((profile) => profile.choice) : []));
              }}
              label={<span className="text-sm font-medium text-foreground">{FANOUT_COPY.allProfiles}</span>}
            />
          </div>
        )}
        {shown.map((profile) => {
          const hint = hintOf(profile, label, savedOn);
          const off = !profile.allowed || Boolean(savedOn?.has(profile.choice));
          return (
            <div key={profile.choice} className="flex min-w-0 items-start gap-3 px-2.5 py-2" data-profile-option={profile.choice}>
              <Checkbox
                checked={!off && chosen.has(profile.choice)}
                disabled={off || busy}
                onCheckedChange={(on) => toggle(profile.choice, on)}
                label={
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm text-foreground">{profile.label}</span>
                    {hint && <span className="text-xs leading-4 text-muted-foreground">{hint}</span>}
                  </span>
                }
              />
            </div>
          );
        })}
      </div>
      {error && (
        <Notice tone="error" className="shrink-0">
          {error}
        </Notice>
      )}
      <DialogFooter flush className="shrink-0">
        {waiting && (
          <p className="mr-auto text-[13px] leading-5 text-muted-foreground" aria-live="polite" data-profiles-waiting="">
            {confirmOff && !busy ? waiting : ''}
          </p>
        )}
        <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button loading={busy} disabled={confirmOff} onClick={() => void confirm()} data-profiles-confirm="">
          {busy && busyLabel ? busyLabel : confirmLabel(count)}
        </Button>
      </DialogFooter>
    </div>
  );
}

export interface SaveToMenuProps {
  /** The trigger's accessible name ("Save Data Analyst to other profiles"). */
  triggerLabel: string;
  profiles: readonly FanoutProfile[];
  label: LabelOf;
  /** Where the job is saved already (each shown off, "Saved already"). */
  savedOn?: ReadonlySet<ProfileChoice>;
  /** One profile, or All profiles. */
  onPick: (targets: FanoutTargets) => void;
  /** Choose profiles… (the dialog). */
  onChoose: () => void;
  disabled?: boolean;
  /** The trigger: the detail's button half (`button`), or the row's small arrow (`row`). */
  look?: 'button' | 'row';
  className?: string;
}

/** The arrow half of the split Save: each profile, All profiles, Choose profiles…. */
export function SaveToMenu({ triggerLabel, profiles, label, savedOn, onPick, onChoose, disabled, look = 'button', className }: SaveToMenuProps) {
  return (
    <Menu>
      <Tooltip content={FANOUT_COPY.saveTo}>
        <MenuTrigger
          aria-label={triggerLabel}
          disabled={disabled}
          className={clsx(
            look === 'button'
              ? 'inline-flex h-9 w-8 items-center justify-center rounded-r-control border border-l-0 border-border-strong bg-surface text-foreground shadow-control hover:bg-surface-low data-popup-open:bg-surface-muted disabled:opacity-50'
              : 'inline-flex h-8 w-6 shrink-0 items-center justify-center rounded-control text-subtle-foreground hover:bg-hover hover:text-foreground data-popup-open:bg-hover disabled:opacity-50',
            className,
          )}
          data-save-to-trigger={look}
        >
          <CaretDownIcon size={look === 'button' ? 14 : 12} weight="bold" aria-hidden="true" />
        </MenuTrigger>
      </Tooltip>
      <MenuContent align="end" width="w-64" aria-label={FANOUT_COPY.saveToMenu}>
        <ProfileMenuItems
          profiles={profiles}
          labelOf={label}
          offReason={(profile) => (savedOn?.has(profile.choice) ? FANOUT_COPY.savedAlready : null)}
          onPick={onPick}
          onChoose={onChoose}
          icon={<BookmarkSimpleIcon size={16} />}
          order="list"
          itemData="data-save-to"
        />
      </MenuContent>
    </Menu>
  );
}

/** "Saved on Ana · Ben": the other profiles that have the job in their Job Tracker. */
export function SavedOnChips({ names, className }: { names: readonly string[]; className?: string }) {
  if (names.length === 0) return null;
  const text = namesList([...names]);
  return (
    <Badge
      tone="neutral"
      icon={<BookmarkSimpleIcon size={12} weight="fill" aria-hidden="true" />}
      className={clsx('max-w-full', className)}
      title={FANOUT_COPY.savedOnLabel(text)}
      data-saved-on={names.join('|')}
    >
      <span className="sr-only">{FANOUT_COPY.savedOnLabel(text)}</span>
      <span aria-hidden="true" className="truncate">
        {FANOUT_COPY.savedOnChip(names.join(' · '))}
      </span>
    </Badge>
  );
}

/** Where a form's changes go: this profile, every profile, or the ones chosen. */
export type ApplyScope = { kind: 'this' } | { kind: 'all' } | { kind: 'some'; targets: ProfileChoice[] };

/**
 * The targets of a scope: the tab's own profile alone, 'all', or exactly the chosen ones (v34 FANWEB fix, both reviews:
 * the form's own profile is never added to them, so the words "1 profile" are what is sent).
 */
export function scopeTargets(scope: ApplyScope, tab: ProfileChoice): FanoutTargets {
  if (scope.kind === 'this') return [tab];
  if (scope.kind === 'all') return FANOUT_ALL;
  return scope.targets;
}

/** The words of a scope ("This profile", "All profiles", "3 profiles"). */
export function scopeText(scope: ApplyScope): string {
  if (scope.kind === 'this') return FANOUT_COPY.applyThis;
  if (scope.kind === 'all') return FANOUT_COPY.applyAll;
  return FANOUT_COPY.applyChosen(scope.targets.length);
}

/**
 * "Apply to: This profile ▾" (This profile, All profiles, Choose profiles…): where the filters form's changes go.
 * `allowThis` false (the Profiles page's form for every profile): This profile is not offered.
 */
export function ApplyToChoice({
  scope,
  onChange,
  profiles,
  label,
  tab,
  allowThis = true,
  disabled,
}: {
  scope: ApplyScope;
  onChange: (scope: ApplyScope) => void;
  profiles: readonly FanoutProfile[];
  label: LabelOf;
  tab: ProfileChoice;
  allowThis?: boolean;
  disabled?: boolean;
}) {
  const [choosing, setChoosing] = useState(false);
  useEffect(() => {
    if (!allowThis && scope.kind === 'this') onChange({ kind: 'all' });
  }, [allowThis, scope.kind, onChange]);
  return (
    <span className="inline-flex items-center gap-1.5" data-apply-to={scope.kind}>
      <span className="text-[13px] leading-5 text-muted-foreground">{FANOUT_COPY.applyTo}</span>
      <Menu>
        <MenuTrigger
          disabled={disabled}
          aria-label={`${FANOUT_COPY.applyToLabel}: ${scopeText(scope)}`}
          render={<Button variant="outline" size="sm" trailingIcon={<CaretDownIcon size={12} aria-hidden="true" />} />}
          data-apply-to-trigger=""
        >
          {scopeText(scope)}
        </MenuTrigger>
        <MenuContent align="start" width="w-56" aria-label={FANOUT_COPY.applyToLabel}>
          {allowThis && (
            <MenuItem onClick={() => onChange({ kind: 'this' })} data-apply-option="this">
              {FANOUT_COPY.applyThis}
            </MenuItem>
          )}
          <MenuItem onClick={() => onChange({ kind: 'all' })} data-apply-option="all">
            {FANOUT_COPY.applyAll}
          </MenuItem>
          <MenuItem onClick={() => setChoosing(true)} data-apply-option="some">
            {FANOUT_COPY.applyChoose}
          </MenuItem>
        </MenuContent>
      </Menu>
      <ProfilesDialog
        open={choosing}
        onOpenChange={setChoosing}
        title={FANOUT_COPY.applyToTitle}
        help={FANOUT_COPY.applyToHelp}
        profiles={profiles}
        label={label}
        initial={scope.kind === 'some' ? scope.targets : [tab]}
        confirmLabel={() => FANOUT_COPY.applyToConfirm}
        onConfirm={(targets) =>
          onChange(targets === FANOUT_ALL ? { kind: 'all' } : targets.length === 1 && targets[0] === tab && allowThis ? { kind: 'this' } : { kind: 'some', targets })
        }
      />
    </span>
  );
}
