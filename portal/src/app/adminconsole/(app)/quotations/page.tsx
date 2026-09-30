'use client';
import Link from 'next/link';
import { Money, Riyal } from '@/components/Money';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useApp } from '@/components/Providers';
import { ErrorBox, Loading, PageHead, QUOTE_LABEL, QUOTE_STATUSES, QuoteBadge } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { can } from '@/lib/roles';
import { fetchAll, supabase } from '@/lib/supabase';
import type { Quotation } from '@/lib/types';

export default function QuotationList() {
  const { profile } = useApp();
  const router = useRouter();
  const sb = supabase();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const { data, error, loading } = useQuery(() =>
    fetchAll<Quotation>((f, t) => sb.from('quotations').select('*').order('number', { ascending: false }).range(f, t)), []);

  const rows = useMemo(() => (data ?? []).filter((r) => (!status || r.status === status) &&
    `${r.number} ${r.client} ${r.project}`.toLowerCase().includes(q.toLowerCase())), [data, q, status]);

  return (
    <>
      <PageHead eyebrow="Quotations" title="Quotations" sub="Create, revise and track client quotations">
        {can(profile!.role, 'quotations:write') && <Link href="/adminconsole/quotations/new" className="btn primary">＋ New Quotation</Link>}
      </PageHead>
      {error && <ErrorBox error={error} />}
      <div className="panel flush">
        <div className="panel-head">
          <div className="toolbar">
            <input className="input" placeholder="Search number, client, project…" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 260 }} />
            <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All statuses</option>
              {QUOTE_STATUSES.map((s) => <option key={s} value={s}>{QUOTE_LABEL[s]}</option>)}
            </select>
          </div>
          <span className="muted">{rows.length} quotations</span>
        </div>
        {loading ? <Loading /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Quotation No.</th><th>Client</th><th>Project</th><th>Date</th><th className="r">Amount</th><th>Revision</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="click" onClick={() => router.push(`/adminconsole/quotations/${r.id}`)}>
                  <td className="strong mono">{r.number}</td><td>{r.client}</td><td>{r.project}</td><td>{fmtDate(r.quote_date)}</td>
                  <td className="r strong">{<Money v={r.amount} />}</td><td>{r.current_revision === 0 ? 'Original' : `R${r.current_revision}`}</td><td><QuoteBadge s={r.status} /></td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={7}><div className="empty">No quotations found.</div></td></tr>}
            </tbody>
          </table></div>
        )}
      </div>
    </>
  );
}
