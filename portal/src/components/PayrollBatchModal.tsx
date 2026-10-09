'use client';
import { useState } from 'react';
import { DatePicker, ErrorBox, Field, Loading, Modal } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import { ymd } from '@/lib/format';
import { fetchAll, supabase } from '@/lib/supabase';
import type { Employee, PayrollPeriod } from '@/lib/types';

export function BatchModal({ year, month, period, busy, onClose, onRun }: {
  year: number; month: number; period: PayrollPeriod | null; busy: boolean; onClose: () => void;
  onRun: (start: string, end: string, ids: string[]) => void;
}) {
  const sb = supabase();
  const { data: emps, error } = useQuery(async () =>
    (await fetchAll<Employee>((f, t) => sb.from('employees').select('*').eq('status', 'active').order('emp_code').range(f, t))), []);
  const [start, setStart] = useState(period?.start_date ?? ymd(new Date(year, month - 1, 1)));
  const [end, setEnd] = useState(period?.end_date ?? ymd(new Date(year, month, 0)));
  const [picked, setPicked] = useState<Set<string> | null>(
    // a new run starts with nobody selected; an existing run keeps its saved choice (null = everyone)
    !period ? new Set() : period.employee_ids ? new Set(period.employee_ids) : null);
  const [q, setQ] = useState('');

  const all = emps ?? [];
  const sel = picked ?? new Set(all.map((e) => e.id));
  const shown = all.filter((e) => `${e.emp_code} ${e.name} ${e.department}`.toLowerCase().includes(q.trim().toLowerCase()));
  const toggle = (id: string) => { const n = new Set(sel); n.has(id) ? n.delete(id) : n.add(id); setPicked(n); };
  const setMany = (list: Employee[], on: boolean) => { const n = new Set(sel); list.forEach((e) => (on ? n.add(e.id) : n.delete(e.id))); setPicked(n); };
  const badDates = !start || !end || end < start;
  const ids = all.filter((e) => sel.has(e.id)).map((e) => e.id);

  return (
    <Modal title="Payroll batch" wide onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || badDates || ids.length === 0} onClick={() => onRun(start, end, ids)}>{period ? 'Recalculate' : 'Calculate'} · {ids.length} employee{ids.length === 1 ? '' : 's'}</button></>}>
      <div className="grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Pay period start"><DatePicker value={start} onChange={setStart} /></Field>
        <Field label="Pay period end"><DatePicker value={end} onChange={setEnd} /></Field>
      </div>
      {badDates && <div className="banner error">The end date must be on or after the start date.</div>}
      <div className="muted" style={{ margin: '4px 0 12px', fontSize: 11 }}>Attendance within these dates is used for the calculation. Only the selected employees are included in this batch.</div>
      <div className="toolbar" style={{ marginBottom: 8 }}>
        <input className="input" style={{ flex: '1 1 100%' }} placeholder="Search employees…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn sm" style={{ flex: 1 }} onClick={() => setMany(shown, true)}>Select {q ? 'shown' : 'all'}</button>
        <button className="btn sm" style={{ flex: 1 }} onClick={() => setMany(shown, false)}>Clear {q ? 'shown' : 'all'}</button>
      </div>
      {error && <ErrorBox error={error} />}
      <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--line, #ddd)', borderRadius: 6 }}>
        {!emps ? <Loading /> : shown.map((e) => (
          <label key={e.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '7px 12px', cursor: 'pointer' }}>
            <input type="checkbox" checked={sel.has(e.id)} onChange={() => toggle(e.id)} />
            <span className="strong">{e.name}</span><span className="muted" style={{ fontSize: 11 }}>{e.emp_code} · {e.department}</span>
          </label>
        ))}
        {emps && shown.length === 0 && <div className="empty">No employees match.</div>}
      </div>
      <div className="muted" style={{ marginTop: 8, fontSize: 11 }}>{ids.length} of {all.length} active employees selected.</div>
    </Modal>
  );
}
