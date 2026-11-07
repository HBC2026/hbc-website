/** Browser-side helpers for the shared inbox: types, calls to /api/mail/*, and attachment download links. */
import { getCompanyId, supabase } from './supabase';

export interface MailAddr { name: string; address: string }

export interface MailListRow {
  id: string; folder: 'inbox' | 'sent'; thread_key: string; message_id: string; in_reply_to: string;
  from_name: string; from_addr: string; to_addrs: MailAddr[]; subject: string; snippet: string;
  sent_at: string; is_read: boolean; has_attachments: boolean;
}
export interface MailMessage extends MailListRow { cc_addrs: MailAddr[]; text_body: string; html_body: string }
export interface MailAttachment { id: string; message_id: string; filename: string; content_type: string; size: number; storage_path: string }

export const LIST_COLUMNS = 'id,folder,thread_key,message_id,in_reply_to,from_name,from_addr,to_addrs,subject,snippet,sent_at,is_read,has_attachments';

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Your session has expired. Please sign in again.');
  return { authorization: `Bearer ${token}`, 'x-company-id': getCompanyId() ?? '' };
}

async function readError(res: Response): Promise<string> {
  const b = await res.json().catch(() => null) as { error?: string } | null;
  return b?.error ?? (res.status === 413 ? 'The request was too large.' : `The server returned an error (${res.status}).`);
}

/** Pulls new mail (or, with `backfill`, the next batch of older mail) from IONOS. `more` means there is still a backlog; call again. */
export async function syncMail(backfill = false): Promise<{ added: number; addedInbox: number; more: boolean; backfillDone: boolean }> {
  let res: Response;
  try { res = await fetch('/api/mail/sync', { method: 'POST', headers: { ...(await authHeaders()), 'content-type': 'application/json' }, body: JSON.stringify({ backfill }) }); }
  catch (e) {
    if (e instanceof Error && /session/i.test(e.message)) throw e;
    throw new Error('Could not reach the server. Check your connection and try again.');
  }
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

export interface OutgoingMail {
  to: string; cc: string; bcc: string; subject: string; html: string; inReplyTo?: string; references?: string;
  files: File[]; forwardIds: string[];
}

export async function sendMail(m: OutgoingMail): Promise<{ savedToSent: boolean }> {
  const f = new FormData();
  f.set('to', m.to); f.set('cc', m.cc); f.set('bcc', m.bcc); f.set('subject', m.subject); f.set('html', m.html);
  if (m.inReplyTo) f.set('in_reply_to', m.inReplyTo);
  if (m.references) f.set('references', m.references);
  if (m.forwardIds.length) f.set('forward_ids', m.forwardIds.join(','));
  m.files.forEach((file) => f.append('files', file));
  let res: Response;
  try { res = await fetch('/api/mail/send', { method: 'POST', headers: await authHeaders(), body: f }); }
  catch (e) {
    if (e instanceof Error && /session/i.test(e.message)) throw e;
    throw new Error('Could not reach the server. Check your connection and try again.');
  }
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

async function post(path: string, body: unknown): Promise<void> {
  let res: Response;
  try { res = await fetch(path, { method: 'POST', headers: { ...(await authHeaders()), 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
  catch (e) {
    if (e instanceof Error && /session/i.test(e.message)) throw e;
    throw new Error('Could not reach the server. Check your connection and try again.');
  }
  if (!res.ok) throw new Error(await readError(res));
}

/** Moves messages to the IONOS Trash folder and removes them from the portal. Never a permanent delete. */
export const deleteMail = (ids: string[]) => post('/api/mail/delete', { ids });
/** Moves messages to the IONOS Archive folder (created if missing) and removes them from the portal list. */
export const archiveMail = (ids: string[]) => post('/api/mail/delete', { ids, archive: true });
/** Marks messages read/unread in the portal and on IONOS. */
export const setSeen = (ids: string[], seen: boolean) => post('/api/mail/flag', { ids, seen });

export interface MailDraftRow { id: string; to_text: string; cc_text: string; bcc_text: string; subject: string; body: string; in_reply_to: string; refs: string; updated_at: string }

/** Short-lived signed link to a stored attachment. */
export async function attachmentUrl(path: string): Promise<string> {
  const { data, error } = await supabase().storage.from('mail-attachments').createSignedUrl(path, 120);
  if (error || !data) throw new Error('The attachment could not be opened.');
  return data.signedUrl;
}

export const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
export const addrText = (a: MailAddr) => (a.name ? `${a.name} <${a.address}>` : a.address);
export const senderName = (r: { from_name: string; from_addr: string }) => r.from_name || r.from_addr || '(unknown)';

export const MAX_UPLOAD = 3 * 1024 * 1024;       // total size of attached files per message
export const MAX_IMAGE = 600 * 1024;             // one image pasted or inserted into the body

export const longWhen = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
/** Short time for lists: the time today, otherwise the date. */
export const shortWhen = (iso: string) => {
  const d = new Date(iso), now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
};
export const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const TAGGED = /<(p|div|br|span|b|i|u|a|table|ul|ol|li|blockquote|font|strong|em|img)/i;
/** Signatures and drafts saved by earlier versions are plain text; show them as HTML. */
export const toHtml = (t: string) => (!t ? '' : TAGGED.test(t) ? t : `<div>${esc(t).replace(/\n/g, '<br>')}</div>`);
/** Text content of an HTML string (for "is this message empty?" checks and snippets). */
export const htmlText = (h: string) => h.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
