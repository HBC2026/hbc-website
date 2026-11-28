import { prepareReceipt } from '@/lib/receipt';
import type { supabase } from '@/lib/supabase';

export const STORE_BUCKET = 'store-photos';
/** Photos per item; stored as `attachment` and `attachment2`. */
export const MAX_PHOTOS = 2;
const NATIVE = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

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

/** Shrinks and uploads an item photo; returns the storage path to save with the item. */
export async function uploadStorePhoto(sb: ReturnType<typeof supabase>, folder: string, file: File): Promise<string> {
  const p = await prepareReceipt(NATIVE.includes(file.type) ? file : await rasterize(file));
  const path = `${folder}/${crypto.randomUUID()}.${p.ext}`;
  const up = await sb.storage.from(STORE_BUCKET).upload(path, p.blob, { contentType: p.type });
  if (up.error) throw new Error(`Image upload failed: ${up.error.message}`);
  return path;
}
