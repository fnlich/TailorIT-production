import { clsx } from 'clsx';
import { useId, type ReactNode, type RefObject } from 'react';
import { Card } from '@/components/ui/Card';
import { HelpTip } from '@/components/ui/HelpTip';

/**
 * v3.1 INTEG: one card of the Integrations page (docs/design/v3.1/20-visual-identity.md, "Cards on the canvas"): a
 * region named by its heading (`text-heading`), its sentence in a "?" beside it (v32 COPY), an optional action at the
 * right, the content.
 */
export function IntegrationSection({
  title,
  description,
  aside,
  action,
  children,
  className,
  headingRef,
}: {
  title: string;
  description?: ReactNode;
  /** Beside the title (a count). */
  aside?: ReactNode;
  /** At the top right (a button). */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  /** The heading, made focusable from script: where focus goes when the row a person acted on is gone. */
  headingRef?: RefObject<HTMLHeadingElement | null>;
}) {
  const headingId = useId();
  return (
    <Card as="section" aria-labelledby={headingId} className={clsx('flex flex-col gap-5', className)}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex items-center gap-1.5">
            <h2
              id={headingId}
              ref={headingRef}
              tabIndex={headingRef ? -1 : undefined}
              className="text-heading font-semibold text-foreground outline-none"
            >
              {title}
            </h2>
            {description ? <HelpTip label={title}>{description}</HelpTip> : null}
            {aside}
          </div>
        </div>
        {action}
      </div>
      {children}
    </Card>
  );
}
