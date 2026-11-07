'use client';
import { useEffect, useRef, useState } from 'react';
import { useApp } from '@/components/Providers';
import { MAX_UPLOAD, fmtBytes, htmlText, sendMail } from '@/lib/mail';
import { getCompanyId, supabase } from '@/lib/supabase';
import { Icon } from './Icon';
import { RichEditor } from './RichEditor';

export interface Draft {
  draftId?: string;
  to: string; cc: string; bcc: string; subject: string; html: string;
  inReplyTo?: string; references?: string;
  files: File[];
  fwd: { id: string; filename: string; size: number }[];     // attachments carried over from a forwarded message
}

export const blankDraft = (): Draft => ({ to: '', cc: '', bcc: '', subject: '', html: '', files: [], fwd: [] });

/** The writing pane (opens in place of the reading pane, like new Outlook). Auto-saves a shared draft as you type. */
export function Compose({ initial, onClose, onSent, onDraftsChanged }: {
  initial: Draft; onClose: () => void; onSent: (savedToSent: boolean) => void; onDraftsChanged: () => void;
}) {
  const { toast, confirmDialog } = useApp();
  const sb = supabase();
  const [d, setD] = useState<Draft>(initial);
  const [showCc, setShowCc] = useState(!!initial.cc || !!initial.bcc);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const draftId = useRef<string | undefined>(initial.draftId);
  const baseline = useRef<string | null>(null);     // editor HTML right after loading
  const dirty = useRef(false);
  const saving = useRef(false);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    if (k !== 'files' && k !== 'fwd') dirty.current = true;
    setD((x) => ({ ...x, [k]: v }));
  };
  const hasContent = (x: Draft) => !!(x.to.trim() || x.subject.trim() || htmlText(x.html));

  // auto-save the text of the message as a shared draft (attachments are not kept in drafts)
  useEffect(() => {
    if (!dirty.current || !hasContent(d)) return;
    const t = setTimeout(async () => {
      if (saving.current) return;
      saving.current = true;
      const row = {
        to_text: d.to, cc_text: d.cc, bcc_text: d.bcc, subject: d.subject.slice(0, 300), body: d.html.slice(0, 190_000),
        in_reply_to: d.inReplyTo ?? '', refs: d.references ?? '', updated_at: new Date().toISOString(),
      };
      if (draftId.current) await sb.from('mail_drafts').update(row).eq('id', draftId.current);
      else {
        const { data } = await sb.from('mail_drafts').insert([{ ...row, company_id: getCompanyId() }]).select('id').single();
        if (data) draftId.current = data.id as string;
      }
      saving.current = false;
    }, 1500);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.to, d.cc, d.bcc, d.subject, d.html]);

  const size = d.files.reduce((n, f) => n + f.size, 0);
  function addFiles(list: FileList | null) {
    if (!list) return;
    const next = [...d.files, ...Array.from(list)];
    if (next.reduce((n, f) => n + f.size, 0) > MAX_UPLOAD) return toast(`Attachments can be ${fmtBytes(MAX_UPLOAD)} in total`, true);
    set('files', next);
  }

  function close() {            // closing keeps the draft, like Outlook
    if (busy) return;
    if (draftId.current) { toast('Draft saved'); onDraftsChanged(); }
    onClose();
  }

  async function discard() {
    if (busy) return;
    if (hasContent(d) && !(await confirmDialog({ title: 'Discard this message?', message: 'The draft will be deleted.', confirmLabel: 'Discard', danger: true }))) return;
    if (draftId.current) { await sb.from('mail_drafts').delete().eq('id', draftId.current); onDraftsChanged(); }
    onClose();
  }

  async function send() {
    if (!d.to.trim()) return toast('Add a recipient in To', true);
    if (!d.subject.trim() && !(await confirmDialog({ title: 'Send without a subject?', message: 'This message has no subject.', confirmLabel: 'Send anyway' }))) return;
    if (!htmlText(d.html) && !/<img\b/i.test(d.html) && !d.files.length && !d.fwd.length) return toast('The message is empty', true);
    setBusy(true);
    try {
      const r = await sendMail({
        to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject.trim() || '(no subject)', html: d.html,
        inReplyTo: d.inReplyTo, references: d.references, files: d.files, forwardIds: d.fwd.map((f) => f.id),
      });
      if (draftId.current) { await sb.from('mail_drafts').delete().eq('id', draftId.current); draftId.current = undefined; onDraftsChanged(); }
      toast('Message sent');
      onSent(r.savedToSent);
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not send the message', true); }
    finally { setBusy(false); }
  }

  return (
    <div className="ol-compose">
      <div className="ol-compose-bar">
        <button className="ol-send" disabled={busy} onClick={send}><Icon n="send" size={15} /> {busy ? 'Sending…' : 'Send'}</button>
        <button className="ol-cmd" disabled={busy} onClick={() => fileRef.current?.click()}><Icon n="clip" /> Attach</button>
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
        <button className="ol-cmd" disabled={busy} onClick={discard}><Icon n="trash" /> Discard</button>
        <span className="ol-compose-note">Draft saves automatically</span>
        <button className="ol-icon-btn" aria-label="Close" title="Close (keeps the draft)" onClick={close}><Icon n="x" /></button>
      </div>

      <div className="ol-fields">
        <div className="ol-field">
          <label htmlFor="ol-to">To</label>
          <input id="ol-to" className="ol-input" value={d.to} onChange={(e) => set('to', e.target.value)} placeholder="name@company.com, another@company.com" autoFocus={!initial.to} />
          {!showCc && <button type="button" className="ol-link" onClick={() => setShowCc(true)}>Cc &amp; Bcc</button>}
        </div>
        {showCc && (
          <>
            <div className="ol-field"><label htmlFor="ol-cc">Cc</label><input id="ol-cc" className="ol-input" value={d.cc} onChange={(e) => set('cc', e.target.value)} /></div>
            <div className="ol-field"><label htmlFor="ol-bcc">Bcc</label><input id="ol-bcc" className="ol-input" value={d.bcc} onChange={(e) => set('bcc', e.target.value)} /></div>
          </>
        )}
        <div className="ol-field">
          <label htmlFor="ol-subject">Subject</label>
          <input id="ol-subject" className="ol-input" value={d.subject} maxLength={300} onChange={(e) => set('subject', e.target.value)} placeholder="Add a subject" autoFocus={!!initial.to} />
        </div>
      </div>

      {(d.files.length > 0 || d.fwd.length > 0) && (
        <div className="ol-chips">
          {d.fwd.map((f) => (
            <span key={f.id} className="ol-chip"><Icon n="clip" size={13} /> {f.filename} <span className="ol-dim">({fmtBytes(f.size)})</span>
              <button type="button" aria-label={`Remove ${f.filename}`} onClick={() => set('fwd', d.fwd.filter((x) => x.id !== f.id))}><Icon n="x" size={12} /></button></span>
          ))}
          {d.files.map((f, i) => (
            <span key={i} className="ol-chip"><Icon n="clip" size={13} /> {f.name} <span className="ol-dim">({fmtBytes(f.size)})</span>
              <button type="button" aria-label={`Remove ${f.name}`} onClick={() => set('files', d.files.filter((_, j) => j !== i))}><Icon n="x" size={12} /></button></span>
          ))}
          {size > 0 && <span className="ol-dim">{fmtBytes(size)} of {fmtBytes(MAX_UPLOAD)}</span>}
        </div>
      )}

      <RichEditor value={initial.html} minHeight={300} placeholder="Write your message…" onError={(m) => toast(m, true)}
        onInit={(h) => { baseline.current = h; }}
        onChange={(h) => { if (h !== baseline.current) dirty.current = true; setD((x) => (x.html === h ? x : { ...x, html: h })); }} />
    </div>
  );
}
