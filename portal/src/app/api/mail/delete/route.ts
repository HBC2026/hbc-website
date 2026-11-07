import { authorize, folderPath, imapClient, json, mailErrorText } from '@/lib/mail/server';

export const runtime = 'nodejs';
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The mailbox's Archive folder; created on first use when the account has none. */
async function archivePath(client: ReturnType<typeof imapClient>): Promise<string | null> {
  const boxes = await client.list();
  const found = boxes.find((b) => b.specialUse === '\Archive')?.path ?? boxes.find((b) => /^(archive|archiv|archived)$/i.test(b.name))?.path;
  if (found) return found;
  try { return (await client.mailboxCreate('Archive')).path; } catch { return null; }
}

/**
 * "Delete" = move to the IONOS Trash folder, never a permanent delete; with `archive: true` the target is the Archive folder. The row is removed from the portal only after
 * the server confirmed the move; IONOS empties its own Trash on its own schedule.
 */
export async function POST(req: Request) {
  const a = await authorize(req);
  if (a instanceof Response) return a;
  const { sb, cfg, companyId } = a;

  const body = await req.json().catch(() => null) as { ids?: unknown; archive?: unknown } | null;
  const ids = Array.isArray(body?.ids) ? (body!.ids as unknown[]).filter((x): x is string => typeof x === 'string' && UUID.test(x)).slice(0, 100) : [];
  if (!ids.length) return json({ error: 'Choose a message to delete.' }, 400);

  const archive = body?.archive === true;
  const { data: rows, error } = await sb.from('mail_messages').select('id,folder,uid').in('id', ids).eq('company_id', companyId);
  if (error) return json({ error: 'The messages could not be loaded.' }, 500);
  if (!rows?.length) return json({ ok: true, deleted: 0 });

  const client = imapClient(cfg);
  try {
    await client.connect();
    const target = archive ? await archivePath(client) : await folderPath(client, 'trash');
    if (!target) { await client.logout(); return json({ error: archive ? 'The Archive folder could not be found or created, so nothing was archived.' : 'No Trash folder was found on the mailbox, so nothing was deleted.' }, 409); }
    for (const folder of ['inbox', 'sent'] as const) {
      const uids = rows.filter((r) => r.folder === folder).map((r) => Number(r.uid));
      if (!uids.length) continue;
      const path = await folderPath(client, folder);
      if (!path) continue;
      const lock = await client.getMailboxLock(path);
      try { await client.messageMove(uids.join(','), target, { uid: true }); } finally { lock.release(); }
    }
    await client.logout();
  } catch (e) {
    try { client.close(); } catch { /* already closed */ }
    return json({ error: mailErrorText(e) }, 502);
  }

  // attachment files first (rows cascade with the message)
  const { data: atts } = await sb.from('mail_attachments').select('storage_path').in('message_id', rows.map((r) => r.id));
  if (atts?.length) await sb.storage.from('mail-attachments').remove(atts.map((x) => x.storage_path)).then(() => undefined, () => undefined);
  const del = await sb.from('mail_messages').delete().in('id', rows.map((r) => r.id));
  if (del.error) return json({ error: 'Moved on the mailbox, but the portal list could not be updated. Refresh the page.' }, 500);
  return json({ ok: true, deleted: rows.length });
}
