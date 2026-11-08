'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '@/components/Providers';
import { ErrorBox, Loading } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import {
  addrText, attachmentUrl, esc, fmtBytes, longWhen, senderName, setSeen,
  type MailAddr, type MailAttachment, type MailMessage,
} from '@/lib/mail';
import { supabase, unwrap } from '@/lib/supabase';
import { Avatar } from './Avatar';
import type { Draft } from './Compose';
import { Icon } from './Icon';
import { forwardQuote, replyQuote } from './quote';

/** Message body in a script-free sandboxed frame. Remote images are blocked until the user asks for them. */
function Body({ m, images }: { m: MailMessage; images: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const doc = useMemo(() => {
    const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src data:${images ? ' https: http:' : ''}`;
    const inner = m.html_body || `<pre style="white-space:pre-wrap;font:inherit">${esc(m.text_body)}</pre>`;
    return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank">`
      + `<style>body{margin:0;font:14px/1.5 "Segoe UI",Arial,sans-serif;color:#242424;word-break:break-word}img{max-width:100%;height:auto}table{max-width:100%}blockquote{margin:0 0 0 8px;padding-left:10px;border-left:3px solid #c8c8c8;color:#555}</style>${inner}`;
  }, [m.html_body, m.text_body, images]);
  const fit = () => {
    const d = ref.current?.contentDocument;
    if (d?.body && ref.current) ref.current.style.height = `${Math.max(60, d.documentElement.scrollHeight)}px`;
  };
  return <iframe ref={ref} className="ol-frame" title="Message" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcDoc={doc} onLoad={fit} />;
}

function MessageCard({ m, atts, open, current, toggle }: { m: MailMessage; atts: MailAttachment[]; open: boolean; current: boolean; toggle: () => void }) {
  const { toast } = useApp();
  const [images, setImages] = useState(false);
  const hasRemote = /<img[^>]+src=["']https?:/i.test(m.html_body);
  async function download(a: MailAttachment) {
    try { window.open(await attachmentUrl(a.storage_path), '_blank', 'noopener'); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not open the attachment', true); }
  }
  const toLine = m.to_addrs.map((a) => a.name || a.address).join(', ') || '—';
  return (
    <div className={`ol-msg${open ? ' open' : ''}${current ? ' current' : ''}`}>
      <button type="button" className="ol-msg-head" onClick={toggle} aria-expanded={open}>
        <Avatar name={m.from_name} addr={m.from_addr} />
        <span className="ol-msg-who">
          <span className="ol-msg-name">{m.folder === 'sent' ? 'You' : senderName(m)}{open && <span className="ol-dim"> &lt;{m.from_addr}&gt;</span>}</span>
          <span className="ol-msg-sub">{open ? `To: ${toLine}` : m.snippet}</span>
        </span>
        <span className="ol-msg-when">{m.has_attachments && <Icon n="clip" size={13} />} {longWhen(m.sent_at)}</span>
      </button>
      {open && (
        <div className="ol-msg-body">
          {m.cc_addrs.length > 0 && <div className="ol-dim ol-cc">Cc: {m.cc_addrs.map(addrText).join(', ')}</div>}
          {atts.length > 0 && (
            <div className="ol-att">
              <div className="ol-att-title"><Icon n="clip" size={15} /> {atts.length} attachment{atts.length > 1 ? 's' : ''}</div>
              <div className="ol-chips">
                {atts.map((a) => <button key={a.id} className="ol-chip btn-like" onClick={() => download(a)}><Icon n="clip" size={14} /> <strong>{a.filename}</strong> <span className="ol-dim">({fmtBytes(a.size)})</span></button>)}
              </div>
            </div>
          )}
          {hasRemote && !images && (
            <div className="ol-notice">Images from the sender are blocked to protect your privacy. <button className="ol-link" onClick={() => setImages(true)}>Load images</button></div>
          )}
          <Body m={m} images={images} />
        </div>
      )}
    </div>
  );
}

export function ThreadView({ threadKey, ownAddrs, signature, onCompose, onChanged }: {
  threadKey: string; ownAddrs: Set<string>; signature: string; onCompose: (d: Draft) => void; onChanged: () => void;
}) {
  const sb = supabase();
  const { data, error, loading } = useQuery(async () => {
    const msgs = unwrap(await sb.from('mail_messages').select('*').eq('thread_key', threadKey).order('sent_at', { ascending: true })) as MailMessage[];
    const atts = msgs.some((m) => m.has_attachments)
      ? unwrap(await sb.from('mail_attachments').select('*').in('message_id', msgs.map((m) => m.id))) as MailAttachment[] : [];
    return { msgs, atts };
  }, [threadKey]);
  const [openIds, setOpenIds] = useState<Record<string, boolean>>({});

  // opening a conversation marks its unread messages as read (portal and IONOS)
  useEffect(() => {
    const unread = (data?.msgs ?? []).filter((m) => !m.is_read).map((m) => m.id);
    if (!unread.length) return;
    setSeen(unread, true).then(onChanged, () => undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  if (loading) return <Loading />;
  if (error || !data) return <ErrorBox error={error ?? 'Could not load the conversation.'} />;
  const { msgs, atts } = data;
  const last = msgs[msgs.length - 1];
  const isOpen = (m: MailMessage) => openIds[m.id] ?? (m.id === last.id || !m.is_read);
  const sig = signature ? `<br>${signature}` : '';

  function reply(all: boolean) {
    const target = [...msgs].reverse().find((m) => m.folder === 'inbox') ?? last;
    const own = (a: string) => ownAddrs.has(a.toLowerCase());
    const base: MailAddr[] = target.folder === 'inbox' ? [{ name: target.from_name, address: target.from_addr }] : target.to_addrs;
    const to = base.filter((a) => !own(a.address)).map((a) => a.address);
    const cc = all ? [...target.to_addrs, ...target.cc_addrs].filter((a) => !own(a.address) && !to.includes(a.address)).map((a) => a.address) : [];
    onCompose({
      to: to.join(', '), cc: cc.join(', '), bcc: '',
      subject: /^re:/i.test(last.subject) ? last.subject : `Re: ${last.subject}`,
      html: `<div><br></div>${sig}${replyQuote(target)}`,
      inReplyTo: last.message_id || undefined,
      references: msgs.map((m) => m.message_id).filter(Boolean).slice(-20).join(' ') || undefined,
      files: [], fwd: [],
    });
  }

  function forward() {
    onCompose({
      to: '', cc: '', bcc: '',
      subject: /^(fwd?|fw):/i.test(last.subject) ? last.subject : `Fwd: ${last.subject}`,
      html: `<div><br></div>${sig}${forwardQuote(last)}`,
      files: [], fwd: atts.filter((a) => a.message_id === last.id).map((a) => ({ id: a.id, filename: a.filename, size: a.size })),
    });
  }

  return (
    <div className="ol-thread">
      <div className="ol-thread-head">
        <h2>{last.subject || '(no subject)'}</h2>
        <div className="ol-thread-actions">
          <button className="ol-cmd" onClick={() => reply(false)}><Icon n="reply" /> Reply</button>
          <button className="ol-cmd" onClick={() => reply(true)}><Icon n="replyAll" /> Reply all</button>
          <button className="ol-cmd" onClick={forward}><Icon n="forward" /> Forward</button>
        </div>
      </div>
      {msgs.map((m) => (
        <MessageCard key={m.id} m={m} atts={atts.filter((a) => a.message_id === m.id)} open={isOpen(m)} current={m.id === last.id && msgs.length > 1}
          toggle={() => setOpenIds((o) => ({ ...o, [m.id]: !isOpen(m) }))} />
      ))}
      <div className="ol-thread-foot">
        <button className="ol-cmd outline" onClick={() => reply(false)}><Icon n="reply" /> Reply</button>
        <button className="ol-cmd outline" onClick={() => reply(true)}><Icon n="replyAll" /> Reply all</button>
        <button className="ol-cmd outline" onClick={forward}><Icon n="forward" /> Forward</button>
      </div>
    </div>
  );
}
