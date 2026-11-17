'use client';

import { useDraggable } from '@dnd-kit/core';
import { clsx } from 'clsx';
import { useCallback, useId, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { addedLabel, type ApplicationSummary } from '@tailorit/shared';
import { Badge } from '@/components/ui/Badge';
import { Checkbox } from '@/components/ui/Checkbox';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/ContextMenu';
import { IconButton } from '@/components/ui/IconButton';
import { Menu, MenuContent, MenuTrigger } from '@/components/ui/Menu';
import { Tooltip } from '@/components/ui/Tooltip';
import { DotsThreeIcon, HeartIcon, MapPinIcon } from '@/components/ui/icons';
import { HeldBadge, useHeldTitle } from '@/features/jobs/detail/held/HeldNotice'; // v30 INT-3: decision 1
import { isHeld } from '@/features/jobs/detail/held/copy';
import { ClosedBadge, isClosed } from '@/features/jobs/closed/ClosedBadge'; // v30 FIX-WEB (UX-10)
import { RowCredit } from '@/features/jobs/credits/JobCredit'; // v30 FIX-WEB (REQ-1)
import { creditOf } from '@/features/jobs/credits/credit';
import { usePublicConstants } from '@/lib/constants';
import type { MarkerView } from '../../auto-apply/copy';
import { CompanyLogo } from '../CompanyLogo';
import { useLongPress } from '../hooks';
import { ApplicationMenuItems, type ApplicationActions } from './ApplicationMenu';

export interface CardHandlers extends ApplicationActions {
  onToggleFavorite: (application: ApplicationSummary) => void;
  onToggleSelected: (application: ApplicationSummary, selected: boolean) => void;
  /** Why this application cannot be selected now (Prepare & Queue jobs: not a saved job, or a draft already), or null. */
  selectBlocked?: (application: ApplicationSummary) => string | null;
  /**
   * v2.0: a Saved entry's auto-apply marker (Draft for one in the queue, A30; Preparing, Filtered: …, Preparation
   * failed, … from the Saved pane's read), shown on its card and row.
   */
  markerOf?: (application: ApplicationSummary) => MarkerView | null;
}

/** v2.0: a Saved entry's marker badge (Draft, Preparing, Filtered: …), the Saved pane's words. */
export function MarkerBadge({ marker }: { marker: MarkerView | null | undefined }) {
  if (!marker) return null;
  return (
    <Badge tone={marker.tone} data-card-marker={marker.label}>
      {marker.label}
    </Badge>
  );
}

const stop = (event: MouseEvent | KeyboardEvent) => event.stopPropagation();

/** A card's or a row's selection box; one that cannot be selected is disabled and says why. */
export function SelectionBox({
  application,
  checked,
  handlers,
}: {
  application: ApplicationSummary;
  checked: boolean;
  handlers: CardHandlers;
}) {
  const blocked = handlers.selectBlocked?.(application) ?? null;
  if (blocked) {
    return (
      <Tooltip content={blocked}>
        <span className="flex" data-not-selectable="" onClick={(event) => event.stopPropagation()}>
          <Checkbox
            checked={false}
            disabled
            aria-label={`${application.title}: ${blocked}`}
            onCheckedChange={() => undefined}
          />
        </span>
      </Tooltip>
    );
  }
  return (
    <Checkbox
      checked={checked}
      stopPropagation
      aria-label={`Select ${application.title}`}
      onCheckedChange={(next) => handlers.onToggleSelected(application, next)}
    />
  );
}

/** The heart: outline and muted, or filled #08758c. */
export function FavoriteButton({
  application,
  onToggle,
  size = 'sm',
}: {
  application: ApplicationSummary;
  onToggle: (application: ApplicationSummary) => void;
  size?: 'xs' | 'sm';
}) {
  const label = application.favorite ? 'Remove from favorites' : 'Add to favorites';
  return (
    <IconButton
      label={label}
      size={size}
      aria-pressed={application.favorite}
      onPointerDown={stop}
      onMouseDown={stop}
      onClick={(event) => {
        event.stopPropagation();
        onToggle(application);
      }}
      icon={
        application.favorite ? (
          <HeartIcon size={16} weight="fill" className="text-primary-ink" />
        ) : (
          <HeartIcon size={16} />
        )
      }
    />
  );
}

/** The card's face (also drawn in the drag overlay). */
export function CardBody({
  application,
  leading,
  actions,
  marker,
  heldSentenceId,
  closedSentenceId,
}: {
  application: ApplicationSummary;
  leading?: ReactNode;
  actions?: ReactNode;
  /** v2.0: the Saved entry's auto-apply marker. */
  marker?: MarkerView | null;
  /** v30 FIX-WEB (UX-8): ids of the held and closed sentences, for the card's aria-describedby. */
  heldSentenceId?: string;
  closedSentenceId?: string;
}) {
  return (
    <>
      <div className="flex items-center gap-2.5">
        {leading}
        <CompanyLogo name={application.companyName} logoUrl={application.logoUrl} size={32} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-muted-foreground">{application.companyName}</span>
        {actions}
      </div>
      <p className="mt-2.5 line-clamp-2 text-sm leading-5 font-semibold break-words text-foreground">{application.title}</p>
      {application.location && (
        <p className="mt-[7px] flex items-center gap-1.5 text-xs leading-5 text-muted-foreground">
          <MapPinIcon size={13} className="shrink-0" />
          <span className="truncate">{application.location}</span>
        </p>
      )}
      {/* v30 FIX-WEB (REQ-1): the credit its source asks for. */}
      <RowCredit credit={creditOf(application)} className="mt-1" />
      <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-divider-soft pt-2 text-xs leading-4 text-muted-foreground">
        <span>{addedLabel(application.trackedOn)}</span>
        <span className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
          <HeldBadge held={application.held} sentenceId={heldSentenceId} />
          <ClosedBadge closed={isClosed(application)} sentenceId={closedSentenceId} />
          <MarkerBadge marker={marker} />
        </span>
      </div>
    </>
  );
}

export const CARD_SURFACE = 'rounded-surface border bg-surface p-4 shadow-soft';

/**
 * v30 FIX-WEB (REV-UX UX-8): a board card's accessible name: its title and company, then the marks it shows in words
 * ("…, Waiting for approval", "…, Closed"), so a screen reader hears what the card's badges say.
 */
export function cardName(title: string, company: string, marks: { held: string | null; closed: string | null }): string {
  return [title, company, marks.held, marks.closed].filter((part): part is string => Boolean(part && part.trim())).join(', ');
}

/**
 * A board card (Simplify): draggable between columns (8 px mouse, 180 ms touch hold, Space for the keyboard), opens
 * the application on click or Enter, and offers the actions menu from ⋯, a right-click or a 500 ms press.
 */
export function ApplicationCard({
  application,
  handlers,
  selected,
  selectMode,
  checked,
  draggingAny,
  consumeDragClick,
}: {
  application: ApplicationSummary;
  handlers: CardHandlers;
  /** Its detail sheet is open. */
  selected: boolean;
  selectMode: boolean;
  checked: boolean;
  /** Any card is being dragged (a long touch must not also open the context menu). */
  draggingAny: boolean;
  /** True once for the click that ends a drag. */
  consumeDragClick: () => boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: application.id,
    data: { application },
    disabled: selectMode,
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const openMenu = useCallback(() => setMenuOpen(true), []);
  const longPress = useLongPress(openMenu);
  // v30 FIX-WEB (REV-UX UX-8): a held or closed job says so in the card's name, and its sentence describes the card.
  const heldTitle = useHeldTitle();
  const { t } = usePublicConstants();
  const marks = useId();
  const held = isHeld(application);
  const closed = isClosed(application);
  const name = cardName(application.title, application.companyName, { held: held ? heldTitle : null, closed: closed ? t('LABEL_JOB_CLOSED_MARK') : null });
  const described = [
    selectMode ? undefined : attributes['aria-describedby'],
    held ? `${marks}-held` : undefined,
    closed ? `${marks}-closed` : undefined,
  ].filter(Boolean).join(' ');

  const activate = () => {
    if (!selectMode) handlers.onOpen(application);
    else if (!handlers.selectBlocked?.(application)) handlers.onToggleSelected(application, !checked);
  };

  return (
    <ContextMenu
      open={contextOpen}
      onOpenChange={(open) => {
        if (open && (draggingAny || selectMode)) return;
        setContextOpen(open);
      }}
    >
      <ContextMenuTrigger
        ref={setNodeRef}
        {...attributes}
        {...listeners}
        {...longPress.handlers}
        render={<article />}
        aria-label={name}
        aria-roledescription={selectMode ? 'selectable application' : 'draggable application'}
        // In select mode the card toggles its selection: not disabled, and its state is announced.
        aria-disabled={selectMode ? undefined : attributes['aria-disabled']}
        aria-describedby={described || undefined}
        aria-pressed={selectMode ? checked : attributes['aria-pressed']}
        data-application-card={application.id}
        onClick={() => {
          if (longPress.consumeClick() || consumeDragClick()) return;
          activate();
        }}
        onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
          // During a keyboard drag Enter drops the card (dnd-kit's own listener); it must not also open it.
          if (event.key === 'Enter' && event.target === event.currentTarget && !isDragging && !draggingAny) {
            event.preventDefault();
            activate();
            return;
          }
          if (event.key === 'Enter' && (isDragging || draggingAny)) return;
          listeners?.onKeyDown?.(event);
        }}
        className={clsx(
          CARD_SURFACE,
          'block w-full cursor-pointer text-left outline-offset-2 transition-colors duration-150 select-none',
          selected || checked ? 'border-primary-ink bg-primary/5' : 'border-border hover:bg-[#f6f6f6]',
          isDragging && 'opacity-40',
        )}
      >
        <CardBody
          application={application}
          marker={handlers.markerOf?.(application)}
          heldSentenceId={`${marks}-held`}
          closedSentenceId={`${marks}-closed`}
          leading={
            selectMode ? <SelectionBox application={application} checked={checked} handlers={handlers} /> : null
          }
          actions={
            <span className="flex items-center gap-0.5" onClick={stop} onKeyDown={stop} onMouseDown={stop} onPointerDown={stop}>
              <FavoriteButton application={application} onToggle={handlers.onToggleFavorite} />
              <Menu
                open={menuOpen}
                onOpenChange={(open) => {
                  if (!open) longPress.cancel();
                  setMenuOpen(open);
                }}
              >
                <MenuTrigger
                  render={
                    <IconButton
                      label="Application actions"
                      size="sm"
                      icon={<DotsThreeIcon size={16} weight="bold" className="text-foreground" />}
                    />
                  }
                />
                <MenuContent width="w-56" align="end">
                  <ApplicationMenuItems application={application} actions={handlers} />
                </MenuContent>
              </Menu>
            </span>
          }
        />
      </ContextMenuTrigger>
      <ContextMenuContent width="w-56">
        <ApplicationMenuItems application={application} actions={handlers} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
