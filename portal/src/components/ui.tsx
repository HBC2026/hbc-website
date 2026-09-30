'use client';
import { useEffect, type ReactNode } from 'react';
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

export function StatCard({ label, icon, value, note }: { label: string; icon: ReactNode; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="stat-card">
      <div className="stat-top"><span className="stat-label">{label}</span><span className="stat-icon">{icon}</span></div>
      <div className="stat-number">{value}</div>
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
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
