'use client';

import { clsx } from 'clsx';
// Relative, not '@/': the web tests draw these views.
import { Tooltip } from '../../components/ui/Tooltip';
import { HandPointingIcon, RobotIcon } from '../../components/ui/icons';
import type { SavedJobSupport } from '@tailorit/shared/prepare';
import { supportKind, supportText } from './copy';

// v2.0: the support icon, the at-a-glance difference between the jobs the extension fills and the manual ones. v30
// ST0: the panes' chrome (Pane) and their hooks (useRowFocus, ROW_ACTION, useReducedMotion, useThrottled) moved,
// unchanged, to components/queue, the queue-style panes' base.

/**
 * The robot (the extension fills it) or the hand (applied to by hand), with its words as tooltip and name. Not a tab
 * stop (v2.0 fix UX-10: it does nothing, and a list of 50 saved jobs had 50 extra stops): the row's action names it
 * with `aria-describedby` to `id`.
 */
export function SupportIcon({ support, id, className }: { support: SavedJobSupport; id?: string; className?: string }) {
  const words = supportText(support);
  const Glyph = supportKind(support) === 'manual' ? HandPointingIcon : RobotIcon;
  return (
    <Tooltip content={words}>
      <span
        id={id}
        role="img"
        aria-label={words}
        data-support={supportKind(support)}
        className={clsx(
          'inline-flex size-7 shrink-0 items-center justify-center rounded-full outline-offset-1',
          supportKind(support) === 'manual' ? 'bg-amber text-amber-foreground' : 'bg-primary-container text-primary-ink',
          className,
        )}
      >
        <Glyph size={15} aria-hidden="true" />
      </span>
    </Tooltip>
  );
}
