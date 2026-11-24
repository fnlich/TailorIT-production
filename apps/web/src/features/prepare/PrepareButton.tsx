'use client';

import type { ButtonSize, ButtonVariant } from '../../components/ui/Button';
// Relative, not '@/': the web tests draw this view.
import { Button } from '../../components/ui/Button';
import { prepareLabel } from './copy';

// v2.0: the Prepare button (docs/design/v2.0/08-ui.md): primary, "Prepare" (or "Prepare (n)"
// for a selection), the spinner while its request is in flight. On the Saved pane's rows, the Saved pane's and the
// Tracker's selection bars. The action itself is usePrepareAndQueue's.

export interface PrepareButtonProps {
  onClick: () => void;
  /** A selection's count: "Prepare (3)". */
  count?: number;
  loading?: boolean;
  disabled?: boolean;
  size?: ButtonSize;
  variant?: ButtonVariant;
  /** The accessible name, when the visible words need the job's name ("Prepare Senior Engineer at Acme"). */
  'aria-label'?: string;
  /** More about the job (a Saved row's support words). */
  'aria-describedby'?: string;
  /** Marks a row's action (ROW_ACTION), so focus finds it again once the row changed. */
  'data-row-action'?: string;
  /** Words other than the default ("Try again"). */
  label?: string;
  className?: string;
}

export function PrepareButton({
  onClick,
  count,
  loading = false,
  disabled = false,
  size = 'sm',
  variant = 'primary',
  label,
  className,
  ...aria
}: PrepareButtonProps) {
  return (
    <Button
      variant={variant}
      size={size}
      loading={loading}
      disabled={disabled}
      // Focus stays on the pressed button while its request runs (08-ui.md, Accessibility).
      focusableWhenDisabled
      onClick={onClick}
      aria-label={aria['aria-label']}
      aria-describedby={aria['aria-describedby']}
      className={className}
      data-prepare-button=""
      data-row-action={aria['data-row-action']}
    >
      {label ?? prepareLabel(count)}
    </Button>
  );
}
