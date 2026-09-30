'use client';
import Link from 'next/link';
import { Money, Riyal } from '@/components/Money';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { QuotationDoc } from '@/components/Docs';
import { useApp } from '@/components/Providers';
import { ErrorBox, Select, Loading, PageHead, QUOTE_LABEL, QUOTE_STATUSES } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import { fmtDateTime } from '@/lib/format';
import { can } from '@/lib/roles';
import { supabase, unwrap } from '@/lib/supabase';
import type { Quotation, QuotationRevision, QuotationStatus } from '@/lib/types';

export default function QuotationDetail() {
  const { id } = useParams<{ id: string }>();
  const { profile, settings, toast } = useApp();
  const canWrite = can(profile!.role, 'quotations:write');
  const sb = supabase();
  const [sel, setSel] = useState<number | null>(null);

  const { data, error, loading, reload } = useQuery(async () => {
    const q = unwrap(await sb.from('quotations').select('*').eq('id', id).single()) as Quotation;
    const revs = unwrap(await sb.from('quotation_revisions').select('*, quotation_items(*)').eq('quotation_id', id).order('revision', { ascending: false })) as QuotationRevision[];
    return { q, revs };
  }, [id]);

  if (loading) return <Loading />;
  if (error || !data) return <ErrorBox error={error ?? 'Quotation not found'} />;
  const { q, revs } = data;
  const rev = revs.find((r) => r.revision === (sel ?? q.current_revision)) ?? revs[0];
  const items = [...(rev.quotation_items ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const isCurrent = rev.revision === q.current_revision;

  async function setStatus(status: QuotationStatus) {
    const { error } = await sb.rpc('set_quotation_status', { p_id: id, p_status: status });
    if (error) return toast(error.message, true);
    toast(`Status changed to ${QUOTE_LABEL[status]}`); reload();
  }

  return (
    <>
      <PageHead eyebrow="Quotation" title={q.number} sub={`${q.client}${q.project ? ` · ${q.project}` : ''}`}>
        <Link href="/adminconsole/quotations" className="btn">← Quotations</Link>
        {canWrite && <Link href={`/adminconsole/quotations/${id}/revise`} className="btn">Revise</Link>}
        <button className="btn primary" onClick={() => window.print()}>Print</button>
        <button className="btn" onClick={() => window.print()} title="Choose “Save as PDF” as the destination in the print dialog">Download PDF</button>
      </PageHead>

      <div className="grid-2 no-print" style={{ gridTemplateColumns: '1fr 1.3fr', marginBottom: 20 }}>
        <div className="panel">
          <div className="panel-title">Status</div>
          <Select className="select" disabled={!canWrite} value={q.status} onChange={(e) => setStatus(e.target.value as QuotationStatus)}>
            {QUOTE_STATUSES.map((s) => <option key={s} value={s}>{QUOTE_LABEL[s]}</option>)}
          </Select>
          <div className="muted" style={{ marginTop: 10, fontSize: 11 }}>Current amount {<Money v={q.amount} />} incl. VAT. Saving a revision marks the quotation “Revised”; set it back to Submitted once re-sent.</div>
        </div>
        <div className="panel flush">
          <div className="panel-head"><div className="panel-title">Revision history</div></div>
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Revision</th><th>Saved</th><th className="r">Grand Total</th><th>Note</th></tr></thead>
            <tbody>
              {revs.map((r) => (
                <tr key={r.id} className="click" onClick={() => setSel(r.revision)} style={r.revision === rev.revision ? { background: 'var(--green-soft)' } : undefined}>
                  <td className="strong">{r.revision === 0 ? 'Original' : `R${r.revision}`}{r.revision === q.current_revision && ' (current)'}</td>
                  <td>{fmtDateTime(r.created_at)}</td><td className="r">{<Money v={r.grand_total} />}</td><td className="muted">{r.revision_note}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </div>
      </div>

      {!isCurrent && <div className="banner warn no-print">You are viewing {rev.revision === 0 ? 'the original version' : `revision R${rev.revision}`}, which has been superseded.</div>}
      <QuotationDoc number={q.number} rev={rev} items={items} co={settings.company} />
    </>
  );
}
