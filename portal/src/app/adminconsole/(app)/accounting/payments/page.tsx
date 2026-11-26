'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Money } from '@/components/Money';
import { useApp } from '@/components/Providers';
import { useChart, useVendorPayments, useVendors } from '@/components/AccountingBits';
import { DatePicker, ErrorBox, Field, Loading, Modal, PageHead, Select } from '@/components/ui';
import { paymentAmount, r2, type VendorPayment } from '@/lib/accounting';
import { fmtDate, today } from '@/lib/format';
import { can } from '@/lib/roles';
import { supabase } from '@/lib/supabase';

interface Draft { id?: string; vendor: string; date: string; from: string; for: string; amount: string; ref: string; memo: string }

export default function PaymentsPage() {
  const { profile, toast, confirmDialog } = useApp();
  const canWrite = can(profile!.role, 'accounting:write');
  const chart = useChart();
  const vendors = useVendors();
  const payments = useVendorPayments();
  const [vendorId, setVendorId] = useState('');
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  // the Vendors page links here with ?vendor=<id>
  useEffect(() => { setVendorId(new URLSearchParams(window.location.search).get('vendor') ?? ''); }, []);

  const accs = chart.data ?? [];
  const accById = useMemo(() => new Map((chart.data ?? []).map((a) => [a.id, a])), [chart.data]);
  const venById = useMemo(() => new Map((vendors.data ?? []).map((v) => [v.id, v])), [vendors.data]);
  const accLabel = (id: string) => { const a = accById.get(id); return a ? `${a.code} · ${a.name}` : '—'; };
  const paidFrom = (p: VendorPayment) => p.acc_lines.find((l) => Number(l.credit))?.account_id ?? '';
  const paidFor = (p: VendorPayment) => p.acc_lines.find((l) => Number(l.debit))?.account_id ?? '';

  const t = q.trim().toLowerCase();
  const rows = (payments.data ?? []).filter((p) =>
    (!vendorId || p.vendor_id === vendorId) &&
    (!t || `${venById.get(p.vendor_id)?.name ?? ''} ${p.memo} ${p.reference} ${accLabel(paidFor(p))}`.toLowerCase().includes(t)));
  const total = r2(rows.reduce((s, p) => s + paymentAmount(p), 0));

  const add = () => setDraft({
    vendor: venById.get(vendorId)?.is_active ? vendorId : '', date: today(),
    from: accs.find((a) => a.code === '1010' && a.is_active)?.id ?? '', for: '', amount: '', ref: '', memo: '',
  });
  const edit = (p: VendorPayment) => setDraft({
    id: p.id, vendor: p.vendor_id, date: p.entry_date, from: paidFrom(p), for: paidFor(p),
    amount: String(paymentAmount(p)), ref: p.reference, memo: p.memo,
  });

  async function save() {
    if (!draft) return;
    if (!draft.vendor) return toast('Choose a vendor', true);
    if (!draft.date) return toast('Enter the date', true);
    if (!draft.from || !draft.for) return toast('Choose both accounts', true);
    if (!(Number(draft.amount) > 0)) return toast('Enter the amount', true);
    setSaving(true);
    const { error } = await supabase().rpc('acc_save_payment', {
      p_id: draft.id ?? null, p_vendor: draft.vendor, p_date: draft.date, p_from: draft.from, p_for: draft.for,
      p_amount: Number(draft.amount), p_ref: draft.ref, p_memo: draft.memo,
    });
    setSaving(false);
    if (error) return toast(error.message, true);
    toast(draft.id ? 'Payment updated' : 'Payment recorded'); setDraft(null); payments.reload();
  }

  async function remove(p: VendorPayment) {
    if (!(await confirmDialog({ title: 'Delete payment', message: `Delete the payment to ${venById.get(p.vendor_id)?.name ?? 'this vendor'} dated ${fmtDate(p.entry_date)}? It is also removed from the Journal and the reports.`, confirmLabel: 'Delete', danger: true }))) return;
    const { error } = await supabase().rpc('acc_delete_entry', { p_id: p.id });
    if (error) return toast(error.message, true);
    toast('Payment deleted'); payments.reload();
  }

  const err = chart.error || vendors.error || payments.error;
  const loading = chart.loading || vendors.loading || payments.loading;
  const noVendors = !vendors.loading && !vendors.error && (vendors.data?.length ?? 0) === 0;

  return (
    <>
      <PageHead eyebrow="Accounting" title="Payments" sub="Money paid to vendors. Each payment is posted to the Journal.">
        {canWrite && !noVendors && <button className="btn primary" disabled={loading} onClick={add}>＋ New payment</button>}
      </PageHead>
      {err && <ErrorBox error={err} />}

      <div className="panel flush">
        <div className="panel-head">
          <div className="toolbar">
            <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
              <option value="">All vendors</option>
              {(vendors.data ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </Select>
            <input className="input" placeholder="Search payments…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div><span className="muted">Total </span><strong><Money v={total} /></strong></div>
        </div>
        {loading ? <Loading /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Date</th><th>Vendor</th><th>Description</th><th>Reference</th><th>Paid from</th><th>Paid for</th><th className="r">Amount</th><th /></tr></thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td>{fmtDate(p.entry_date)}</td>
                  <td className="strong">{venById.get(p.vendor_id)?.name ?? '—'}</td>
                  <td>{p.memo || <span className="muted">—</span>}</td>
                  <td>{p.reference || <span className="muted">—</span>}</td>
                  <td className="muted">{p.acc_lines.length > 2 ? '-Split-' : accLabel(paidFrom(p))}</td>
                  <td className="muted">{p.acc_lines.length > 2 ? '-Split-' : accLabel(paidFor(p))}</td>
                  <td className="r"><Money v={paymentAmount(p)} /></td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {canWrite && <>
                      {/* a payment split into more lines in the Journal is edited there */}
                      {p.acc_lines.length === 2 && <button className="btn sm" onClick={() => edit(p)}>Edit</button>}{' '}
                      <button className="btn sm danger" onClick={() => remove(p)}>Delete</button>
                    </>}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={8}><div className="empty">
                {noVendors ? <>Add a vendor first on the <Link href="/adminconsole/accounting/vendors" className="strong">Vendors</Link> page.</> : 'No payments to show.'}
              </div></td></tr>}
            </tbody>
          </table></div>
        )}
      </div>

      {draft && (
        <Modal title={draft.id ? 'Edit payment' : 'New payment'} onClose={() => setDraft(null)}
          footer={<><button className="btn" onClick={() => setDraft(null)}>Cancel</button><button className="btn primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save payment'}</button></>}>
          <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
            <Field label="Vendor">
              <Select value={draft.vendor} onChange={(e) => setDraft({ ...draft, vendor: e.target.value })}>
                <option value="">Choose vendor…</option>
                {(vendors.data ?? []).filter((v) => v.is_active || v.id === draft.vendor).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </Select>
            </Field>
            <Field label="Date"><DatePicker value={draft.date} onChange={(v) => setDraft({ ...draft, date: v })} /></Field>
            <Field label="Amount (SAR)"><input className="input num" type="number" inputMode="decimal" min="0" step="0.01" value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} /></Field>
            <Field label="Paid from (cash / bank)">
              <Select value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })}>
                <option value="">Choose account…</option>
                {accs.filter((a) => a.is_active && a.type === 'asset').map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
              </Select>
            </Field>
            <Field label="Paid for (materials, subcontractor, rent…)">
              <Select value={draft.for} onChange={(e) => setDraft({ ...draft, for: e.target.value })}>
                <option value="">Choose account…</option>
                {accs.filter((a) => a.is_active && a.id !== draft.from).map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
              </Select>
            </Field>
            <Field label="Reference (invoice / cheque no.)"><input className="input" value={draft.ref} onChange={(e) => setDraft({ ...draft, ref: e.target.value })} /></Field>
            <Field label="Description"><input className="input" value={draft.memo} onChange={(e) => setDraft({ ...draft, memo: e.target.value })} placeholder="What is this for?" /></Field>
          </div>
        </Modal>
      )}
    </>
  );
}
