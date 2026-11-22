import type { Metadata } from 'next';
import { SupportPage } from '@/features/public/SupportPage';

// v34 PUBLIC (PLAN G8): public, without sign-in (proxy.ts).
export const metadata: Metadata = {
  title: 'Support',
  description: 'How to get help with TailorIT, and what to check when an AI app does not connect.',
};

export default function Page() {
  return <SupportPage />;
}
