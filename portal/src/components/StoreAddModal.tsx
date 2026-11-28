'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '@/components/Providers';
import { DatePicker, Field, Modal, Select, SuggestInput } from '@/components/ui';
import { STORE_BUCKET, uploadStorePhoto } from '@/lib/storePhoto';
import { getCompanyId, supabase } from '@/lib/supabase';

export interface NewStoreItem {
  item: string; description: string; qty: string; location: string; condition: string; status: string;
  purchase_date: string; warranty: string; useful_life: string;
}
export interface AddedStoreItem extends NewStoreItem { id: string; attachment: string | null; preview?: string }

const empty = (location = ''): NewStoreItem => ({ item: '', description: '', qty: '1', location, condition: 'Good', status: 'In store', purchase_date: '', warranty: '', useful_life: '' });

/** One item, saved the moment it is submitted. Built for a phone held in the store: camera first, big buttons. */
export function StoreAddModal({ locations, conditions, statuses, onAdded, onClose }: {
  locations: string[]; conditions: string[]; statuses: string[]; onAdded: (item: AddedStoreItem) => void; onClose: () => void;
}) {
  const { toast, confirmDialog } = useApp();
  const [form, setForm] = useState<NewStoreItem>(empty);
  const [photo, setPhoto] = useState<{ file: File; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const name = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<NewStoreItem>) => setForm((f) => ({ ...f, ...patch }));

  // object URLs not handed to the sheet are released
  const url = useRef<string | null>(null);
  const showPhoto = (file: File | null) => {
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = file ? URL.createObjectURL(file) : null;
    setPhoto(file ? { file, url: url.current! } : null);
  };
  useEffect(() => () => { if (url.current) URL.revokeObjectURL(url.current); }, []);

  function pick(input: HTMLInputElement) {
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    if (!f.type.startsWith('image/')) return toast('Choose an image file', true);
    showPhoto(f);
  }

  const started = !!(form.item.trim() || form.description.trim() || form.warranty.trim() || photo);
  const close = useCallback(async () => {
    if (busy) return;
    // a stray tap outside the form must not throw away a photo already taken
    if (started && !(await confirmDialog({ title: 'Discard this item?', message: 'It has not been saved yet.', confirmLabel: 'Discard', danger: true }))) return;
    onClose();
  }, [busy, started, confirmDialog, onClose]);

  async function save(another: boolean) {
    if (!form.item.trim()) { name.current?.focus(); return toast('Enter the item name', true); }
    if (form.qty.trim() === '' || !(Number(form.qty) >= 0)) return toast('Quantity must be a number, 0 or more', true);
    if (form.useful_life.trim() !== '' && !(Number(form.useful_life) >= 0)) return toast('Useful life must be a number of years, 0 or more', true);
    const company = getCompanyId();
    if (!company) return toast('No company selected', true);
    setBusy(true);
    const sb = supabase();
    let path: string | null = null;
    try {
      if (photo) path = await uploadStorePhoto(sb, company, photo.file);
      const res = await sb.rpc('store_add_item', { p_item: {
        item: form.item.trim(), description: form.description.trim(), qty: Number(form.qty), location: form.location.trim(), condition: form.condition, status: form.status,
        purchase_date: form.purchase_date || null, warranty: form.warranty.trim(),
        useful_life_years: form.useful_life.trim() === '' ? null : Number(form.useful_life), attachment: path,
      } });
      if (res.error) throw new Error(res.error.message);
      onAdded({ ...form, item: form.item.trim(), description: form.description.trim(), location: form.location.trim(), warranty: form.warranty.trim(),
        id: res.data as string, attachment: path, preview: photo ? URL.createObjectURL(photo.file) : undefined });
      toast(`Added “${form.item.trim()}”`);
      if (another) { setForm(empty(form.location)); showPhoto(null); } else onClose();
    } catch (e) {
      if (path) await sb.storage.from(STORE_BUCKET).remove([path]);   // the item was not saved, so neither is its photo
      toast(e instanceof Error ? e.message : String(e), true);
    } finally { setBusy(false); }
  }

  return (
    <Modal title="Add item" onClose={close} footer={
      <>
        <button className="btn" disabled={busy} onClick={() => save(true)}>Save &amp; add another</button>
        <button className="btn primary" disabled={busy} onClick={() => save(false)}>{busy ? 'Saving…' : 'Save item'}</button>
      </>
    }>
      <div className="store-add">
        <div className="store-photo">
          {photo
            ? <img src={photo.url} alt="Photo of the item" />
            : <span className="muted">No photo yet</span>}
        </div>
        <div className="store-photo-actions">
          {/* capture="environment" opens the back camera on a phone; a computer just shows the file picker */}
          <input ref={camera} type="file" accept="image/*" capture="environment" onChange={(e) => pick(e.currentTarget)} />
          <input ref={gallery} type="file" accept="image/*" onChange={(e) => pick(e.currentTarget)} />
          <button type="button" className="btn primary" disabled={busy} onClick={() => camera.current?.click()}>{photo ? 'Retake photo' : 'Take photo'}</button>
          <button type="button" className="btn" disabled={busy} onClick={() => gallery.current?.click()}>Choose from phone</button>
          {photo && <button type="button" className="btn danger" disabled={busy} onClick={() => showPhoto(null)}>Remove</button>}
        </div>

        <div className="store-add-grid">
          <Field label="Item" className="full"><input ref={name} className="input" value={form.item} onChange={(e) => set({ item: e.target.value })} placeholder="e.g. Angle grinder" /></Field>
          <Field label="Short description" className="full"><input className="input" value={form.description} maxLength={200} onChange={(e) => set({ description: e.target.value })} placeholder="e.g. 125mm, with spare discs" /></Field>
          <Field label="Quantity"><input className="input" inputMode="decimal" value={form.qty} onChange={(e) => set({ qty: e.target.value })} /></Field>
          <Field label="Location"><SuggestInput value={form.location} onChange={(v) => set({ location: v })} options={locations} /></Field>
          <Field label="Condition"><Select value={form.condition} onChange={(e) => set({ condition: e.target.value })}>{conditions.map((c) => <option key={c}>{c}</option>)}</Select></Field>
          <Field label="Status"><Select value={form.status} onChange={(e) => set({ status: e.target.value })}>{statuses.map((c) => <option key={c}>{c}</option>)}</Select></Field>
        </div>

        <details className="store-more">
          <summary>More details (optional)</summary>
          <div className="store-add-grid">
            <Field label="Date of purchase"><DatePicker value={form.purchase_date} onChange={(v) => set({ purchase_date: v })} /></Field>
            <Field label="Useful life (years)"><input className="input" inputMode="decimal" value={form.useful_life} onChange={(e) => set({ useful_life: e.target.value })} /></Field>
            <Field label="Warranty" className="full"><input className="input" value={form.warranty} onChange={(e) => set({ warranty: e.target.value })} placeholder="e.g. 2 years / none" /></Field>
          </div>
        </details>
      </div>
    </Modal>
  );
}
