'use client';
import { useEffect, useRef, useState } from 'react';
import { useApp } from './Providers';
import { Modal } from './ui';
import { ScanDocument } from './ScanDocument';
import { imageToPdf } from '@/lib/pdf';
import { uploadSignedSlip } from '@/lib/slips';

const isPdf = (f: File) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');
const isImage = (f: File) => f.type.startsWith('image/');

/** Scan the signed slip with the camera (same flow as petty cash receipts) or choose a photo / PDF. Photos are saved as a one-page PDF. */
export function SignedUploadModal({ slipId, hasSigned, onClose, onDone }: {
  slipId: string; hasSigned: boolean; onClose: () => void; onDone: () => void;
}) {
  const { toast, confirmDialog } = useApp();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    if (!file || !isImage(file)) { setPreview(''); return; }
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
      <input ref={fileRef} type="file" accept="image/*,application/pdf" hidden onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ''; }} />
      <button type="button" className="pc-photo" disabled={busy} onClick={() => setScanning(true)}>
        {preview ? <img src={preview} alt="Signed slip preview" /> : file ? <span>📄 {file.name}</span> : <span>📷<br />Scan the signed slip</span>}
      </button>
      <button type="button" className="btn block" style={{ marginTop: 8 }} disabled={busy} onClick={() => fileRef.current?.click()}>
        {file ? 'Choose a different file' : 'Or choose a photo / PDF'}
      </button>
      {scanning && <ScanDocument title="Scan signed slip" originalOnly onClose={() => setScanning(false)} onScan={(f) => { setScanning(false); choose(f); }} />}
    </Modal>
  );
}
