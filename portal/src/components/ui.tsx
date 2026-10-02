'use client';
import Link from 'next/link';
import { Children, isValidElement, useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type ReactNode } from 'react';
import type { AttendanceStatus, PeriodStatus, QuotationStatus, SlipStatus } from '@/lib/types';

/* ------------------------------------------------ status vocab */
export const ATT_LABEL: Record<AttendanceStatus, string> = {
  present: 'Present', absent: 'Absent', annual_leave: 'Annual Leave', sick_leave: 'Sick Leave',
  unpaid_leave: 'Unpaid Leave', holiday: 'Holiday', weekly_off: 'Weekly Off',
};
export const ATT_CODE: Record<AttendanceStatus, string> = {
  present: 'P', absent: 'A', annual_leave: 'AL', sick_leave: 'SL', unpaid_leave: 'UL', holiday: 'H', weekly_off: 'W',
};
export const ATT_STATUSES = Object.keys(ATT_LABEL) as AttendanceStatus[];

export const QUOTE_LABEL: Record<QuotationStatus, string> = {
  draft: 'Draft', submitted: 'Submitted', revised: 'Revised', approved: 'Approved', rejected: 'Rejected', expired: 'Expired',
};
const QUOTE_TONE: Record<QuotationStatus, string> = {
  draft: '', submitted: 'blue', revised: 'gold', approved: 'green', rejected: 'red', expired: '',
};
export const QUOTE_STATUSES = Object.keys(QUOTE_LABEL) as QuotationStatus[];
export const OPEN_QUOTE: QuotationStatus[] = ['draft', 'submitted', 'revised'];

export const SLIP_LABEL: Record<SlipStatus, string> = {
  generated: 'Generated', awaiting_signature: 'Awaiting Signature', signed_uploaded: 'Signed Copy Uploaded', completed: 'Completed',
};
const SLIP_TONE: Record<SlipStatus, string> = { generated: '', awaiting_signature: 'gold', signed_uploaded: 'blue', completed: 'green' };

export const PERIOD_LABEL: Record<PeriodStatus, string> = {
  open: 'Open', calculated: 'Calculated', approved: 'Approved', completed: 'Completed',
};
const PERIOD_TONE: Record<PeriodStatus, string> = { open: '', calculated: 'gold', approved: 'blue', completed: 'green' };

/* ------------------------------------------------ components */
export function Badge({ tone = '', children }: { tone?: string; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export const QuoteBadge = ({ s }: { s: QuotationStatus }) => <Badge tone={QUOTE_TONE[s]}>{QUOTE_LABEL[s]}</Badge>;
export const SlipBadge = ({ s }: { s: SlipStatus }) => <Badge tone={SLIP_TONE[s]}>{SLIP_LABEL[s]}</Badge>;
export const PeriodBadge = ({ s }: { s: PeriodStatus }) => <Badge tone={PERIOD_TONE[s]}>{PERIOD_LABEL[s]}</Badge>;

export function PageHead({ eyebrow, title, sub, children }: { eyebrow?: string; title: string; sub?: string; children?: ReactNode }) {
  return (
    <div className="page-head no-print">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {children && <div className="head-actions">{children}</div>}
    </div>
  );
}

export function StatCard({ label, icon, value, note, href }: { label: string; icon: ReactNode; value: ReactNode; note?: ReactNode; href?: string }) {
  const body = (
    <>
      <div className="stat-top"><span className="stat-label">{label}</span><span className="stat-icon">{icon}</span></div>
      <div className="stat-number">{value}</div>
      {note && <div className="stat-note">{note}</div>}
    </>
  );
  return href
    ? <Link href={href} className="stat-card stat-link">{body}</Link>
    : <div className="stat-card">{body}</div>;
}

export function Modal({ title, onClose, children, footer, wide }: {
  title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-back no-print" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head"><h3>{title}</h3><button className="modal-x" onClick={onClose} aria-label="Close">×</button></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, children, className = "" }: { label: ReactNode; children: ReactNode; className?: string }) {
  return <div className={`field ${className}`}><label>{label}</label>{children}</div>;
}

export function Loading({ text = 'Loading…' }: { text?: string }) { return <div className="empty">{text}</div>; }
export function ErrorBox({ error }: { error: string }) { return <div className="banner error">{error}</div>; }

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: [T, string][]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="tabs no-print">
      {tabs.map(([k, label]) => (
        <button key={k} className={`tab${value === k ? ' active' : ''}`} onClick={() => onChange(k)}>{label}</button>
      ))}
    </div>
  );
}

/* ------------------------------------------------ in-app dropdown (replaces the browser's native <select> popup) */
interface Opt { value: string; label: ReactNode; disabled?: boolean }
function collectOptions(children: ReactNode, out: Opt[] = []): Opt[] {
  Children.forEach(children, (c) => {
    if (!isValidElement(c)) return;
    const p = c.props as { value?: string | number; children?: ReactNode; disabled?: boolean };
    if (c.type === 'option') out.push({ value: String(p.value ?? p.children ?? ''), label: p.children, disabled: p.disabled });
    else collectOptions(p.children, out);
  });
  return out;
}

export function Select({ value, onChange, disabled, className = 'select', style, children, ...rest }: {
  value: string; onChange: (e: ChangeEvent<HTMLSelectElement>) => void; disabled?: boolean;
  className?: string; style?: CSSProperties; children: ReactNode; 'aria-label'?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxH: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const opts = collectOptions(children);
  const current = opts.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const outside = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.dd-menu, .dd-btn')) close(); };
    window.addEventListener('resize', close); window.addEventListener('keydown', key); document.addEventListener('mousedown', outside);
    return () => { window.removeEventListener('resize', close); window.removeEventListener('keydown', key); document.removeEventListener('mousedown', outside); };
  }, [open]);

  function toggle() {
    if (disabled) return;
    if (!open && btn.current) {
      const r = btn.current.getBoundingClientRect();
      const below = window.innerHeight - r.bottom - 12;
      const above = r.top - 12;
      const up = below < 200 && above > below;
      const maxH = Math.min(320, up ? above : below);
      setPos({ left: r.left, width: Math.max(r.width, 160), top: up ? Math.max(8, r.top - Math.min(maxH, opts.length * 38 + 10) - 4) : r.bottom + 4, maxH });
    }
    setOpen(!open);
  }

  return (
    <>
      <button type="button" ref={btn} className={`${className} dd-btn`} style={style} disabled={disabled} aria-haspopup="listbox" aria-expanded={open}
        aria-label={rest['aria-label']} onClick={toggle}>
        <span className="dd-label">{current?.label ?? '—'}</span><span className="dd-caret" aria-hidden>▾</span>
      </button>
      {open && pos && (
        <>
          <div className="dd-backdrop" onClick={() => setOpen(false)} />
          <ul className="dd-menu" role="listbox" style={{ top: pos.top, left: pos.left, minWidth: pos.width, maxHeight: pos.maxH }}>
            {opts.map((o) => (
              <li key={o.value} role="option" aria-selected={o.value === value} aria-disabled={o.disabled}
                className={`dd-item${o.value === value ? ' sel' : ''}${o.disabled ? ' off' : ''}`}
                onClick={() => { if (o.disabled) return; setOpen(false); onChange({ target: { value: o.value } } as ChangeEvent<HTMLSelectElement>); }}>
                {o.label}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/* ------------------------------------------------ in-app date / month pickers and unit suggestions */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const p2 = (n: number) => String(n).padStart(2, '0');

/** Anchored popup used by the pickers: fixed position under (or over) the trigger; a bottom sheet on phones (CSS). */
function usePopup(height: number) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('resize', close); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('resize', close); window.removeEventListener('keydown', key); };
  }, [open]);
  function toggle() {
    if (!open && btn.current) {
      const r = btn.current.getBoundingClientRect();
      const up = window.innerHeight - r.bottom < height + 16 && r.top > window.innerHeight - r.bottom;
      setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 300)), top: up ? Math.max(8, r.top - height - 4) : r.bottom + 4 });
    }
    setOpen(!open);
  }
  return { open, setOpen, pos, btn, toggle };
}

function PickerButton({ pop, className, style, children, disabled, onOpen }: { pop: ReturnType<typeof usePopup>; className: string; style?: CSSProperties; children: ReactNode; disabled?: boolean; onOpen: () => void }) {
  return (
    <button type="button" ref={pop.btn} className={`${className} dd-btn`} style={style} disabled={disabled} aria-haspopup="dialog" aria-expanded={pop.open}
      onClick={() => { if (!pop.open) onOpen(); pop.toggle(); }}>
      <span className="dd-label">{children}</span><span className="dd-caret" aria-hidden>▾</span>
    </button>
  );
}

export function DatePicker({ value, onChange, className = 'input', style, disabled }: { value: string; onChange: (v: string) => void; className?: string; style?: CSSProperties; disabled?: boolean }) {
  const pop = usePopup(340);
  const today = new Date();
  const sel = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
  const [view, setView] = useState({ y: today.getFullYear(), m: today.getMonth() });
  const shown = sel ? `${Number(sel.slice(8))} ${MONTHS[Number(sel.slice(5, 7)) - 1]} ${sel.slice(0, 4)}` : 'Select date';
  const first = new Date(view.y, view.m, 1).getDay();
  const count = new Date(view.y, view.m + 1, 0).getDate();
  const step = (n: number) => setView((v) => { const d = new Date(v.y, v.m + n, 1); return { y: d.getFullYear(), m: d.getMonth() }; });
  const todayStr = `${today.getFullYear()}-${p2(today.getMonth() + 1)}-${p2(today.getDate())}`;
  return (
    <>
      <PickerButton pop={pop} className={className} style={style} disabled={disabled}
        onOpen={() => { if (sel) setView({ y: Number(sel.slice(0, 4)), m: Number(sel.slice(5, 7)) - 1 }); }}>{shown}</PickerButton>
      {pop.open && (
        <>
          <div className="dd-backdrop" onClick={() => pop.setOpen(false)} />
          <div className="dd-menu pick" role="dialog" style={{ top: pop.pos.top, left: pop.pos.left }}>
            <div className="pick-head">
              <button type="button" className="pick-nav" aria-label="Previous month" onClick={() => step(-1)}>‹</button>
              <strong>{MONTHS_LONG[view.m]} {view.y}</strong>
              <button type="button" className="pick-nav" aria-label="Next month" onClick={() => step(1)}>›</button>
            </div>
            <div className="pick-grid">
              {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <div key={i} className={`pick-dow${i === 5 ? ' fri' : ''}`}>{d}</div>)}
              {Array.from({ length: first }, (_, i) => <div key={`b${i}`} />)}
              {Array.from({ length: count }, (_, i) => {
                const s = `${view.y}-${p2(view.m + 1)}-${p2(i + 1)}`;
                return <button type="button" key={s} className={`pick-day${s === sel ? ' sel' : ''}${s === todayStr ? ' today' : ''}${new Date(view.y, view.m, i + 1).getDay() === 5 ? ' fri' : ''}`}
                  onClick={() => { pop.setOpen(false); onChange(s); }}>{i + 1}</button>;
              })}
            </div>
            <div className="pick-foot"><button type="button" className="btn sm" onClick={() => { pop.setOpen(false); onChange(todayStr); }}>Today</button></div>
          </div>
        </>
      )}
    </>
  );
}

export function MonthPicker({ value, onChange, className = 'input', style, disabled }: { value: string; onChange: (v: string) => void; className?: string; style?: CSSProperties; disabled?: boolean }) {
  const pop = usePopup(250);
  const ok = /^\d{4}-\d{2}$/.test(value);
  const selY = ok ? Number(value.slice(0, 4)) : new Date().getFullYear();
  const selM = ok ? Number(value.slice(5)) : 0;
  const [year, setYear] = useState(selY);
  return (
    <>
      <PickerButton pop={pop} className={className} style={style} disabled={disabled} onOpen={() => setYear(selY)}>
        {ok ? `${MONTHS_LONG[selM - 1]} ${selY}` : 'Select month'}
      </PickerButton>
      {pop.open && (
        <>
          <div className="dd-backdrop" onClick={() => pop.setOpen(false)} />
          <div className="dd-menu pick" role="dialog" style={{ top: pop.pos.top, left: pop.pos.left }}>
            <div className="pick-head">
              <button type="button" className="pick-nav" aria-label="Previous year" onClick={() => setYear(year - 1)}>‹</button>
              <strong>{year}</strong>
              <button type="button" className="pick-nav" aria-label="Next year" onClick={() => setYear(year + 1)}>›</button>
            </div>
            <div className="pick-months">
              {MONTHS.map((m, i) => (
                <button type="button" key={m} className={`pick-day${year === selY && i + 1 === selM ? ' sel' : ''}`}
                  onClick={() => { pop.setOpen(false); onChange(`${year}-${p2(i + 1)}`); }}>{m}</button>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  );
}

/** Text input with an in-app suggestion list (replaces <datalist>). Free text is still allowed. */
export function SuggestInput({ value, onChange, options, style, className = 'input' }: { value: string; onChange: (v: string) => void; options: string[]; style?: CSSProperties; className?: string }) {
  const [focus, setFocus] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const list = options.filter((o) => o.toLowerCase().includes(value.toLowerCase()) && o !== value);
  return (
    <>
      <input ref={ref} className={className} style={style} value={value} autoComplete="off"
        onFocus={() => { setRect(ref.current?.getBoundingClientRect() ?? null); setFocus(true); }}
        onBlur={() => setFocus(false)} onChange={(e) => onChange(e.target.value)} />
      {focus && rect && list.length > 0 && (
        <ul className="dd-menu suggest" style={{ top: rect.bottom + 4, left: rect.left, minWidth: Math.max(rect.width, 110), maxHeight: 220 }}>
          {list.map((o) => <li key={o} className="dd-item" onMouseDown={(e) => { e.preventDefault(); onChange(o); setFocus(false); }}>{o}</li>)}
        </ul>
      )}
    </>
  );
}
