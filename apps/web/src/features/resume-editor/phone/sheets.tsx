'use client';

import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { clsx } from 'clsx';
import { forwardRef, useRef, type ComponentProps, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { BACKDROP } from '@/components/ui/Dialog';
import { IconButton } from '@/components/ui/IconButton';
import { CaretLeftIcon, XIcon } from '@/components/ui/icons';
import { PanelFrameContext, type PanelFrameProps } from '../panels/SidePanel';

// The phone editor's surfaces, all Base UI dialogs (modal, labelled by their title, focus kept inside): a sheet that
// slides up from the bottom with a part's actions or the menu, and full-screen ones for a part's form and for the
// Templates and Design & Font panels. Where focus goes when one closes is the caller's (`finalFocus`), so it can go
// back to the part that was tapped, or on to the next one when that part was deleted.

type FinalFocus = ComponentProps<typeof BaseDialog.Popup>['finalFocus'];

interface SurfaceProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** It has closed (after its animation). */
  onClosed?(): void;
  /** Where focus goes when it closes; nowhere by default (the caller moves it once it has closed). */
  finalFocus?: FinalFocus;
  children: ReactNode;
}

const rootProps = ({ open, onOpenChange, onClosed }: SurfaceProps) => ({
  open,
  onOpenChange: (next: boolean) => onOpenChange(next),
  onOpenChangeComplete: (next: boolean) => {
    if (!next) onClosed?.();
  },
});

/** A sheet from the bottom edge: a title, a line under it, then its rows (the first one that can be used has focus). */
export function BottomSheet(props: SurfaceProps & { title: ReactNode; description?: ReactNode }) {
  const { title, description, children, finalFocus = false } = props;
  const rows = useRef<HTMLDivElement | null>(null);
  return (
    <BaseDialog.Root {...rootProps(props)}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className={BACKDROP} />
        <BaseDialog.Popup
          initialFocus={() => rows.current?.querySelector<HTMLElement>('button:not(:disabled)') ?? true}
          finalFocus={finalFocus}
          className={clsx(
            'fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col rounded-t-2xl bg-surface text-foreground',
            'shadow-dialog outline-none pb-[env(safe-area-inset-bottom)] transition-transform duration-300 ease-out-soft',
            'data-starting-style:translate-y-full data-ending-style:translate-y-full',
          )}
        >
          <span aria-hidden="true" className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-control-strong" />
          <div className="flex items-start gap-2 pt-2 pr-3 pb-2 pl-5">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-1">
              <BaseDialog.Title className="truncate text-base leading-6 font-semibold">{title}</BaseDialog.Title>
              {description ? (
                <BaseDialog.Description className="text-[13px] leading-5 text-muted-foreground">
                  {description}
                </BaseDialog.Description>
              ) : null}
            </div>
            <BaseDialog.Close render={<IconButton label="Close" icon={<XIcon size={18} />} size="sm" tooltip={false} />} />
          </div>
          <div ref={rows} className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {children}
          </div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

export interface SheetRowProps extends Omit<ComponentPropsWithoutRef<'button'>, 'className'> {
  icon: ReactNode;
  destructive?: boolean;
}

/** One row of a sheet: a full-width button, tall enough for a thumb. */
export const SheetRow = forwardRef<HTMLButtonElement, SheetRowProps>(function SheetRow(
  { icon, destructive, children, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={clsx(
        'flex h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-[15px] outline-none',
        'focus-visible:bg-hover active:bg-hover disabled:pointer-events-none disabled:opacity-40 [&_svg]:shrink-0',
        destructive ? 'text-destructive' : 'text-foreground',
      )}
      {...rest}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
});

const FULL_SCREEN =
  'fixed inset-0 z-50 flex flex-col bg-surface text-foreground outline-none transition-[opacity,translate] duration-200 ' +
  'ease-out-soft data-starting-style:translate-y-3 data-starting-style:opacity-0 data-ending-style:translate-y-3 ' +
  'data-ending-style:opacity-0';

/**
 * A part's form over the whole screen: "Back to resume" at the top left, its title, "Done" at the top right. Every
 * change is in the resume as it is typed, so both just close it. The body is where the session puts the caret
 * (`data-edit-form`) after a bullet is split or joined.
 */
export function FullScreenForm(props: SurfaceProps & { title: string }) {
  const { title, children, finalFocus = false } = props;
  return (
    <BaseDialog.Root {...rootProps(props)}>
      <BaseDialog.Portal>
        <BaseDialog.Popup finalFocus={finalFocus} className={FULL_SCREEN}>
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 pt-[env(safe-area-inset-top)]">
            <div className="flex h-14 min-w-0 flex-1 items-center gap-2">
              <BaseDialog.Close
                render={<Button variant="ghost" size="sm" icon={<CaretLeftIcon size={16} />} className="shrink-0" />}
              >
                Back to resume
              </BaseDialog.Close>
              <BaseDialog.Title className="min-w-0 flex-1 truncate text-center text-[15px] font-semibold">
                {title}
              </BaseDialog.Title>
              <BaseDialog.Close render={<Button size="sm" className="shrink-0" />}>Done</BaseDialog.Close>
            </div>
          </div>
          <div
            className="min-h-0 flex-1 overflow-y-auto px-4 pt-5 pb-[calc(2rem+env(safe-area-inset-bottom))]"
            data-edit-form=""
          >
            {children}
          </div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

/** A docked panel's frame as a full-screen sheet: its title and ✕, the panel's controls, then Continue editing. */
function panelSheetFrame({ title, onClose, children }: PanelFrameProps) {
  return (
    <>
      <div className="shrink-0 border-b border-border px-4 pt-[env(safe-area-inset-top)]">
        <div className="flex h-14 min-w-0 items-center justify-between gap-2">
          <BaseDialog.Title className="truncate text-[15px] font-semibold">{title}</BaseDialog.Title>
          <BaseDialog.Close render={<IconButton label={`Close ${title}`} icon={<XIcon size={18} />} tooltip={false} />} />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-5">{children}</div>
      <div className="shrink-0 border-t border-border px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        <Button className="w-full" variant="outline" onClick={onClose}>
          Continue editing
        </Button>
      </div>
    </>
  );
}

/** Templates or Design & Font on a phone: the docked panel itself (`children`), drawn over the whole screen. */
export function PanelSheet(props: SurfaceProps) {
  const { children, finalFocus = false } = props;
  return (
    <BaseDialog.Root {...rootProps(props)}>
      <BaseDialog.Portal>
        <BaseDialog.Popup finalFocus={finalFocus} className={FULL_SCREEN}>
          <PanelFrameContext.Provider value={panelSheetFrame}>{children}</PanelFrameContext.Provider>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
