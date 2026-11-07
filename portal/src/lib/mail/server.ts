/** Server-side helpers for the /api/mail routes: caller authorisation and IONOS IMAP/SMTP configuration. */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ImapFlow } from 'imapflow';

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export interface MailConfig {
  user: string; password: string; fromName: string; companyId: string;
  imapHost: string; imapPort: number; smtpHost: string; smtpPort: number;
}

/** Mailbox settings from server-only env vars. Returns an error message when something required is missing. */
export function mailConfig(): MailConfig | string {
  const e = process.env;
  if (!e.MAIL_USER || !e.MAIL_PASSWORD) return 'The mailbox is not configured. Set MAIL_USER and MAIL_PASSWORD on the server.';
  if (!e.MAIL_COMPANY_ID) return 'MAIL_COMPANY_ID is not set. It pins the mailbox to one company.';
  return {
    user: e.MAIL_USER, password: e.MAIL_PASSWORD, companyId: e.MAIL_COMPANY_ID,
    fromName: e.MAIL_FROM_NAME || 'HBC',
    imapHost: e.MAIL_IMAP_HOST || 'imap.ionos.com', imapPort: Number(e.MAIL_IMAP_PORT) || 993,
    smtpHost: e.MAIL_SMTP_HOST || 'smtp.ionos.com', smtpPort: Number(e.MAIL_SMTP_PORT) || 587,
  };
}

/**
 * Supabase client acting AS THE CALLER (JWT + company header), so RLS applies exactly as in the browser.
 * Only an administrator of the company named by MAIL_COMPANY_ID may use the mailbox.
 */
export async function authorize(req: Request): Promise<{ sb: SupabaseClient; cfg: MailConfig; companyId: string } | Response> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return json({ error: 'Supabase is not configured on the server.' }, 500);
  const cfg = mailConfig();
  if (typeof cfg === 'string') return json({ error: cfg }, 500);
  const auth = req.headers.get('authorization') ?? '';
  const company = req.headers.get('x-company-id') ?? '';
  if (!/^Bearer\s+\S+$/.test(auth) || !company) return json({ error: 'Please sign in again.' }, 401);
  if (company !== cfg.companyId) return json({ error: 'The company mailbox belongs to a different company.' }, 403);
  const sb = createClient(url, anon, {
    global: { headers: { Authorization: auth, 'x-company-id': company } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await sb.rpc('mail_can_use');
  if (error) return json({ error: /mail_can_use/.test(error.message) ? 'Mail migration 0018 has not been applied to the database yet.' : 'Your session could not be verified. Please sign in again.' }, error.code === 'PGRST202' ? 500 : 401);
  if (data !== true) return json({ error: 'The inbox is available to administrators only.' }, 403);
  return { sb, cfg, companyId: company };
}

export function imapClient(cfg: MailConfig): ImapFlow {
  const c = new ImapFlow({
    host: cfg.imapHost, port: cfg.imapPort, secure: true,
    auth: { user: cfg.user, pass: cfg.password }, logger: false,
    socketTimeout: 45_000, greetingTimeout: 15_000, connectionTimeout: 15_000,
  });
  c.on('error', () => { /* surfaced by the awaiting call */ });
  return c;
}

/** Human-friendly message for an IMAP/SMTP failure, without leaking server details. */
export function mailErrorText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/auth|login|credentials|535|AUTHENTICATIONFAILED/i.test(m)) return 'IONOS rejected the mailbox login. Check MAIL_USER / MAIL_PASSWORD (use an app password if two-step login is on).';
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|timeout/i.test(m)) return 'Could not reach the IONOS mail server. Check MAIL_IMAP_HOST / MAIL_SMTP_HOST.';
  return 'The mail server returned an error. Try again in a minute.';
}

export type MailFolder = 'inbox' | 'sent';

/** Mailbox path for a folder. Folder names differ by language, so the \Sent / \Trash special-use flags are used first. */
export async function folderPath(client: ImapFlow, folder: MailFolder | 'trash'): Promise<string | null> {
  if (folder === 'inbox') return 'INBOX';
  const boxes = await client.list();
  const flag = folder === 'sent' ? '\\Sent' : '\\Trash';
  const names = folder === 'sent'
    ? /^(sent|sent items|sent messages|gesendet|gesendete objekte)$/i
    : /^(trash|deleted|deleted items|deleted messages|papierkorb|gelöscht)$/i;
  return boxes.find((b) => b.specialUse === flag)?.path ?? boxes.find((b) => names.test(b.name))?.path ?? null;
}
