import { htmlToText } from '@/lib/jsa/extractText';
import { authorize, json } from '@/lib/jsa/server';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_BYTES = 4 * 1024 * 1024;        // stays under the serverless request-body limit

export async function POST(req: Request) {
  const a = await authorize(req);
  if (a instanceof Response) return a;
  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get('file');
    if (f instanceof File) file = f;
  } catch { return json({ error: 'Upload a file to read.' }, 400); }
  if (!file) return json({ error: 'No file was uploaded.' }, 400);
  if (file.size > MAX_BYTES) return json({ error: 'The file is larger than 4 MB. Split it or paste the text instead.' }, 413);

  const name = file.name.toLowerCase();
  const buf = Buffer.from(await file.arrayBuffer());
  try {
    let text = '';
    if (name.endsWith('.docx')) {
      const mammoth = await import('mammoth');
      const { value } = await mammoth.convertToHtml({ buffer: buf });
      text = htmlToText(value);
    } else if (name.endsWith('.pdf')) {
      const { extractText, getDocumentProxy } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      const out = await extractText(pdf, { mergePages: true });
      text = (Array.isArray(out.text) ? out.text.join('\n') : out.text).replace(/[ \t]+\n/g, '\n').trim();
    } else if (name.endsWith('.txt') || name.endsWith('.md') || name.endsWith('.csv')) {
      text = buf.toString('utf8');
    } else if (name.endsWith('.doc')) {
      return json({ error: 'Old .doc files are not supported. Save the document as .docx or PDF and upload it again.' }, 415);
    } else {
      return json({ error: 'Supported files: Word (.docx), PDF, or plain text.' }, 415);
    }
    if (text.trim().length < 10) return json({ error: 'No readable text was found. Scanned PDFs need to be converted with OCR first.' }, 422);
    return json({ text: text.slice(0, 200_000), truncated: text.length > 200_000, name: file.name });
  } catch {
    return json({ error: 'The file could not be read. It may be damaged or password protected.' }, 422);
  }
}
