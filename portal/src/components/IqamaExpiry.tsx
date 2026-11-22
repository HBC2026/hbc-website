import { Badge } from './ui';
import { fmtDate, today } from '@/lib/format';

/** Days until a date (negative = already past). */
export const daysUntil = (d: string) =>
  Math.round((new Date(`${d}T00:00:00`).getTime() - new Date(`${today()}T00:00:00`).getTime()) / 86400000);

/** Row highlight tone for an iqama expiry date: red within 30 days / expired, gold within 60, else none. */
export const iqamaTone = (date: string | null): 'red' | 'gold' | null => {
  if (!date) return null;
  const n = daysUntil(date);
  return n <= 30 ? 'red' : n <= 60 ? 'gold' : null;
};

/** Iqama expiry date: highlighted amber within 60 days, red within 30 days or once expired. */
export function IqamaExpiry({ date }: { date: string | null }) {
  if (!date) return <span className="muted">—</span>;
  const n = daysUntil(date);
  const tone = n <= 30 ? 'red' : n <= 60 ? 'gold' : null;
  const label = n < 0 ? 'Expired' : n <= 60 ? `${n}d left` : null;
  return (
    <>
      <span className={tone ? `expiry-hl ${tone}` : undefined}>{fmtDate(date)}</span>{' '}
      {tone && label && <Badge tone={tone}>{label}</Badge>}
    </>
  );
}
