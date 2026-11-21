import type { Metadata } from 'next';
import { ProfilesPage } from '@/features/sharing/ProfilesPage';

// v33 SHARE-7 (PLAN F9 "Seeing every profile at once"): every profile at once ("All profiles" in the account menu).
export const metadata: Metadata = { title: 'Profiles' };

export default function Page() {
  return <ProfilesPage />;
}
