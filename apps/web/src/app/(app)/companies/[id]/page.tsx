import type { Metadata } from 'next';
import { CompanyPage } from '@/features/companies/CompanyPage';

// v30 E0-WEB: a company's page (owner question 24): its profile, its open positions and its closed history.
export const metadata: Metadata = { title: 'Company' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CompanyPage idParam={id} />;
}
