const MAX_BYTES = 10 * 1024 * 1024;
const MAX_SIDE = 1600;

export interface PreparedReceipt { blob: Blob; type: string; ext: string }

/** Shrinks a phone photo (typically 3-8 MB) to ~300 KB JPEG so it uploads quickly on mobile data. PDFs pass through. */
export async function prepareReceipt(file: File): Promise<PreparedReceipt> {
  if (file.type === 'application/pdf') {
    if (file.size > MAX_BYTES) throw new Error('That PDF is larger than 10 MB.');
    return { blob: file, type: file.type, ext: 'pdf' };
  }
  if (!file.type.startsWith('image/')) throw new Error('Choose a photo or PDF of the receipt.');
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * k);
    canvas.height = Math.round(bmp.height * k);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.8));
    if (!blob) throw new Error('no blob');
    return { blob, type: 'image/jpeg', ext: 'jpg' };
  } catch {
    // the browser cannot decode it (e.g. HEIC on desktop Chrome): send the original if it is small enough
    if (file.size > MAX_BYTES) throw new Error('That photo is too large. Try a smaller one.');
    const ext = file.type.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
    return { blob: file, type: file.type, ext };
  }
}
