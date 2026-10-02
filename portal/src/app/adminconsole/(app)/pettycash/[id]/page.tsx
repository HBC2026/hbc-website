'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Money } from '@/components/Money';
import { useApp } from '@/components/Providers';
import { Badge, DatePicker, ErrorBox, Field, Loading, Modal, PageHead, StatCard } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import { fmtDate, today } from '@/lib/format';
import { can } from '@/lib/roles';
import { PETTY_BUCKET, supabase, unwrap } from '@/lib/supabase';
import type { Employee, PcCash, PcReceipt, ReceiptStatus } from '@/lib/types';

const TONE: Record<ReceiptStatus, string> = { pending: 'gold', approved: 'green', rejected: 'red' };
const LABEL: Record<ReceiptStatus, string> = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected' };

export default function PettyCashEmployeePage() {
  const { id } = useParams<{ id: string }>();
  const { profile, company, toast, confirmDialog } = useApp();
  const canWrite = can(profile!.role, 'pettycash:write');
  const sb = supabase();
  const { data, error, loading, reload } = useQuery(async () => {
    const [emp, cash, rec] = await Promise.all([
      sb.from('employees').select('id, emp_code, name, job_title, status').eq('id', id).maybeSingle(),
      sb.from('pc_cash_given').select('*').eq('employee_id', id).order('given_on', { ascending: false }).order('created_at', { ascending: false }),
      sb.from('pc_receipts').select('*').eq('employee_id', id).order('spent_on', { ascending: false }).order('created_at', { ascending: false }),
    ]);
    return {
      emp: unwrap(emp) as Pick<Employee, 'id' | 'emp_code' | 'name' | 'job_title' | 'status'> | null,
      cash: unwrap(cash) as PcCash[],
      receipts: unwrap(rec) as PcReceipt[],
    };
  }, [id, company?.id]);

  const [give, setGive] = useState<{ amount: string; date: string; note: string; given_by: string } | null>(null);
  const [reject, setReject] = useState<{ id: string; reason: string } | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const given = (data?.cash ?? []).reduce((a, c) => a + Number(c.amount), 0);
  const spent = (data?.receipts ?? []).filter((r) => r.status !== 'rejected').reduce((a, r) => a + Number(r.amount), 0);
  const balance = given - spent;

  async function run(fn: () => PromiseLike<{ error: { message: string } | null }>, ok: string) {
    setBusy(true);
    const { error } = await fn();
    setBusy(false);
    if (error) { toast(error.message, true); return false; }
    toast(ok); reload(); return true;
  }

  async function saveCash() {
    if (!give) return;
    const amount = Number(give.amount);
    if (!(amount > 0)) return toast('Enter the amount given', true);
    if (!give.given_by.trim()) return toast('Enter who gave the cash', true);
    if (await run(() => sb.rpc('pc_give_cash', { p_employee: id, p_amount: amount, p_date: give.date, p_note: give.note, p_given_by: give.given_by }), 'Cash recorded')) setGive(null);
  }

  async function deleteCash(c: PcCash) {
    if (!(await confirmDialog({ title: 'Delete cash entry?', message: `Delete the ${Number(c.amount).toFixed(2)} SAR entry of ${fmtDate(c.given_on)}? The balance will drop by that amount.`, confirmLabel: 'Delete', danger: true }))) return;
    await run(() => sb.rpc('pc_delete_cash', { p_id: c.id }), 'Entry deleted');
  }

  async function review(rid: string, status: 'approved' | 'rejected', reason = '') {
    if (status === 'rejected' && !reason.trim()) return toast('Write why it is rejected so the employee can fix it', true);
    if (await run(() => sb.rpc('pc_review_receipt', { p_id: rid, p_status: status, p_reason: reason }), status === 'approved' ? 'Receipt approved' : 'Receipt rejected')) setReject(null);
  }

  async function view(path: string) {
    const w = window.open('', '_blank');   // opened first so the popup is not blocked after the async call
    const { data: d, error } = await sb.storage.from(PETTY_BUCKET).createSignedUrl(path, 60);
    if (error || !d) { w?.close(); return toast(error?.message ?? 'Could not open the receipt', true); }
    if (w) w.location.href = d.signedUrl; else window.location.href = d.signedUrl;
  }

  async function openLink(regenerate = false) {
    if (regenerate && !(await confirmDialog({ title: 'Create a new link?', message: 'The old link stops working immediately. You must send the new one to the employee.', confirmLabel: 'New link', danger: true }))) return;
    const { data: t, error } = await sb.rpc('pc_get_link', { p_employee: id, p_regenerate: regenerate });
    if (error) return toast(error.message, true);
    setLink(`${window.location.origin}/pettycash/${t}`);
  }

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data?.emp) return <div className="empty">Employee not found. <Link href="/adminconsole/pettycash">Back to petty cash</Link></div>;
  const { emp } = data;

  return (
    <>
      <PageHead eyebrow="Petty Cash" title={emp.name} sub={`${emp.emp_code}${emp.job_title ? ' · ' + emp.job_title : ''}`}>
        <Link className="btn" href="/adminconsole/pettycash">← All employees</Link>
        {canWrite && <button className="btn" onClick={() => openLink()}>Employee link</button>}
        {canWrite && <button className="btn primary" onClick={() => setGive({ amount: '', date: today(), note: '', given_by: profile!.full_name })}>＋ Give cash</button>}
      </PageHead>

      <div className="stats">
        <StatCard label="Cash given" icon="＋" value={<Money v={given} />} />
        <StatCard label="Receipts" icon="▤" value={<Money v={spent} />} note="Pending and approved" />
        <StatCard label="Balance" icon="◉" value={<span style={{ color: balance < 0 ? 'var(--red)' : undefined }}><Money v={balance} /></span>} note={balance < 0 ? 'Spent more than given' : 'Cash still held'} />
      </div>

      <div className="panel flush" style={{ marginBottom: 18 }}>
        <div className="panel-head"><div className="panel-title">Receipts</div><span className="muted">{data.receipts.length}</span></div>
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Date</th><th>Description</th><th className="r">Amount</th><th>Status</th><th /></tr></thead>
          <tbody>
            {data.receipts.map((r) => (
              <tr key={r.id}>
                <td>{fmtDate(r.spent_on)}</td>
                <td>{r.description}{r.status === 'rejected' && r.reject_reason && <div className="muted" style={{ fontSize: 11 }}>Rejected: {r.reject_reason}</div>}</td>
                <td className="r" style={r.status === 'rejected' ? { textDecoration: 'line-through', opacity: .55 } : undefined}><Money v={r.amount} /></td>
                <td><Badge tone={TONE[r.status]}>{LABEL[r.status]}</Badge></td>
                <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                  <button className="btn sm" onClick={() => view(r.file_path)}>View receipt</button>{' '}
                  {canWrite && r.status !== 'approved' && <button className="btn sm green" disabled={busy} onClick={() => review(r.id, 'approved')}>Approve</button>}{' '}
                  {canWrite && r.status !== 'rejected' && <button className="btn sm danger" disabled={busy} onClick={() => setReject({ id: r.id, reason: '' })}>Reject</button>}
                </td>
              </tr>
            ))}
            {data.receipts.length === 0 && <tr><td colSpan={5}><div className="empty">No receipts uploaded yet.</div></td></tr>}
          </tbody>
        </table></div>
      </div>

      <div className="panel flush">
        <div className="panel-head"><div className="panel-title">Cash given</div><span className="muted">{data.cash.length}</span></div>
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Date</th><th>Given by</th><th>Note</th><th className="r">Amount</th><th /></tr></thead>
          <tbody>
            {data.cash.map((c) => (
              <tr key={c.id}>
                <td>{fmtDate(c.given_on)}</td><td>{c.given_by || <span className="muted">—</span>}</td><td>{c.note || <span className="muted">—</span>}</td>
                <td className="r"><Money v={c.amount} /></td>
                <td style={{ textAlign: 'right' }}>{canWrite && <button className="btn sm danger" disabled={busy} onClick={() => deleteCash(c)}>Delete</button>}</td>
              </tr>
            ))}
            {data.cash.length === 0 && <tr><td colSpan={5}><div className="empty">No cash given yet.</div></td></tr>}
          </tbody>
        </table></div>
      </div>

      {give && (
        <Modal title="Give cash" onClose={() => setGive(null)}
          footer={<><button className="btn" onClick={() => setGive(null)}>Cancel</button><button className="btn primary" disabled={busy} onClick={saveCash}>{busy ? 'Saving…' : 'Save'}</button></>}>
          <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
            <Field label="Amount (SAR)"><input className="input num" type="number" inputMode="decimal" min="0" step="0.01" autoFocus value={give.amount} onChange={(e) => setGive({ ...give, amount: e.target.value })} /></Field>
            <Field label="Date given"><DatePicker value={give.date} onChange={(v) => setGive({ ...give, date: v })} /></Field>
            <Field label="Given by"><input className="input" value={give.given_by} onChange={(e) => setGive({ ...give, given_by: e.target.value })} placeholder="Name of the person who gave the cash" /></Field>
            <Field label="Note (optional)"><input className="input" value={give.note} onChange={(e) => setGive({ ...give, note: e.target.value })} placeholder="e.g. Site supplies" /></Field>
          </div>
        </Modal>
      )}

      {reject && (
        <Modal title="Reject receipt" onClose={() => setReject(null)}
          footer={<><button className="btn" onClick={() => setReject(null)}>Cancel</button><button className="btn danger" disabled={busy} onClick={() => review(reject.id, 'rejected', reject.reason)}>Reject</button></>}>
          <p className="muted" style={{ marginBottom: 12 }}>It stops counting against the balance and the employee sees your reason, then uploads it again.</p>
          <Field label="Reason"><input className="input" autoFocus value={reject.reason} onChange={(e) => setReject({ ...reject, reason: e.target.value })} placeholder="e.g. Photo is blurry, amount not readable" /></Field>
        </Modal>
      )}

      {link && (
        <Modal title="Employee link" onClose={() => setLink(null)}
          footer={<><button className="btn danger" onClick={() => openLink(true)}>New link</button>
            <a className="btn" href={`https://wa.me/?text=${encodeURIComponent(`Petty cash link for ${emp.name}: ${link}`)}`} target="_blank" rel="noreferrer">Send by WhatsApp</a>
            <button className="btn primary" onClick={async () => { try { await navigator.clipboard.writeText(link); toast('Link copied'); } catch { toast('Select the link and copy it', true); } }}>Copy link</button></>}>
          <p className="muted" style={{ marginBottom: 12 }}>Private to {emp.name}. Anyone with this link can upload receipts for them, so send it only to them.</p>
          <input className="input" readOnly value={link} onFocus={(e) => e.target.select()} />
        </Modal>
      )}
    </>
  );
}
