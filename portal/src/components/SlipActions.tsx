'use client';
import { useState } from 'react';
import { useApp } from './Providers';
import { SignedUploadModal } from './SignedUploadModal';
import { openSignedSlip } from '@/lib/slips';
import { can } from '@/lib/roles';

export function SlipUpload({ slipId, hasSigned, onDone, small }: { slipId: string; hasSigned: boolean; onDone: () => void; small?: boolean }) {
  const { profile } = useApp();
  const [open, setOpen] = useState(false);
  if (!can(profile!.role, 'payroll:write')) return null;

  return (
    <>
      <button className={`btn${small ? ' sm' : ''}`} onClick={() => setOpen(true)}>
        {hasSigned ? 'Replace Signed Copy' : 'Upload Signed Copy'}
      </button>
      {open && <SignedUploadModal slipId={slipId} hasSigned={hasSigned} onClose={() => setOpen(false)} onDone={onDone} />}
    </>
  );
}

export function ViewSigned({ path, small }: { path: string; small?: boolean }) {
  const { toast } = useApp();
  return <button className={`btn${small ? ' sm' : ''}`} onClick={() => openSignedSlip(path).catch((e) => toast(e.message, true))}>View Signed Copy</button>;
}
