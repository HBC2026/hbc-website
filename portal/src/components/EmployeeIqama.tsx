'use client';
import { useState } from 'react';
import { useApp } from './Providers';
import { IqamaExpiry } from './IqamaExpiry';
import { Money, Riyal } from './Money';
import { DatePicker, ErrorBox, Field, Loading, Modal } from './ui';
import { useQuery } from '@/lib/hooks';
import { fmtDate, today } from '@/lib/format';
import { supabase, unwrap } from '@/lib/supabase';
import type { Employee, EmployeeRenewal, RenewalItem } from '@/lib/types';

const ITEMS: { key: RenewalItem; label: string; expiry: (e: Employee) => string | null }[] = [
  { key: 'work_permit', label: 'Work Permit', expiry: (e) => e.work_permit_expiry_date },
  { key: 'iqama', label: 'Iqama', expiry: (e) => e.iqama_expiry_date },
  { key: 'tamin', label: 'Tamin (Insurance)', expiry: (e) => e.tamin_expiry_date },
];
const itemLabel = (k: RenewalItem) => ITEMS.find((i) => i.key === k)!.label;

/** Newest payment first. */
const loadRenewals = async (employeeId: string) =>
  unwrap(await supabase().from('employee_renewals').select('*').eq('employee_id', employeeId)
    .order('paid_date', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false })) as EmployeeRenewal[];

type Draft = { item: RenewalItem; expiry_date: string; fee_paid: string; paid_date: string; note: string };

/** Iqama section of the employee profile: current expiry dates and Renew actions. Fees are listed in the Renewal History tab. */
export function EmployeeIqama({ employee: e, canWrite, onChanged }: {
  employee: Employee; canWrite: boolean; onChanged: () => void;
}) {
  const { toast } = useApp();
  const sb = supabase();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (k: keyof Draft, v: string) => setDraft((d) => d && { ...d, [k]: v });

  const add = (item: RenewalItem) => setDraft({ item, expiry_date: '', fee_paid: '', paid_date: today(), note: '' });

  async function save() {
    if (!draft) return;
    const fee = draft.fee_paid.trim();
    if (!draft.expiry_date && !fee) return toast('Enter a new expiry date or the fee paid', true);
    if (fee && !(Number(fee) >= 0)) return toast('Fee paid cannot be negative', true);
    if (fee && !draft.paid_date) return toast('Choose the date the fee was paid', true);
    setSaving(true);
    const { error } = await sb.from('employee_renewals').insert({
      employee_id: e.id, item: draft.item, expiry_date: draft.expiry_date || null,
      fee_paid: fee ? Number(fee) : null, paid_date: fee ? draft.paid_date : null, note: draft.note.trim(),
    });
    setSaving(false);
    if (error) return toast(error.message, true);
    toast(`${itemLabel(draft.item)} recorded`);
    setDraft(null); onChanged();
  }

  return (
    <>
      <div className="panel info-strip permits">
        <div className="form-section-title">Work permit, Iqama &amp; Tamin</div>
        {ITEMS.map((i) => (
            <div key={i.key} className="compliance-row">
              <div className="info-grid">
                <div><div className="stat-label">{i.label} expiry</div><div><IqamaExpiry date={i.expiry(e)} /></div></div>
                {i.key === 'iqama' && <>
                  <div><div className="stat-label">Iqama / ID number</div><div className="mono">{e.iqama_no || '—'}</div></div>
                  <div><div className="stat-label">Iqama issue date</div><div>{fmtDate(e.iqama_issue_date)}</div></div>
                </>}
              </div>
              {canWrite && <button className="btn sm" aria-label={`Renew ${i.label}`} onClick={() => add(i.key)}>Renew</button>}
            </div>
        ))}
      </div>

      {draft && (
        <Modal title={`Renew ${itemLabel(draft.item)} · ${e.name}`} wide onClose={() => setDraft(null)}
          footer={<><button className="btn" onClick={() => setDraft(null)}>Cancel</button><button className="btn primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button></>}>
          <div className="form-grid">
            <Field label="New expiry date"><DatePicker value={draft.expiry_date} onChange={(v) => set('expiry_date', v)} /></Field>
            <Field label={<>Fee paid (<Riyal />)</>}><input className="input num" type="number" min="0" step="0.01" value={draft.fee_paid} onChange={(ev) => set('fee_paid', ev.target.value)} /></Field>
            <Field label="Paid on"><DatePicker value={draft.paid_date} onChange={(v) => set('paid_date', v)} /></Field>
            <Field label="Note (optional)" className="span-2"><input className="input" value={draft.note} onChange={(ev) => set('note', ev.target.value)} /></Field>
          </div>
          <div className="muted" style={{ marginTop: 12, fontSize: 12 }}>A newer expiry date updates the employee's current date. Leave it blank to record a fee only.</div>
        </Modal>
      )}
    </>
  );
}

/** Renewal / fee history tab on the employee profile (payroll-side roles only). */
export function EmployeeRenewalHistory({ employeeId, canWrite, onChanged }: {
  employeeId: string; canWrite: boolean; onChanged: () => void;
}) {
  const { toast, confirmDialog } = useApp();
  const history = useQuery(() => loadRenewals(employeeId), [employeeId]);
  const rows = history.data ?? [];

  async function remove(r: EmployeeRenewal) {
    if (!(await confirmDialog({
      title: 'Delete history entry?',
      message: `Delete this ${itemLabel(r.item)} entry? If it set the current expiry date, the earlier date is restored. This cannot be undone.`,
      confirmLabel: 'Delete', danger: true,
    }))) return;
    const { error } = await supabase().from('employee_renewals').delete().eq('id', r.id);
    if (error) return toast(error.message, true);
    toast('Entry deleted'); history.reload(); onChanged();
  }

  return (
    <div className="panel flush">
      {history.error && <ErrorBox error={history.error} />}
      {history.loading ? <Loading /> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Item</th><th>New expiry</th><th className="r">Fee paid</th><th>Paid on</th><th>Note</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td data-label="Item">{itemLabel(r.item)}</td>
                <td data-label="New expiry">{r.expiry_date ? fmtDate(r.expiry_date) : '—'}</td>
                <td data-label="Fee paid" className="r">{r.fee_paid != null ? <Money v={r.fee_paid} /> : '—'}</td>
                <td data-label="Paid on">{r.paid_date ? fmtDate(r.paid_date) : '—'}</td>
                <td data-label="Note" className="muted">{r.note}</td>
                <td style={{ textAlign: 'right' }}>{canWrite && <button className="btn sm danger" onClick={() => remove(r)}>Delete</button>}</td>
              </tr>
            ))}
            {rows.length === 0 && !history.error && <tr><td colSpan={6}><div className="empty">No renewals or fees recorded yet.</div></td></tr>}
          </tbody>
        </table></div>
      )}
    </div>
  );
}
