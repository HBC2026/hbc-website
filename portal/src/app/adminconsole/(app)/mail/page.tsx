'use client';
import '@/app/mail.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '@/components/Providers';
import { Avatar } from '@/components/mail/Avatar';
import { Compose, blankDraft, type Draft } from '@/components/mail/Compose';
import { Icon } from '@/components/mail/Icon';
import { RichEditor } from '@/components/mail/RichEditor';
import { ThreadView } from '@/components/mail/Reader';
import { Modal } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import {
  LIST_COLUMNS, archiveMail, deleteMail, htmlText, senderName, setSeen, shortWhen, syncMail, toHtml,
  type MailDraftRow, type MailListRow,
} from '@/lib/mail';
import { MAIL_SIDE } from '@/lib/roles';
import { getCompanyId, supabase, unwrap } from '@/lib/supabase';

type Folder = 'inbox' | 'sent' | 'drafts';
type MailFolder = 'inbox' | 'sent';
interface Thread { key: string; latest: MailListRow; count: number; unread: boolean; attach: boolean }
type Item = { kind: 'head'; label: string } | { kind: 'thread'; t: Thread };

const POLL_MS = 60_000;

function groupThreads(rows: MailListRow[]): Thread[] {
  const map = new Map<string, Thread>();
  for (const r of rows) {                                   // rows arrive newest first
    const t = map.get(r.thread_key);
    if (!t) map.set(r.thread_key, { key: r.thread_key, latest: r, count: 1, unread: !r.is_read, attach: r.has_attachments });
    else { t.count++; t.unread ||= !r.is_read; t.attach ||= r.has_attachments; }
  }
  return [...map.values()];
}

/** Outlook-style date headings between rows. */
function dateLabel(iso: string): string {
  const d = new Date(iso), now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return 'Last 7 days';
  if (diff < 31) return 'Last 30 days';
  return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

function SignatureModal({ initial, onClose, onSave }: { initial: string; onClose: () => void; onSave: (html: string) => void }) {
  const [html, setHtml] = useState(initial);
  return (
    <Modal title="Email signature" onClose={onClose} wide
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={() => onSave(html)}>Save</button></>}>
      <p className="ol-dim" style={{ marginBottom: 10 }}>Added under every new message, reply and forward. Shared by all administrators.</p>
      <RichEditor value={initial} minHeight={160} onChange={setHtml} placeholder="Best regards, …" />
    </Modal>
  );
}

export default function MailPage() {
  const { profile, toast, confirmDialog } = useApp();
  const allowed = MAIL_SIDE.includes(profile!.role);
  const sb = supabase();

  const [folder, setFolder] = useState<Folder>('inbox');
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [compose, setCompose] = useState<{ draft: Draft; key: number } | null>(null);
  const [sigOpen, setSigOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [importing, setImporting] = useState(false);     // one-time import of the older history
  const [working, setWorking] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [limit, setLimit] = useState(500);
  // folders pane: expanded (icons + names) or compact (icons only); remembered per browser
  const [compact, setCompact] = useState(true);
  useEffect(() => { try { setCompact(localStorage.getItem('hbc-mail-folders') !== 'full'); } catch { /* storage unavailable */ } }, []);
  const toggleCompact = () => setCompact((c) => { try { localStorage.setItem('hbc-mail-folders', c ? 'full' : 'compact'); } catch { /* ignore */ } return !c; });
  const busy = useRef(false);
  const composeKey = useRef(0);

  const { data, error, loading, reload } = useQuery(async () =>
    unwrap(await sb.from('mail_messages').select(LIST_COLUMNS).order('sent_at', { ascending: false }).limit(limit)) as MailListRow[], [limit]);
  const { data: sig, reload: reloadSig } = useQuery(async () =>
    (unwrap(await sb.from('mail_settings').select('signature').maybeSingle()) as { signature: string } | null)?.signature ?? '', []);
  const { data: drafts, reload: reloadDrafts } = useQuery(async () =>
    unwrap(await sb.from('mail_drafts').select('*').order('updated_at', { ascending: false })) as MailDraftRow[], []);
  const sigHtml = useMemo(() => toHtml(sig ?? ''), [sig]);

  const ownAddrs = useMemo(() => new Set((data ?? []).filter((r) => r.folder === 'sent').map((r) => r.from_addr.toLowerCase())), [data]);
  const unreadCount = useMemo(() => groupThreads((data ?? []).filter((r) => r.folder === 'inbox')).filter((t) => t.unread).length, [data]);

  const items = useMemo<Item[]>(() => {
    const needle = q.trim().toLowerCase();
    const rows = (data ?? []).filter((r) => r.folder === (folder as MailFolder)
      && (!needle || `${r.subject} ${r.from_name} ${r.from_addr} ${r.snippet}`.toLowerCase().includes(needle)));
    const threads = groupThreads(rows).filter((t) => filter === 'all' || t.unread);
    const out: Item[] = [];
    let last = '';
    for (const t of threads) {
      const label = dateLabel(t.latest.sent_at);
      if (label !== last) { out.push({ kind: 'head', label }); last = label; }
      out.push({ kind: 'thread', t });
    }
    return out;
  }, [data, folder, q, filter]);
  const threadCount = items.filter((i) => i.kind === 'thread').length;

  // ---- actions on the selection: ticked conversations, otherwise the open one
  const targetKeys = checked.size ? [...checked] : selected ? [selected] : [];
  const rowsFor = (keys: string[]) => (data ?? []).filter((r) => keys.includes(r.thread_key));
  const targetRows = rowsFor(targetKeys);
  const anyUnread = targetRows.some((r) => r.folder === 'inbox' && !r.is_read);
  const canAct = folder !== 'drafts' && targetKeys.length > 0 && !working;

  function clearSelection(keys: string[]) {
    setChecked(new Set());
    if (selected && keys.includes(selected)) setSelected(null);
  }

  async function removeSelected(archive: boolean) {
    const ids = targetRows.map((r) => r.id);
    if (!ids.length) return;
    if (!archive) {
      const n = targetKeys.length;
      const ok = await confirmDialog({
        title: `Delete ${n === 1 ? 'conversation' : `${n} conversations`}?`,
        message: 'They are moved to the Trash folder of the mailbox on IONOS and removed from this list.', confirmLabel: 'Delete', danger: true,
      });
      if (!ok) return;
    }
    setWorking(true);
    try {
      await (archive ? archiveMail(ids) : deleteMail(ids));
      toast(archive ? 'Archived' : 'Moved to Trash');
      clearSelection(targetKeys);
      await reload();
    } catch (e) { toast(e instanceof Error ? e.message : 'The action failed', true); }
    finally { setWorking(false); }
  }

  async function toggleRead() {
    const rows = anyUnread ? targetRows.filter((r) => !r.is_read) : targetRows.filter((r) => r.folder === 'inbox');
    if (!rows.length) return;
    setWorking(true);
    try {
      await setSeen(rows.map((r) => r.id), anyUnread);
      clearSelection(anyUnread ? [] : targetKeys);       // marking unread closes the open conversation so it is not re-read at once
      await reload();
    } catch (e) { toast(e instanceof Error ? e.message : 'The action failed', true); }
    finally { setWorking(false); }
  }

  // ---- compose
  const openCompose = (d: Draft) => { setSelected(null); setCompose({ draft: d, key: ++composeKey.current }); };
  const newMail = () => openCompose({ ...blankDraft(), html: sigHtml ? `<div><br></div><br>${sigHtml}` : '' });
  const openDraft = (r: MailDraftRow) => openCompose({
    draftId: r.id, to: r.to_text, cc: r.cc_text, bcc: r.bcc_text ?? '', subject: r.subject, html: toHtml(r.body),
    inReplyTo: r.in_reply_to || undefined, references: r.refs || undefined, files: [], fwd: [],
  });
  async function discardDraft(id: string) {
    const { error: e } = await sb.from('mail_drafts').delete().eq('id', id);
    if (e) return toast(e.message, true);
    reloadDrafts();
  }
  async function saveSignature(html: string) {
    const value = htmlText(html) || /<img\b/i.test(html) ? html : '';
    const { error: e } = await sb.from('mail_settings').upsert({ company_id: getCompanyId(), signature: value, updated_at: new Date().toISOString() }, { onConflict: 'company_id' });
    if (e) return toast(e.message, true);
    toast('Signature saved'); setSigOpen(false); reloadSig();
  }

  // ---- sync
  const runSync = useCallback(async (quiet = true) => {
    if (busy.current) return;
    busy.current = true;
    setSyncing(true);
    try {
      let added = 0, fresh = 0, done = false;
      for (let i = 0; i < 6; i++) {                       // drain a backlog in a few rounds
        const r = await syncMail();
        added += r.added; fresh += r.addedInbox; done = r.backfillDone;
        if (!r.more) break;
      }
      setSyncError(null);
      if (added > 0) await reload();
      // First time only: bring in the older history in the background. The database remembers when this is finished.
      if (!done) {
        setImporting(true);
        try {
          for (let i = 0; i < 10; i++) {
            const r = await syncMail(true);
            if (r.added > 0) await reload();
            if (!r.more) break;
          }
        } finally { setImporting(false); }
      }
      if (fresh > 0 || !quiet) toast(fresh ? `${fresh} new message${fresh === 1 ? '' : 's'}` : 'No new mail');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Sync failed';
      setSyncError(msg);
      if (!quiet) toast(msg, true);
    } finally { setSyncing(false); busy.current = false; }
  }, [reload, toast]);

  // sync when the page opens and then once a minute while it is visible
  useEffect(() => {
    if (!allowed) return;
    runSync();
    const t = setInterval(() => { if (document.visibilityState === 'visible') runSync(); }, POLL_MS);
    return () => clearInterval(t);
  }, [allowed, runSync]);

  useEffect(() => {
    document.title = unreadCount ? `(${unreadCount}) Mail` : 'Mail';
    return () => { document.title = 'HBC Administration Portal'; };
  }, [unreadCount]);

  // Delete key removes the selection (not while typing)
  const removeRef = useRef(removeSelected);
  removeRef.current = removeSelected;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key !== 'Delete' || compose || el?.closest('input,textarea,select,[contenteditable="true"],.modal-back')) return;
      if (canAct) removeRef.current(false);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [canAct, compose]);

  if (!allowed) return <div className="banner error">The inbox is available to administrators only.</div>;

  const reading = !!selected || !!compose;
  const toggleCheck = (key: string) => setChecked((c) => { const n = new Set(c); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const allKeys = items.flatMap((i) => (i.kind === 'thread' ? [i.t.key] : []));
  const allChecked = allKeys.length > 0 && allKeys.every((k) => checked.has(k));

  const FOLDERS: { id: Folder; label: string; icon: string; badge?: number }[] = [
    { id: 'inbox', label: 'Inbox', icon: 'inbox', badge: unreadCount },
    { id: 'sent', label: 'Sent', icon: 'send' },
    { id: 'drafts', label: 'Drafts', icon: 'draft', badge: drafts?.length },
  ];

  return (
    <div className={`ol-app${reading ? ' reading' : ''}`}>
      {/* ---------- command bar ---------- */}
      <div className="ol-toolbar" role="toolbar" aria-label="Mail actions">
        <button className="ol-new" onClick={newMail}><Icon n="edit" size={15} /> New mail</button>
        <span className="ol-sep" />
        <button className="ol-cmd" disabled={!canAct} onClick={() => removeSelected(false)} title="Delete (moves to Trash)"><Icon n="trash" /> <span>Delete</span></button>
        <button className="ol-cmd" disabled={!canAct} onClick={() => removeSelected(true)} title="Archive"><Icon n="archive" /> <span>Archive</span></button>
        <button className="ol-cmd" disabled={!canAct} onClick={toggleRead} title={anyUnread ? 'Mark as read' : 'Mark as unread'}>
          <Icon n={anyUnread ? 'mailOpen' : 'mail'} /> <span>{anyUnread ? 'Mark read' : 'Mark unread'}</span>
        </button>
        <span className="ol-sep" />
        <button className="ol-cmd" onClick={() => runSync(false)} disabled={syncing} title="Check for new mail"><Icon n="refresh" /> <span>{syncing ? 'Checking…' : 'Sync'}</span></button>
        <button className="ol-cmd" onClick={() => setSigOpen(true)} title="Edit signature"><Icon n="edit" /> <span>Signature</span></button>
        <div className="ol-search">
          <Icon n="search" size={15} />
          <input placeholder="Search mail" aria-label="Search mail" value={q} onChange={(e) => setQ(e.target.value)} />
          {q && <button aria-label="Clear search" onClick={() => setQ('')}><Icon n="x" size={13} /></button>}
        </div>
      </div>

      {syncError && <div className="ol-banner error">{syncError}</div>}
      {error && <div className="ol-banner error">{error}</div>}

      <div className={`ol-panes${compact ? ' compact' : ''}`}>
        {/* ---------- folders ---------- */}
        <nav className="ol-folders" aria-label="Folders">
          <button className="ol-folders-toggle" onClick={toggleCompact} aria-label={compact ? 'Expand folders' : 'Collapse folders'} title={compact ? 'Expand folders' : 'Collapse folders'} aria-expanded={!compact}><Icon n="menu" /></button>
          <div className="ol-folders-title">contact@hbcgcc.com</div>
          {FOLDERS.map((f) => (
            <button key={f.id} title={f.label} className={`ol-folder${folder === f.id ? ' active' : ''}`} onClick={() => { setFolder(f.id); setSelected(null); setChecked(new Set()); }}>
              <Icon n={f.icon} /> <span>{f.label}</span>{!!f.badge && <span className="ol-count">{f.badge}</span>}
            </button>
          ))}
        </nav>

        {/* ---------- message list ---------- */}
        <section className="ol-list" aria-label="Messages">
          <div className="ol-list-head">
            <div className="ol-list-title">
              {threadCount > 0 && folder !== 'drafts' && (
                <input type="checkbox" className="ol-checkall" aria-label="Select all" checked={allChecked}
                  onChange={() => setChecked(allChecked ? new Set() : new Set(allKeys))} />
              )}
              <h2>{FOLDERS.find((f) => f.id === folder)!.label}</h2>
              {checked.size > 0 && <span className="ol-dim">{checked.size} selected · <button className="ol-link" onClick={() => setChecked(new Set())}>Clear</button></span>}
            </div>
            {folder !== 'drafts' && (
              <div className="ol-filter" role="group" aria-label="Filter">
                <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>All</button>
                <button className={filter === 'unread' ? 'on' : ''} onClick={() => setFilter('unread')}>Unread</button>
              </div>
            )}
          </div>

          <div className={`ol-rows${checked.size ? ' selecting' : ''}`}>
            {folder === 'drafts' ? (
              (drafts ?? []).length === 0 ? <div className="ol-empty">No drafts.</div> : (drafts ?? []).map((r) => (
                <div key={r.id} className="ol-row draft">
                  <button type="button" className="ol-row-main" onClick={() => openDraft(r)}>
                    <Avatar name={r.to_text} addr={r.to_text} />
                    <span className="ol-row-text">
                      <span className="ol-row-top"><span className="ol-row-from">Draft · {r.to_text || 'no recipient'}</span><span className="ol-row-when">{shortWhen(r.updated_at)}</span></span>
                      <span className="ol-row-subject">{r.subject || '(no subject)'}</span>
                      <span className="ol-row-snip">{htmlText(toHtml(r.body)).slice(0, 120)}</span>
                    </span>
                  </button>
                  <button type="button" className="ol-icon-btn" aria-label="Discard draft" title="Discard draft" onClick={() => discardDraft(r.id)}><Icon n="trash" size={15} /></button>
                </div>
              ))
            ) : loading && !data ? <div className="ol-empty">Loading…</div> : items.length === 0 ? (
              <div className="ol-empty">{q ? 'No messages match your search.' : filter === 'unread' ? 'No unread mail.' : folder === 'inbox' ? 'No mail yet.' : 'Nothing sent yet.'}</div>
            ) : items.map((it) => it.kind === 'head' ? (
              <div key={`h-${it.label}`} className="ol-group">{it.label}</div>
            ) : (
              <div key={it.t.key} className={`ol-row${it.t.unread ? ' unread' : ''}${selected === it.t.key ? ' active' : ''}${checked.has(it.t.key) ? ' checked' : ''}`}>
                <label className="ol-check" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" aria-label="Select conversation" checked={checked.has(it.t.key)} onChange={() => toggleCheck(it.t.key)} />
                </label>
                <button type="button" className="ol-row-main" onClick={() => { setCompose(null); setSelected(it.t.key); }}>
                  <span className="ol-row-avatar"><Avatar name={it.t.latest.from_name} addr={it.t.latest.from_addr} /></span>
                  <span className="ol-row-text">
                    <span className="ol-row-top">
                      <span className="ol-row-from">{folder === 'sent' ? `To: ${it.t.latest.to_addrs.map((a) => a.name || a.address).join(', ') || '—'}` : senderName(it.t.latest)}{it.t.count > 1 && <span className="ol-dim"> ({it.t.count})</span>}</span>
                      <span className="ol-row-when">{it.t.attach && <Icon n="clip" size={12} />} {shortWhen(it.t.latest.sent_at)}</span>
                    </span>
                    <span className="ol-row-subject">{it.t.latest.subject || '(no subject)'}</span>
                    <span className="ol-row-snip">{it.t.latest.snippet}</span>
                  </span>
                </button>
              </div>
            ))}
            {folder !== 'drafts' && (
              <div className="ol-list-foot">
                {importing && <div className="ol-dim">Importing older mail… this happens once.</div>}
                {!importing && (data?.length ?? 0) >= limit && <button className="ol-cmd outline" onClick={() => setLimit((n) => n + 500)}>Show more</button>}
              </div>
            )}
          </div>
        </section>

        {/* ---------- reading pane / compose ---------- */}
        <section className="ol-reader" aria-label={compose ? 'Compose' : 'Reading pane'}>
          {reading && (
            <button className="ol-back" onClick={() => { setSelected(null); if (compose) { setCompose(null); reloadDrafts(); } }}><Icon n="back" /> Back</button>
          )}
          {compose ? (
            <Compose key={compose.key} initial={compose.draft} onDraftsChanged={reloadDrafts} onClose={() => setCompose(null)}
              onSent={(saved) => {
                setCompose(null);
                if (!saved) toast('Sent, but a copy could not be saved to the IONOS Sent folder', true);
                setTimeout(() => runSync(), 1500);            // pick the sent copy up from the Sent folder
              }} />
          ) : selected ? (
            <ThreadView key={selected} threadKey={selected} ownAddrs={ownAddrs} signature={sigHtml} onCompose={openCompose} onChanged={reload} />
          ) : (
            <div className="ol-placeholder-pane">
              <Icon n="mail" size={44} />
              <h3>Select an item to read</h3>
              <p>Nothing is selected</p>
            </div>
          )}
        </section>
      </div>

      {sigOpen && <SignatureModal initial={sigHtml} onClose={() => setSigOpen(false)} onSave={saveSignature} />}
    </div>
  );
}
