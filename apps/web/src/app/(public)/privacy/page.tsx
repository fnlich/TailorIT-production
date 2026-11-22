import type { Metadata } from 'next';
import { PrivacyPage } from '@/features/public/PrivacyPage';

// v34 PUBLIC (PLAN G8): public, without sign-in (proxy.ts).
export const metadata: Metadata = {
  title: 'Privacy policy',
  description: 'What TailorIT keeps about you, why, who handles it, how long it is kept and how to delete it.',
};

export default function Page() {
  return <PrivacyPage />;
}
