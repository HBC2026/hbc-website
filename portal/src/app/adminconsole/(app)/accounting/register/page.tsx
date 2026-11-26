'use client';
import { useEffect, useMemo, useState } from 'react';
import { Money } from '@/components/Money';
import { useApp } from '@/components/Providers';
import { useChart } from '@/components/AccountingBits';
import { DatePicker, ErrorBox, Loading, PageHead, Select } from '@/components/ui';
import { natural, r2 } from '@/lib/accounting';
import { useQuery } from '@/lib/hooks';
import { fmtDate, today } from '@/lib/format';
import { can } from '@/lib/roles';
import { supabase, unwrap } from '@/lib/supabase';

interface Peer { account_id: string; debit: number; credit: number }
interface Row {
  id: string; debit: number; credit: number; account_id: string; memo: string;
  acc_entries: { id: string; entry_no: number; entry_date: string; memo: string; reference: string; acc_lines: Peer[] };
}
interface Draft { id?: string; date: string; num: string; memo: string; note: string; other: string; debit: string; credit: string }

const jeNo = (n: number) => `JE-${String(n).padStart(4, '0')}`;
const num = (s: string) => Number(s) || 0;
const fresh = (date = today()): Draft => ({ date, num: '', memo: '', note: '', other: '', debit: '', credit: '' });

export default function RegisterPage() {
  const { profile, company, toast, confirmDialog } = useApp();
  const canWrite = can(profile!.role, 'accounting:write');
  const sb = supabase();
  const chart = useChart();
  const accs = chart.data ?? [];
  const byId = useMemo(() => new Map(accs.map((a) => [a.id, a])), [accs]);

  const [accountId, setAccountId] = useState('');
  useEffect(() => {
    if (!accountId && accs.length) setAccountId((accs.find((a) => a.kind === 'cash' && a.is_active) ?? accs.find((a) => a.type === 'asset') ?? accs[0]).id);
  }, [accs, accountId]);
  const account = byId.get(accountId);
  // everyday words on this screen: "Money in" posts a debit, "Money out" posts a credit
  const drLabel = 'Money in';
  const crLabel = 'Money out';

  const { data, error, loading, reload } = useQuery(async () => {
    if (!accountId) return [] as Row[];
    return unwrap(await sb.from('acc_lines')
      .select('id, debit, credit, account_id, memo, acc_entries!inner(id, entry_no, entry_date, memo, reference, acc_lines(account_id, debit, credit))')
      .eq('account_id', accountId).limit(2000)) as unknown as Row[];
  }, [company?.id, accountId]);

  const [draft, setDraft] = useState<Draft>(fresh());
  const [saving, setSaving] = useState(false);
  const [q, setQ] = useState('');

  // oldest first with a running balance, like a paper ledger
  const rows = useMemo(() => {
    if (!account) return [];
    const sorted = [...(data ?? [])].sort((a, b) =>
      a.acc_entries.entry_date.localeCompare(b.acc_entries.entry_date) || a.acc_entries.entry_no - b.acc_entries.entry_no);
    let bal = 0;
    return sorted.map((r) => {
      bal = r2(bal + natural(account.type, Number(r.debit), Number(r.credit)));
      const others = r.acc_entries.acc_lines.filter((l) => l.account_id !== accountId);
      const split = new Set(others.map((l) => l.account_id)).size > 1;
      const otherId = others[0]?.account_id ?? '';
      return { r, bal, split, otherId };
    });
  }, [data, account, accountId]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return rows;
    return rows.filter(({ r, split, otherId }) =>
      `${r.acc_entries.memo} ${r.memo} ${r.acc_entries.reference} ${jeNo(r.acc_entries.entry_no)} ${split ? 'split' : byId.get(otherId)?.name ?? ''}`.toLowerCase().includes(t));
  }, [rows, q, byId]);

  const totals = useMemo(() => ({
    debit: r2(shown.reduce((s, x) => s + Number(x.r.debit), 0)),
    credit: r2(shown.reduce((s, x) => s + Number(x.r.credit), 0)),
  }), [shown]);
  const ending = rows.length ? rows[rows.length - 1].bal : 0;

  async function save() {
    if (!account) return;
    const d = num(draft.debit), c = num(draft.credit);
    if (!draft.date) return toast('Enter the date', true);
    if (d && c) return toast(`Use either ${drLabel} or ${crLabel}, not both`, true);
    if (!(d > 0 || c > 0)) return toast(`Enter an amount in ${drLabel} or ${crLabel}`, true);
    if (!draft.other) return toast('Choose the COA account', true);
    if (draft.other === accountId) return toast('The other account must be different', true);
    const amt = d || c;
    const note = draft.note.trim();
    const lines = d
      ? [{ account_id: accountId, debit: amt, credit: 0, memo: note }, { account_id: draft.other, debit: 0, credit: amt, memo: note }]
      : [{ account_id: accountId, debit: 0, credit: amt, memo: note }, { account_id: draft.other, debit: amt, credit: 0, memo: note }];
    setSaving(true);
    const { error } = await sb.rpc('acc_post_entry', { p_id: draft.id ?? null, p_date: draft.date, p_memo: draft.memo, p_ref: draft.num, p_lines: lines });
    setSaving(false);
    if (error) return toast(error.message, true);
    toast(draft.id ? 'Transaction updated' : 'Transaction added');
    setDraft(fresh(draft.date)); reload();
  }

  function edit(x: (typeof rows)[number]) {
    const e = x.r.acc_entries;
    setDraft({ id: e.id, date: e.entry_date, num: e.reference, memo: e.memo, note: x.r.memo, other: x.otherId, debit: Number(x.r.debit) ? String(x.r.debit) : '', credit: Number(x.r.credit) ? String(x.r.credit) : '' });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function remove(x: (typeof rows)[number]) {
    const e = x.r.acc_entries;
    if (!(await confirmDialog({ title: 'Delete transaction', message: `Delete ${jeNo(e.entry_no)}${e.memo ? ` (${e.memo})` : ''}? It also disappears from the other account and from the reports.`, confirmLabel: 'Delete', danger: true }))) return;
    const { error } = await sb.rpc('acc_delete_entry', { p_id: e.id });
    if (error) return toast(error.message, true);
    toast('Transaction deleted'); if (draft.id === e.id) setDraft(fresh()); reload();
  }

  const editing = draft.id ? rows.find((x) => x.r.acc_entries.id === draft.id)?.r.acc_entries : undefined;
  const onKey = (ev: React.KeyboardEvent) => {
    if (ev.key === 'Enter') { ev.preventDefault(); save(); }
    if (ev.key === 'Escape' && draft.id) setDraft(fresh());
  };
  const active = accs.filter((a) => a.is_active && a.id !== accountId);

  return (
    <>
      <PageHead eyebrow="Accounting" title="Register" sub="Type transactions straight into the table. Each one is posted against the other account you choose." />
      {(error || chart.error) && <ErrorBox error={(chart.error || error)!} />}

      <div className="panel flush">
        <div className="panel-head">
          <div className="toolbar">
            <Select searchable value={accountId} onChange={(e) => { setAccountId(e.target.value); setDraft(fresh()); }}>
              {accs.filter((a) => a.is_active || a.id === accountId).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
            <input className="input" placeholder="Search this register…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div>
            <span className="muted">Balance </span><strong><Money v={ending} /></strong>
          </div>
        </div>

        {editing && (
          <div className="reg-banner" role="status">
            <span><strong>✎ Updating {jeNo(editing.entry_no)}</strong> dated {fmtDate(editing.entry_date)}. Change the top row, then save.</span>
            <button className="btn sm" onClick={() => setDraft(fresh())}>Cancel update</button>
          </div>
        )}

        {loading || chart.loading ? <Loading /> : (
          <div className="table-wrap"><table className="table register">
            <thead><tr>
              <th style={{ width: 150 }}>Date</th><th style={{ width: 110 }}>Num</th><th>Description</th><th>Memo</th><th style={{ width: 230 }}>COA</th>
              <th className="r" style={{ width: 130 }}>{drLabel}</th><th className="r" style={{ width: 130 }}>{crLabel}</th><th className="r" style={{ width: 140 }}>Balance</th><th style={{ width: 150 }} />
            </tr></thead>
            <tbody>
              {canWrite && (
                <tr className={draft.id ? 'reg-entry is-editing' : 'reg-entry'} onKeyDown={onKey}>
                  <td data-label="Date"><DatePicker value={draft.date} onChange={(v) => setDraft({ ...draft, date: v })} /></td>
                  <td data-label="Num"><input className="input" value={draft.num} onChange={(e) => setDraft({ ...draft, num: e.target.value })} placeholder="Ref no." /></td>
                  <td data-label="Description"><input className="input" value={draft.memo} onChange={(e) => setDraft({ ...draft, memo: e.target.value })} placeholder="Description" /></td>
                  <td data-label="Memo"><input className="input" value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} placeholder="Memo" /></td>
                  <td data-label="COA">
                    <Select searchable value={draft.other} onChange={(e) => setDraft({ ...draft, other: e.target.value })}>
                      <option value="">Choose COA…</option>
                      {active.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </Select>
                  </td>
                  <td data-label={drLabel}><input className="input num" type="number" inputMode="decimal" min="0" step="0.01" value={draft.debit} onChange={(e) => setDraft({ ...draft, debit: e.target.value, credit: e.target.value ? '' : draft.credit })} /></td>
                  <td data-label={crLabel}><input className="input num" type="number" inputMode="decimal" min="0" step="0.01" value={draft.credit} onChange={(e) => setDraft({ ...draft, credit: e.target.value, debit: e.target.value ? '' : draft.debit })} /></td>
                  <td />
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className={draft.id ? 'btn sm update' : 'btn sm primary'} disabled={saving} onClick={save}>{saving ? 'Saving…' : draft.id ? 'Save changes' : '＋ Add'}</button>{' '}
                    {draft.id && <button className="btn sm" onClick={() => setDraft(fresh())}>Cancel</button>}
                  </td>
                </tr>
              )}
              {shown.map((x) => {
                const e = x.r.acc_entries;
                return (
                  <tr key={x.r.id} className={draft.id === e.id ? 'reg-editing' : undefined}>
                    <td>{fmtDate(e.entry_date)}</td>
                    <td className="mono">{e.reference || <span className="muted">{jeNo(e.entry_no)}</span>}</td>
                    <td>{e.memo || <span className="muted">—</span>}</td>
                    <td>{x.r.memo || <span className="muted">—</span>}</td>
                    <td className="muted">{x.split ? '-Split-' : x.otherId ? byId.get(x.otherId)?.name : '—'}</td>
                    <td className="r">{Number(x.r.debit) ? <Money v={x.r.debit} /> : ''}</td>
                    <td className="r">{Number(x.r.credit) ? <Money v={x.r.credit} /> : ''}</td>
                    <td className="r"><strong style={{ color: x.bal < 0 ? 'var(--red)' : undefined }}><Money v={x.bal} /></strong></td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {canWrite && draft.id === e.id && <span className="reg-tag">Editing above ↑</span>}
                      {canWrite && draft.id !== e.id && <>
                        {!x.split && <button className="btn sm" onClick={() => edit(x)}>Edit</button>}{' '}
                        <button className="btn sm danger" onClick={() => remove(x)}>Delete</button>
                      </>}
                    </td>
                  </tr>
                );
              })}
              {shown.length === 0 && <tr><td colSpan={9}><div className="empty">No transactions in this account yet.{canWrite ? ' Fill in the top row and press Enter.' : ''}</div></td></tr>}
            </tbody>
            {shown.length > 0 && (
              <tfoot><tr>
                <td colSpan={5} className="strong">Totals</td>
                <td className="r strong"><Money v={totals.debit} /></td><td className="r strong"><Money v={totals.credit} /></td>
                <td className="r strong"><Money v={ending} /></td><td />
              </tr></tfoot>
            )}
          </table></div>
        )}
      </div>
      {account && <p className="muted" style={{ marginTop: 10, fontSize: 12 }}>
        {account.name}: {account.type === 'asset' || account.type === 'expense' ? 'money in increases the balance and money out decreases it.' : 'money out increases the balance and money in decreases it.'} Transactions with more than two accounts show as -Split- and are edited in the Journal.
      </p>}
    </>
  );
}
