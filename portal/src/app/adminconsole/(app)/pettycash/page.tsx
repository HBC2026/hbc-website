'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Money } from '@/components/Money';
import { useApp } from '@/components/Providers';
import { Badge, DatePicker, ErrorBox, Field, Loading, Modal, PageHead, Select, StatCard } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import { today } from '@/lib/format';
import { can } from '@/lib/roles';
import { supabase, unwrap } from '@/lib/supabase';
import type { Employee, PcCash, PcReceipt, PcSummaryRow } from '@/lib/types';

type Emp = Pick<Employee, 'id' | 'emp_code' | 'name' | 'job_title' | 'status'>;
interface Draft { employee: string; amount: string; date: string; note: string; given_by: string }

export default function PettyCashPage() {
  const { profile, company, toast } = useApp();
  const canWrite = can(profile!.role, 'pettycash:write');
  const sb = supabase();
  const { data, error, loading, reload } = useQuery(async () => {
    const [emps, sums] = await Promise.all([
      sb.from('employees').select('id, emp_code, name, job_title, status').order('emp_code'),
      sb.rpc('pc_summary'),
    ]);
    return {
      emps: unwrap(emps) as Emp[],
      sums: new Map((unwrap(sums) as PcSummaryRow[]).map((s) => [s.employee_id, s])),
    };
  }, [company?.id]);
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const router = useRouter();
  const fromDash = useRef(false);   // opened by the dashboard shortcut, so cancelling goes back there
  const closeDraft = () => { setDraft(null); if (fromDash.current) { fromDash.current = false; router.push('/adminconsole'); } };

  // dashboard shortcut: /pettycash?new=1 opens the new-transaction dialog straight away
  useEffect(() => {
    if (canWrite && new URLSearchParams(window.location.search).get('new') === '1') {
      setDraft({ employee: '', amount: '', date: today(), note: '', given_by: profile!.full_name });
      fromDash.current = true;
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, [canWrite, profile]);

  // only employees who have had petty cash activity; anyone else is reached through "New transaction"
  const rows = useMemo(() => (data?.emps ?? [])
    .map((e) => ({ e, s: data!.sums.get(e.id) }))
    .filter(({ s }) => s && (s.given > 0 || s.spent > 0 || s.pending_count > 0 || s.rejected_count > 0))
    .filter(({ e }) => `${e.emp_code} ${e.name} ${e.job_title}`.toLowerCase().includes(q.toLowerCase())), [data, q]);

  const tot = useMemo(() => rows.reduce((a, { s }) => ({ given: a.given + (s?.given ?? 0), spent: a.spent + (s?.spent ?? 0), review: a.review + (s?.pending_count ?? 0) }), { given: 0, spent: 0, review: 0 }), [rows]);
  const active = (data?.emps ?? []).filter((e) => e.status === 'active');

  async function save() {
    if (!draft) return;
    const amount = Number(draft.amount);
    if (!draft.employee) return toast('Choose the employee', true);
    if (!(amount > 0)) return toast('Enter the amount given', true);
    if (!draft.given_by.trim()) return toast('Enter who gave the cash', true);
    setSaving(true);
    const { error } = await sb.rpc('pc_give_cash', { p_employee: draft.employee, p_amount: amount, p_date: draft.date, p_note: draft.note, p_given_by: draft.given_by });
    setSaving(false);
    if (error) return toast(error.message, true);
    toast('Cash recorded');
    fromDash.current = false; setDraft(null); reload();
  }

  async function exportXlsx() {
    setExporting(true);
    try {
      const ids = rows.map(({ e }) => e.id);
      const all = async <T,>(table: string, order: string) => {
        const out: T[] = [];
        for (let from = 0; ; from += 1000) {
          const page = unwrap(await sb.from(table).select('*').in('employee_id', ids).order(order).range(from, from + 999)) as T[];
          out.push(...page);
          if (page.length < 1000) return out;
        }
      };
      const [cash, receipts] = await Promise.all([all<PcCash & { employee_id: string }>('pc_cash_given', 'created_at'), all<PcReceipt & { employee_id: string }>('pc_receipts', 'created_at')]);
      const { exportPettyCash } = await import('@/lib/pettyExport');
      await exportPettyCash(rows.map(({ e }) => e), cash, receipts, company?.name ?? '');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Export failed', true);
    }
    setExporting(false);
  }

  return (
    <>
      <PageHead eyebrow="Petty Cash" title="Petty Cash" sub="Cash given to employees, receipts uploaded and what each still holds">
        <button className="btn" disabled={exporting || loading || rows.length === 0} onClick={exportXlsx}>{exporting ? 'Exporting…' : '⬇ Export Excel'}</button>
        {canWrite && <button className="btn primary" onClick={() => setDraft({ employee: '', amount: '', date: today(), note: '', given_by: profile!.full_name })}>＋ New transaction</button>}
      </PageHead>
      {error && <ErrorBox error={error} />}
      <div className="stats">
        <StatCard label="Cash given" icon="＋" value={<Money v={tot.given} />} />
        <StatCard label="Receipts" icon="▤" value={<Money v={tot.spent} />} note="Pending and approved" />
        <StatCard label="Balance held" icon="◉" value={<Money v={tot.given - tot.spent} />} note="Given − receipts" />
        <StatCard label="To review" icon="◔" value={tot.review} note="Receipts waiting for approval" />
      </div>
      <div className="panel flush">
        <div className="panel-head">
          <div className="toolbar">
            <input className="input" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <span className="muted">{rows.length} employees</span>
        </div>
        {loading ? <Loading /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>ID</th><th>Name</th><th className="r">Given</th><th className="r">Receipts</th><th className="r">Balance</th><th>To review</th><th /></tr></thead>
            <tbody>
              {rows.map(({ e, s }) => (
                <tr key={e.id}>
                  <td className="mono">{e.emp_code}</td>
                  <td><Link href={`/adminconsole/pettycash/${e.id}`} className="strong">{e.name}</Link></td>
                  <td className="r"><Money v={s?.given ?? 0} /></td>
                  <td className="r"><Money v={s?.spent ?? 0} /></td>
                  <td className="r"><strong style={{ color: (s?.balance ?? 0) < 0 ? 'var(--red)' : undefined }}><Money v={s?.balance ?? 0} /></strong></td>
                  <td>{s && s.pending_count > 0 ? <Badge tone="gold">{s.pending_count} pending</Badge> : s && s.rejected_count > 0 ? <Badge tone="red">{s.rejected_count} rejected</Badge> : <span className="muted">—</span>}</td>
                  <td style={{ textAlign: 'right' }}><Link className="btn sm" href={`/adminconsole/pettycash/${e.id}`}>Open</Link></td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={7}><div className="empty">No petty cash yet. Use “New transaction” to give cash to an employee.</div></td></tr>}
            </tbody>
          </table></div>
        )}
      </div>

      {draft && (
        <Modal title="New transaction" onClose={closeDraft}
          footer={<><button className="btn" onClick={closeDraft}>Cancel</button><button className="btn primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button></>}>
          <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
            <Field label="Employee">
              <Select className="select" value={draft.employee} onChange={(e) => setDraft({ ...draft, employee: e.target.value })}>
                <option value="">Choose employee…</option>
                {active.map((e) => <option key={e.id} value={e.id}>{e.emp_code} · {e.name}</option>)}
              </Select>
            </Field>
            <Field label="Amount given (SAR)"><input className="input num" type="number" inputMode="decimal" min="0" step="0.01" value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} /></Field>
            <Field label="Date given"><DatePicker value={draft.date} onChange={(v) => setDraft({ ...draft, date: v })} /></Field>
            <Field label="Given by"><input className="input" value={draft.given_by} onChange={(e) => setDraft({ ...draft, given_by: e.target.value })} placeholder="Name of the person who gave the cash" /></Field>
            <Field label="Note (optional)"><input className="input" value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} placeholder="e.g. Site supplies" /></Field>
          </div>
        </Modal>
      )}
    </>
  );
}
