import type { Metadata } from 'next';
import { ResumeEditRoute } from '@/features/resume-editor/edit/ResumeEditRoute';

export const metadata: Metadata = { title: 'Edit resume' };

/** v1.5 W (decision 3): Edit for any resume; an upload's editable copy is made first when it has none. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ResumeEditRoute resumeId={id} />;
}
