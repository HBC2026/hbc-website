'use client';
import { useRef, useState } from 'react';
import { useApp } from './Providers';
import { ErrorBox, Field, Loading, Select } from './ui';
import { useQuery } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { EMP_DOC_BUCKET, supabase, unwrap } from '@/lib/supabase';
import type { EmployeeDocument } from '@/lib/types';

const DOC_TYPES = ['Iqama', 'Passport', 'Contract', 'Medical / Insurance', 'Certificate', 'Photo', 'Other'];
const MAX_BYTES = 15 * 1024 * 1024;
const ALLOWED = /\.(pdf|png|jpe?g|webp|heic|docx?|xlsx?)$/i;

const fmtSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Document box on the employee profile: iqama copy, passport, contract, etc. Files live in a private bucket. */
export function EmployeeDocuments({ employeeId, canWrite }: { employeeId: string; canWrite: boolean }) {
  const { company, toast, confirmDialog } = useApp();
  const sb = supabase();
  const fileRef = useRef<HTMLInputElement>(null);
  const [type, setType] = useState(DOC_TYPES[0]);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const docs = useQuery(async () =>
    unwrap(await sb.from('employee_documents').select('*').eq('employee_id', employeeId).order('created_at', { ascending: false })) as EmployeeDocument[], [employeeId]);

  async function upload(file: File | undefined | null) {
    if (!file || !company) return;
    if (!ALLOWED.test(file.name)) return toast('Choose a PDF, photo, Word or Excel file.', true);
    if (file.size > MAX_BYTES) return toast('File is larger than 15 MB.', true);
    setBusy(true);
    const safe = file.name.replace(/[^\w.\- ]+/g, '_').slice(-80);
    const path = `${company.id}/${employeeId}/${crypto.randomUUID()}-${safe}`;
    const up = await sb.storage.from(EMP_DOC_BUCKET).upload(path, file, { contentType: file.type || undefined });
    if (up.error) { setBusy(false); return toast(up.error.message, true); }
    const ins = await sb.from('employee_documents').insert({
      employee_id: employeeId, doc_type: type, title: title.trim(), file_path: path, file_name: file.name, file_size: file.size,
    });
    if (ins.error) {
      await sb.storage.from(EMP_DOC_BUCKET).remove([path]);
      setBusy(false); return toast(ins.error.message, true);
    }
    setBusy(false); setTitle('');
    toast('Document uploaded'); docs.reload();
  }

  async function open(d: EmployeeDocument) {
    const { data, error } = await sb.storage.from(EMP_DOC_BUCKET).createSignedUrl(d.file_path, 60);
    if (error || !data) return toast(error?.message ?? 'Could not open the document', true);
    window.open(data.signedUrl, '_blank', 'noopener');
  }

  async function remove(d: EmployeeDocument) {
    if (!(await confirmDialog({ title: 'Delete document?', message: `Delete ${d.title || d.file_name}? This cannot be undone.`, confirmLabel: 'Delete', danger: true }))) return;
    const del = await sb.from('employee_documents').delete().eq('id', d.id);
    if (del.error) return toast(del.error.message, true);
    await sb.storage.from(EMP_DOC_BUCKET).remove([d.file_path]);
    toast('Document deleted'); docs.reload();
  }

  return (
    <div className="panel flush">
      {canWrite && (
        <div className="panel-head">
          <div className="toolbar">
            <Field label="Type"><Select className="select" style={{ width: 180 }} value={type} onChange={(e) => setType(e.target.value)}>
              {DOC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </Select></Field>
            <Field label="Title (optional)"><input className="input" style={{ width: 240 }} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Iqama front & back" /></Field>
            <input ref={fileRef} type="file" hidden accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,.doc,.docx,.xls,.xlsx" onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} />
            <button className="btn primary" style={{ alignSelf: 'flex-end' }} disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? 'Uploading…' : '＋ Upload document'}</button>
          </div>
        </div>
      )}
      {docs.error && <ErrorBox error={docs.error} />}
      {docs.loading ? <Loading /> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Type</th><th>Title</th><th>File</th><th className="r">Size</th><th>Uploaded</th><th /></tr></thead>
          <tbody>
            {(docs.data ?? []).map((d) => (
              <tr key={d.id}>
                <td><span className="badge">{d.doc_type}</span></td>
                <td className="strong">{d.title || '—'}</td>
                <td className="muted">{d.file_name}</td>
                <td className="r muted">{fmtSize(d.file_size)}</td>
                <td>{fmtDate(d.created_at)}</td>
                <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                  <button className="btn sm" onClick={() => open(d)}>Open</button>{' '}
                  {canWrite && <button className="btn sm danger" onClick={() => remove(d)}>Delete</button>}
                </td>
              </tr>
            ))}
            {(docs.data ?? []).length === 0 && <tr><td colSpan={6}><div className="empty">No documents uploaded yet.</div></td></tr>}
          </tbody>
        </table></div>
      )}
    </div>
  );
}
