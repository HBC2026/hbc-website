'use client';
import { Fragment, useMemo, useState } from 'react';
import { Money } from '@/components/Money';
import { useApp } from '@/components/Providers';
import { useChart } from '@/components/AccountingBits';
import { DatePicker, ErrorBox, Field, Loading, Modal, PageHead, Select } from '@/components/ui';
import { r2, type Acc } from '@/lib/accounting';
import { useQuery } from '@/lib/hooks';
import { fmtDate, today } from '@/lib/format';
import { can } from '@/lib/roles';
import { supabase, unwrap } from '@/lib/supabase';

interface Line { id: string; account_id: string; debit: number; credit: number; memo: string }
interface Entry { id: string; entry_no: number; entry_date: string; memo: string; reference: string; acc_lines: Line[] }
type Mode = 'receipt' | 'payment' | 'journal';
interface DraftLine { account_id: string; debit: string; credit: string }
interface Draft { id?: string; mode: Mode; date: string; memo: string; ref: string; a1: string; a2: string; amount: string; lines: DraftLine[] }

const blank = (mode: Mode): Draft => ({
  mode, date: today(), memo: '', ref: '', a1: '', a2: '', amount: '',
  lines: [{ account_id: '', debit: '', credit: '' }, { account_id: '', debit: '', credit: '' }],
});
const jeNo = (n: number) => `JE-${String(n).padStart(4, '0')}`;
const num = (s: string) => Number(s) || 0;

export default function JournalPage() {
  const { profile, company, toast, confirmDialog } = useApp();
  const canWrite = can(profile!.role, 'accounting:write');
  const sb = supabase();
  const chart = useChart();
  const accs = chart.data ?? [];
  const byId = useMemo(() => new Map(accs.map((a) => [a.id, a])), [accs]);

  const { data, error, loading, reload } = useQuery(async () =>
    unwrap(await sb.from('acc_entries').select('id, entry_no, entry_date, memo, reference, acc_lines(id, account_id, debit, credit, memo)')
      .order('entry_date', { ascending: false }).order('entry_no', { ascending: false }).limit(300)) as Entry[],
  [company?.id]);

  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  const label = (id: string) => { const a = byId.get(id); return a ? `${a.code} · ${a.name}` : '—'; };
  const rows = useMemo(() => (data ?? []).filter((e) => {
    const t = q.trim().toLowerCase();
    return !t || `${jeNo(e.entry_no)} ${e.memo} ${e.reference} ${e.acc_lines.map((l) => label(l.account_id)).join(' ')}`.toLowerCase().includes(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [data, q, byId]);

  const active = accs.filter((a) => a.is_active);
  const opts = (list: Acc[]) => list.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>);

  function edit(e: Entry) {
    setDraft({
      id: e.id, mode: 'journal', date: e.entry_date, memo: e.memo, ref: e.reference, a1: '', a2: '', amount: '',
      lines: e.acc_lines.map((l) => ({ account_id: l.account_id, debit: l.debit ? String(l.debit) : '', credit: l.credit ? String(l.credit) : '' })),
    });
  }

  const dr = draft ? r2(draft.lines.reduce((s, l) => s + num(l.debit), 0)) : 0;
  const cr = draft ? r2(draft.lines.reduce((s, l) => s + num(l.credit), 0)) : 0;

  async function save() {
    if (!draft) return;
    let lines: { account_id: string; debit: number; credit: number }[];
    if (draft.mode === 'journal') {
      lines = draft.lines.filter((l) => num(l.debit) || num(l.credit)).map((l) => ({ account_id: l.account_id, debit: num(l.debit), credit: num(l.credit) }));
      if (lines.some((l) => !l.account_id)) return toast('Choose an account on every line', true);
      if (dr !== cr) return toast('Debits and credits must be equal', true);
    } else {
      const amount = num(draft.amount);
      if (!draft.a1 || !draft.a2) return toast('Choose both accounts', true);
      if (draft.a1 === draft.a2) return toast('The two accounts must be different', true);
      if (!(amount > 0)) return toast('Enter the amount', true);
      lines = draft.mode === 'receipt'
        ? [{ account_id: draft.a1, debit: amount, credit: 0 }, { account_id: draft.a2, debit: 0, credit: amount }]
        : [{ account_id: draft.a2, debit: amount, credit: 0 }, { account_id: draft.a1, debit: 0, credit: amount }];
    }
    if (lines.length < 2) return toast('An entry needs at least two lines', true);
    setSaving(true);
    const { error } = await sb.rpc('acc_post_entry', { p_id: draft.id ?? null, p_date: draft.date, p_memo: draft.memo, p_ref: draft.ref, p_lines: lines });
    setSaving(false);
    if (error) return toast(error.message, true);
    toast(draft.id ? 'Entry updated' : 'Entry posted');
    setDraft(null); reload();
  }

  async function remove(e: Entry) {
    if (!(await confirmDialog({ title: 'Delete entry', message: `Delete ${jeNo(e.entry_no)}? It will no longer appear in any report.`, confirmLabel: 'Delete', danger: true }))) return;
    const { error } = await sb.rpc('acc_delete_entry', { p_id: e.id });
    if (error) return toast(error.message, true);
    toast('Entry deleted'); reload();
  }

  const setLine = (i: number, patch: Partial<DraftLine>) => setDraft((d) => d && ({ ...d, lines: d.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));

  return (
    <>
      <PageHead eyebrow="Accounting" title="Journal" sub="Every money movement as a balanced entry. Reports are built from these.">
        {canWrite && <>
          <button className="btn" onClick={() => setDraft(blank('journal'))}>＋ Journal entry</button>
          <button className="btn" onClick={() => setDraft(blank('payment'))}>− Payment</button>
          <button className="btn primary" onClick={() => setDraft(blank('receipt'))}>＋ Money received</button>
        </>}
      </PageHead>
      {(error || chart.error) && <ErrorBox error={(error || chart.error)!} />}

      <div className="panel flush">
        <div className="panel-head">
          <div className="toolbar"><input className="input" placeholder="Search entries, accounts, references…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <span className="muted">{rows.length} entries{(data?.length ?? 0) >= 300 ? ' (latest 300)' : ''}</span>
        </div>
        {loading || chart.loading ? <Loading /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>No.</th><th>Date</th><th>Description</th><th>Reference</th><th className="r">Amount</th><th /></tr></thead>
            <tbody>
              {rows.map((e) => {
                const amt = e.acc_lines.reduce((s, l) => s + Number(l.debit), 0);
                const isOpen = open === e.id;
                return (
                  <Fragment key={e.id}>
                    <tr>
                      <td className="mono strong"><a href="#" onClick={(ev) => { ev.preventDefault(); setOpen(isOpen ? null : e.id); }}>{jeNo(e.entry_no)}</a></td>
                      <td>{fmtDate(e.entry_date)}</td>
                      <td>{e.memo || <span className="muted">—</span>}</td>
                      <td>{e.reference || <span className="muted">—</span>}</td>
                      <td className="r"><Money v={amt} /></td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {canWrite && <><button className="btn sm" onClick={() => edit(e)}>Edit</button>{' '}<button className="btn sm danger" onClick={() => remove(e)}>Delete</button></>}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr><td colSpan={6} style={{ background: '#f8fafc' }}>
                        <table className="table sheet je-lines" style={{ width: '100%' }}>
                          <thead><tr><th>Account</th><th className="r">Debit</th><th className="r">Credit</th></tr></thead>
                          <tbody>{e.acc_lines.map((l) => (
                            <tr key={l.id}><td>{label(l.account_id)}</td><td className="r">{Number(l.debit) ? <Money v={l.debit} /> : ''}</td><td className="r">{Number(l.credit) ? <Money v={l.credit} /> : ''}</td></tr>
                          ))}</tbody>
                        </table>
                      </td></tr>
                    )}
                  </Fragment>
                );
              })}
              {rows.length === 0 && <tr><td colSpan={6}><div className="empty">No entries yet. Start with “Journal entry” to record opening balances, then add payments and money received.</div></td></tr>}
            </tbody>
          </table></div>
        )}
      </div>

      {draft && (
        <Modal title={draft.id ? `Edit ${jeNo(data?.find((e) => e.id === draft.id)?.entry_no ?? 0)}` : draft.mode === 'receipt' ? 'Money received' : draft.mode === 'payment' ? 'Payment' : 'Journal entry'}
          wide={draft.mode === 'journal'} onClose={() => setDraft(null)}
          footer={<><button className="btn" onClick={() => setDraft(null)}>Cancel</button><button className="btn primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Post entry'}</button></>}>
          <div className="form-grid" style={{ gridTemplateColumns: draft.mode === 'journal' ? '1fr 1fr 1fr' : '1fr' }}>
            <Field label="Date"><DatePicker value={draft.date} onChange={(v) => setDraft({ ...draft, date: v })} /></Field>
            <Field label="Reference (invoice / voucher no.)"><input className="input" value={draft.ref} onChange={(e) => setDraft({ ...draft, ref: e.target.value })} /></Field>
            <Field label="Description"><input className="input" value={draft.memo} onChange={(e) => setDraft({ ...draft, memo: e.target.value })} placeholder="What is this for?" /></Field>

            {draft.mode !== 'journal' && <>
              <Field label={draft.mode === 'receipt' ? 'Received into (cash / bank)' : 'Paid from (cash / bank)'}>
                <Select value={draft.a1} onChange={(e) => setDraft({ ...draft, a1: e.target.value })}>
                  <option value="">Choose account…</option>{opts(active.filter((a) => a.type === 'asset'))}
                </Select>
              </Field>
              <Field label={draft.mode === 'receipt' ? 'Received for (revenue, receivable, loan…)' : 'Paid for (expense, payable, asset…)'}>
                <Select value={draft.a2} onChange={(e) => setDraft({ ...draft, a2: e.target.value })}>
                  <option value="">Choose account…</option>{opts(active)}
                </Select>
              </Field>
              <Field label="Amount (SAR)"><input className="input num" type="number" inputMode="decimal" min="0" step="0.01" value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} /></Field>
            </>}
          </div>

          {draft.mode === 'journal' && (
            <div style={{ marginTop: 16 }}>
              <table className="table sheet je-lines" style={{ width: '100%' }}>
                <thead><tr><th>Account</th><th className="r" style={{ width: 130 }}>Debit</th><th className="r" style={{ width: 130 }}>Credit</th><th style={{ width: 30 }} /></tr></thead>
                <tbody>
                  {draft.lines.map((l, i) => (
                    <tr key={i}>
                      <td><Select value={l.account_id} onChange={(e) => setLine(i, { account_id: e.target.value })}><option value="">Choose account…</option>{opts(active)}</Select></td>
                      <td><input className="input num" style={{ width: '100%' }} type="number" min="0" step="0.01" value={l.debit} onChange={(e) => setLine(i, { debit: e.target.value, credit: e.target.value ? '' : l.credit })} /></td>
                      <td><input className="input num" style={{ width: '100%' }} type="number" min="0" step="0.01" value={l.credit} onChange={(e) => setLine(i, { credit: e.target.value, debit: e.target.value ? '' : l.debit })} /></td>
                      <td>{draft.lines.length > 2 && <button className="btn sm danger" aria-label="Remove line" onClick={() => setDraft({ ...draft, lines: draft.lines.filter((_, j) => j !== i) })}>×</button>}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr>
                  <td><button className="btn sm" onClick={() => setDraft({ ...draft, lines: [...draft.lines, { account_id: '', debit: dr < cr ? String(r2(cr - dr)) : '', credit: cr < dr ? String(r2(dr - cr)) : '' }] })}>＋ Add line</button></td>
                  <td className="r strong"><Money v={dr} /></td><td className="r strong"><Money v={cr} /></td><td />
                </tr></tfoot>
              </table>
              <p className={dr === cr && dr > 0 ? 'acc-balanced' : 'acc-unbalanced'} style={{ marginTop: 10, fontSize: 12 }}>
                {dr === cr && dr > 0 ? 'Balanced' : dr === cr ? 'Enter amounts' : <>Out of balance by <Money v={Math.abs(r2(dr - cr))} /></>}
              </p>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
