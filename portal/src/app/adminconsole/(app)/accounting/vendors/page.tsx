'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Money } from '@/components/Money';
import { useApp } from '@/components/Providers';
import { useVendorPayments, useVendors } from '@/components/AccountingBits';
import { Badge, ErrorBox, Field, Loading, Modal, PageHead } from '@/components/ui';
import { paymentAmount, r2, type Vendor } from '@/lib/accounting';
import { can } from '@/lib/roles';
import { supabase } from '@/lib/supabase';

type Draft = Omit<Vendor, 'id'> & { id?: string };
const blank: Draft = { name: '', phone: '', vat_no: '', notes: '', is_active: true };

export default function VendorsPage() {
  const { profile, toast } = useApp();
  const canWrite = can(profile!.role, 'accounting:write');
  const vendors = useVendors();
  const payments = useVendorPayments();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [q, setQ] = useState('');
  const [showInactive, setShowInactive] = useState(false);

  const paid = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of payments.data ?? []) m.set(p.vendor_id, r2((m.get(p.vendor_id) ?? 0) + paymentAmount(p)));
    return m;
  }, [payments.data]);

  const t = q.trim().toLowerCase();
  const rows = (vendors.data ?? []).filter((v) =>
    (showInactive || v.is_active) && (!t || `${v.name} ${v.phone} ${v.vat_no} ${v.notes}`.toLowerCase().includes(t)));

  async function save() {
    if (!draft) return;
    if (!draft.name.trim()) return toast('Enter the vendor name', true);
    setSaving(true);
    const { error } = await supabase().rpc('acc_save_vendor', { p_id: draft.id ?? null, p_name: draft.name, p_phone: draft.phone, p_vat_no: draft.vat_no, p_notes: draft.notes, p_active: draft.is_active });
    setSaving(false);
    if (error) return toast(error.message, true);
    toast('Vendor saved'); setDraft(null); vendors.reload();
  }

  const err = vendors.error || payments.error;

  return (
    <>
      <PageHead eyebrow="Accounting" title="Vendors" sub="Suppliers and subcontractors you pay">
        <label className="muted" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive
        </label>
        {canWrite && <button className="btn primary" onClick={() => setDraft(blank)}>＋ New vendor</button>}
      </PageHead>
      {err && <ErrorBox error={err} />}

      <div className="panel flush">
        <div className="panel-head">
          <div className="toolbar"><input className="input" placeholder="Search vendors…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <span className="muted">{rows.length} vendors</span>
        </div>
        {vendors.loading || payments.loading ? <Loading /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Vendor</th><th>Phone</th><th>VAT no.</th><th>Notes</th><th className="r">Total paid</th><th /></tr></thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.id}>
                  <td className="strong">{v.name} {!v.is_active && <Badge>Inactive</Badge>}</td>
                  <td>{v.phone || <span className="muted">—</span>}</td>
                  <td className="mono">{v.vat_no || <span className="muted">—</span>}</td>
                  <td>{v.notes || <span className="muted">—</span>}</td>
                  <td className="r"><Money v={paid.get(v.id) ?? 0} /></td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <Link className="btn sm" href={`/adminconsole/accounting/payments?vendor=${v.id}`}>Payments</Link>{' '}
                    {canWrite && <button className="btn sm" onClick={() => setDraft(v)}>Edit</button>}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={6}><div className="empty">No vendors to show.{canWrite ? ' Add one with “New vendor”.' : ''}</div></td></tr>}
            </tbody>
          </table></div>
        )}
      </div>

      {draft && (
        <Modal title={draft.id ? 'Edit vendor' : 'New vendor'} onClose={() => setDraft(null)}
          footer={<><button className="btn" onClick={() => setDraft(null)}>Cancel</button><button className="btn primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button></>}>
          <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
            <Field label="Name"><input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
            <Field label="Phone"><input className="input" value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} /></Field>
            <Field label="VAT number"><input className="input" value={draft.vat_no} onChange={(e) => setDraft({ ...draft, vat_no: e.target.value })} /></Field>
            <Field label="Notes"><input className="input" value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} placeholder="Bank details, what they supply…" /></Field>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
              <input type="checkbox" checked={draft.is_active} onChange={(e) => setDraft({ ...draft, is_active: e.target.checked })} /> Active (can receive new payments)
            </label>
          </div>
        </Modal>
      )}
    </>
  );
}
