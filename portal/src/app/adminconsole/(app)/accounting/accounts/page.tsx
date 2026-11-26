'use client';
import { Fragment, useMemo, useState } from 'react';
import { Money } from '@/components/Money';
import { useApp } from '@/components/Providers';
import { useBalances, useChart } from '@/components/AccountingBits';
import { Badge, ErrorBox, Field, Loading, Modal, PageHead, Select } from '@/components/ui';
import { natural, SECTIONS_OF, SECTION_LABEL, TYPES, TYPE_LABEL, type Acc, type AccKind, type AccSection, type AccType } from '@/lib/accounting';
import { can } from '@/lib/roles';
import { supabase } from '@/lib/supabase';

interface Draft { id?: string; name: string; type: AccType; section: AccSection; kind: AccKind; is_active: boolean }

const KIND_LABEL: Record<AccKind, string> = { '': 'Nothing special', cash: 'Cash or bank', receivable: 'Receivable (owed to us)', payable: 'Payable (we owe)' };
const KINDS_OF: Record<AccType, AccKind[]> = { asset: ['', 'cash', 'receivable'], liability: ['', 'payable'], equity: [''], income: [''], expense: [''] };

export default function AccountsPage() {
  const { profile, toast } = useApp();
  const canWrite = can(profile!.role, 'accounting:write');
  const chart = useChart();
  const bals = useBalances(null, null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [moving, setMoving] = useState(false);
  const [showInactive, setShowInactive] = useState(false);

  const accs = chart.data ?? [];
  const bm = useMemo(() => new Map((bals.data ?? []).map((b) => [b.account_id, b])), [bals.data]);
  const list = accs.filter((a) => showInactive || a.is_active);

  async function save() {
    if (!draft) return;
    if (!draft.name.trim()) return toast('Enter the account name', true);
    setSaving(true);
    const { error } = await supabase().rpc('acc_save_account', { p_id: draft.id ?? null, p_name: draft.name, p_type: draft.type, p_section: draft.section, p_kind: draft.kind, p_active: draft.is_active });
    setSaving(false);
    if (error) return toast(error.message, true);
    toast('Account saved'); setDraft(null); chart.reload();
  }

  /** Saves a section's order; an empty list puts it back to alphabetical. */
  async function saveOrder(section: AccSection, ids: string[]) {
    setMoving(true);
    const { error } = await supabase().rpc('acc_order_accounts', { p_section: section, p_ids: ids });
    setMoving(false);
    if (error) return toast(error.message, true);
    chart.reload();
  }

  /** Swaps an account with its neighbour on screen; hidden inactive accounts keep their places. */
  function move(a: Acc, step: -1 | 1) {
    const shown = list.filter((x) => x.section === a.section);
    const other = shown[shown.findIndex((x) => x.id === a.id) + step];
    if (!other) return;
    const ids = accs.filter((x) => x.section === a.section).map((x) => (x.id === a.id ? other.id : x.id === other.id ? a.id : x.id));
    saveOrder(a.section, ids);
  }

  const open = (a?: Acc) => setDraft(a
    ? { id: a.id, name: a.name, type: a.type, section: a.section, kind: a.kind, is_active: a.is_active }
    : { name: '', type: 'expense', section: 'operating_expense', kind: '', is_active: true });

  return (
    <>
      <PageHead eyebrow="Accounting" title="Chart of Accounts" sub="Grouped by section and sorted by name. Use the arrows to set your own order.">
        <label className="muted" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive
        </label>
        {canWrite && <button className="btn primary" onClick={() => open()}>＋ New account</button>}
      </PageHead>
      {(chart.error || bals.error) && <ErrorBox error={(chart.error || bals.error)!} />}

      {chart.loading && !chart.data ? <Loading /> : TYPES.map((t) => {
        const sections = SECTIONS_OF[t].filter((s) => list.some((a) => a.section === s));
        if (!sections.length) return null;
        return (
          <div className="panel flush" key={t} style={{ marginBottom: 16 }}>
            <div className="panel-head"><strong>{TYPE_LABEL[t]}</strong></div>
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Account</th><th className="r" style={{ width: 180 }}>Balance</th><th style={{ width: 200 }} /></tr></thead>
              <tbody>{sections.map((s) => {
                const rows = list.filter((a) => a.section === s);
                const custom = rows.some((a) => a.sort_order !== null);
                return (
                  <Fragment key={s}>
                    <tr>
                      <td colSpan={2} className="muted strong" style={{ background: '#f8fafc' }}>{SECTION_LABEL[s]}</td>
                      <td style={{ textAlign: 'right', background: '#f8fafc' }}>
                        {canWrite && custom && <button className="btn sm" disabled={moving} onClick={() => saveOrder(s, [])}>Sort by name</button>}
                      </td>
                    </tr>
                    {rows.map((a, i) => {
                      const b = bm.get(a.id);
                      return (
                        <tr key={a.id}>
                          <td className="strong">{a.name} {!a.is_active && <Badge>Inactive</Badge>}</td>
                          <td className="r"><Money v={natural(a.type, b?.debit ?? 0, b?.credit ?? 0)} /></td>
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {canWrite && <>
                              <button className="btn sm" aria-label={`Move ${a.name} up`} title="Move up" disabled={moving || i === 0} onClick={() => move(a, -1)}>↑</button>{' '}
                              <button className="btn sm" aria-label={`Move ${a.name} down`} title="Move down" disabled={moving || i === rows.length - 1} onClick={() => move(a, 1)}>↓</button>{' '}
                              <button className="btn sm" onClick={() => open(a)}>Edit</button>
                            </>}
                          </td>
                        </tr>
                      );
                    })}
                  </Fragment>
                );
              })}</tbody>
            </table></div>
          </div>
        );
      })}

      {draft && (
        <Modal title={draft.id ? 'Edit account' : 'New account'} onClose={() => setDraft(null)}
          footer={<><button className="btn" onClick={() => setDraft(null)}>Cancel</button><button className="btn primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button></>}>
          <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
            <Field label="Name"><input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
            <Field label="Type">
              <Select value={draft.type} onChange={(e) => { const t = e.target.value as AccType; setDraft({ ...draft, type: t, section: SECTIONS_OF[t][0], kind: KINDS_OF[t].includes(draft.kind) ? draft.kind : '' }); }}>
                {TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
              </Select>
            </Field>
            <Field label="Shown under">
              <Select value={draft.section} onChange={(e) => setDraft({ ...draft, section: e.target.value as AccSection })}>
                {SECTIONS_OF[draft.type].map((s) => <option key={s} value={s}>{SECTION_LABEL[s]}</option>)}
              </Select>
            </Field>
            {KINDS_OF[draft.type].length > 1 && (
              <Field label="Counts on the Overview as">
                <Select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as AccKind })}>
                  {KINDS_OF[draft.type].map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                </Select>
              </Field>
            )}
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
              <input type="checkbox" checked={draft.is_active} onChange={(e) => setDraft({ ...draft, is_active: e.target.checked })} /> Active (can be used in new entries)
            </label>
          </div>
        </Modal>
      )}
    </>
  );
}
