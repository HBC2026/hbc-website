'use client';
import { useMemo, useState } from 'react';
import { Money } from '@/components/Money';
import { useApp } from '@/components/Providers';
import { useBalances, useChart } from '@/components/AccountingBits';
import { Badge, ErrorBox, Field, Loading, Modal, PageHead, Select } from '@/components/ui';
import { natural, SECTIONS_OF, SECTION_LABEL, TYPES, TYPE_LABEL, type Acc, type AccSection, type AccType } from '@/lib/accounting';
import { can } from '@/lib/roles';
import { supabase } from '@/lib/supabase';

interface Draft { id?: string; code: string; name: string; type: AccType; section: AccSection; is_active: boolean }

export default function AccountsPage() {
  const { profile, toast } = useApp();
  const canWrite = can(profile!.role, 'accounting:write');
  const chart = useChart();
  const bals = useBalances(null, null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [showInactive, setShowInactive] = useState(false);

  const bm = useMemo(() => new Map((bals.data ?? []).map((b) => [b.account_id, b])), [bals.data]);
  const list = (chart.data ?? []).filter((a) => showInactive || a.is_active);

  async function save() {
    if (!draft) return;
    setSaving(true);
    const { error } = await supabase().rpc('acc_save_account', { p_id: draft.id ?? null, p_code: draft.code, p_name: draft.name, p_type: draft.type, p_section: draft.section, p_active: draft.is_active });
    setSaving(false);
    if (error) return toast(error.message, true);
    toast('Account saved'); setDraft(null); chart.reload();
  }

  const open = (a?: Acc) => setDraft(a
    ? { id: a.id, code: a.code, name: a.name, type: a.type, section: a.section, is_active: a.is_active }
    : { code: '', name: '', type: 'expense', section: 'operating_expense', is_active: true });

  return (
    <>
      <PageHead eyebrow="Accounting" title="Chart of Accounts" sub="The accounts every entry is posted to, with balances to date">
        <label className="muted" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive
        </label>
        {canWrite && <button className="btn primary" onClick={() => open()}>＋ New account</button>}
      </PageHead>
      {(chart.error || bals.error) && <ErrorBox error={(chart.error || bals.error)!} />}

      {chart.loading ? <Loading /> : TYPES.map((t) => {
        const rows = list.filter((a) => a.type === t);
        if (!rows.length) return null;
        return (
          <div className="panel flush" key={t} style={{ marginBottom: 16 }}>
            <div className="panel-head"><strong>{TYPE_LABEL[t]}</strong></div>
            <div className="table-wrap"><table className="table">
              <thead><tr><th style={{ width: 90 }}>Code</th><th>Account</th><th>Section</th><th className="r">Balance</th><th /></tr></thead>
              <tbody>{rows.map((a) => {
                const b = bm.get(a.id);
                return (
                  <tr key={a.id}>
                    <td className="mono">{a.code}</td>
                    <td className="strong">{a.name} {!a.is_active && <Badge>Inactive</Badge>}</td>
                    <td className="muted">{SECTION_LABEL[a.section]}</td>
                    <td className="r"><Money v={natural(a.type, b?.debit ?? 0, b?.credit ?? 0)} /></td>
                    <td style={{ textAlign: 'right' }}>{canWrite && <button className="btn sm" onClick={() => open(a)}>Edit</button>}</td>
                  </tr>
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
            <Field label="Code"><input className="input" value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} placeholder="e.g. 6130" /></Field>
            <Field label="Name"><input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
            <Field label="Type">
              <Select value={draft.type} onChange={(e) => { const t = e.target.value as AccType; setDraft({ ...draft, type: t, section: SECTIONS_OF[t][0] }); }}>
                {TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
              </Select>
            </Field>
            <Field label="Shown under">
              <Select value={draft.section} onChange={(e) => setDraft({ ...draft, section: e.target.value as AccSection })}>
                {SECTIONS_OF[draft.type].map((s) => <option key={s} value={s}>{SECTION_LABEL[s]}</option>)}
              </Select>
            </Field>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
              <input type="checkbox" checked={draft.is_active} onChange={(e) => setDraft({ ...draft, is_active: e.target.checked })} /> Active (can be used in new entries)
            </label>
          </div>
        </Modal>
      )}
    </>
  );
}
