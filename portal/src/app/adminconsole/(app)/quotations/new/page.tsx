'use client';
import { useApp } from '@/components/Providers';
import { QuotationForm } from '@/components/QuotationForm';
import { PageHead } from '@/components/ui';
import { can } from '@/lib/roles';

export default function NewQuotation() {
  const { profile, company } = useApp();
  return (
    <>
      <PageHead eyebrow="Quotations" title="New Quotation" sub={`The quotation number is assigned automatically, e.g. ${company?.code ?? ''}-QT-2026-0148.`} />
      {can(profile!.role, 'quotations:write') ? <QuotationForm /> : <div className="banner error">Your role can’t create quotations.</div>}
    </>
  );
}
