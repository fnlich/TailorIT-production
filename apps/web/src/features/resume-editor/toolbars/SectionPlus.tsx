'use client';

import { Menu as BaseMenu } from '@base-ui/react/menu';
import { clsx } from 'clsx';
import { useRef } from 'react';
import { PlusIcon, RowsIcon, SquaresFourIcon } from '@/components/ui/icons';
import { MENU_ROW, MENU_SURFACE, Z_FLOATING } from '@/components/ui/styles';
import { Tooltip } from '@/components/ui/Tooltip';

// The green "+" under a section (Enhancv's): New entry, when the section holds entries, and New section, which opens
// the Add section gallery placing the new one after this section. Its menu hands focus back only when nothing was
// chosen; a choice puts the caret where the new entry or section is, once the menu has closed.

export interface SectionPlusProps {
  /** The section's name ("Experience"). */
  name: string;
  /** Whether the section holds entries (New entry is offered). */
  canAddEntry: boolean;
  /** Where the button's centre goes, in the canvas's coordinates. */
  at: { x: number; y: number };
  open: boolean;
  onOpenChange(open: boolean): void;
  onNewEntry(): void;
  onNewSection(): void;
  /** The menu has closed (after its animation): focus may move. */
  onClosed(): void;
}

export function SectionPlus({ name, canAddEntry, at, open, onOpenChange, onNewEntry, onNewSection, onClosed }: SectionPlusProps) {
  const chose = useRef(false);
  return (
    <div className="pointer-events-auto absolute" style={{ left: at.x - 11, top: at.y - 11 }}>
      <BaseMenu.Root
        open={open}
        onOpenChange={(next) => {
          if (next) chose.current = false;
          onOpenChange(next);
        }}
        onOpenChangeComplete={(next) => {
          if (!next) onClosed();
        }}
      >
        <Tooltip content="Add below">
          <BaseMenu.Trigger
            aria-label={`Add below ${name}`}
            className={clsx(
              'flex size-[22px] items-center justify-center rounded-full bg-success text-white shadow-control',
              'ring-2 ring-white transition-transform duration-150 hover:scale-110 data-popup-open:scale-110',
            )}
            data-section-plus=""
          >
            <PlusIcon size={13} weight="bold" />
          </BaseMenu.Trigger>
        </Tooltip>
        <BaseMenu.Portal>
          <BaseMenu.Positioner side="bottom" align="center" sideOffset={6} collisionPadding={8} className={clsx(Z_FLOATING, 'outline-none')}>
            <BaseMenu.Popup
              aria-label={`Add below ${name}`}
              finalFocus={() => !chose.current}
              className={clsx(MENU_SURFACE, 'w-44')}
            >
              {canAddEntry ? (
                <BaseMenu.Item
                  className={MENU_ROW}
                  onClick={() => {
                    chose.current = true;
                    onNewEntry();
                  }}
                >
                  <RowsIcon size={16} className="text-muted-foreground" />
                  New entry
                </BaseMenu.Item>
              ) : null}
              <BaseMenu.Item
                className={MENU_ROW}
                onClick={() => {
                  chose.current = true;
                  onNewSection();
                }}
              >
                <SquaresFourIcon size={16} className="text-muted-foreground" />
                New section
              </BaseMenu.Item>
            </BaseMenu.Popup>
          </BaseMenu.Positioner>
        </BaseMenu.Portal>
      </BaseMenu.Root>
    </div>
  );
}
