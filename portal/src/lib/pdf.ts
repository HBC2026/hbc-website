/** Builds a one-page PDF whose page is exactly the JPEG (page width 595 pt, height follows the image). No dependencies. */
export function buildImagePdf(jpeg: Uint8Array, width: number, height: number): Uint8Array {
  const pageW = 595;
  const pageH = Math.max(1, Math.round((pageW * height) / width));
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let len = 0;
  const push = (u: Uint8Array) => { parts.push(u); len += u.length; };
  const str = (s: string) => push(enc.encode(s));
  const obj = (n: number, body: () => void) => { offsets[n] = len; str(`${n} 0 obj\n`); body(); str('\nendobj\n'); };

  const content = `q ${pageW} 0 0 ${pageH} 0 0 cm /Im0 Do Q`;
  str('%PDF-1.4\n');
  obj(1, () => str('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => str('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'));
  obj(3, () => str(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`));
  obj(4, () => {
    str(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
    push(jpeg);
    str('\nendstream');
  });
  obj(5, () => str(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));

  const xref = len;
  str('xref\n0 6\n0000000000 65535 f \n');
  for (let n = 1; n <= 5; n++) str(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  str(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(len);
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}

const MAX_SIDE = 2200;

/** Converts a photo/image file into a single-page PDF File (JPEG, longest side capped at 2200 px, EXIF rotation applied). */
export async function imageToPdf(file: File): Promise<File> {
  let bmp: ImageBitmap;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { throw new Error('This image format is not supported. Use a JPEG or PNG photo, or a PDF.'); }

  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not process the image in this browser.');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();

  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
  if (!blob) throw new Error('Could not process the image in this browser.');
  const pdf = buildImagePdf(new Uint8Array(await blob.arrayBuffer()), w, h);
  const base = file.name.replace(/\.[^.]+$/, '') || 'signed-slip';
  return new File([pdf.buffer as ArrayBuffer], `${base}.pdf`, { type: 'application/pdf' });
}
