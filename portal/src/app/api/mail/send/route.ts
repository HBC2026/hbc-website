import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import type Mail from 'nodemailer/lib/mailer';
import { cleanHtml, htmlToText } from '@/lib/mail/html';
import { authorize, folderPath, imapClient, json, mailErrorText } from '@/lib/mail/server';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_UPLOAD = 3 * 1024 * 1024;       // uploaded files; with the HTML this stays under the serverless request-body limit
const MAX_FORWARD = 10 * 1024 * 1024;     // attachments carried over from a forwarded message
const MAX_HTML = 1_500_000;               // editor HTML incl. pasted images (base64)
const MAX_INLINE_IMAGES = 10;
const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** "a@x.com, b@y.com" -> validated list (max 20). Returns null when any entry is not an email address. */
function parseList(v: FormDataEntryValue | null): string[] | null {
  const items = String(v ?? '').split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
  if (items.length > 20 || items.some((s) => !EMAIL.test(s))) return null;
  return items;
}

export async function POST(req: Request) {
  const a = await authorize(req);
  if (a instanceof Response) return a;
  const { sb, cfg, companyId } = a;

  let form: FormData;
  try { form = await req.formData(); } catch { return json({ error: 'The message could not be read.' }, 400); }
  const to = parseList(form.get('to'));
  const cc = parseList(form.get('cc'));
  const bcc = parseList(form.get('bcc'));
  if (!to || !to.length) return json({ error: 'Enter at least one valid recipient in To.' }, 400);
  if (!cc) return json({ error: 'One of the Cc addresses is not valid.' }, 400);
  if (!bcc) return json({ error: 'One of the Bcc addresses is not valid.' }, 400);
  const subject = String(form.get('subject') ?? '').trim().replace(/[\r\n]+/g, ' ').slice(0, 300);
  if (!subject) return json({ error: 'Add a subject.' }, 400);

  // The editor sends HTML. Plain `body` is still accepted for simple callers.
  const rawHtml = String(form.get('html') ?? '') || `<div style="white-space:pre-wrap">${esc(String(form.get('body') ?? ''))}</div>`;
  if (rawHtml.length > MAX_HTML) return json({ error: 'The message is too large. Remove some images and try again.' }, 413);
  const safe = cleanHtml(rawHtml);
  const text = htmlToText(safe);

  // pasted / inserted images (data: URIs) become real inline images so every mail app shows them
  const inline: Mail.Attachment[] = [];
  const html = safe.replace(/src=(["'])data:(image\/(png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=]+)\1/gi, (_m, q: string, type: string, ext: string, b64: string) => {
    if (inline.length >= MAX_INLINE_IMAGES) return 'src=""';
    const cid = `img${inline.length + 1}-${randomUUID()}@hbc`;
    inline.push({ filename: `image${inline.length + 1}.${ext.toLowerCase().replace('jpeg', 'jpg')}`, content: Buffer.from(b64, 'base64'), contentType: type, cid, contentDisposition: 'inline' });
    return `src=${q}cid:${cid}${q}`;
  });

  // reply threading: only well-formed Message-IDs are accepted
  const idOk = (s: string) => /^<[^<>\s]{1,300}>$/.test(s);
  const inReplyTo = String(form.get('in_reply_to') ?? '').trim();
  const refs = String(form.get('references') ?? '').split(/\s+/).filter(idOk).slice(-20);

  const files = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
  if (files.reduce((n, f) => n + f.size, 0) > MAX_UPLOAD) return json({ error: 'Attachments are larger than 3 MB in total.' }, 413);
  const attachments: Mail.Attachment[] = await Promise.all(files.map(async (f) => ({
    filename: f.name.replace(/[\r\n"]+/g, '_').slice(0, 150), content: Buffer.from(await f.arrayBuffer()), contentType: f.type || undefined,
  })));

  // attachments of a forwarded message, read from private storage as the signed-in administrator (RLS applies)
  const fwdIds = String(form.get('forward_ids') ?? '').split(',').map((s) => s.trim()).filter((s) => UUID.test(s)).slice(0, 20);
  if (fwdIds.length) {
    const { data: rows } = await sb.from('mail_attachments').select('filename,content_type,size,storage_path').in('id', fwdIds).eq('company_id', companyId);
    if ((rows ?? []).reduce((n, r) => n + Number(r.size), 0) > MAX_FORWARD) return json({ error: 'The forwarded attachments are larger than 10 MB in total.' }, 413);
    for (const r of rows ?? []) {
      const dl = await sb.storage.from('mail-attachments').download(r.storage_path);
      if (dl.error || !dl.data) return json({ error: `The attachment ${r.filename} could not be read.` }, 502);
      attachments.push({ filename: r.filename, content: Buffer.from(await dl.data.arrayBuffer()), contentType: r.content_type || undefined });
    }
  }

  if (!text.trim() && !inline.length && !attachments.length) return json({ error: 'The message is empty.' }, 400);

  const mail = new MailComposer({
    from: { name: cfg.fromName, address: cfg.user },
    to, cc: cc.length ? cc : undefined, bcc: bcc.length ? bcc : undefined, subject,
    text,
    html: `<div style="font-family:Calibri,Arial,sans-serif;font-size:14px;line-height:1.5">${html}</div>`,
    inReplyTo: idOk(inReplyTo) ? inReplyTo : undefined,
    references: refs.length ? refs : undefined,
    attachments: [...inline, ...attachments],
  });
  const raw = await mail.compile().build();

  try {
    const smtp = nodemailer.createTransport({
      host: cfg.smtpHost, port: cfg.smtpPort, secure: cfg.smtpPort === 465, requireTLS: cfg.smtpPort !== 465,
      auth: { user: cfg.user, pass: cfg.password }, connectionTimeout: 15_000, socketTimeout: 40_000,
    });
    await smtp.sendMail({ envelope: { from: cfg.user, to: [...to, ...cc, ...bcc] }, raw });
  } catch (e) {
    return json({ error: mailErrorText(e) }, 502);
  }

  // Keep a copy in the IONOS Sent folder (also visible in webmail). The message is already sent, so failure here is not an error.
  let saved = true;
  const client = imapClient(cfg);
  try {
    await client.connect();
    const sentPath = await folderPath(client, 'sent');
    if (sentPath) await client.append(sentPath, raw, ['\\Seen']); else saved = false;
    await client.logout();
  } catch {
    saved = false;
    try { client.close(); } catch { /* already closed */ }
  }

  await sb.rpc('mail_audit_send', { p_to: [...to, ...cc, ...bcc].join(', '), p_subject: subject }).then(() => undefined, () => undefined);
  return json({ ok: true, savedToSent: saved });
}
