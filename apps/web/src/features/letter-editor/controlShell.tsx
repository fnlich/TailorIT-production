import { clsx } from 'clsx';
import { CaretDownIcon } from '@/components/ui/icons';

/*
 * The editors' dropdown controls (the font select, "Insert variable..." and "Base from template..."), drawn like the
 * kit's Select (components/ui/Select.tsx): 36 px, white, a border-strong edge with a 6 px radius that darkens on
 * hover and turns denim with the focus halo while open or typed in, then a thin separator and a caret.
 */

export const SHELL =
  'relative flex h-9 min-w-0 items-center rounded-control border border-border-strong bg-surface text-sm text-foreground ' +
  'shadow-control transition-[border-color,box-shadow] duration-150 hover:border-control-hover ' +
  'data-popup-open:border-primary data-popup-open:shadow-focus has-[input:focus]:border-primary has-[input:focus]:shadow-focus ' +
  'data-disabled:cursor-not-allowed data-disabled:bg-surface-low data-disabled:text-muted-foreground';

/** The text field inside a typed-in shell ("Insert variable...", "Base from template..."). */
export const SHELL_INPUT =
  'h-full min-w-0 flex-1 rounded-control bg-transparent pl-2.5 text-sm outline-none placeholder:text-subtle-foreground';

/** The separator and caret at the right end of a shell. */
export function ShellIndicator({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={clsx('pointer-events-none flex h-full shrink-0 items-center', className)}>
      <span className="h-5 w-px bg-border" />
      <span className="flex w-9 items-center justify-center text-muted-foreground">
        <CaretDownIcon size={14} />
      </span>
    </span>
  );
}
