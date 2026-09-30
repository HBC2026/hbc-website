'use client';
import { useRouter } from 'next/navigation';
import { Money, Riyal } from '@/components/Money';
import { useMemo, useState } from 'react';
import { useApp } from './Providers';
import { DatePicker, Field, SuggestInput } from './ui';
import { fmtNum, today } from '@/lib/format';
import { supabase } from '@/lib/supabase';
import type { QuotationItem, QuotationRevision } from '@/lib/types';

const UNITS = ['Nos', 'Lot', 'm', 'm2', 'm3', 'kg', 'ton', 'Hour', 'Day', 'Man-month', 'Visit'];
interface ItemDraft { description: string; qty: string; unit: string; unit_price: string }
const blank = (): ItemDraft => ({ description: '', qty: '1', unit: 'Nos', unit_price: '' });

export function QuotationForm({ quotationId, base, items: baseItems }: { quotationId?: string; base?: QuotationRevision; items?: QuotationItem[] }) {
  const { settings, toast } = useApp();
  const router = useRouter();
  const revising = !!quotationId;
  const [f, setF] = useState({
    client: base?.client ?? '', attention: base?.attention ?? '', project: base?.project ?? '', quote_date: base ? today() : today(),
    validity_days: String(base?.validity_days ?? 30), reference: base?.reference ?? '',
    discount: String(Number(base?.discount ?? 0)), vat_pct: String(Number(base?.vat_rate ?? settings.vat_rate) * 100),
    payment_terms: base?.payment_terms ?? '', delivery: base?.delivery ?? '', notes: base?.notes ?? '', revision_note: '',
  });
  const [items, setItems] = useState<ItemDraft[]>(baseItems?.length
    ? baseItems.map((i) => ({ description: i.description, qty: String(Number(i.qty)), unit: i.unit, unit_price: String(Number(i.unit_price)) })) : [blank()]);
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));
  const setItem = (i: number, k: keyof ItemDraft, v: string) => setItems((a) => a.map((x, j) => (j === i ? { ...x, [k]: v } : x)));

  const t = useMemo(() => {
    const subtotal = items.reduce((s, i) => s + Math.round((Number(i.qty) || 0) * (Number(i.unit_price) || 0) * 100) / 100, 0);
    const discount = Number(f.discount) || 0;
    const vat = Math.round((subtotal - discount) * (Number(f.vat_pct) || 0)) / 100;
    return { subtotal, discount, vat, grand: subtotal - discount + vat };
  }, [items, f.discount, f.vat_pct]);

  async function save() {
    if (!f.client.trim()) return toast('Client is required', true);
    const clean = items.filter((i) => i.description.trim() || i.unit_price);
    if (!clean.length) return toast('Add at least one line item', true);
    if (clean.some((i) => !i.description.trim() || !(Number(i.qty) > 0) || i.unit_price === '' || Number(i.unit_price) < 0)) return toast('Each line needs a description, a quantity above zero and a unit price', true);
    if (t.discount < 0 || t.discount > t.subtotal) return toast('Discount must be between 0 and the subtotal', true);
    const payload = {
      client: f.client, attention: f.attention, project: f.project, quote_date: f.quote_date, validity_days: Number(f.validity_days) || 30,
      reference: f.reference, discount: t.discount, vat_rate: (Number(f.vat_pct) || 0) / 100, payment_terms: f.payment_terms, delivery: f.delivery,
      notes: f.notes, revision_note: f.revision_note,
      items: clean.map((i) => ({ description: i.description, qty: Number(i.qty), unit: i.unit, unit_price: Number(i.unit_price) })),
    };
    setSaving(true);
    const sb = supabase();
    const res = revising ? await sb.rpc('revise_quotation', { p_id: quotationId, p: payload }) : await sb.rpc('create_quotation', { p: payload });
    setSaving(false);
    if (res.error) return toast(res.error.message, true);
    toast(revising ? `Revision R${res.data} saved — previous version kept` : 'Quotation created');
    router.push(`/adminconsole/quotations/${revising ? quotationId : res.data}`);
  }

  return (
    <div className="stack">
      <div className="panel">
        <div className="panel-title">Quotation details</div>
        <div className="form-grid">
          <Field label="Client *" className="span-2"><input className="input" value={f.client} onChange={(e) => set('client', e.target.value)} /></Field>
          <Field label="Attention"><input className="input" value={f.attention} onChange={(e) => set('attention', e.target.value)} /></Field>
          <Field label="Project" className="span-2"><input className="input" value={f.project} onChange={(e) => set('project', e.target.value)} /></Field>
          <Field label="Reference"><input className="input" value={f.reference} onChange={(e) => set('reference', e.target.value)} placeholder="Client RFQ / enquiry no." /></Field>
          <Field label="Date"><DatePicker value={f.quote_date} onChange={(v) => set('quote_date', v)} /></Field>
          <Field label="Validity (days)"><input className="input num" type="number" min="1" value={f.validity_days} onChange={(e) => set('validity_days', e.target.value)} /></Field>
        </div>
      </div>

      <div className="panel flush">
        <div className="panel-head"><div className="panel-title">Line items</div><button className="btn sm" onClick={() => setItems((a) => [...a, blank()])}>＋ Add line</button></div>
        <div className="table-wrap"><table className="table">
          <thead><tr><th style={{ width: 30 }}>#</th><th>Description</th><th className="r" style={{ width: 90 }}>Qty</th><th style={{ width: 120 }}>Unit</th><th className="r" style={{ width: 130 }}>Unit Price</th><th className="r" style={{ width: 130 }}>Total</th><th style={{ width: 40 }} /></tr></thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={i}>
                <td className="muted">{i + 1}</td>
                <td><input className="input" style={{ width: '100%' }} value={it.description} onChange={(e) => setItem(i, 'description', e.target.value)} placeholder="Item / scope description" /></td>
                <td className="r"><input className="input num" type="number" min="0" step="0.001" style={{ width: 80 }} value={it.qty} onChange={(e) => setItem(i, 'qty', e.target.value)} /></td>
                <td><SuggestInput options={UNITS} style={{ width: 110 }} value={it.unit} onChange={(v) => setItem(i, 'unit', v)} /></td>
                <td className="r"><input className="input num" type="number" min="0" step="0.01" style={{ width: 120 }} value={it.unit_price} onChange={(e) => setItem(i, 'unit_price', e.target.value)} /></td>
                <td className="r strong">{fmtNum((Number(it.qty) || 0) * (Number(it.unit_price) || 0))}</td>
                <td><button className="btn sm danger" aria-label="Remove line" disabled={items.length === 1} onClick={() => setItems((a) => a.filter((_, j) => j !== i))}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table></div>
        <div style={{ padding: 22, display: 'flex', justifyContent: 'flex-end' }}>
          <div className="kv" style={{ width: 340 }}>
            <span className="k">Subtotal</span><span className="v">{<Money v={t.subtotal} />}</span>
            <span className="k">Discount (<Riyal />)</span><span className="v"><input className="input num" style={{ width: 120 }} type="number" min="0" step="0.01" value={f.discount} onChange={(e) => set('discount', e.target.value)} /></span>
            <span className="k">VAT %</span><span className="v"><input className="input num" style={{ width: 120 }} type="number" min="0" step="0.01" value={f.vat_pct} onChange={(e) => set('vat_pct', e.target.value)} /></span>
            <span className="k">VAT amount</span><span className="v">{<Money v={t.vat} />}</span>
            <div className="sep" />
            <span className="k tot">Grand Total</span><span className="v tot">{<Money v={t.grand} />}</span>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="form-grid">
          <Field label="Payment terms" className="span-3"><textarea className="textarea" value={f.payment_terms} onChange={(e) => set('payment_terms', e.target.value)} /></Field>
          <Field label="Delivery" className="span-3"><textarea className="textarea" style={{ minHeight: 50 }} value={f.delivery} onChange={(e) => set('delivery', e.target.value)} /></Field>
          <Field label="Notes" className="span-3"><textarea className="textarea" value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
          {revising && <Field label="Revision note (what changed?)" className="span-3"><input className="input" value={f.revision_note} onChange={(e) => set('revision_note', e.target.value)} /></Field>}
        </div>
      </div>

      <div className="toolbar" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={() => router.back()}>Cancel</button>
        <button className="btn primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : revising ? 'Save as new revision' : 'Create quotation'}</button>
      </div>
    </div>
  );
}
