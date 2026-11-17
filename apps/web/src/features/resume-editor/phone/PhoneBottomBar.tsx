'use client';

import { ListIcon } from '@phosphor-icons/react/List';
import { clsx } from 'clsx';
import { forwardRef, useRef, useState, type ComponentPropsWithoutRef, type ReactNode, type RefObject } from 'react';
import {
  ArrowUUpLeftIcon,
  ArrowUUpRightIcon,
  ArrowsDownUpIcon,
  DownloadSimpleIcon,
  EyeIcon,
  PaletteIcon,
  PencilSimpleIcon,
  PlusIcon,
  SquaresFourIcon,
} from '@/components/ui/icons';
import { DesignPanel } from '../panels/DesignPanel';
import { TemplatesPanel } from '../panels/TemplatesPanel';
import { AddSectionDialog } from '../toolbars/AddSectionDialog';
import { useToolbarCommands } from '../toolbars/useToolbarCommands';
import type { EditorSession } from '../workspace/useEditorSession';
import { BottomSheet, PanelSheet, SheetRow } from './sheets';
import { usePhoneFocus } from './usePhoneFocus';

// The bar along a phone's bottom edge (above the home indicator): Preview, Download, Undo, Redo and the Menu, a sheet
// with Add section (the desktop's gallery), Rearrange, Templates and Design & Font. Templates and Design & Font are
// the desktop's panels, drawn over the whole screen. What the menu opens opens once the menu has closed, so focus goes
// back to the Menu button when that closes in turn.

type MenuChoice = 'add' | 'rearrange' | 'templates' | 'design';

interface BarButtonProps extends Omit<ComponentPropsWithoutRef<'button'>, 'className'> {
  icon: ReactNode;
  /** The word under the icon; the button's name too unless `aria-label` says more. */
  text: string;
}

const BarButton = forwardRef<HTMLButtonElement, BarButtonProps>(function BarButton({ icon, text, type, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={clsx(
        'flex h-14 min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg text-[11px] leading-4 font-medium',
        'text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary active:bg-hover',
        'disabled:pointer-events-none disabled:opacity-40',
      )}
      {...rest}
    >
      {icon}
      <span className="max-w-full truncate">{text}</span>
    </button>
  );
});

export interface PhoneBottomBarProps {
  session: EditorSession;
  canvas: RefObject<HTMLDivElement | null>;
  previewing: boolean;
  onPreview(): void;
  onDownload(): void;
  onRearrange(): void;
}

export function PhoneBottomBar({ session, canvas, previewing, onPreview, onDownload, onRearrange }: PhoneBottomBarProps) {
  const focus = usePhoneFocus(canvas);
  const commands = useToolbarCommands(session, focus, canvas);
  const [menu, setMenu] = useState(false);
  const [panel, setPanel] = useState<{ which: 'templates' | 'design'; open: boolean } | null>(null);
  const [adding, setAdding] = useState(false);
  const chosen = useRef<MenuChoice | null>(null);
  const menuButton = useRef<HTMLButtonElement | null>(null);

  const choose = (choice: MenuChoice) => {
    chosen.current = choice;
    setMenu(false);
  };
  const openChosen = () => {
    const choice = chosen.current;
    chosen.current = null;
    if (choice === 'add') setAdding(true);
    else if (choice === 'rearrange') onRearrange();
    else if (choice) setPanel({ which: choice, open: true });
  };
  const closePanel = () => setPanel((current) => (current ? { ...current, open: false } : current));

  return (
    <>
      <div
        role="group"
        aria-label="Editor actions"
        className={clsx(
          'fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface px-2 pb-[env(safe-area-inset-bottom)]',
          'shadow-[0_-1px_3px_rgba(17,24,39,0.06)]',
        )}
        data-phone-bar=""
      >
        <div className="mx-auto grid max-w-md grid-cols-5 gap-1 py-1">
          <BarButton
            icon={previewing ? <PencilSimpleIcon size={20} /> : <EyeIcon size={20} />}
            text={previewing ? 'Edit' : 'Preview'}
            aria-label={previewing ? 'Back to editing' : undefined}
            onClick={onPreview}
          />
          <BarButton icon={<DownloadSimpleIcon size={20} />} text="Download" onClick={onDownload} />
          <BarButton
            icon={<ArrowUUpLeftIcon size={20} />}
            text="Undo"
            aria-label={session.undoLabel ? `Undo ${session.undoLabel}` : 'Undo'}
            disabled={!session.canUndo}
            onClick={session.undo}
          />
          <BarButton
            icon={<ArrowUUpRightIcon size={20} />}
            text="Redo"
            aria-label={session.redoLabel ? `Redo ${session.redoLabel}` : 'Redo'}
            disabled={!session.canRedo}
            onClick={session.redo}
          />
          <BarButton
            ref={menuButton}
            icon={<ListIcon size={20} />}
            text="Menu"
            aria-haspopup="dialog"
            onClick={() => setMenu(true)}
          />
        </div>
      </div>
      <BottomSheet open={menu} onOpenChange={setMenu} onClosed={openChosen} finalFocus={menuButton} title="Menu">
        <SheetRow icon={<PlusIcon size={18} />} onClick={() => choose('add')}>
          Add section
        </SheetRow>
        <SheetRow icon={<ArrowsDownUpIcon size={18} />} onClick={() => choose('rearrange')}>
          Rearrange
        </SheetRow>
        <SheetRow icon={<SquaresFourIcon size={18} />} onClick={() => choose('templates')}>
          Templates
        </SheetRow>
        <SheetRow icon={<PaletteIcon size={18} />} onClick={() => choose('design')}>
          Design & Font
        </SheetRow>
      </BottomSheet>
      {panel ? (
        <PanelSheet
          open={panel.open}
          onOpenChange={(open) => {
            if (!open) closePanel();
          }}
          onClosed={() => setPanel(null)}
          finalFocus={menuButton}
        >
          {panel.which === 'templates' ? (
            <TemplatesPanel document={session.document} store={session.store} onClose={closePanel} />
          ) : (
            <DesignPanel document={session.document} store={session.store} onClose={closePanel} />
          )}
        </PanelSheet>
      ) : null}
      <AddSectionDialog
        open={adding}
        onOpenChange={setAdding}
        document={session.document}
        onAdd={(ref) => commands.addSection(ref, null)}
        onAddCustom={(title, fields) => commands.addCustomSection(title, fields, null)}
        onClosed={focus.flush}
      />
    </>
  );
}
