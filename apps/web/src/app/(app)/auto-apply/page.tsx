import type { Metadata } from 'next';
import { AutoApplyPage } from '@/features/auto-apply/AutoApplyPage';

export const metadata: Metadata = { title: 'Auto-apply' };

export default function Page() {
  return <AutoApplyPage />;
}
