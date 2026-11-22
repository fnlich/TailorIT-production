import type { Metadata } from 'next';
import { TermsPage } from '@/features/public/TermsPage';

// v34 PUBLIC (PLAN G8): public, without sign-in (proxy.ts).
export const metadata: Metadata = {
  title: 'Terms of use',
  description: 'The terms for using this TailorIT service.',
};

export default function Page() {
  return <TermsPage />;
}
