const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const pad = (n: number) => String(n).padStart(2, '0');

/** '2026-09-30' | Date | ISO timestamp -> '30 Sep 2026' */
export function fmtDate(v: string | Date | null | undefined): string {
  if (!v) return '—';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split('-').map(Number);
    return `${pad(d)} ${MONTHS[m - 1]} ${y}`;
  }
  const d = new Date(v);
  return `${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function fmtDateTime(v: string | null | undefined): string {
  if (!v) return '—';
  const d = new Date(v);
  return `${fmtDate(d)}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtLongDate(d: Date): string {
  return `${DAYS_LONG[d.getDay()]}, ${d.getDate()} ${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`;
}

export const monthLabel = (y: number, m: number) => `${MONTHS_LONG[m - 1]} ${y}`;
export const monthShort = (y: number, m: number) => `${MONTHS[m - 1]} ${y}`;

export function fmtNum(n: number | string | null | undefined, dp = 2): string {
  const v = Number(n ?? 0);
  return v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export const hrs = (n: number | string | null | undefined) => fmtNum(n, 2).replace(/\.00$/, '');

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const today = () => ymd(new Date());
export const daysInMonth = (y: number, m: number) => new Date(y, m, 0).getDate();
export const monthStart = (y: number, m: number) => `${y}-${pad(m)}-01`;
export const monthEnd = (y: number, m: number) => `${y}-${pad(m)}-${pad(daysInMonth(y, m))}`;
export const ymKey = (y: number, m: number) => `${y}-${pad(m)}`;
export function parseYm(s: string): { year: number; month: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(s);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return null;
  return { year: Number(m[1]), month: Number(m[2]) };
}

export function timeAgo(v: string): string {
  const s = Math.max(0, (Date.now() - new Date(v).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  if (s < 172800) return 'Yesterday';
  return fmtDate(v);
}

export function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return ymd(new Date(y, m - 1, d + n));
}
