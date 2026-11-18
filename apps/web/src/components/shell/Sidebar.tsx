'use client';

import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import type { Account } from '@tailorit/shared/auth';
import { clsx } from 'clsx';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { BACKDROP } from '@/components/ui/Dialog';
import {
  BriefcaseIcon,
  CaretDoubleLeftIcon,
  CaretDoubleRightIcon,
  FileTextIcon,
  GearSixIcon,
  KanbanIcon,
  PlugsConnectedIcon,
  RobotIcon,
  ShieldCheckIcon,
  XIcon,
  type Icon,
} from '@/components/ui/icons';
import { Tooltip } from '@/components/ui/Tooltip';
import { APP_NAV, APP_NAV_SECONDARY, activeNavHref, type NavItem, type SidebarMode } from './layout';
import { LogoMark, Wordmark } from './Logo';

/*
 * v3.1 DS: the app's left sidebar ("Denim & Tape"). Dark denim; the logo, then the work (Jobs, Job Tracker,
 * Auto-apply, Documents) and, at the bottom, setting up (Integrations, Settings, Admin for administrators). The active
 * row is a lighter band with a 3 px tape-yellow bar on the sidebar's edge and aria-current="page".
 * From 1024 px it is a column: the 240 px sidebar or the 64 px icon rail. Until the person chooses (`auto`), it is the
 * rail from 1024 px and the sidebar from 1280 px, so pages keep their room on a small laptop; their choice (« Collapse
 * beside the logo, or the rail's logo mark to expand) is kept in a cookie and holds at every width. In the rail each
 * icon keeps its name for screen readers and shows it as a tooltip. Below 1024 px it is a drawer the top bar's menu
 * button opens: a modal dialog (focus kept inside, Escape or the × closes it, a link closes it).
 */

const ICONS: Record<string, Icon> = {
  '/jobs': BriefcaseIcon,
  '/tracker': KanbanIcon,
  '/auto-apply': RobotIcon,
  '/documents': FileTextIcon,
  '/settings/integrations': PlugsConnectedIcon,
  '/settings': GearSixIcon,
  '/settings/admin': ShieldCheckIcon,
};

/** Keyboard focus on the dark denim: the tape colour, drawn inside the row so the scroll box never clips it. */
const FOCUS_ON_DARK = 'outline-offset-[-2px] focus-visible:outline-tape';

/** Each mode's classes: `auto` is the rail below 1280 px and the sidebar from 1280 px. */
const MODE = {
  width: { auto: 'w-rail xl:w-sidebar', collapsed: 'w-rail', expanded: 'w-sidebar' },
  row: { auto: 'justify-center xl:justify-start xl:px-3', collapsed: 'justify-center', expanded: 'px-3' },
  label: { auto: 'sr-only xl:not-sr-only', collapsed: 'sr-only', expanded: 'min-w-0 truncate' },
} as const;

function NavLink({
  item,
  active,
  mode,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  mode: SidebarMode;
  onNavigate?: () => void;
}) {
  const ItemIcon = ICONS[item.href] ?? BriefcaseIcon;
  const link = (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      data-active={active ? '' : undefined}
      onClick={onNavigate}
      className={clsx(
        'relative flex h-10 items-center gap-3 rounded-control text-sm font-medium transition-colors duration-150',
        MODE.row[mode],
        FOCUS_ON_DARK,
        active ? 'bg-sidebar-active text-sidebar-strong' : 'text-sidebar-foreground hover:bg-sidebar-hover hover:text-sidebar-strong',
      )}
    >
      {active && <span aria-hidden="true" data-tape-bar="" className="absolute inset-y-2 -left-3 w-[3px] rounded-r-full bg-tape" />}
      <ItemIcon size={20} weight={active ? 'fill' : 'regular'} />
      <span className={MODE.label[mode]}>{item.label}</span>
    </Link>
  );
  if (mode === 'expanded') return link;
  // The rail's tooltip names the icon; in `auto` it is hidden from 1280 px, where the name is drawn.
  return (
    <Tooltip content={item.label} side="right" className={mode === 'auto' ? 'xl:hidden' : undefined}>
      {link}
    </Tooltip>
  );
}

function SidebarNav({
  path,
  account,
  mode,
  onNavigate,
}: {
  path: string | null;
  account: Account | null;
  mode: SidebarMode;
  onNavigate?: () => void;
}) {
  const active = activeNavHref(path);
  const isAdmin = account?.role === 'admin';
  const secondary = APP_NAV_SECONDARY.filter((item: NavItem) => !item.adminOnly || isAdmin);
  return (
    <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto px-3 pt-2 pb-3">
      <ul className="flex flex-col gap-0.5">
        {APP_NAV.map((item) => (
          <li key={item.href}>
            <NavLink item={item} active={active === item.href} mode={mode} onNavigate={onNavigate} />
          </li>
        ))}
      </ul>
      <ul className="mt-auto flex flex-col gap-0.5 border-t border-sidebar-border pt-3" data-nav-group="setup">
        {secondary.map((item) => (
          <li key={item.href}>
            <NavLink item={item} active={active === item.href} mode={mode} onNavigate={onNavigate} />
          </li>
        ))}
      </ul>
    </nav>
  );
}

function Brand({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link
      href="/jobs"
      aria-label="TailorIT, go to Jobs"
      onClick={onNavigate}
      className={clsx('flex min-w-0 items-center gap-2.5 rounded-control p-1', FOCUS_ON_DARK)}
    >
      <LogoMark size={30} />
      <Wordmark size={20} tone="inverse" />
    </Link>
  );
}

/** The open sidebar's top row: the logo (a link to Jobs) and, at the right, « Collapse. */
function OpenTop({ controls, onModeChange, className }: { controls: string; onModeChange: SidebarProps['onModeChange']; className: string }) {
  return (
    <div className={clsx('h-topbar shrink-0 items-center gap-2 pr-2 pl-3', className)}>
      <Brand />
      <Tooltip content="Collapse sidebar" side="right">
        <button
          type="button"
          onClick={() => onModeChange('collapsed')}
          aria-controls={controls}
          aria-expanded="true"
          data-sidebar-toggle=""
          aria-label="Collapse sidebar"
          className={clsx(
            'ml-auto inline-flex size-8 shrink-0 items-center justify-center rounded-control text-sidebar-muted transition-colors duration-150',
            'hover:bg-sidebar-hover hover:text-sidebar-strong',
            FOCUS_ON_DARK,
          )}
        >
          <CaretDoubleLeftIcon size={16} />
        </button>
      </Tooltip>
    </div>
  );
}

/** The rail's top cell: the logo mark is the Expand button (» on hover and focus); Jobs is the first item below. */
function RailTop({ controls, onModeChange, className }: { controls: string; onModeChange: SidebarProps['onModeChange']; className: string }) {
  return (
    <div className={clsx('h-topbar shrink-0 items-center justify-center', className)}>
      <Tooltip content="Expand sidebar" side="right">
        <button
          type="button"
          onClick={() => onModeChange('expanded')}
          aria-controls={controls}
          aria-expanded="false"
          data-sidebar-toggle=""
          aria-label="Expand sidebar"
          className={clsx(
            'group relative inline-flex size-10 items-center justify-center rounded-control transition-colors duration-150 hover:bg-sidebar-hover',
            FOCUS_ON_DARK,
          )}
        >
          <LogoMark size={30} className="transition-opacity duration-150 group-hover:opacity-0 group-focus-visible:opacity-0" />
          <CaretDoubleRightIcon
            size={18}
            className="absolute text-sidebar-strong opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
          />
        </button>
      </Tooltip>
    </div>
  );
}

export interface SidebarProps {
  /** The path whose item is active. */
  path: string | null;
  account: Account | null;
  /** `auto` (the rail below 1280 px, the sidebar from 1280 px), or the person's choice. */
  mode: SidebarMode;
  onModeChange: (mode: 'collapsed' | 'expanded') => void;
  /** The column's id (the toggles' aria-controls). */
  id?: string;
}

/**
 * The sidebar column, from 1024 px: 240 px, or the 64 px icon rail. The toggle sits at the top (« beside the logo;
 * in the rail the logo mark itself expands), clear of the page's corners.
 */
export function Sidebar({ path, account, mode, onModeChange, id = 'app-sidebar' }: SidebarProps) {
  const column = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);
  // v31 FIX-WEB (REV-UX UX-3): Collapse and Expand are two buttons (one in each mode), so the one pressed goes away. When
  // focus was on it, it moves to the toggle the new mode shows (the one drawn: `auto` holds both, one hidden by width),
  // never to the page's start (WCAG 2.4.3).
  const changeMode: SidebarProps['onModeChange'] = (next) => {
    refocus.current = Boolean(column.current?.contains(document.activeElement));
    onModeChange(next);
  };
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    const toggles = column.current?.querySelectorAll<HTMLElement>('[data-sidebar-toggle]') ?? [];
    [...toggles].find((toggle) => toggle.getClientRects().length > 0)?.focus();
  }, [mode]);
  return (
    <div
      ref={column}
      id={id}
      data-sidebar={mode}
      className={clsx(
        'sticky top-0 z-40 hidden h-dvh shrink-0 flex-col bg-sidebar text-sidebar-foreground lg:flex',
        'transition-[width] duration-200 ease-out-soft',
        MODE.width[mode],
      )}
    >
      {mode === 'expanded' && <OpenTop controls={id} onModeChange={changeMode} className="flex" />}
      {mode === 'collapsed' && <RailTop controls={id} onModeChange={changeMode} className="flex" />}
      {mode === 'auto' && (
        <>
          <RailTop controls={id} onModeChange={changeMode} className="flex xl:hidden" />
          <OpenTop controls={id} onModeChange={changeMode} className="hidden xl:flex" />
        </>
      )}
      <SidebarNav path={path} account={account} mode={mode} />
    </div>
  );
}

/** Below 1024 px: the same sidebar as a drawer from the left edge (a modal dialog named "Menu"). */
export function SidebarDrawer({
  open,
  onOpenChange,
  path,
  account,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  path: string | null;
  account: Account | null;
}) {
  const close = () => onOpenChange(false);
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className={clsx(BACKDROP, 'lg:hidden')} />
        <BaseDialog.Popup
          aria-label="Menu"
          data-sidebar="drawer"
          className={clsx(
            'fixed inset-y-0 left-0 z-50 flex w-[17.5rem] max-w-[85vw] flex-col bg-sidebar text-sidebar-foreground shadow-dialog outline-none lg:hidden',
            'transition-transform duration-200 ease-out-soft data-starting-style:-translate-x-full data-ending-style:-translate-x-full',
          )}
        >
          <div className="flex h-topbar shrink-0 items-center justify-between pr-2 pl-3">
            <Brand onNavigate={close} />
            <BaseDialog.Close
              aria-label="Close menu"
              className={clsx(
                'inline-flex size-10 items-center justify-center rounded-control text-sidebar-foreground transition-colors',
                'hover:bg-sidebar-hover hover:text-sidebar-strong',
                FOCUS_ON_DARK,
              )}
            >
              <XIcon size={20} />
            </BaseDialog.Close>
          </div>
          <SidebarNav path={path} account={account} mode="expanded" onNavigate={close} />
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
