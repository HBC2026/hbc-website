import { authorize, folderPath, imapClient, json } from '@/lib/mail/server';

export const runtime = 'nodejs';
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Marks messages read/unread in the portal and mirrors it to the IONOS \Seen flag (best effort). */
export async function POST(req: Request) {
  const a = await authorize(req);
  if (a instanceof Response) return a;
  const { sb, cfg, companyId } = a;
  const body = await req.json().catch(() => null) as { ids?: unknown; seen?: unknown } | null;
  const ids = Array.isArray(body?.ids) ? (body!.ids as unknown[]).filter((x): x is string => typeof x === 'string' && UUID.test(x)).slice(0, 200) : [];
  if (!ids.length || typeof body?.seen !== 'boolean') return json({ error: 'Nothing to update.' }, 400);
  const seen = body.seen;

  const { data: rows, error } = await sb.from('mail_messages').update({ is_read: seen }).in('id', ids).eq('company_id', companyId).select('folder,uid');
  if (error) return json({ error: 'The messages could not be updated.' }, 500);

  let mirrored = true;
  const inbox = (rows ?? []).filter((r) => r.folder === 'inbox').map((r) => Number(r.uid));
  if (inbox.length) {
    const client = imapClient(cfg);
    try {
      await client.connect();
      const path = await folderPath(client, 'inbox');
      const lock = await client.getMailboxLock(path!);
      try {
        if (seen) await client.messageFlagsAdd(inbox.join(','), ['\\Seen'], { uid: true });
        else await client.messageFlagsRemove(inbox.join(','), ['\\Seen'], { uid: true });
      } finally { lock.release(); }
      await client.logout();
    } catch {
      mirrored = false;
      try { client.close(); } catch { /* already closed */ }
    }
  }
  return json({ ok: true, mirrored });
}
