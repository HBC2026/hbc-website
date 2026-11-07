'use client';
import DOMPurify from 'dompurify';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_IMAGE, fmtBytes } from '@/lib/mail';
import { Icon } from './Icon';

/** Cleans HTML before it is put into the editor (pasted text, saved drafts, quoted mail, the source box). */
export const cleanForEditor = (html: string) => DOMPurify.sanitize(html, {
  ADD_ATTR: ['target'], FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'link', 'meta'],
});

const FONTS = ['Calibri', 'Arial', 'Cambria', 'Georgia', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Courier New'];
// execCommand only knows sizes 1-7; they are converted to exact pixel sizes below
const SIZES: [string, number][] = [['10', 10], ['12', 12], ['14', 14], ['16', 16], ['18', 18], ['24', 24], ['32', 32]];

interface Props {
  value: string;                       // initial HTML (the editor keeps its own state afterwards)
  onChange: (html: string) => void;
  /** Called once with the HTML as the editor normalised it, so callers can tell real edits from clean-up. */
  onInit?: (html: string) => void;
  onError?: (msg: string) => void;
  minHeight?: number;
  placeholder?: string;
}

/**
 * Rich-text editor (contentEditable) with an Outlook-like formatting bar and an HTML source mode.
 * HTML coming in from outside is always sanitised; the server sanitises again before anything is sent.
 */
export function RichEditor({ value, onChange, onInit, onError, minHeight = 240, placeholder }: Props) {
  const ed = useRef<HTMLDivElement>(null);
  const saved = useRef<Range | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState(false);
  const [src, setSrc] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [empty, setEmpty] = useState(!value);

  // load the initial content once
  useEffect(() => {
    if (ed.current) ed.current.innerHTML = cleanForEditor(value);
    setEmpty(!ed.current?.textContent?.trim() && !ed.current?.querySelector('img'));
    onInit?.(ed.current?.innerHTML ?? '');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const emit = useCallback(() => {
    const el = ed.current;
    if (!el) return;
    setEmpty(!el.textContent?.trim() && !el.querySelector('img'));
    onChange(el.innerHTML);
  }, [onChange]);

  // remember the caret/selection so toolbar buttons (and the colour pickers) can act on it
  useEffect(() => {
    const h = () => {
      const sel = window.getSelection();
      if (sel && sel.rangeCount && ed.current?.contains(sel.anchorNode)) saved.current = sel.getRangeAt(0).cloneRange();
    };
    document.addEventListener('selectionchange', h);
    return () => document.removeEventListener('selectionchange', h);
  }, []);

  function restore() {
    ed.current?.focus();
    const sel = window.getSelection();
    if (sel && saved.current) { sel.removeAllRanges(); sel.addRange(saved.current); }
  }

  function exec(cmd: string, arg?: string) {
    restore();
    document.execCommand('styleWithCSS', false, 'true');
    document.execCommand(cmd, false, arg);
    emit();
  }

  function setSize(px: number) {
    restore();
    document.execCommand('fontSize', false, '7');           // marker, then swapped for an exact pixel size
    ed.current?.querySelectorAll<HTMLElement>('font[size="7"]').forEach((f) => {
      const span = document.createElement('span');
      span.style.fontSize = `${px}px`;
      span.innerHTML = f.innerHTML;
      f.replaceWith(span);
    });
    ed.current?.querySelectorAll<HTMLElement>('[style*="xxx-large"]').forEach((el) => { el.style.fontSize = `${px}px`; });
    emit();
  }

  function insertImage(file: File) {
    if (!/^image\/(png|jpe?g|gif|webp)$/i.test(file.type)) return onError?.('Only PNG, JPG, GIF or WebP images can be inserted.');
    if (file.size > MAX_IMAGE) return onError?.(`Images in the message can be ${fmtBytes(MAX_IMAGE)} at most. Attach larger files instead.`);
    const r = new FileReader();
    r.onload = () => exec('insertImage', String(r.result));
    r.readAsDataURL(file);
  }

  function onPaste(e: React.ClipboardEvent) {
    const img = Array.from(e.clipboardData.files).find((f) => f.type.startsWith('image/'));
    if (img) { e.preventDefault(); insertImage(img); return; }
    const html = e.clipboardData.getData('text/html');
    e.preventDefault();
    if (html) exec('insertHTML', cleanForEditor(html));
    else exec('insertText', e.clipboardData.getData('text/plain'));
  }

  function toggleSource() {
    if (!source) { setSrc(ed.current?.innerHTML ?? ''); setSource(true); return; }
    if (ed.current) ed.current.innerHTML = cleanForEditor(src);   // scripts / unsafe markup are removed here
    setSource(false);
    emit();
  }

  function applyLink() {
    const url = (link ?? '').trim();
    setLink(null);
    if (!url) return;
    if (!/^(https?:\/\/|mailto:|tel:)/i.test(url)) return exec('createLink', /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(url) ? `mailto:${url}` : `https://${url}`);
    exec('createLink', url);
  }

  // buttons must not steal the selection from the editor
  const keep = (e: React.MouseEvent) => e.preventDefault();
  const Btn = ({ cmd, icon, label, text, arg }: { cmd: string; icon?: string; label: string; text?: React.ReactNode; arg?: string }) => (
    <button type="button" className="ol-fmt" title={label} aria-label={label} onMouseDown={keep} onClick={() => exec(cmd, arg)}>
      {icon ? <Icon n={icon} size={15} /> : text}
    </button>
  );

  return (
    <div className="ol-editor">
      <div className="ol-fmtbar" role="toolbar" aria-label="Formatting">
        <Btn cmd="undo" icon="undo" label="Undo" />
        <Btn cmd="redo" icon="redo" label="Redo" />
        <span className="ol-sep" />
        <select className="ol-fmt-select" aria-label="Font" defaultValue="" onMouseDown={() => restore()} onChange={(e) => { if (e.target.value) exec('fontName', e.target.value); e.target.value = ''; }}>
          <option value="">Font</option>
          {FONTS.map((f) => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
        </select>
        <select className="ol-fmt-select narrow" aria-label="Font size" defaultValue="" onChange={(e) => { if (e.target.value) setSize(Number(e.target.value)); e.target.value = ''; }}>
          <option value="">Size</option>
          {SIZES.map(([l, px]) => <option key={px} value={px}>{l}</option>)}
        </select>
        <span className="ol-sep" />
        <Btn cmd="bold" label="Bold (Ctrl+B)" text={<b>B</b>} />
        <Btn cmd="italic" label="Italic (Ctrl+I)" text={<i>I</i>} />
        <Btn cmd="underline" label="Underline (Ctrl+U)" text={<u>U</u>} />
        <Btn cmd="strikeThrough" label="Strikethrough" text={<s>S</s>} />
        <label className="ol-fmt color" title="Text colour" onMouseDown={() => restore()}>
          <span style={{ borderBottom: '3px solid #c0392b' }}>A</span>
          <input type="color" defaultValue="#c0392b" aria-label="Text colour" onChange={(e) => exec('foreColor', e.target.value)} />
        </label>
        <label className="ol-fmt color" title="Highlight colour" onMouseDown={() => restore()}>
          <span style={{ background: '#fff2a8', padding: '0 3px' }}>ab</span>
          <input type="color" defaultValue="#fff2a8" aria-label="Highlight colour" onChange={(e) => exec('hiliteColor', e.target.value)} />
        </label>
        <span className="ol-sep" />
        <Btn cmd="insertUnorderedList" icon="listUl" label="Bulleted list" />
        <Btn cmd="insertOrderedList" icon="listOl" label="Numbered list" />
        <Btn cmd="outdent" icon="outdent" label="Decrease indent" />
        <Btn cmd="indent" icon="indent" label="Increase indent" />
        <span className="ol-sep" />
        <Btn cmd="justifyLeft" icon="alignLeft" label="Align left" />
        <Btn cmd="justifyCenter" icon="alignCenter" label="Centre" />
        <Btn cmd="justifyRight" icon="alignRight" label="Align right" />
        <span className="ol-sep" />
        <Btn cmd="formatBlock" arg="<blockquote>" icon="quote" label="Quote" />
        <Btn cmd="insertHorizontalRule" icon="minus" label="Horizontal line" />
        <button type="button" className="ol-fmt" title="Insert link" aria-label="Insert link" onMouseDown={keep} onClick={() => setLink('')}><Icon n="link" size={15} /></button>
        <button type="button" className="ol-fmt" title="Insert image" aria-label="Insert image" onMouseDown={keep} onClick={() => fileRef.current?.click()}><Icon n="image" size={15} /></button>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) insertImage(f); e.target.value = ''; }} />
        <Btn cmd="removeFormat" icon="clear" label="Clear formatting" />
        <span className="ol-sep" />
        <button type="button" className={`ol-fmt${source ? ' on' : ''}`} title="Edit HTML source" aria-pressed={source} onMouseDown={keep} onClick={toggleSource}><Icon n="code" size={15} /><span className="ol-fmt-label">HTML</span></button>
      </div>

      {link !== null && (
        <div className="ol-linkbar">
          <input className="input" autoFocus placeholder="https://example.com" value={link} onChange={(e) => setLink(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyLink(); } if (e.key === 'Escape') setLink(null); }} />
          <button type="button" className="btn sm primary" onClick={applyLink}>Add link</button>
          <button type="button" className="btn sm" onClick={() => exec('unlink')}>Remove link</button>
          <button type="button" className="btn sm" onClick={() => setLink(null)}>Cancel</button>
        </div>
      )}

      <div className="ol-editor-body" style={{ minHeight }}>
        <div ref={ed} className="ol-editable" contentEditable suppressContentEditableWarning spellCheck role="textbox" aria-multiline="true" aria-label="Message body"
          style={{ display: source ? 'none' : 'block', minHeight }} onInput={emit} onPaste={onPaste} onBlur={emit} />
        {!source && empty && placeholder && <div className="ol-placeholder">{placeholder}</div>}
        {source && (
          <textarea className="ol-source" spellCheck={false} aria-label="HTML source" value={src} style={{ minHeight }} onChange={(e) => setSrc(e.target.value)} />
        )}
      </div>
    </div>
  );
}
