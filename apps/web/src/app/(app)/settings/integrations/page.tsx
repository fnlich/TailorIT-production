import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PageSpinner } from '@/components/ui/Spinner';
import { IntegrationsPage } from '@/features/settings/integrations/IntegrationsPage';

export const metadata: Metadata = { title: 'Integrations' };

export default function Page() {
  // IntegrationsPage reads ?tab= (useSearchParams), which needs a Suspense boundary when prerendered.
  return (
    <Suspense fallback={<PageSpinner />}>
      <IntegrationsPage />
    </Suspense>
  );
}
