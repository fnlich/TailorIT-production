'use client';

import { clsx } from 'clsx';
import { PAGE_GUTTER } from '@/components/shell/layout';
import { McpSection } from './McpSection';

/** Settings › Integrations (/settings/integrations, v1.5 M): what TailorIT connects to. Today: your own AI, over MCP. */
export function IntegrationsPage() {
  return (
    <div className={clsx('mx-auto w-full max-w-[880px] pt-9 pb-20', PAGE_GUTTER)}>
      <h1 className="text-[30px] leading-10 font-bold tracking-[-0.01em] text-foreground">Integrations</h1>
      <p className="mt-2 text-base text-muted-foreground">The tools that work with TailorIT on your behalf.</p>
      <div className="mt-8 flex flex-col gap-6">
        <McpSection />
      </div>
    </div>
  );
}
