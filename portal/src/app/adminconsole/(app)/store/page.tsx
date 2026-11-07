'use client';
import '@/app/store.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '@/components/Providers';
import { SignaturePad } from '@/components/SignaturePad';
import { DatePicker, ErrorBox, Field, Loading, Modal, PageHead, Select, SuggestInput } from '@/components/ui';
import { fmtDate, today } from '@/lib/format';
import { useQuery } from '@/lib/hooks';
import { prepareReceipt } from '@/lib/receipt';
import { can } from '@/lib/roles';
import { fetchAll, getCompanyId, supabase, unwrap } from '@/lib/supabase';

const BUCKET = 'store-photos';
const CONDITIONS = ['Good', 'Fair', 'Needs repair', 'Broken', 'Scrap'];
const STATUSES = ['In store', 'Checked out', 'Under repair', 'Missing', 'Disposed'];
const LOCATIONS = ['Store Room', 'Site Container', 'Vehicle'];

interface Row {
  key: string; id?: string; item: string; purchase_date: string; useful_life: string; decommission_date: string; warranty: string; location: string; qty: string; condition: string; status: string;
  attachment: string | null;   // saved storage path
  file?: File;                 // new image, uploaded on Save
  preview?: string;            // what the thumbnail shows (signed URL or local object URL)
}
interface DbRow { id: string; item: string; purchase_date: string | null; useful_life_years: number | null; decommission_date: string | null; warranty: string; location: string; qty: number; condition: string; status: string; attachment: string | null }
interface Check { id: string; checker_name: string; check_date: string; signature: string; row_count: number; created_at: string }

/** The storage bucket takes JPEG/PNG/WebP/HEIC only, so SVG (and anything else) is redrawn as a PNG first. */
async function rasterize(file: File): Promise<File> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, no) => {
      const i = new Image();
      i.onload = () => ok(i); i.onerror = () => no(new Error('Could not read that image.'));
      i.src = url;
    });
    const w = img.naturalWidth || 800, h = img.naturalHeight || 800;
    const k = Math.min(1, 1600 / Math.max(w, h)) || 1;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
    if (!blob) throw new Error('Could not convert that image.');
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.png', { type: 'image/png' });
  } finally { URL.revokeObjectURL(url); }
}
/** Purchase date -> out-of-commission date as "2 y 3 m 5 d". Blank until both dates are filled in. */
function actualLife(from: string, to: string): string {
  if (!from || !to || to < from) return '—';
  const [y1, m1, d1] = from.split('-').map(Number), [y2, m2, d2] = to.split('-').map(Number);
  let months = (y2 - y1) * 12 + (m2 - m1);
  let days = d2 - d1;
  if (days < 0) { months -= 1; days += new Date(Date.UTC(y2, m2 - 1, 0)).getUTCDate(); }
  const y = Math.floor(months / 12), m = months % 12;
  const out = [y && `${y} y`, m && `${m} m`, days && `${days} d`].filter(Boolean).join(' ');
  return out || '0 d';
}
const HEADS: [string, boolean][] = [
  ['Item', false], ['Date of purchase', false], ['Warranty', false], ['Useful life (yrs)', true], ['Date out of commission', false], ['Total actual life', false],
  ['Location', false], ['Qty', true], ['Condition', false], ['Status', false], ['Attachment', false], ['', false],
];
const DEFAULT_WIDTHS = [14, 9, 9, 5.5, 9, 8.5, 10, 4.5, 8, 8, 10, 4.5];   // % of the table, always totals 100
const MIN_W = 2.5;
const WIDTH_KEY = 'hbc-store-col-widths-v2';
const NATIVE = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

const blank = (): Row => ({ key: crypto.randomUUID(), item: '', purchase_date: '', useful_life: '', decommission_date: '', warranty: '', location: '', qty: '1', condition: 'Good', status: 'In store', attachment: null });

export default function StorePage() {
  const { profile, toast, confirmDialog } = useApp();
  const canWrite = can(profile!.role, 'store:write');
  const sb = supabase();

  const { data, error, loading, reload } = useQuery(async () => {
    const items = await fetchAll<DbRow>((a, b) => sb.from('store_items').select('*').order('sort_order').order('updated_at').range(a, b));
    const checks = unwrap(await sb.from('store_checks').select('id, checker_name, check_date, signature, row_count, created_at')
      .order('created_at', { ascending: false }).limit(10)) as Check[];
    const paths = items.map((i) => i.attachment).filter((p): p is string => !!p);
    const urls = new Map<string, string>();
    if (paths.length) {
      const { data: signed } = await sb.storage.from(BUCKET).createSignedUrls(paths, 3600);
      signed?.forEach((s) => { if (s.path && s.signedUrl) urls.set(s.path, s.signedUrl); });
    }
    const rows: Row[] = items.map((i) => ({
      key: i.id, id: i.id, item: i.item, purchase_date: i.purchase_date ?? '', useful_life: i.useful_life_years == null ? '' : String(i.useful_life_years), decommission_date: i.decommission_date ?? '', warranty: i.warranty ?? '', location: i.location, qty: String(i.qty), condition: i.condition, status: i.status,
      attachment: i.attachment, preview: i.attachment ? urls.get(i.attachment) : undefined,
    }));
    return { rows, checks };
  }, []);

  const [rows, setRows] = useState<Row[]>([]);
  const [dirty, setDirty] = useState(false);
  const [signing, setSigning] = useState(false);
  const [q, setQ] = useState('');
  const tableRef = useRef<HTMLTableElement>(null);
  const [widths, setWidths] = useState<number[]>(DEFAULT_WIDTHS);
  useEffect(() => {
    try {
      const w = JSON.parse(localStorage.getItem(WIDTH_KEY) ?? 'null');
      if (Array.isArray(w) && w.length === DEFAULT_WIDTHS.length && w.every((x) => typeof x === 'number' && x > 0)) setWidths(w);
    } catch { /* storage unavailable */ }
  }, []);
  const saveWidths = (w: number[]) => { try { localStorage.setItem(WIDTH_KEY, JSON.stringify(w)); } catch { /* ignore */ } };
  function resetWidths() { setWidths(DEFAULT_WIDTHS); try { localStorage.removeItem(WIDTH_KEY); } catch { /* ignore */ } }
  /** Dragging a column edge moves width between that column and its right neighbour, so the table never gets wider than the screen. */
  function startResize(e: React.PointerEvent, i: number) {
    e.preventDefault();
    const tw = tableRef.current?.offsetWidth ?? 1;
    const x0 = e.clientX, start = widths;
    let latest = start;
    const move = (ev: PointerEvent) => {
      const d = ((ev.clientX - x0) / tw) * 100;
      const pair = start[i] + start[i + 1];
      const a = Math.min(pair - MIN_W, Math.max(MIN_W, start[i] + d));
      latest = start.map((w, k) => (k === i ? a : k === i + 1 ? pair - a : w));
      setWidths(latest);
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); saveWidths(latest); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});

  // this page uses the whole width of the screen (the shared layout normally adds side margins)
  useEffect(() => { document.body.classList.add('store-wide'); return () => document.body.classList.remove('store-wide'); }, []);
  useEffect(() => { if (data) { setRows(data.rows); setDirty(false); } }, [data]);
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const locations = useMemo(() => Array.from(new Set([...LOCATIONS, ...rows.map((r) => r.location.trim()).filter(Boolean)])).sort(), [rows]);
  const edit = (key: string, patch: Partial<Row>) => { setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r))); setDirty(true); };

  function pickImage(key: string, f: File | undefined) {
    if (!f) return;
    if (!f.type.startsWith('image/')) return toast('Choose an image file', true);
    const old = rows.find((r) => r.key === key);
    if (old?.file && old.preview) URL.revokeObjectURL(old.preview);
    edit(key, { file: f, preview: URL.createObjectURL(f) });
  }
  const removeImage = (key: string) => edit(key, { file: undefined, preview: undefined, attachment: null });

  async function removeRow(r: Row) {
    if (r.item.trim() && !(await confirmDialog({ title: 'Delete row?', message: `“${r.item}” is removed from the sheet when you Save.`, confirmLabel: 'Delete', danger: true }))) return;
    setRows((rs) => rs.filter((x) => x.key !== r.key)); setDirty(true);
  }

  function startSave() {
    if (rows.length === 0) return toast('Add at least one row before saving', true);
    const bad = rows.findIndex((r) => !r.item.trim());
    if (bad >= 0) return toast(`Row ${bad + 1} has no item name`, true);
    if (rows.some((r) => r.useful_life.trim() !== '' && !(Number(r.useful_life) >= 0))) return toast('Useful life must be a number of years, 0 or more', true);
    const early = rows.findIndex((r) => r.purchase_date && r.decommission_date && r.decommission_date < r.purchase_date);
    if (early >= 0) return toast(`Row ${early + 1}: out-of-commission date is before the purchase date`, true);
    if (rows.some((r) => !(Number(r.qty) >= 0) || r.qty.trim() === '')) return toast('Quantity must be a number, 0 or more', true);
    setSigning(true);
  }

  async function save(checker: string, date: string, signature: string) {
    const co = getCompanyId();
    if (!co) throw new Error('No company selected');
    const payload = [];
    for (const r of rows) {
      let attachment = r.attachment;
      if (r.file) {
        const p = await prepareReceipt(NATIVE.includes(r.file.type) ? r.file : await rasterize(r.file));
        const path = `${co}/${crypto.randomUUID()}.${p.ext}`;
        const up = await sb.storage.from(BUCKET).upload(path, p.blob, { contentType: p.type });
        if (up.error) throw new Error(`Image upload failed: ${up.error.message}`);
        attachment = path;
      }
      payload.push({ id: r.id ?? null, item: r.item.trim(), purchase_date: r.purchase_date || null, useful_life_years: r.useful_life.trim() === '' ? null : Number(r.useful_life), decommission_date: r.decommission_date || null, warranty: r.warranty.trim(), location: r.location.trim(), qty: Number(r.qty), condition: r.condition, status: r.status, attachment });
    }
    const res = await sb.rpc('store_save', { p_rows: payload, p_checker: checker, p_date: date, p_signature: signature });
    if (res.error) throw new Error(res.error.message);
    const unused = (res.data as string[]) ?? [];
    if (unused.length) await sb.storage.from(BUCKET).remove(unused);
    toast(`Saved · checked by ${checker}`);
    setSigning(false); setDirty(false); reload();
  }

  const shown = rows.filter((r) => !q.trim() || `${r.item} ${r.location} ${r.status}`.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <>
      <PageHead eyebrow="Store" title="Store Inventory" sub="Edit the table, then Save with the checker's name, date and signature">
        {canWrite && <button className="btn" onClick={() => { setRows((rs) => [...rs, blank()]); setDirty(true); }}>＋ Add row</button>}
        {canWrite && <button className="btn primary" disabled={!dirty && rows.length === 0} onClick={startSave}>Save</button>}
      </PageHead>
      {error && <ErrorBox error={error} />}

      <div className="panel flush">
        <div className="panel-head">
          <div className="toolbar"><input className="input" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <div className="store-bar">
            {dirty && <span className="store-dirty">Unsaved changes</span>}
            <button className="btn sm" onClick={resetWidths}>Reset columns</button>
            <span className="muted">{rows.length} items</span>
          </div>
        </div>
        {loading && !data ? <Loading /> : (
          <div className="table-wrap">
            <table className="table store-sheet" ref={tableRef}>
              <colgroup>{widths.map((w, i) => <col key={i} style={{ width: `${w}%` }} />)}</colgroup>
              <thead><tr>
                {HEADS.map(([label, right], i) => (
                  <th key={label || 'del'} className={right ? 'r' : ''}>
                    {label}
                    {i < HEADS.length - 1 && <span className="col-grip" onPointerDown={(e) => startResize(e, i)} onDoubleClick={resetWidths} title="Drag to resize · double-click to reset" />}
                  </th>
                ))}
              </tr></thead>
              <tbody>
                {shown.length === 0 && <tr><td colSpan={12} className="empty">{rows.length ? 'No rows match.' : 'The table is empty. Add a row to start.'}</td></tr>}
                {shown.map((r) => (
                  <tr key={r.key}>
                    <td><input className="input" value={r.item} disabled={!canWrite} onChange={(e) => edit(r.key, { item: e.target.value })} placeholder="Item" /></td>
                    <td>{canWrite ? <DatePicker value={r.purchase_date} onChange={(v) => edit(r.key, { purchase_date: v })} /> : fmtDate(r.purchase_date)}</td>
                    <td><input className="input" value={r.warranty} disabled={!canWrite} onChange={(e) => edit(r.key, { warranty: e.target.value })} placeholder="e.g. 2 years / none" /></td>
                    <td className="r"><input className="input qty-in" inputMode="decimal" value={r.useful_life} disabled={!canWrite} onChange={(e) => edit(r.key, { useful_life: e.target.value })} placeholder="yrs" /></td>
                    <td>{canWrite ? <DatePicker value={r.decommission_date} onChange={(v) => edit(r.key, { decommission_date: v })} /> : fmtDate(r.decommission_date)}</td>
                    <td><b>{actualLife(r.purchase_date, r.decommission_date)}</b></td>
                    <td>{canWrite
                      ? <SuggestInput value={r.location} onChange={(v) => edit(r.key, { location: v })} options={locations} />
                      : r.location}</td>
                    <td className="r"><input className="input qty-in" inputMode="decimal" value={r.qty} disabled={!canWrite} onChange={(e) => edit(r.key, { qty: e.target.value })} /></td>
                    <td><Select value={r.condition} disabled={!canWrite} onChange={(e) => edit(r.key, { condition: e.target.value })}>{CONDITIONS.map((c) => <option key={c}>{c}</option>)}</Select></td>
                    <td><Select value={r.status} disabled={!canWrite} onChange={(e) => edit(r.key, { status: e.target.value })}>{STATUSES.map((c) => <option key={c}>{c}</option>)}</Select></td>
                    <td>
                      <div className="store-att">
                        {r.preview && <a href={r.preview} target="_blank" rel="noreferrer"><img className="store-thumb" src={r.preview} alt="" /></a>}
                        {canWrite && (
                          <>
                            <input type="file" accept="image/*" ref={(el) => { fileInputs.current[r.key] = el; }} onChange={(e) => { pickImage(r.key, e.target.files?.[0]); e.target.value = ''; }} />
                            <button className="btn sm" onClick={() => fileInputs.current[r.key]?.click()}>{r.preview ? 'Change' : '＋ Image'}</button>
                            {r.preview && <button className="btn sm danger" onClick={() => removeImage(r.key)}>Remove</button>}
                          </>
                        )}
                      </div>
                    </td>
                    <td className="del-cell">{canWrite && (
                      <button className="icon-btn" onClick={() => removeRow(r)} aria-label="Delete row" title="Delete row">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6" /></svg>
                      </button>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {data && data.checks.length > 0 && (
        <div className="panel flush" style={{ marginTop: 18 }}>
          <div className="panel-head"><h3 style={{ margin: 0 }}>Recent checks</h3></div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Date</th><th>Checked by</th><th className="r">Items</th><th>Signature</th><th>Saved</th></tr></thead>
              <tbody>
                {data.checks.map((c) => (
                  <tr key={c.id}>
                    <td>{fmtDate(c.check_date)}</td><td>{c.checker_name}</td><td className="r">{c.row_count}</td>
                    <td><img className="store-sig-img" src={c.signature} alt={`Signature of ${c.checker_name}`} /></td>
                    <td className="muted">{fmtDate(c.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {signing && <SignModal count={rows.length} onClose={() => setSigning(false)} onSave={save} />}
    </>
  );
}

function SignModal({ count, onClose, onSave }: { count: number; onClose: () => void; onSave: (name: string, date: string, sig: string) => Promise<void> }) {
  const { toast } = useApp();
  const [name, setName] = useState(''), [date, setDate] = useState(today()), [sig, setSig] = useState('');
  const [busy, setBusy] = useState(false);
  async function go() {
    if (!name.trim()) return toast('Enter the name of the inventory checker', true);
    if (!date) return toast('Enter the date', true);
    if (!sig) return toast('Please sign in the box', true);
    setBusy(true);
    try { await onSave(name.trim(), date, sig); } catch (e) { toast(e instanceof Error ? e.message : String(e), true); setBusy(false); }
  }
  return (
    <Modal title="Sign off and save" onClose={busy ? () => {} : onClose} footer={
      <><button className="btn" disabled={busy} onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={go}>{busy ? 'Saving…' : 'Save inventory'}</button></>
    }>
      <p className="muted" style={{ marginTop: 0 }}>Saving {count} item{count === 1 ? '' : 's'}. This is recorded with your name, date and signature.</p>
      <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
        <Field label="Inventory checker (name)"><input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        <Field label="Date"><DatePicker value={date} onChange={setDate} /></Field>
        <Field label="Signature"><SignaturePad onChange={setSig} /></Field>
      </div>
    </Modal>
  );
}
