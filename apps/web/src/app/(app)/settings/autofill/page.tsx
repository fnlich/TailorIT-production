import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PageSpinner } from '@/components/ui/Spinner';
import { AutofillSettingsPage } from '@/features/autofill/AutofillSettingsPage';

export const metadata: Metadata = { title: 'Autofill' };

export default function Page() {
  // AutofillSettingsPage reads ?tab= (useSearchParams), which needs a Suspense boundary when prerendered.
  return (
    <Suspense fallback={<PageSpinner />}>
      <AutofillSettingsPage />
    </Suspense>
  );
}
