import { SIGNED_BUCKET, supabase } from './supabase';

const MAX_BYTES = 10 * 1024 * 1024;

/** Uploads a signed, scanned slip to the private bucket and records its path on the salary slip. */
export async function uploadSignedSlip(slipId: string, file: File): Promise<void> {
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) throw new Error('Please upload the scan as a PDF file.');
  if (file.size > MAX_BYTES) throw new Error('File is larger than 10 MB.');
  const sb = supabase();

  const { data: path, error: pe } = await sb.rpc('signed_slip_path', { p_slip: slipId });
  if (pe || !path) throw new Error(pe?.message ?? 'Could not determine storage path');

  const { error: ue } = await sb.storage.from(SIGNED_BUCKET).upload(path as string, file, { upsert: true, contentType: 'application/pdf' });
  if (ue) throw new Error(ue.message);

  const { error: re } = await sb.rpc('register_signed_slip', { p_slip: slipId, p_path: path });
  if (re) throw new Error(re.message);
}

/** Opens a short-lived signed URL for a stored signed slip (bucket is private). */
export async function openSignedSlip(path: string): Promise<void> {
  const { data, error } = await supabase().storage.from(SIGNED_BUCKET).createSignedUrl(path, 60);
  if (error || !data) throw new Error(error?.message ?? 'Could not create a link to the document');
  window.open(data.signedUrl, '_blank', 'noopener');
}
