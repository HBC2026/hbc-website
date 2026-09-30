'use client';
import { useRef, useState } from 'react';
import { useApp } from './Providers';
import { openSignedSlip, uploadSignedSlip } from '@/lib/slips';
import { can } from '@/lib/roles';

export function SlipUpload({ slipId, hasSigned, onDone, small }: { slipId: string; hasSigned: boolean; onDone: () => void; small?: boolean }) {
  const { toast, profile, confirmDialog } = useApp();
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  if (!can(profile!.role, 'payroll:write')) return null;

  async function pick(f: File | undefined) {
    if (!f) return;
    if (hasSigned && !(await confirmDialog({ title: 'Replace signed copy?', message: 'A signed copy already exists. Replace it with this file?', confirmLabel: 'Replace', danger: true }))) { if (ref.current) ref.current.value = ''; return; }
    setBusy(true);
    try { await uploadSignedSlip(slipId, f); toast(hasSigned ? 'Signed copy replaced' : 'Signed copy uploaded'); onDone(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Upload failed', true); }
    finally { setBusy(false); if (ref.current) ref.current.value = ''; }
  }

  return (
    <>
      <input ref={ref} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => pick(e.target.files?.[0])} />
      <button className={`btn${small ? ' sm' : ''}`} disabled={busy} onClick={() => ref.current?.click()}>
        {busy ? 'Uploading…' : hasSigned ? 'Replace Signed Copy' : 'Upload Signed Copy'}
      </button>
    </>
  );
}

export function ViewSigned({ path, small }: { path: string; small?: boolean }) {
  const { toast } = useApp();
  return <button className={`btn${small ? ' sm' : ''}`} onClick={() => openSignedSlip(path).catch((e) => toast(e.message, true))}>View Signed Copy</button>;
}
