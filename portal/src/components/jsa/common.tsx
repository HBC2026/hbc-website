'use client';
import { useEffect, useRef, type ChangeEvent, type CSSProperties } from 'react';
import type { ReactNode } from 'react';
import { useApp } from '@/components/Providers';
import { Badge } from '@/components/ui';
import { can } from '@/lib/roles';
import { fmtDateTime } from '@/lib/format';
import type { SaveState } from '@/lib/jsa/useJsaDoc';
import { REVIEW_NOTICE, type JsaStatus } from '@/lib/jsa/types';

export const JsaStatusBadge = ({ s, revision }: { s: JsaStatus; revision?: number }) => (
  <Badge tone={s === 'finalized' ? 'green' : 'gold'}>{s === 'finalized' ? 'Finalized' : 'Draft'}{revision ? ` · Rev ${revision}` : ''}</Badge>
);

/** Textarea that grows with its content (control measures can be long). */
export function AutoTextarea({ value, onChange, className = 'textarea', style, disabled, placeholder, onBlur, minRows = 1 }: {
  value: string; onChange: (v: string) => void; className?: string; style?: CSSProperties; disabled?: boolean; placeholder?: string;
  onBlur?: () => void; minRows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = () => {
    const el = ref.current; if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.max(el.scrollHeight + 2, minRows * 20 + 14)}px`;
  };
  useEffect(fit, [value, minRows]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {                   // the width can change after the first paint (layout, window resize): re-fit then
    const el = ref.current; if (!el || typeof ResizeObserver === 'undefined') return;
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => { if (el.clientWidth !== w) { w = el.clientWidth; fit(); } });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);                             // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <textarea ref={ref} className={className} rows={minRows} value={value} disabled={disabled} placeholder={placeholder} onBlur={onBlur}
      style={{ minHeight: 0, resize: 'none', overflow: 'hidden', ...style }}
      onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)} />
  );
}

export function SaveBadge({ state, error, savedAt }: { state: SaveState; error: string | null; savedAt: Date | null }) {
  const label =
    state === 'saving' ? 'Saving…' :
    state === 'dirty' ? 'Unsaved changes' :
    state === 'error' ? 'Not saved' :
    state === 'saved' && savedAt ? `Saved ${fmtDateTime(savedAt.toISOString()).split(', ')[1]}` : 'All changes saved';
  return <span className={`jsa-save ${state}`} title={error ?? undefined}>{state === 'error' ? '⚠ ' : state === 'saving' || state === 'dirty' ? '● ' : '✓ '}{label}</span>;
}

export const ReviewNotice = () => <div className="banner warn jsa-notice">⚠ {REVIEW_NOTICE}</div>;

/** JSA Management is administrator-only (the database enforces it too). */
export function JsaGuard({ children }: { children: ReactNode }) {
  const { profile } = useApp();
  if (!can(profile?.role, 'jsa:manage')) return <div className="banner warn">JSA Management is available to administrators only.</div>;
  return <>{children}</>;
}
