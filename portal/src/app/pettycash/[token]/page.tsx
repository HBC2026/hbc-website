'use client';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Money } from '@/components/Money';
import { DatePicker } from '@/components/ui';
import { fmtDate, today } from '@/lib/format';
import { prepareReceipt } from '@/lib/receipt';
import { isConfigured, PETTY_BUCKET, supabase } from '@/lib/supabase';
import type { PcStatement, ReceiptStatus } from '@/lib/types';

const TONE: Record<ReceiptStatus, string> = { pending: 'gold', approved: 'green', rejected: 'red' };
const LABEL: Record<ReceiptStatus, string> = { pending: 'Waiting for approval', approved: 'Approved', rejected: 'Rejected – upload again' };

type Entry =
  | { kind: 'cash'; id: string; date: string; amount: number; note: string; by: string }
  | { kind: 'receipt'; id: string; date: string; amount: number; description: string; status: ReceiptStatus; reason: string };

/** The employee's private petty cash page. The token in the URL is the only credential. */
export default function EmployeePettyCash() {
  const { token } = useParams<{ token: string }>();
  const [st, setSt] = useState<PcStatement | null | undefined>(undefined);   // undefined = loading, null = invalid link
  const [fetchError, setFetchError] = useState('');
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    if (!isConfigured) return;
    const { data, error } = await supabase().rpc('pc_statement', { p_token: token });
    if (error) { setFetchError(error.message); return; }
    setFetchError('');
    setSt((data as PcStatement | null) ?? null);
  }, [token]);
  useEffect(() => { load(); }, [load]);

  // one list, oldest first to build the running balance, shown newest first
  const entries = useMemo(() => {
    if (!st) return [];
    const list: Entry[] = [
      ...st.cash.map((c) => ({ kind: 'cash' as const, id: c.id, date: c.date, amount: Number(c.amount), note: c.note, by: c.given_by })),
      ...st.receipts.map((r) => ({ kind: 'receipt' as const, id: r.id, date: r.date, amount: Number(r.amount), description: r.description, status: r.status, reason: r.reject_reason })),
    ].sort((a, b) => a.date.localeCompare(b.date) || (a.kind === b.kind ? 0 : a.kind === 'cash' ? -1 : 1));
    let run = 0;
    return list.map((e) => {
      if (e.kind === 'cash') run += e.amount; else if (e.status !== 'rejected') run -= e.amount;
      return { e, run };
    }).reverse();
  }, [st]);

  async function remove(id: string, ask = true): Promise<boolean> {
    if (ask && !window.confirm('Remove this receipt?')) return false;
    const { error } = await supabase().rpc('pc_delete_receipt', { p_token: token, p_id: id });
    if (error) { setFetchError(error.message); return false; }
    load();
    return true;
  }

  if (!isConfigured) return <div className="pc-wrap"><div className="pc-card">The portal is not configured.</div></div>;
  if (st === undefined && !fetchError) return <div className="pc-wrap"><div className="pc-card pc-center">Loading…</div></div>;
  if (st === null) {
    return (
      <div className="pc-wrap"><div className="pc-card pc-center">
        <h1>Link not valid</h1>
        <p>This petty cash link is no longer active. Please ask the office for a new one.</p>
      </div></div>
    );
  }
  if (!st) return <div className="pc-wrap"><div className="pc-card"><div className="banner error">{fetchError}</div><button className="btn block" onClick={load}>Try again</button></div></div>;

  return (
    <div className="pc-wrap">
      <header className="pc-head">
        <div className="pc-co">{st.company}</div>
        <h1>{st.name}</h1>
        <div className="pc-sub">Petty cash · {st.emp_code}</div>
      </header>

      {fetchError && <div className="banner error">{fetchError}</div>}

      <section className="pc-card pc-balance">
        <div className="pc-bal-label">Your balance</div>
        <div className="pc-bal-num" style={{ color: st.balance < 0 ? 'var(--red)' : undefined }}><Money v={st.balance} /></div>
        <div className="pc-split">
          <div><span>Cash given</span><strong><Money v={st.given} /></strong></div>
          <div><span>Receipts</span><strong><Money v={st.spent} /></strong></div>
        </div>
        {st.balance < 0 && <div className="pc-note">You have spent more than you were given. The office will settle the difference.</div>}
      </section>

      {st.active
        ? <button className="btn primary block pc-add" onClick={() => setAdding(true)}>＋ Add a receipt</button>
        : <div className="banner warn">Your petty cash is closed. Please contact the office.</div>}

      <section className="pc-list">
        <h2>Statement</h2>
        {entries.length === 0 && <div className="pc-card pc-center muted">Nothing yet. When the office gives you cash it appears here.</div>}
        {entries.map(({ e, run }) => (
          <div key={e.kind + e.id} className={`pc-row${e.kind === 'receipt' && e.status === 'rejected' ? ' rejected' : ''}`}>
            <div className="pc-row-main">
              <div className="pc-row-title">{e.kind === 'cash' ? (e.note || 'Cash received') : e.description}</div>
              <div className="pc-row-sub">
                {fmtDate(e.date)}
                {e.kind === 'cash' && e.by && <span>from {e.by}</span>}
                {e.kind === 'receipt' && <span className={`badge ${TONE[e.status]}`}>{LABEL[e.status]}</span>}
              </div>
              {e.kind === 'receipt' && e.status === 'rejected' && e.reason && <div className="pc-reason">Reason: {e.reason}</div>}
              {e.kind === 'receipt' && e.status !== 'approved' && (
                <div className="pc-actions">
                  {e.status === 'rejected' && <button className="btn sm primary" onClick={async () => { if (await remove(e.id, false)) setAdding(true); }}>Upload again</button>}
                  <button className="btn sm danger" onClick={() => remove(e.id)}>Remove</button>
                </div>
              )}
            </div>
            <div className="pc-row-amt">
              <div className={e.kind === 'cash' ? 'pc-in' : 'pc-out'}>{e.kind === 'cash' ? '+' : '−'} <Money v={e.amount} /></div>
              <div className="pc-run">Balance <Money v={run} /></div>
            </div>
          </div>
        ))}
      </section>

      {adding && <AddReceipt token={token} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load(); }} />}
    </div>
  );
}

function AddReceipt({ token, onClose, onSaved }: { token: string; onClose: () => void; onSaved: () => void }) {
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today());
  const [desc, setDesc] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!file || !file.type.startsWith('image/')) { setPreview(''); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!file) return setError('Take or choose a photo of the receipt.');
    if (!(Number(amount) > 0)) return setError('Enter the amount on the receipt.');
    if (!desc.trim()) return setError('Say what you bought.');
    setBusy(true); setError('');
    try {
      const sb = supabase();
      const { blob, type, ext } = await prepareReceipt(file);
      const path = `${token}/${crypto.randomUUID()}.${ext}`;
      const up = await sb.storage.from(PETTY_BUCKET).upload(path, blob, { contentType: type });
      if (up.error) throw new Error('Upload failed: ' + up.error.message);
      const { error: err } = await sb.rpc('pc_add_receipt', { p_token: token, p_amount: Number(amount), p_date: date, p_description: desc.trim(), p_file_path: path });
      if (err) throw new Error(err.message);
      onSaved();
    } catch (ex) {
      setError(ex instanceof Error ? ex.message : String(ex));
      setBusy(false);
    }
  }

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form className="modal pc-modal" onSubmit={submit}>
        <div className="modal-head"><h3>Add a receipt</h3><button type="button" className="modal-x" onClick={onClose} disabled={busy} aria-label="Close">×</button></div>
        <div className="modal-body">
          <input ref={input} type="file" accept="image/*,application/pdf" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <button type="button" className="pc-photo" onClick={() => input.current?.click()}>
            {preview ? <img src={preview} alt="Receipt preview" /> : file ? <span>📄 {file.name}</span> : <span>📷<br />Take or choose a photo of the receipt</span>}
          </button>
          <div className="form-grid" style={{ gridTemplateColumns: '1fr', marginTop: 14 }}>
            <div className="field"><label>Amount on the receipt (SAR)</label>
              <input className="input num" type="number" inputMode="decimal" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
            <div className="field"><label>Date on the receipt</label><DatePicker value={date} onChange={setDate} /></div>
            <div className="field"><label>What was it for?</label>
              <input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="e.g. Diesel for the pickup" /></div>
          </div>
          {error && <div className="banner error" style={{ marginTop: 14, marginBottom: 0 }}>{error}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Uploading…' : 'Submit receipt'}</button>
        </div>
      </form>
    </div>
  );
}
