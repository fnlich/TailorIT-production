'use client';

import { clsx } from 'clsx';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { PAGE_GUTTER } from '@/components/shell/layout';
import { PageHeader } from '@/components/ui/PageHeader';
import { TabPanel } from '@/components/ui/SegmentedControl';
import { UnderlineTabs } from '@/components/ui/UnderlineTabs';
import { AiAssistantsTab } from './AiAssistantsTab';
import { ConnectionsTab } from './ConnectionsTab';
import { INTEGRATIONS_TABS, PAGE_COPY, readIntegrationsTab, type IntegrationsTab } from './integrations';

/**
 * Integrations (/settings/integrations; v1.5 M, v3.1 INTEG): what TailorIT connects to, in two tabs bound to `?tab=`
 * (the address keeps the tab, so reload and back land on it): AI assistants (TailorIT's MCP server, Claude and ChatGPT
 * with Connect, the connected ones, the personal tokens) and Connections (Gmail and Google Calendar, coming soon).
 */
export function IntegrationsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = readIntegrationsTab(searchParams.get('tab'));

  const selectTab = (next: IntegrationsTab) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === 'ai-assistants') params.delete('tab');
    else params.set('tab', next);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  return (
    <div className={clsx('mx-auto w-full max-w-[880px] pt-7 pb-20', PAGE_GUTTER)}>
      <PageHeader title={PAGE_COPY.title} description={PAGE_COPY.description} />
      <UnderlineTabs aria-label={PAGE_COPY.tabsLabel} items={INTEGRATIONS_TABS} value={tab} onValueChange={selectTab} className="mt-6">
        <TabPanel value="ai-assistants" className="mt-6">
          <AiAssistantsTab />
        </TabPanel>
        <TabPanel value="connections" className="mt-6">
          <ConnectionsTab onOpenAiAssistants={() => selectTab('ai-assistants')} />
        </TabPanel>
      </UnderlineTabs>
    </div>
  );
}
