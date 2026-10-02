'use client';
import { useMemo, useState } from 'react';
import { useApp } from '@/components/Providers';
import { Badge, ErrorBox, Field, Loading, Modal, PageHead } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import { can } from '@/lib/roles';
import { supabase, unwrap } from '@/lib/supabase';
import type { Client } from '@/lib/types';

type Draft = Omit<Client, 'id'> & { id?: string };

const toDraft = (c?: Client): Draft => ({
  id: c?.id, name: c?.name ?? '', attention: c?.attention ?? '', email: c?.email ?? '', phone: c?.phone ?? '',
  address: c?.address ?? '', vat_no: c?.vat_no ?? '', payment_terms: c?.payment_terms ?? '', notes: c?.notes ?? '',
  status: c?.status ?? 'active',
});

export default function ClientsPage() {
  const { profile, toast, confirmDialog } = useApp();
  const canWrite = can(profile!.role, 'clients:write');
  const sb = supabase();
  const { data, error, loading, reload } = useQuery(async () =>
    unwrap(await sb.from('clients').select('*').order('name')) as Client[], []);
  const [q, setQ] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  const rows = useMemo(() => (data ?? []).filter((c) =>
    (showInactive || c.status === 'active') &&
    `${c.name} ${c.attention} ${c.email} ${c.phone}`.toLowerCase().includes(q.toLowerCase())), [data, q, showInactive]);

  async function save() {
    if (!draft) return;
    if (!draft.name.trim()) return toast('Client name is required', true);
    setSaving(true);
    const { id, ...rest } = draft;
    const payload: Record<string, string> = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, v.trim()]));
    const res = id ? await sb.from('clients').update(payload).eq('id', id) : await sb.from('clients').insert([payload]);
    setSaving(false);
    if (res.error) return toast(res.error.code === '23505' ? 'A client with this name already exists' : res.error.message, true);
    toast(id ? 'Client updated' : 'Client added');
    setDraft(null); reload();
  }

  async function toggle(c: Client) {
    const status = c.status === 'active' ? 'inactive' : 'active';
    if (status === 'inactive' && !(await confirmDialog({ title: 'Deactivate client?', message: `${c.name} will no longer appear when creating quotations. Existing quotations are not affected.`, confirmLabel: 'Deactivate', danger: true }))) return;
    const { error } = await sb.from('clients').update({ status }).eq('id', c.id);
    if (error) return toast(error.message, true);
    toast(status === 'active' ? 'Client reactivated' : 'Client deactivated'); reload();
  }

  const set = (k: keyof Draft, v: string) => setDraft((d) => (d ? { ...d, [k]: v } : d));

  return (
    <>
      <PageHead eyebrow="Quotations" title="Clients" sub="Saved client profiles, picked when creating a quotation">
        {canWrite && <button className="btn primary" onClick={() => setDraft(toDraft())}>＋ Add Client</button>}
      </PageHead>
      {error && <ErrorBox error={error} />}
      <div className="panel flush">
        <div className="panel-head">
          <div className="toolbar">
            <input className="input" placeholder="Search clients…" value={q} onChange={(e) => setQ(e.target.value)} />
            <label className="check"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive</label>
          </div>
          <span className="muted">{rows.length} clients</span>
        </div>
        {loading ? <Loading /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Client</th><th>Attention</th><th>Phone</th><th>Email</th><th>VAT No.</th><th>Status</th><th /></tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td className="strong">{c.name}</td><td>{c.attention}</td><td>{c.phone}</td><td>{c.email}</td><td className="mono">{c.vat_no}</td>
                  <td><Badge tone={c.status === 'active' ? 'green' : ''}>{c.status === 'active' ? 'Active' : 'Inactive'}</Badge></td>
                  <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                    {canWrite && <button className="btn sm" onClick={() => setDraft(toDraft(c))}>Edit</button>}{' '}
                    {canWrite && <button className={`btn sm${c.status === 'active' ? ' danger' : ''}`} onClick={() => toggle(c)}>{c.status === 'active' ? 'Deactivate' : 'Activate'}</button>}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={7}><div className="empty">No clients yet.</div></td></tr>}
            </tbody>
          </table></div>
        )}
      </div>

      {draft && (
        <Modal title={draft.id ? 'Edit Client' : 'Add Client'} wide onClose={() => setDraft(null)}
          footer={<><button className="btn" onClick={() => setDraft(null)}>Cancel</button><button className="btn primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save Client'}</button></>}>
          <div className="form-grid">
            <Field label="Client name *" className="span-2"><input className="input" value={draft.name} onChange={(e) => set('name', e.target.value)} /></Field>
            <Field label="Default attention"><input className="input" value={draft.attention} onChange={(e) => set('attention', e.target.value)} /></Field>
            <Field label="Phone"><input className="input" value={draft.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
            <Field label="Email" className="span-2"><input className="input" type="email" value={draft.email} onChange={(e) => set('email', e.target.value)} /></Field>
            <Field label="VAT number"><input className="input" value={draft.vat_no} onChange={(e) => set('vat_no', e.target.value)} /></Field>
            <Field label="Address" className="span-3"><input className="input" value={draft.address} onChange={(e) => set('address', e.target.value)} /></Field>
            <Field label="Default payment terms" className="span-3"><textarea className="textarea" value={draft.payment_terms} onChange={(e) => set('payment_terms', e.target.value)} /></Field>
            <Field label="Notes" className="span-3"><textarea className="textarea" style={{ minHeight: 50 }} value={draft.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
          </div>
        </Modal>
      )}
    </>
  );
}
