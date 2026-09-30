'use client';
import { useState } from 'react';
import { ErrorBox, Select, Loading, PageHead } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import { fmtDateTime } from '@/lib/format';
import { supabase, unwrap } from '@/lib/supabase';
import type { AuditLog } from '@/lib/types';

const PAGE = 100;
const TYPES = [['', 'All records'], ['attendance', 'Attendance'], ['payroll_period', 'Payroll'], ['salary_slip', 'Salary slips'], ['quotation', 'Quotations']];

const show = (v: Record<string, unknown> | null) => v ? Object.entries(v).filter(([, x]) => x !== null && x !== undefined && x !== '').map(([k, x]) => `${k.replace(/_/g, ' ')}: ${typeof x === 'object' ? JSON.stringify(x) : String(x)}`).join(' · ') : '';

export default function AuditPage() {
  const sb = supabase();
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(PAGE);

  const { data, error, loading } = useQuery(async () => {
    let query = sb.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(limit);
    if (type) query = query.eq('record_type', type);
    return unwrap(await query) as AuditLog[];
  }, [type, limit]);

  const rows = (data ?? []).filter((a) => `${a.user_name} ${a.action} ${a.record_label ?? ''}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <>
      <PageHead eyebrow="System" title="Audit Log" sub="Attendance, overtime, payroll, salary slip and quotation actions. Entries can’t be edited or deleted." />
      {error && <ErrorBox error={error} />}
      <div className="panel flush">
        <div className="panel-head">
          <div className="toolbar">
            <Select className="select" value={type} onChange={(e) => { setType(e.target.value); setLimit(PAGE); }}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
            <input className="input" placeholder="Filter by user, action or record…" style={{ minWidth: 260 }} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <span className="muted">Showing {rows.length}</span>
        </div>
        {loading && !data ? <Loading /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Timestamp</th><th>User</th><th>Action</th><th>Record</th><th>Previous value</th><th>New value</th></tr></thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(a.created_at)}</td><td>{a.user_name}</td>
                  <td style={{ textTransform: 'capitalize', whiteSpace: 'nowrap' }}>{a.action.replace(/[._]/g, ' ')}</td>
                  <td>{a.record_label ?? a.record_id}</td>
                  <td className="muted" style={{ maxWidth: 260 }}>{show(a.old_value)}</td><td style={{ maxWidth: 300 }}>{show(a.new_value)}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={6}><div className="empty">No audit entries.</div></td></tr>}
            </tbody>
          </table></div>
        )}
        {(data ?? []).length >= limit && <div style={{ padding: 14, textAlign: 'center' }}><button className="btn" onClick={() => setLimit(limit + PAGE)}>Load more</button></div>}
      </div>
    </>
  );
}
