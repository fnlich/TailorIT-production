'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { XIcon } from '@/components/ui/icons';

export interface PanelFrameProps {
  title: string;
  onClose(): void;
  children: ReactNode;
}

/** Draws a panel's frame instead of the docked one (a phone's full-screen sheet); null: docked beside the page. */
export const PanelFrameContext = createContext<((props: PanelFrameProps) => ReactNode) | null>(null);

/** A panel docked beside the page (Templates, Design & Font): non-modal, the page stays editable next to it. */
export function SidePanel({ title, onClose, children }: PanelFrameProps) {
  const frame = useContext(PanelFrameContext);
  if (frame) return frame({ title, onClose, children });
  return (
    <aside
      aria-label={title}
      className="sticky top-4 flex max-h-[calc(100dvh-6rem)] w-[340px] shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-sm"
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-[15px] font-semibold text-foreground">{title}</h2>
        <IconButton label={`Close ${title}`} icon={<XIcon size={16} />} variant="ghost" size="sm" onClick={onClose} />
      </div>
      <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-4 py-4">{children}</div>
      <div className="border-t border-border px-4 py-3">
        <Button className="w-full" variant="outline" onClick={onClose}>
          Continue editing
        </Button>
      </div>
    </aside>
  );
}

export function PanelSection({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        {hint ? <span className="text-[12px] text-muted-foreground">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}
