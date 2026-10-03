'use client';
import { useEffect, useRef, useState } from 'react';
import { useApp } from './Providers';
import { Modal } from './ui';
import { ScanDocument } from './ScanDocument';
import { imageToPdf } from '@/lib/pdf';
import { uploadSignedSlip } from '@/lib/slips';

const isPdf = (f: File) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');
const isImage = (f: File) => f.type.startsWith('image/');
const size = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

/** Choose, drag in, or photograph the signed slip. Photos/images are converted to a one-page PDF before upload. */
export function SignedUploadModal({ slipId, hasSigned, onClose, onDone }: {
  slipId: string; hasSigned: boolean; onClose: () => void; onDone: () => void;
}) {
  const { toast, confirmDialog } = useApp();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    if (!file || !isImage(file)) { setPreview(null); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function choose(f: File | undefined | null) {
    if (!f) return;
    if (!isPdf(f) && !isImage(f)) return toast('Please choose a PDF or a photo (JPEG / PNG).', true);
    setFile(f);
  }

  async function upload() {
    if (!file) return;
    if (hasSigned && !(await confirmDialog({ title: 'Replace signed copy?', message: 'A signed copy already exists. Replace it with this file?', confirmLabel: 'Replace', danger: true }))) return;
    setBusy(true);
    try {
      await uploadSignedSlip(slipId, isPdf(file) ? file : await imageToPdf(file));
      toast(hasSigned ? 'Signed copy replaced' : 'Signed copy uploaded');
      onDone(); onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Upload failed', true);
      setBusy(false);
    }
  }

  return (
    <Modal title={hasSigned ? 'Replace signed copy' : 'Upload signed copy'} onClose={busy ? () => {} : onClose}
      footer={<>
        <button className="btn" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!file || busy} onClick={upload}>{busy ? 'Uploading…' : 'Upload'}</button>
      </>}>
      <input ref={fileRef} type="file" accept="application/pdf,.pdf,image/*" hidden onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ''; }} />

      <div className={`dropzone${over ? ' over' : ''}`} role="button" tabIndex={0}
        onClick={() => fileRef.current?.click()}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), fileRef.current?.click())}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); choose(e.dataTransfer.files?.[0]); }}>
        <div className="dropzone-icon">⬆</div>
        <div className="dropzone-title">Drag &amp; drop the signed slip here</div>
        <div className="muted">or click to choose a file · PDF or photo · up to 10 MB</div>
      </div>

      <div className="dropzone-or">or</div>
      <button className="btn block" disabled={busy} onClick={() => setScanning(true)}>📷 Scan document</button>

      {file && (
        <div className="dropzone-file">
          {preview ? <img src={preview} alt="Selected photo" /> : <span className="dropzone-pdf">PDF</span>}
          <div>
            <div className="strong">{file.name}</div>
            <div className="muted">{size(file.size)}{isImage(file) ? ' · will be saved as a PDF' : ''}</div>
          </div>
          <button className="btn sm" disabled={busy} onClick={() => setFile(null)}>Remove</button>
        </div>
      )}
      {scanning && <ScanDocument title="Scan signed slip" onClose={() => setScanning(false)} onScan={(f) => { setScanning(false); choose(f); }} />}
    </Modal>
  );
}
