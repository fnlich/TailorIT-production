import type { Metadata } from 'next';
import { NotificationsPage } from '@/features/notifications/NotificationsPage';

export const metadata: Metadata = { title: 'Notifications' };

// v3.1 HEADER (D8): every notification, from the bell's "See all".
export default function Page() {
  return <NotificationsPage />;
}
