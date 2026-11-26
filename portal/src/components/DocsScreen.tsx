'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Money } from '@/components/Money';
import { useApp } from '@/components/Providers';
import { useChart, useDocs, useParties } from '@/components/AccountingBits';
import { Badge, DatePicker, ErrorBox, Field, Loading, Modal, PageHead, Select, StatCard, Tabs } from '@/components/ui';
import { docBalance, docNo, docStatus, docTotals, r2, type Acc, type AccDoc, type DocKind, type DocStatus } from '@/lib/accounting';
import { addDays, fmtDate, today } from '@/lib/format';
import { can } from '@/lib/roles';
import { supabase, unwrap } from '@/lib/supabase';

const WORDS = {
  invoice: {
    title: 'Invoices', one: 'invoice', One: 'Invoice', party: 'Client', parties: '/adminconsole/clients',
    sub: 'What clients owe the company. Each invoice is posted to the Journal. These are accounting records, not ZATCA tax invoices.',
    pay: 'Receive payment', paid: 'Received', into: 'Deposit to (cash / bank)', control: 'Receivable account', lineAccount: 'Income account', ref: 'Reference (PO / contract no.)',
  },
  bill: {
    title: 'Bills', one: 'bill', One: 'Bill', party: 'Vendor', parties: '/adminconsole/accounting/vendors',
    sub: 'What the company owes its vendors. Each bill is posted to the Journal.',
    pay: 'Pay bill', paid: 'Paid', into: 'Pay from (cash / bank)', control: 'Payable account', lineAccount: 'Expense / asset account', ref: 'Vendor invoice no.',
  },
} as const;

const STATUS: Record<DocStatus, { label: string; tone: string }> = {
  open: { label: 'Open', tone: 'blue' }, partial: { label: 'Partly paid', tone: 'gold' },
  overdue: { label: 'Overdue', tone: 'red' }, paid: { label: 'Paid', tone: 'green' },
};
type Filter = 'unpaid' | 'overdue' | 'paid' | 'all';

interface Line { account: string; description: string; qty: string; price: string }
interface Draft { id?: string; party: string; date: string; due: string; control: string; vat: boolean; rate: number; vatAccount: string; ref: string; memo: string; lines: Line[] }
interface PayDraft { doc: AccDoc; date: string; account: string; amount: string; ref: string }
interface Paid { id: string; entry_date: string; reference: string; acc_lines: { account_id: string; debit: number; credit: number }[] }

const blankLine = (account = ''): Line => ({ account, description: '', qty: '1', price: '' });
const used = (l: Line) => Boolean(l.description.trim() || Number(l.price));

/** Invoices and bills are the same screen seen from the two sides. */
export function DocsScreen({ kind }: { kind: DocKind }) {
  const w = WORDS[kind];
  const { profile, settings, toast, confirmDialog } = useApp();
  const canWrite = can(profile!.role, 'accounting:write');
  const chart = useChart();
  const parties = useParties(kind);
  const docs = useDocs(kind);

  const [filter, setFilter] = useState<Filter>('unpaid');
  const [partyId, setPartyId] = useState('');
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [payDraft, setPayDraft] = useState<PayDraft | null>(null);
  const [paid, setPaid] = useState<Paid[]>([]);
  const [saving, setSaving] = useState(false);

  // the Vendors page links here with ?vendor=<id>
  useEffect(() => { setPartyId(new URLSearchParams(window.location.search).get('vendor') ?? ''); }, []);

  const accs = useMemo(() => chart.data ?? [], [chart.data]);
  const accById = useMemo(() => new Map(accs.map((a) => [a.id, a])), [accs]);
  const partyById = useMemo(() => new Map((parties.data ?? []).map((p) => [p.id, p])), [parties.data]);
  const partyName = (id: string) => partyById.get(id)?.name ?? '—';

  const controls = accs.filter((a) => a.kind === (kind === 'invoice' ? 'receivable' : 'payable'));
  const lineAccounts = accs.filter((a) => (kind === 'invoice' ? a.type === 'income' : (a.type === 'expense' || a.type === 'asset') && a.kind === ''));
  const vatAccounts = accs.filter((a) => a.type === (kind === 'invoice' ? 'liability' : 'asset') && a.kind === '');
  const cashAccounts = accs.filter((a) => a.type === 'asset' && a.kind !== 'receivable');
  /** Active accounts, plus the one already chosen even if it has been deactivated since. */
  const options = (list: Acc[], selected: string) => list.filter((a) => a.is_active || a.id === selected)
    .map((a) => <option key={a.id} value={a.id}>{a.name}</option>);

  const now = today();
  const all = docs.data ?? [];
  const sum = (list: AccDoc[]) => r2(list.reduce((s, d) => s + docBalance(d), 0));
  const unpaid = all.filter((d) => docBalance(d) > 0);
  const overdue = unpaid.filter((d) => docStatus(d, now) === 'overdue');

  const t = q.trim().toLowerCase();
  const rows = all.filter((d) => {
    const status = docStatus(d, now);
    return (filter === 'all' || (filter === 'unpaid' ? status !== 'paid' : status === filter))
      && (!partyId || d.party_id === partyId)
      && (!t || `${docNo(kind, d.doc_no)} ${partyName(d.party_id)} ${d.reference} ${d.memo}`.toLowerCase().includes(t));
  });

  const open = draft?.id ? all.find((d) => d.id === draft.id) : undefined;
  const totals = draft ? docTotals(draft.lines.filter(used).map((l) => ({ qty: l.qty, unit_price: l.price })), draft.vat ? draft.rate : 0) : null;

  function add() {
    const date = today();
    const vat = Boolean(settings.company.vat_no);
    setPaid([]);
    setDraft({
      party: partyById.get(partyId)?.active ? partyId : '', date, due: addDays(date, 30),
      control: controls.find((a) => a.is_active)?.id ?? '', vat, rate: Number(settings.vat_rate),
      vatAccount: vatAccounts.find((a) => a.is_active && /vat/i.test(a.name))?.id ?? '', ref: '', memo: '',
      lines: [blankLine(lineAccounts.find((a) => a.is_active)?.id ?? '')],
    });
  }

  const loadPaid = async (id: string) => unwrap(await supabase().from('acc_entries')
    .select('id, entry_date, reference, acc_lines(account_id, debit, credit)').eq('doc_id', id).order('entry_date').order('entry_no')) as Paid[];

  async function view(d: AccDoc) {
    try {
      const [lines, payments] = await Promise.all([
        supabase().from('acc_doc_lines').select('account_id, description, qty, unit_price').eq('doc_id', d.id).order('position')
          .then((res) => unwrap(res) as { account_id: string; description: string; qty: number; unit_price: number }[]),
        loadPaid(d.id),
      ]);
      setPaid(payments);
      setDraft({
        id: d.id, party: d.party_id, date: d.doc_date, due: d.due_date, control: d.control_account_id,
        vat: d.vat_rate > 0, rate: d.vat_rate > 0 ? d.vat_rate : Number(settings.vat_rate),
        vatAccount: d.vat_account_id ?? vatAccounts.find((a) => a.is_active && /vat/i.test(a.name))?.id ?? '',
        ref: d.reference, memo: d.memo,
        lines: lines.map((l) => ({ account: l.account_id, description: l.description, qty: String(Number(l.qty)), price: String(Number(l.unit_price)) })),
      });
    } catch (e) { toast(e instanceof Error ? e.message : String(e), true); }
  }

  /** Moving the document date keeps the same payment terms. */
  const setDate = (date: string) => {
    if (!draft) return;
    const terms = Math.max(0, Math.round((Date.parse(draft.due) - Date.parse(draft.date)) / 86_400_000));
    setDraft({ ...draft, date, due: addDays(date, terms) });
  };
  const setLine = (i: number, patch: Partial<Line>) => draft && setDraft({ ...draft, lines: draft.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });

  async function save() {
    if (!draft) return;
    const lines = draft.lines.filter(used);
    if (!draft.party) return toast(`Choose a ${w.party.toLowerCase()}`, true);
    if (!draft.control) return toast(`Choose the ${w.control.toLowerCase()}`, true);
    if (lines.length === 0) return toast('Add at least one line with a price', true);
    if (lines.some((l) => !l.account || !(Number(l.qty) > 0) || !(Number(l.price) > 0))) return toast('Every line needs an account, quantity and price', true);
    if (draft.vat && !draft.vatAccount) return toast('Choose the VAT account', true);
    setSaving(true);
    const { error } = await supabase().rpc('acc_save_doc', {
      p_id: draft.id ?? null, p_kind: kind, p_party: draft.party, p_date: draft.date, p_due: draft.due, p_control: draft.control,
      p_vat_rate: draft.vat ? draft.rate : 0, p_vat_account: draft.vat ? draft.vatAccount : null, p_ref: draft.ref, p_memo: draft.memo,
      p_lines: lines.map((l) => ({ account_id: l.account, description: l.description, qty: Number(l.qty), unit_price: Number(l.price) })),
    });
    setSaving(false);
    if (error) return toast(error.message, true);
    toast(`${w.One} saved`); setDraft(null); docs.reload();
  }

  async function remove(d: AccDoc) {
    if (!(await confirmDialog({ title: `Delete ${w.one}`, message: `Delete ${docNo(kind, d.doc_no)} for ${partyName(d.party_id)}? It is also removed from the Journal and the reports.`, confirmLabel: 'Delete', danger: true }))) return;
    const { error } = await supabase().rpc('acc_delete_doc', { p_id: d.id });
    if (error) return toast(error.message, true);
    toast(`${w.One} deleted`); setDraft(null); docs.reload();
  }

  async function removePayment(p: Paid) {
    if (!draft?.id) return;
    if (!(await confirmDialog({ title: 'Delete payment', message: `Delete the payment dated ${fmtDate(p.entry_date)}? The balance owed goes back up.`, confirmLabel: 'Delete', danger: true }))) return;
    const { error } = await supabase().rpc('acc_delete_entry', { p_id: p.id });
    if (error) return toast(error.message, true);
    toast('Payment deleted'); docs.reload();
    try { setPaid(await loadPaid(draft.id)); } catch (e) { toast(e instanceof Error ? e.message : String(e), true); }
  }

  const startPayment = (d: AccDoc) => setPayDraft({
    doc: d, date: today() < d.doc_date ? d.doc_date : today(), amount: String(docBalance(d)), ref: '',
    account: cashAccounts.find((a) => a.kind === 'cash' && a.is_active)?.id ?? '',
  });

  async function savePayment() {
    if (!payDraft) return;
    if (!payDraft.account) return toast('Choose the cash or bank account', true);
    if (!(Number(payDraft.amount) > 0)) return toast('Enter the amount', true);
    setSaving(true);
    const { error } = await supabase().rpc('acc_pay_doc', {
      p_doc: payDraft.doc.id, p_date: payDraft.date, p_account: payDraft.account, p_amount: Number(payDraft.amount), p_ref: payDraft.ref, p_memo: '',
    });
    setSaving(false);
    if (error) return toast(error.message, true);
    toast('Payment recorded'); setPayDraft(null); docs.reload();
  }

  const err = chart.error || parties.error || docs.error;
  const loading = chart.loading || parties.loading || docs.loading;
  const noParties = !parties.loading && !parties.error && (parties.data?.length ?? 0) === 0;

  return (
    <>
      <PageHead eyebrow="Accounting" title={w.title} sub={w.sub}>
        {canWrite && !noParties && <button className="btn primary" disabled={loading} onClick={add}>＋ New {w.one}</button>}
      </PageHead>
      {err && <ErrorBox error={err} />}

      <div className="stats doc-stats" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        <StatCard label="Overdue" icon="!" value={<span style={{ color: overdue.length ? 'var(--red)' : undefined }}><Money v={sum(overdue)} /></span>} note={`${overdue.length} ${w.one}${overdue.length === 1 ? '' : 's'}`} />
        <StatCard label="Not yet due" icon="◷" value={<Money v={r2(sum(unpaid) - sum(overdue))} />} note={`${unpaid.length - overdue.length} ${w.one}${unpaid.length - overdue.length === 1 ? '' : 's'}`} />
        <StatCard label={kind === 'invoice' ? 'Total owed to us' : 'Total we owe'} icon="∑" value={<Money v={sum(unpaid)} />} note="Ageing report →" href={`/adminconsole/accounting/aging${kind === 'bill' ? '?side=bill' : ''}`} />
      </div>

      <Tabs<Filter> value={filter} onChange={setFilter} tabs={[['unpaid', 'Unpaid'], ['overdue', 'Overdue'], ['paid', 'Paid'], ['all', 'All']]} />

      <div className="panel flush">
        <div className="panel-head">
          <div className="toolbar">
            <Select searchable value={partyId} onChange={(e) => setPartyId(e.target.value)}>
              <option value="">All {w.party.toLowerCase()}s</option>
              {(parties.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
            <input className="input" placeholder={`Search ${w.title.toLowerCase()}…`} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div><span className="muted">Balance </span><strong><Money v={sum(rows)} /></strong></div>
        </div>
        {loading ? <Loading /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>No.</th><th>{w.party}</th><th>Date</th><th>Due</th><th>Status</th><th className="r">Total</th><th className="r">Balance</th><th /></tr></thead>
            <tbody>
              {rows.map((d) => {
                const s = docStatus(d, now);
                return (
                  <tr key={d.id}>
                    <td data-label="No." className="mono">{docNo(kind, d.doc_no)}</td>
                    <td data-label={w.party} className="strong">{partyName(d.party_id)}{d.reference && <div className="muted" style={{ fontWeight: 400 }}>{d.reference}</div>}</td>
                    <td data-label="Date">{fmtDate(d.doc_date)}</td>
                    <td data-label="Due">{fmtDate(d.due_date)}</td>
                    <td data-label="Status"><Badge tone={STATUS[s].tone}>{STATUS[s].label}</Badge></td>
                    <td data-label="Total" className="r"><Money v={d.total} /></td>
                    <td data-label="Balance" className="r"><strong><Money v={docBalance(d)} /></strong></td>
                    <td data-label="" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {canWrite && s !== 'paid' && <button className="btn sm primary" onClick={() => startPayment(d)}>{w.pay}</button>}{' '}
                      <button className="btn sm" onClick={() => view(d)}>{canWrite ? 'Open' : 'View'}</button>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && <tr><td colSpan={8}><div className="empty">
                {noParties ? <>Add a {w.party.toLowerCase()} first on the <Link href={w.parties} className="strong">{w.party}s</Link> page.</>
                  : all.length === 0 ? `No ${w.title.toLowerCase()} yet.` : `No ${w.title.toLowerCase()} match.`}
              </div></td></tr>}
            </tbody>
          </table></div>
        )}
      </div>

      {draft && totals && (
        <Modal wide title={draft.id ? `${w.One} ${open ? docNo(kind, open.doc_no) : ''}` : `New ${w.one}`} onClose={() => setDraft(null)}
          footer={<>
            {canWrite && open && paid.length === 0 && <button className="btn danger" style={{ marginRight: 'auto' }} onClick={() => remove(open)}>Delete</button>}
            <button className="btn" onClick={() => setDraft(null)}>{canWrite ? 'Cancel' : 'Close'}</button>
            {canWrite && <button className="btn primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : `Save ${w.one}`}</button>}
          </>}>
          <div className="form-grid">
            <Field label={w.party} className="span-2">
              <Select searchable disabled={!canWrite || paid.length > 0} value={draft.party} onChange={(e) => setDraft({ ...draft, party: e.target.value })}>
                <option value="">Choose {w.party.toLowerCase()}…</option>
                {(parties.data ?? []).filter((p) => p.active || p.id === draft.party).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </Field>
            <Field label={w.control}>
              <Select disabled={!canWrite || paid.length > 0} value={draft.control} onChange={(e) => setDraft({ ...draft, control: e.target.value })}>
                <option value="">Choose account…</option>
                {options(controls, draft.control)}
              </Select>
            </Field>
            <Field label={`${w.One} date`}><DatePicker disabled={!canWrite} value={draft.date} onChange={setDate} /></Field>
            <Field label="Due date"><DatePicker disabled={!canWrite} value={draft.due} onChange={(due) => setDraft({ ...draft, due })} /></Field>
            <Field label={w.ref}><input className="input" disabled={!canWrite} value={draft.ref} onChange={(e) => setDraft({ ...draft, ref: e.target.value })} /></Field>
            <Field label="Memo" className="span-3"><input className="input" disabled={!canWrite} value={draft.memo} onChange={(e) => setDraft({ ...draft, memo: e.target.value })} /></Field>
          </div>

          <div className="doc-lines">
            {draft.lines.map((l, i) => (
              <div className="doc-line" key={i}>
                <Field label="Description" className="wide"><input className="input" disabled={!canWrite} value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} /></Field>
                <Field label={w.lineAccount} className="wide">
                  <Select searchable disabled={!canWrite} value={l.account} onChange={(e) => setLine(i, { account: e.target.value })}>
                    <option value="">Choose account…</option>
                    {options(lineAccounts, l.account)}
                  </Select>
                </Field>
                <Field label="Qty"><input className="input num" type="number" inputMode="decimal" min="0" step="any" disabled={!canWrite} value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} /></Field>
                <Field label="Unit price"><input className="input num" type="number" inputMode="decimal" min="0" step="0.01" disabled={!canWrite} value={l.price} onChange={(e) => setLine(i, { price: e.target.value })} /></Field>
                <div className="doc-line-amt"><Money v={docTotals([{ qty: l.qty, unit_price: l.price }], 0).total} /></div>
                {canWrite && <button className="btn sm" aria-label={`Remove line ${i + 1}`} disabled={draft.lines.length === 1}
                  onClick={() => setDraft({ ...draft, lines: draft.lines.filter((_, j) => j !== i) })}>×</button>}
              </div>
            ))}
            {canWrite && <button className="btn sm" onClick={() => setDraft({ ...draft, lines: [...draft.lines, blankLine(draft.lines[draft.lines.length - 1]?.account)] })}>＋ Add line</button>}
          </div>

          <div className="doc-sum">
            <div className="doc-sum-vat">
              <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input type="checkbox" disabled={!canWrite} checked={draft.vat} onChange={(e) => setDraft({ ...draft, vat: e.target.checked })} /> Add VAT {r2(draft.rate * 100)}%
              </label>
              {draft.vat && (
                <Field label="VAT account">
                  <Select disabled={!canWrite} value={draft.vatAccount} onChange={(e) => setDraft({ ...draft, vatAccount: e.target.value })}>
                    <option value="">Choose account…</option>
                    {options(vatAccounts, draft.vatAccount)}
                  </Select>
                </Field>
              )}
            </div>
            <dl>
              <dt>Subtotal</dt><dd><Money v={totals.subtotal} /></dd>
              <dt>VAT</dt><dd><Money v={totals.vat} /></dd>
              <dt className="strong">Total</dt><dd className="strong"><Money v={totals.total} /></dd>
            </dl>
          </div>

          {paid.length > 0 && (
            <>
              <div className="panel-title" style={{ marginTop: 18 }}>Payments</div>
              {paid.map((p) => (
                <div className="doc-paid" key={p.id}>
                  <span>{fmtDate(p.entry_date)}</span>
                  <span className="muted">{p.acc_lines.map((x) => accById.get(x.account_id)).find((a) => a && a.id !== draft.control)?.name}{p.reference && ` · ${p.reference}`}</span>
                  <strong><Money v={p.acc_lines.reduce((s, x) => s + Number(x.debit), 0)} /></strong>
                  {canWrite && <button className="btn sm danger" onClick={() => removePayment(p)}>Delete</button>}
                </div>
              ))}
              <p className="muted" style={{ fontSize: 12 }}>To delete this {w.one}, delete its payments first.</p>
            </>
          )}
        </Modal>
      )}

      {payDraft && (
        <Modal title={`${w.pay} · ${docNo(kind, payDraft.doc.doc_no)}`} onClose={() => setPayDraft(null)}
          footer={<><button className="btn" onClick={() => setPayDraft(null)}>Cancel</button><button className="btn primary" disabled={saving} onClick={savePayment}>{saving ? 'Saving…' : 'Save payment'}</button></>}>
          <p style={{ marginBottom: 14 }}>{partyName(payDraft.doc.party_id)} · balance <strong><Money v={docBalance(payDraft.doc)} /></strong></p>
          <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
            <Field label="Date"><DatePicker value={payDraft.date} onChange={(date) => setPayDraft({ ...payDraft, date })} /></Field>
            <Field label="Amount (SAR)"><input className="input num" type="number" inputMode="decimal" min="0" step="0.01" value={payDraft.amount} onChange={(e) => setPayDraft({ ...payDraft, amount: e.target.value })} /></Field>
            <Field label={w.into}>
              <Select value={payDraft.account} onChange={(e) => setPayDraft({ ...payDraft, account: e.target.value })}>
                <option value="">Choose account…</option>
                {options(cashAccounts, payDraft.account)}
              </Select>
            </Field>
            <Field label="Reference (transfer / cheque no.)"><input className="input" value={payDraft.ref} onChange={(e) => setPayDraft({ ...payDraft, ref: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </>
  );
}
