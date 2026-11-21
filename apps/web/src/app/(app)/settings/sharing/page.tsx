import type { Metadata } from 'next';
import { SharingPage } from '@/features/sharing/SharingPage';

// v33 SHARE-7 (PLAN F9): Settings › Sharing. Only ever on the person's own profile (AuthGate switches a tab on a shared
// profile back first: OWN_ONLY_PATHS).
export const metadata: Metadata = { title: 'Sharing' };

export default function Page() {
  return <SharingPage />;
}
