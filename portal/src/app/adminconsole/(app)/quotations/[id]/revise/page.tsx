'use client';
import { useParams } from 'next/navigation';
import { useApp } from '@/components/Providers';
import { QuotationForm } from '@/components/QuotationForm';
import { ErrorBox, Loading, PageHead } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import { can } from '@/lib/roles';
import { supabase, unwrap } from '@/lib/supabase';
import type { Quotation, QuotationRevision } from '@/lib/types';

export default function ReviseQuotation() {
  const { id } = useParams<{ id: string }>();
  const { profile } = useApp();
  const sb = supabase();
  const { data, error, loading } = useQuery(async () => {
    const q = unwrap(await sb.from('quotations').select('*').eq('id', id).single()) as Quotation;
    const rev = unwrap(await sb.from('quotation_revisions').select('*, quotation_items(*)').eq('quotation_id', id).eq('revision', q.current_revision).single()) as QuotationRevision;
    return { q, rev };
  }, [id]);

  if (loading) return <Loading />;
  if (error || !data) return <ErrorBox error={error ?? 'Not found'} />;
  const items = [...(data.rev.quotation_items ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  return (
    <>
      <PageHead eyebrow={data.q.number} title="Revise Quotation" sub={`Saving creates revision R${data.q.current_revision + 1}. Earlier versions are kept and can still be viewed and printed.`} />
      {can(profile!.role, 'quotations:write') ? <QuotationForm quotationId={id} base={data.rev} items={items} /> : <div className="banner error">Your role can’t revise quotations.</div>}
    </>
  );
}
