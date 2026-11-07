import { randomUUID } from 'node:crypto';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import sanitizeHtml from 'sanitize-html';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ImapFlow } from 'imapflow';
import { SAFE_HTML } from '@/lib/mail/html';
import { authorize, folderPath, imapClient, json, mailErrorText, type MailConfig, type MailFolder } from '@/lib/mail/server';

export const runtime = 'nodejs';
export const maxDuration = 60;

const PER_RUN = 30;          // messages pulled per folder per call (the page calls again while `more` is true)
const FIRST_RUN = 50;        // newest messages imported the first time
const MAX_ATTACHMENT = 8 * 1024 * 1024;
const MAX_INLINE_IMAGE = 500 * 1024;

type Folder = MailFolder;
interface Addr { name: string; address: string }

const addrList = (a: AddressObject | AddressObject[] | undefined): Addr[] =>
  (Array.isArray(a) ? a : a ? [a] : []).flatMap((o) => o.value.map((v) => ({ name: v.name ?? '', address: (v.address ?? '').toLowerCase() })));

function buildRow(p: ParsedMail, folder: Folder, uid: number, seen: boolean, companyId: string, id: string) {
  const from = addrList(p.from)[0] ?? { name: '', address: '' };
  let html = typeof p.html === 'string' ? p.html : '';
  // inline (cid:) images become small data: URIs so they still show while remote images stay blocked
  for (const a of p.attachments ?? []) {
    if (a.cid && a.content && a.size <= MAX_INLINE_IMAGE && /^image\//i.test(a.contentType)) {
      html = html.split(`cid:${a.cid}`).join(`data:${a.contentType};base64,${a.content.toString('base64')}`);
    }
  }
  const cleanHtml = html ? sanitizeHtml(html.slice(0, 600_000), SAFE_HTML).slice(0, 400_000) : '';
  const text = (p.text || (html ? sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }) : '')).replace(/\r/g, '').trim().slice(0, 200_000);
  const refs = Array.isArray(p.references) ? p.references : p.references ? [p.references] : [];
  const messageId = p.messageId ?? '';
  return {
    id, company_id: companyId, folder, uid,
    message_id: messageId,
    thread_key: refs[0] || p.inReplyTo || messageId || `${folder}-${uid}`,
    in_reply_to: p.inReplyTo ?? '',
    from_name: from.name, from_addr: from.address,
    to_addrs: addrList(p.to), cc_addrs: addrList(p.cc),
    subject: (p.subject ?? '').slice(0, 500),
    snippet: text.replace(/\s+/g, ' ').slice(0, 160),
    text_body: text, html_body: cleanHtml,
    sent_at: (p.date ?? new Date()).toISOString(),
    is_read: folder === 'sent' || seen,
    has_attachments: (p.attachments ?? []).some((a) => !a.cid || a.contentDisposition === 'attachment'),
  };
}

/** Records that a folder's whole history is in the database. */
async function markDone(sb: SupabaseClient, companyId: string, folder: Folder) {
  await sb.from('mail_sync_state').upsert({ company_id: companyId, folder, backfill_done: true }, { onConflict: 'company_id,folder' });
}

async function syncFolder(client: ImapFlow, sb: SupabaseClient, companyId: string, folder: Folder, backfill: boolean): Promise<{ added: number; more: boolean }> {
  const path = await folderPath(client, folder);
  if (!path) { if (backfill) await markDone(sb, companyId, folder); return { added: 0, more: false }; }
  const lock = await client.getMailboxLock(path);
  try {
    const box = client.mailbox;
    if (!box) return { added: 0, more: false };
    const validity = Number(box.uidValidity);
    const { data: st } = await sb.from('mail_sync_state').select('uidvalidity,last_uid').eq('company_id', companyId).eq('folder', folder).maybeSingle();
    let lastUid = Number(st?.last_uid ?? 0);
    if (st && Number(st.uidvalidity) !== validity) {      // server renumbered the folder: start over
      await sb.from('mail_messages').delete().eq('company_id', companyId).eq('folder', folder);
      lastUid = 0;
    }

    // "Load older mail": the next batch below the oldest message we already hold; sync state is left alone
    let oldest = 0;
    if (backfill) {
      const { data: o } = await sb.from('mail_messages').select('uid').eq('company_id', companyId).eq('folder', folder).order('uid', { ascending: true }).limit(1);
      oldest = Number(o?.[0]?.uid ?? 0);
      if (oldest <= 1) { await markDone(sb, companyId, folder); return { added: 0, more: false }; }
    }

    let uids: number[] = [];
    if (backfill) {
      const found = (await client.search({ uid: `1:${oldest - 1}` }, { uid: true })) || [];
      uids = found.filter((u) => u < oldest).sort((a, b) => a - b);
    } else if (box.exists > 0) {
      const found = (await client.search(lastUid > 0 ? { uid: `${lastUid + 1}:*` } : { all: true }, { uid: true })) || [];
      uids = found.filter((u) => u > lastUid).sort((a, b) => a - b);
    }
    if (lastUid === 0 && !backfill && uids.length > FIRST_RUN) uids = uids.slice(-FIRST_RUN);
    const batch = backfill ? uids.slice(-PER_RUN) : uids.slice(0, PER_RUN);   // backfill takes the newest of the older mail
    const more = uids.length > batch.length;

    let added = 0;
    let top = lastUid;
    if (batch.length) {
      const sources: { uid: number; seen: boolean; source: Buffer }[] = [];
      for await (const m of client.fetch(batch.join(','), { uid: true, flags: true, source: true }, { uid: true })) {
        if (m.source) sources.push({ uid: m.uid, seen: m.flags?.has('\\Seen') ?? false, source: m.source });
      }
      for (const s of sources.sort((a, b) => a.uid - b.uid)) {
        top = Math.max(top, s.uid);
        const parsed = await simpleParser(s.source);
        const id = randomUUID();
        const row = buildRow(parsed, folder, s.uid, s.seen, companyId, id);
        const ins = await sb.from('mail_messages').insert([row]);
        if (ins.error) { if (ins.error.code === '23505') continue; throw new Error(ins.error.message); }
        added++;
        let n = 0;
        for (const a of parsed.attachments ?? []) {
          if (!a.content || a.size > MAX_ATTACHMENT) continue;
          if (a.cid && a.contentDisposition !== 'attachment' && /^image\//i.test(a.contentType) && a.size <= MAX_INLINE_IMAGE) continue;   // already inlined
          const filename = (a.filename || `attachment-${n + 1}`).replace(/[^\w.\- ()]+/g, '_').slice(0, 120);
          const storage_path = `${companyId}/${id}/${++n}-${filename}`;
          const up = await sb.storage.from('mail-attachments').upload(storage_path, a.content, { contentType: a.contentType || 'application/octet-stream', upsert: true });
          if (up.error) continue;
          await sb.from('mail_attachments').insert([{ company_id: companyId, message_id: id, filename, content_type: a.contentType, size: a.size, storage_path }]);
        }
      }
    }
    if (backfill) { if (!more) await markDone(sb, companyId, folder); return { added, more }; }
    await sb.from('mail_sync_state').upsert({
      company_id: companyId, folder, uidvalidity: validity,
      last_uid: batch.length ? Math.max(top, batch[batch.length - 1]) : lastUid,
      last_synced_at: new Date().toISOString(), last_error: '',
    }, { onConflict: 'company_id,folder' });
    return { added, more };
  } finally {
    lock.release();
  }
}

export async function POST(req: Request) {
  const a = await authorize(req);
  if (a instanceof Response) return a;
  const { sb, cfg, companyId } = a;
  const backfill = (await req.json().catch(() => null) as { backfill?: boolean } | null)?.backfill === true;
  const client = imapClient(cfg satisfies MailConfig);
  try {
    await client.connect();
    const inbox = await syncFolder(client, sb, companyId, 'inbox', backfill);
    const sent = await syncFolder(client, sb, companyId, 'sent', backfill);
    await client.logout();
    const { data: st } = await sb.from('mail_sync_state').select('folder,backfill_done').eq('company_id', companyId);
    const backfillDone = ['inbox', 'sent'].every((f) => st?.some((r) => r.folder === f && r.backfill_done));
    return json({ added: inbox.added + sent.added, addedInbox: inbox.added, more: inbox.more || sent.more, backfillDone });
  } catch (e) {
    try { client.close(); } catch { /* already closed */ }
    const msg = mailErrorText(e);
    await sb.from('mail_sync_state').upsert({ company_id: companyId, folder: 'inbox', last_error: msg }, { onConflict: 'company_id,folder', ignoreDuplicates: false }).then(() => undefined, () => undefined);
    return json({ error: msg }, 502);
  }
}
